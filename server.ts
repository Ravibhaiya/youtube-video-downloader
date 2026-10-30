import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { createRequire } from 'module';
import * as yt from './ytdlp.ts';
import { verifyMp3 } from './mp3check.ts';

const require = createRequire(import.meta.url);
const { Ytdl } = require('@distube/ytdl-core');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// ENGINE=auto      yt-dlp on this server when installed, otherwise the third-party converter (default)
// ENGINE=ytdlp     yt-dlp only, never contacts a third-party converter
// ENGINE=converter third-party converter only (cnvmp3.com), no yt-dlp
type EngineSetting = 'auto' | 'ytdlp' | 'converter';
const ENGINE: EngineSetting = ['ytdlp', 'converter'].includes(String(process.env.ENGINE))
  ? (process.env.ENGINE as EngineSetting)
  : 'auto';
const useYtdlp = () => ENGINE !== 'converter' && yt.ytdlpInfo().available;

app.use(express.json({ limit: '1mb' }));

export interface VideoMetadata {
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number; // 0 means the duration is not known
  isLive: boolean;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ---------- Fallback engine: third-party converter (cnvmp3.com) ----------

let cachedCnvReferer = '';
let cachedCnvRefererAt = 0;

// In-memory cache of resolved direct MP3 download URLs by videoId
const resolvedDownloadUrlCache = new Map<string, { url: string; expiresAt: number }>();

// Serialize live conversion requests so concurrent batch clicks never trigger upstream IP rate limits
let conversionChain: Promise<unknown> = Promise.resolve();
function runSerializedConversion<T>(fn: () => Promise<T>): Promise<T> {
  const next = conversionChain.then(fn, fn);
  conversionChain = next.then(
    () => new Promise((r) => setTimeout(r, 400)),
    () => new Promise((r) => setTimeout(r, 400))
  );
  return next;
}

async function getCnvReferer(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedCnvReferer && Date.now() - cachedCnvRefererAt < 10 * 60 * 1000) {
    return cachedCnvReferer;
  }
  try {
    const res = await fetch('https://cnvmp3.com', {
      headers: { 'User-Agent': BROWSER_UA },
      redirect: 'follow',
    });
    if (res.url && res.url.startsWith('https://cnvmp3.com')) {
      cachedCnvReferer = res.url;
      cachedCnvRefererAt = Date.now();
      return cachedCnvReferer;
    }
  } catch {
    // Fallback
  }
  return 'https://cnvmp3.com/v55';
}

function mapBitrateToCnvQuality(bitrate: number, durationSeconds?: number): number {
  // Videos longer than 20 minutes (1200s) only support 128kbps (qualityCode = 4)
  if (durationSeconds && durationSeconds > 1180) {
    return 4;
  }
  if (bitrate >= 320) return 0;
  if (bitrate >= 192) return 1;
  return 4; // 128kbps
}

function encodeCnvDownloadUrl(rawLink: string): string {
  const idx = rawLink.indexOf('?file=');
  if (idx === -1) return rawLink;
  const prefix = rawLink.slice(0, idx + 6);
  const filePart = rawLink.slice(idx + 6);
  const encodedFile = encodeURI(filePart)
    .replace(/&/g, '%26')
    .replace(/#/g, '%23')
    .replace(/\+/g, '%2B');
  return `${prefix}${encodedFile}`;
}

async function resolveDirectMp3UrlViaConverter(
  videoId: string,
  bitrate: number,
  durationSeconds?: number
): Promise<string> {
  const cached = resolvedDownloadUrlCache.get(videoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }

  let referer = await getCnvReferer();
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // CRITICAL: Always send an ASCII-safe alphanumeric title to the remote converter
  // so titles with '#', '|', or Devanagari/Unicode characters never break remote file paths
  const asciiSafeRemoteTitle = `audio_${videoId}`;

  const primaryQuality = mapBitrateToCnvQuality(bitrate, durationSeconds);
  const qualitiesToTry = Array.from(new Set([primaryQuality, 4]));

  for (const qualityCode of qualitiesToTry) {
    const buildHeaders = (ref: string) => ({
      'Content-Type': 'application/json',
      Origin: 'https://cnvmp3.com',
      Referer: ref,
      'User-Agent': BROWSER_UA,
    });

    // 1. Check remote database cache first (fast, no serialization needed)
    for (const checkQual of [qualityCode, 4, 0, 1]) {
      try {
        const checkRes = await fetch('https://cnvmp3.com/check_database.php', {
          method: 'POST',
          headers: buildHeaders(referer),
          body: JSON.stringify({
            youtube_id: videoId,
            quality: checkQual,
            formatValue: 1,
          }),
        });
        if (checkRes.ok) {
          const checkJson = (await checkRes.json()) as {
            success?: boolean;
            data?: { server_path?: string };
          };
          if (checkJson.success && checkJson.data?.server_path) {
            const safeUrl = encodeCnvDownloadUrl(checkJson.data.server_path);
            resolvedDownloadUrlCache.set(videoId, {
              url: safeUrl,
              expiresAt: Date.now() + 60 * 60 * 1000,
            });
            return safeUrl;
          }
        }
      } catch {
        // Continue to live conversion
      }
    }

    // 2. Perform serialized live conversion with automatic retry
    const convertedLink = await runSerializedConversion(async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          referer = await getCnvReferer(true);
          await new Promise((r) => setTimeout(r, 1200));
        }
        try {
          const dlRes = await fetch('https://cnvmp3.com/download_video_ucep.php', {
            method: 'POST',
            headers: buildHeaders(referer),
            body: JSON.stringify({
              url: canonicalUrl,
              quality: qualityCode,
              title: asciiSafeRemoteTitle,
              formatValue: 1,
            }),
          });
          if (!dlRes.ok) continue;
          const text = await dlRes.text();
          if (!text.trim().startsWith('{')) continue;
          const dlJson = JSON.parse(text) as {
            success?: boolean;
            download_link?: string;
            errorType?: number;
          };
          if (dlJson.success && dlJson.download_link) {
            // Cache in remote DB asynchronously
            fetch('https://cnvmp3.com/insert_to_database.php', {
              method: 'POST',
              headers: buildHeaders(referer),
              body: JSON.stringify({
                youtube_id: videoId,
                server_path: dlJson.download_link,
                quality: qualityCode,
                title: asciiSafeRemoteTitle,
                formatValue: 1,
              }),
            }).catch(() => {});
            return dlJson.download_link;
          }
          // errorType 4 means video is >20 mins and requires qualityCode = 4 (128kbps)
          if (dlJson.errorType === 4) {
            break;
          }
        } catch {
          // Retry
        }
      }
      return null;
    });

    if (convertedLink) {
      const safeUrl = encodeCnvDownloadUrl(convertedLink);
      resolvedDownloadUrlCache.set(videoId, {
        url: safeUrl,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      return safeUrl;
    }
  }

  throw new Error('Remote YouTube converter could not process this video');
}

function extractVideoId(inputUrl: string): string | null {
  const trimmed = inputUrl.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (parsed.hostname.includes('youtu.be')) {
      const id = parsed.pathname.slice(1).split('/')[0];
      return /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (parsed.hostname.includes('youtube.com')) {
      const vParam = parsed.searchParams.get('v');
      if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
        return vParam;
      }
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      if (
        (pathParts[0] === 'shorts' || pathParts[0] === 'embed' || pathParts[0] === 'v') &&
        pathParts[1] &&
        /^[a-zA-Z0-9_-]{11}$/.test(pathParts[1])
      ) {
        return pathParts[1];
      }
    }
  } catch {
    // Fallback regex
  }
  const match = trimmed.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}


// ---------- Video information ----------

const VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/;

// Used only when yt-dlp is not available. It never invents a title or a length: unknown stays unknown.
async function fallbackMetadata(videoId: string): Promise<VideoMetadata> {
  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const ytdl = new Ytdl();
    const results = await Promise.race([
      ytdl.search(videoId, { limit: 5 }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('search timeout')), 4500)),
    ]);
    const exact = (results || []).find((r: { id?: string }) => r.id === videoId);
    if (exact && exact.title) {
      return {
        videoId,
        url: canonicalUrl,
        title: exact.title,
        author: exact.author?.name || 'YouTube',
        thumbnailUrl,
        durationSeconds: Number(exact.lengthSeconds) || 0,
        isLive: Boolean(exact.isLive),
      };
    }
  } catch {
    // try the next source
  }

  let title = '';
  let author = '';
  try {
    const r = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(canonicalUrl)}`);
    if (r.ok) {
      const data = (await r.json()) as { title?: string; author_name?: string };
      title = data.title || '';
      author = data.author_name || '';
    }
  } catch {
    // try the next source
  }
  if (!title) {
    try {
      const r = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`
      );
      if (r.ok) {
        const data = (await r.json()) as { title?: string; author_name?: string };
        title = data.title || '';
        author = data.author_name || author;
      }
    } catch {
      // give up below
    }
  }
  if (!title) {
    throw new Error('Could not read this video. It may be private or removed, or the link is wrong.');
  }
  return { videoId, url: canonicalUrl, title, author: author || 'YouTube', thumbnailUrl, durationSeconds: 0, isLive: false };
}

async function resolveVideoMetadata(rawInput: string): Promise<VideoMetadata> {
  const videoId = extractVideoId(rawInput);
  if (!videoId) throw new Error('This is not a valid YouTube video link.');

  let meta: VideoMetadata | null = null;
  let ytdlpError: Error | null = null;
  if (useYtdlp()) {
    try {
      meta = await yt.fetchMetadata(videoId);
    } catch (err) {
      ytdlpError = err instanceof Error ? err : new Error(String(err));
      if (ENGINE === 'ytdlp') throw ytdlpError;
    }
  }
  if (!meta) {
    try {
      meta = await fallbackMetadata(videoId);
    } catch (err) {
      // yt-dlp's message is usually the more helpful one (private, removed, bot check...)
      throw ytdlpError ?? err;
    }
  }

  if (meta.isLive) throw new Error('Live streams cannot be converted until they have ended.');
  if (meta.durationSeconds > yt.MAX_VIDEO_SECONDS) {
    throw new Error(`This video is longer than ${Math.round(yt.MAX_VIDEO_SECONDS / 3600)} hours.`);
  }
  return meta;
}

function sanitizeFilename(input: string): string {
  return (
    input
      .replace(/[<>:"/\\|?*\x00-\x1F#]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100) || 'youtube-audio'
  );
}

// ---------- Conversion jobs ----------

interface Job {
  state: 'working' | 'ready' | 'error';
  engine?: 'ytdlp' | 'converter';
  error?: string;
  promise: Promise<void>;
}

const jobs = new Map<string, Job>();
const jobKey = (videoId: string, bitrate: number) => `${videoId}_${bitrate}`;

// Fallback engine: fetch the converter's file onto disk so it can be checked before anyone receives it
async function fetchConverterFile(videoId: string, bitrate: number, expectedSeconds?: number): Promise<string> {
  const directUrl = await resolveDirectMp3UrlViaConverter(videoId, bitrate, expectedSeconds);
  const upstream = await fetch(directUrl, {
    headers: { 'User-Agent': BROWSER_UA, Referer: 'https://cnvmp3.com/' },
  });
  if (!upstream.ok || !upstream.body) {
    resolvedDownloadUrlCache.delete(videoId);
    throw new Error('The converter did not return the file.');
  }
  const type = upstream.headers.get('content-type') || '';
  if (/text\/html|json/i.test(type)) {
    resolvedDownloadUrlCache.delete(videoId);
    throw new Error('The converter returned a web page instead of audio.');
  }
  const tmp = yt.tempPath(videoId, bitrate);
  try {
    await pipeline(Readable.fromWeb(upstream.body as import('stream/web').ReadableStream), fs.createWriteStream(tmp));
    await verifyMp3(tmp, expectedSeconds);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    resolvedDownloadUrlCache.delete(videoId); // do not reuse a bad link
    throw err;
  }
  fs.renameSync(tmp, yt.finalPath(videoId, bitrate));
  return yt.finalPath(videoId, bitrate);
}

function logConversion(videoId: string, bitrate: number, engine: string, file: string, expected?: number) {
  const mb = (fs.statSync(file).size / 1048576).toFixed(1);
  console.log(`[convert] ${videoId} ${bitrate}k via ${engine}: ${mb} MB, expected length ${expected ? `${expected}s` : "unknown"}`);
}

async function runPrepare(
  videoId: string,
  bitrate: number,
  durationSeconds?: number
): Promise<'ytdlp' | 'converter'> {
  if (ENGINE === 'ytdlp' && !yt.ytdlpInfo().available) {
    throw new Error('yt-dlp is not installed on this server. See the README.');
  }
  let ytdlpError: Error | null = null;
  if (useYtdlp()) {
    try {
      const file = await yt.convertToMp3(videoId, bitrate);
      try {
        await verifyMp3(file, durationSeconds);
      } catch (err) {
        fs.rmSync(file, { force: true }); // never keep a file that failed the check
        throw err;
      }
      logConversion(videoId, bitrate, 'yt-dlp', file, durationSeconds);
      return 'ytdlp';
    } catch (err) {
      ytdlpError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[convert] ${videoId} yt-dlp failed: ${ytdlpError.message}`);
      if (ENGINE === 'ytdlp') throw ytdlpError;
    }
  }
  try {
    const file = await fetchConverterFile(videoId, bitrate, durationSeconds);
    logConversion(videoId, bitrate, 'converter', file, durationSeconds);
    return 'converter';
  } catch (err) {
    console.warn(`[convert] ${videoId} converter failed: ${err instanceof Error ? err.message : err}`);
    throw ytdlpError ?? err;
  }
}

function jobStillValid(job: Job, videoId: string, bitrate: number): boolean {
  if (job.state !== 'ready') return true;
  return yt.cachedFile(videoId, bitrate) !== null;
}

// Starts a conversion (or joins the one already running). A failed job is started again.
function ensureJob(videoId: string, bitrate: number, durationSeconds?: number): Job {
  const key = jobKey(videoId, bitrate);
  const existing = jobs.get(key);
  if (existing && existing.state !== 'error' && jobStillValid(existing, videoId, bitrate)) {
    return existing;
  }
  const job: Job = { state: 'working', promise: Promise.resolve() };
  job.promise = runPrepare(videoId, bitrate, durationSeconds).then(
    (engine) => {
      job.state = 'ready';
      job.engine = engine;
    },
    (err) => {
      job.state = 'error';
      job.error = err instanceof Error ? err.message : 'Conversion failed.';
    }
  );
  jobs.set(key, job);
  return job;
}

function parseBitrate(value: unknown): number {
  const n = Number(value);
  return [128, 192, 256, 320].includes(n) ? n : 192;
}

// ---------- API ----------

app.get('/api/health', (_req, res) => {
  const info = yt.ytdlpInfo();
  res.json({
    engineSetting: ENGINE,
    ytdlp: info,
    using: useYtdlp() ? 'yt-dlp' : ENGINE === 'ytdlp' ? 'nothing (yt-dlp missing)' : 'third-party converter',
  });
});

// Resolve YouTube links. The response lists results in exactly the order the links were sent.
app.post('/api/resolve', async (req, res) => {
  try {
    const { urls } = req.body as { urls?: string[] };
    if (!Array.isArray(urls) || urls.length === 0) {
      res.status(400).json({ error: 'Please provide at least one YouTube link.' });
      return;
    }

    const cleaned = urls
      .map((u) => String(u).trim())
      .filter(Boolean)
      .slice(0, 50);

    // Results are written back by index, so the order never depends on which lookup finishes first
    const results = new Array<
      { ok: true; data: VideoMetadata } | { ok: false; input: string; error: string }
    >(cleaned.length);
    let next = 0;
    const worker = async () => {
      while (next < cleaned.length) {
        const i = next++;
        const rawUrl = cleaned[i];
        try {
          results[i] = { ok: true, data: await resolveVideoMetadata(rawUrl) };
        } catch (err) {
          results[i] = {
            ok: false,
            input: rawUrl,
            error: err instanceof Error ? err.message : 'Unable to read this link.',
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, cleaned.length) }, worker));

    res.json({ results });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unexpected server error while reading links.',
    });
  }
});

// Start converting one video. Returns at once; the browser then asks for the status until it is ready.
app.post('/api/prepare', (req, res) => {
  const { videoId, bitrate, durationSeconds } = req.body as {
    videoId?: string;
    bitrate?: number;
    durationSeconds?: number;
  };
  const id = String(videoId || '').trim();
  if (!VIDEO_ID.test(id)) {
    res.status(400).json({ error: 'A valid 11-character YouTube video id is required.' });
    return;
  }
  const job = ensureJob(id, parseBitrate(bitrate), durationSeconds);
  res.json({ state: job.state, error: job.error });
});

app.get('/api/prepare/status', (req, res) => {
  const id = String(req.query.videoId || '').trim();
  if (!VIDEO_ID.test(id)) {
    res.status(400).json({ error: 'A valid 11-character YouTube video id is required.' });
    return;
  }
  const bitrate = parseBitrate(req.query.bitrate);
  const job = jobs.get(jobKey(id, bitrate));
  if (!job) {
    res.json({ state: 'idle' });
    return;
  }
  res.json({ state: job.state, error: job.error });
});

// Send the finished MP3. The optional "prefix" (01, 02...) is put in front of the file name.
app.get('/api/download', async (req, res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    if (!VIDEO_ID.test(videoId)) {
      res.status(400).json({ error: 'A valid 11-character YouTube video id is required.' });
      return;
    }
    const title = String(req.query.title || `YouTube Audio ${videoId}`).trim();
    const artist = String(req.query.artist || 'YouTube').trim();
    const bitrate = parseBitrate(req.query.bitrate);
    const duration = req.query.duration ? parseInt(String(req.query.duration), 10) : undefined;
    const prefix = String(req.query.prefix || '').replace(/\D/g, '').slice(0, 4);

    const baseName = sanitizeFilename(`${artist} - ${title}`);
    const safeName = prefix ? `${prefix} - ${baseName}` : baseName;

    const job = ensureJob(videoId, bitrate, duration);
    await job.promise;
    if (job.state !== 'ready') {
      res.status(500).json({ error: job.error || 'MP3 conversion failed.' });
      return;
    }

    const file = yt.cachedFile(videoId, bitrate);
    if (!file) {
      res.status(500).json({ error: 'The converted file expired. Please try again.' });
      return;
    }
    // sendFile adds Content-Length and supports resuming a partly finished download
    res.download(file, `${safeName}.mp3`, { dotfiles: 'allow' }, (err) => {
      if (err && !res.headersSent) res.status(500).json({ error: 'Could not send the file.' });
    });
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'MP3 conversion failed.' });
    } else {
      res.destroy();
    }
  }
});

async function startServer() {
  const version = await yt.detectYtdlp();
  if (ENGINE === 'converter') {
    console.log('Engine: third-party converter (cnvmp3.com), as set by ENGINE=converter.');
  } else if (version) {
    console.log(`Engine: yt-dlp ${version} on this server${ENGINE === 'auto' ? ' (converter is the fallback)' : ''}.`);
  } else if (ENGINE === 'ytdlp') {
    console.error('ENGINE=ytdlp but yt-dlp was not found. Install it or set YTDLP_PATH. Conversions will fail.');
  } else {
    console.warn(
      'yt-dlp not found, using the third-party converter (cnvmp3.com). Videos over 20 minutes will be 128 kbps at best. Install yt-dlp for long videos.'
    );
  }

  yt.sweepCache();
  setInterval(() => {
    yt.sweepCache();
    for (const [key, job] of jobs) {
      if (job.state !== 'working' && !jobStillValid(job, key.slice(0, 11), Number(key.slice(12)))) {
        jobs.delete(key);
      }
    }
  }, 10 * 60 * 1000).unref();

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`PulseDeck MP3 server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
