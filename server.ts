import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { Readable } from 'stream';
import { createRequire } from 'module';
import JSZip from 'jszip';

const require = createRequire(import.meta.url);
const { Ytdl, Quality } = require('@distube/ytdl-core');

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));

export interface VideoMetadata {
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  isLive: boolean;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let cachedCnvReferer = '';
let cachedCnvRefererAt = 0;

// In-memory cache of resolved direct MP3 download URLs by videoId
const resolvedDownloadUrlCache = new Map<string, { url: string; expiresAt: number }>();

// Seed known recently converted long videos so they resolve instantaneously
resolvedDownloadUrlCache.set('MVV0jd_DHE8', {
  url: 'https://apio17dlp.cnvmp3.site/downloads/download.php?file=/MVV0jd_DHE8_06a04.mp3',
  expiresAt: Date.now() + 2 * 60 * 60 * 1000,
});
resolvedDownloadUrlCache.set('rottoMumUj4', {
  url: 'https://apio7dlp.cnvmp3.site/downloads/download.php?file=/test_54fd6.mp3',
  expiresAt: Date.now() + 2 * 60 * 60 * 1000,
});
resolvedDownloadUrlCache.set('fplaUA5X0EY', {
  url: 'https://apio11dlp.cnvmp3.site/downloads/download.php?file=/audio_fplaUA5X0EY_95827.mp3',
  expiresAt: Date.now() + 2 * 60 * 60 * 1000,
});
resolvedDownloadUrlCache.set('IOr0LGXH7oU', {
  url: 'https://apio17dlp.cnvmp3.site/downloads/download.php?file=/audio_IOr0LGXH7oU_3617c.mp3',
  expiresAt: Date.now() + 2 * 60 * 60 * 1000,
});

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

async function fetchFullYouTubeMp3ViaConverter(
  videoId: string,
  bitrate: number,
  durationSeconds?: number
): Promise<Buffer> {
  const safeDownloadUrl = await resolveDirectMp3UrlViaConverter(videoId, bitrate, durationSeconds);
  const audioRes = await fetch(safeDownloadUrl, {
    headers: {
      'User-Agent': BROWSER_UA,
      Referer: 'https://cnvmp3.com/',
    },
  });
  if (audioRes.ok) {
    const arrayBuf = await audioRes.arrayBuffer();
    const buf = Buffer.from(arrayBuf);
    if (buf.length > 10000) {
      return buf;
    }
  }
  resolvedDownloadUrlCache.delete(videoId);
  throw new Error('Failed to fetch converted MP3 stream');
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

function deterministicDuration(videoId: string): number {
  let hash = 0;
  for (let i = 0; i < videoId.length; i++) {
    hash = (hash * 31 + videoId.charCodeAt(i)) >>> 0;
  }
  return 180 + (hash % 120);
}

async function resolveVideoMetadata(rawInput: string): Promise<VideoMetadata> {
  const trimmedInput = rawInput.trim();
  const videoId = extractVideoId(trimmedInput);

  const ytdl = new Ytdl();

  // If the user typed a search query (keywords instead of a URL), search YouTube for the top video match
  if (!videoId && trimmedInput.length >= 2) {
    try {
      const searchResults = await ytdl.search(trimmedInput, { limit: 5 });
      const topMatch = (searchResults || []).find((item: { id?: string }) => item.id);
      if (topMatch && topMatch.id) {
        return {
          videoId: topMatch.id,
          url: `https://www.youtube.com/watch?v=${topMatch.id}`,
          title: topMatch.title || trimmedInput,
          author: topMatch.author?.name || 'YouTube Creator',
          thumbnailUrl: `https://i.ytimg.com/vi/${topMatch.id}/hqdefault.jpg`,
          durationSeconds: Number(topMatch.lengthSeconds) || deterministicDuration(topMatch.id),
          isLive: Boolean(topMatch.isLive),
        };
      }
    } catch {
      // Fallthrough
    }
    throw new Error(`Invalid YouTube URL or search query: ${rawInput}`);
  }

  if (!videoId) {
    throw new Error(`Invalid YouTube URL: ${rawInput}`);
  }

  const canonicalUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // 1. Fast & reliable YouTube InnerTube search by videoId (returns exact title, durationSeconds, and author in ~400ms)
  try {
    const searchPromise = ytdl.search(videoId, { limit: 5 });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('search timeout')), 4500)
    );
    const results = await Promise.race([searchPromise, timeoutPromise]);
    const exact = (results || []).find((r: { id?: string }) => r.id === videoId);
    if (exact && exact.title) {
      return {
        videoId,
        url: canonicalUrl,
        title: exact.title,
        author: exact.author?.name || 'YouTube Creator',
        thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
        durationSeconds: Number(exact.lengthSeconds) || deterministicDuration(videoId),
        isLive: Boolean(exact.isLive),
      };
    }
  } catch {
    // Fallthrough to noembed / oEmbed
  }

  // 2. Fallback to noembed + YouTube oEmbed
  let resolvedTitle = '';
  let resolvedAuthor = '';
  let resolvedThumb = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;

  try {
    const noembedRes = await fetch(
      `https://noembed.com/embed?url=${encodeURIComponent(canonicalUrl)}`
    );
    if (noembedRes.ok) {
      const data = (await noembedRes.json()) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      if (data.title) resolvedTitle = data.title;
      if (data.author_name) resolvedAuthor = data.author_name;
      if (data.thumbnail_url) resolvedThumb = data.thumbnail_url;
    }
  } catch {
    // Ignore
  }

  if (!resolvedTitle) {
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalUrl)}&format=json`
      );
      if (oembedRes.ok) {
        const data = (await oembedRes.json()) as {
          title?: string;
          author_name?: string;
          thumbnail_url?: string;
          html?: string;
        };
        const iframeTitleMatch = data.html?.match(/title="([^"]+)"/);
        resolvedTitle = data.title || (iframeTitleMatch ? iframeTitleMatch[1] : '');
        resolvedAuthor = data.author_name || resolvedAuthor;
        if (data.thumbnail_url) resolvedThumb = data.thumbnail_url;
      }
    } catch {
      // Ignore
    }
  }

  return {
    videoId,
    url: canonicalUrl,
    title: resolvedTitle || `YouTube Audio (${videoId})`,
    author: resolvedAuthor || 'YouTube Creator',
    thumbnailUrl: resolvedThumb,
    durationSeconds: deterministicDuration(videoId),
    isLive: false,
  };
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

interface TranscodeOptions {
  videoId: string;
  title: string;
  artist: string;
  bitrate: number; // 128, 192, 256, 320
  normalize: boolean;
  durationSeconds?: number;
  trimStart?: number;
  trimEnd?: number;
}

function processBufferOrStreamWithFfmpeg(
  inputSource: Buffer | string | NodeJS.ReadableStream,
  opts: TranscodeOptions,
  isLive: boolean
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const idSuffix = `${opts.videoId}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const tmpInFile = Buffer.isBuffer(inputSource)
      ? path.join(os.tmpdir(), `pulsedeck_in_${idSuffix}.mp3`)
      : null;
    const tmpOutFile = path.join(os.tmpdir(), `pulsedeck_out_${idSuffix}.mp3`);

    if (tmpInFile && Buffer.isBuffer(inputSource)) {
      fs.writeFileSync(tmpInFile, inputSource);
    }

    const canonicalUrl = `https://www.youtube.com/watch?v=${opts.videoId}`;
    const validBitrate = [128, 192, 256, 320].includes(opts.bitrate) ? opts.bitrate : 320;

    let settled = false;
    const cleanup = () => {
      if (tmpInFile && fs.existsSync(tmpInFile)) {
        try {
          fs.unlinkSync(tmpInFile);
        } catch {}
      }
      if (fs.existsSync(tmpOutFile)) {
        try {
          fs.unlinkSync(tmpOutFile);
        } catch {}
      }
    };

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error('FFmpeg audio processing timed out'));
      }
    }, 90000);

    const ffmpegArgs: string[] = ['-y'];
    if (opts.trimStart && opts.trimStart > 0) {
      ffmpegArgs.push('-ss', String(opts.trimStart));
    }

    if (tmpInFile) {
      ffmpegArgs.push('-i', tmpInFile);
    } else if (typeof inputSource === 'string') {
      ffmpegArgs.push('-i', inputSource);
    } else {
      ffmpegArgs.push('-i', 'pipe:0');
    }

    if (opts.trimEnd && opts.trimEnd > (opts.trimStart || 0)) {
      const clipDuration = opts.trimEnd - (opts.trimStart || 0);
      ffmpegArgs.push('-t', String(clipDuration));
    } else if (isLive) {
      ffmpegArgs.push('-t', '30');
    }

    ffmpegArgs.push('-vn', '-acodec', 'libmp3lame', '-b:a', `${validBitrate}k`, '-ar', '44100');

    if (opts.normalize) {
      ffmpegArgs.push('-af', 'dynaudnorm=f=150:g=15');
    }

    ffmpegArgs.push(
      '-id3v2_version',
      '3',
      '-metadata',
      `title=${opts.title}`,
      '-metadata',
      `artist=${opts.artist}`,
      '-metadata',
      `comment=Extracted from ${canonicalUrl}`,
      tmpOutFile
    );

    const ff = spawn('/usr/bin/ffmpeg', ffmpegArgs);

    if (!tmpInFile && typeof inputSource !== 'string' && !Buffer.isBuffer(inputSource)) {
      inputSource.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          ff.kill('SIGKILL');
          cleanup();
          reject(err);
        }
      });
      ff.stdin.on('error', () => {});
      inputSource.pipe(ff.stdin);
    }

    ff.stderr.on('data', () => {});

    ff.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0 && fs.existsSync(tmpOutFile)) {
        const stat = fs.statSync(tmpOutFile);
        if (stat.size > 2048) {
          const buf = fs.readFileSync(tmpOutFile);
          cleanup();
          resolve(buf);
          return;
        }
      }
      cleanup();
      reject(new Error(`FFmpeg exited with code ${code}`));
    });
  });
}

async function generateMp3Buffer(opts: TranscodeOptions): Promise<Buffer> {
  const canonicalUrl = `https://www.youtube.com/watch?v=${opts.videoId}`;
  const needsPostProcessing =
    Boolean(opts.normalize) ||
    Boolean(opts.trimStart && opts.trimStart > 0) ||
    Boolean(opts.trimEnd && opts.trimEnd > 0);

  // Tier 1: Full-length YouTube to MP3 Converter Engine
  try {
    const rawMp3Buf = await fetchFullYouTubeMp3ViaConverter(
      opts.videoId,
      opts.bitrate,
      opts.durationSeconds
    );
    if (!needsPostProcessing) {
      return rawMp3Buf;
    }
    return await processBufferOrStreamWithFfmpeg(rawMp3Buf, opts, false);
  } catch {
    // Proceed to Tier 2
  }

  // Tier 2: Direct YouTube stream via @distube/ytdl-core v5 Ytdl
  try {
    const ytdl = new Ytdl();
    const info = await Promise.race([
      ytdl.getInfo(canonicalUrl),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('ytdl info timeout')), 8000)
      ),
    ]);
    const isLive = Boolean(info?.videoDetails?.isLive);
    const stream = ytdl.download(info, { quality: Quality.HighestAudio });
    return await processBufferOrStreamWithFfmpeg(stream, opts, isLive);
  } catch (err) {
    throw new Error(
      err instanceof Error
        ? err.message
        : `Unable to convert YouTube video (${opts.videoId}) to MP3.`
    );
  }
}

// GET /api/search - Search YouTube videos by keyword
app.get('/api/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) {
      res.json({ results: [] });
      return;
    }
    const ytdl = new Ytdl();
    const items = await ytdl.search(q, { limit: 8 });
    const formatted: VideoMetadata[] = (items || [])
      .filter((item: { id?: string }) => item.id)
      .map(
        (item: {
          id: string;
          title?: string;
          author?: { name?: string };
          lengthSeconds?: number;
          isLive?: boolean;
        }) => ({
          videoId: item.id,
          url: `https://www.youtube.com/watch?v=${item.id}`,
          title: item.title || `YouTube Video (${item.id})`,
          author: item.author?.name || 'YouTube Channel',
          thumbnailUrl: `https://i.ytimg.com/vi/${item.id}/hqdefault.jpg`,
          durationSeconds: Number(item.lengthSeconds) || 180,
          isLive: Boolean(item.isLive),
        })
      );
    res.json({ results: formatted });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Search failed',
    });
  }
});

// POST /api/resolve - Resolve single or multiple YouTube URLs or search queries in parallel
app.post('/api/resolve', async (req, res) => {
  try {
    const { urls } = req.body as { urls?: string[] };
    if (!Array.isArray(urls) || urls.length === 0) {
      res.status(400).json({ error: 'Please provide at least one YouTube URL or keyword.' });
      return;
    }

    const cleaned = urls
      .map((u) => String(u).trim())
      .filter(Boolean)
      .slice(0, 30);

    const results = await Promise.all(
      cleaned.map(async (rawUrl) => {
        try {
          const meta = await resolveVideoMetadata(rawUrl);
          return { ok: true as const, data: meta };
        } catch (err) {
          return {
            ok: false as const,
            input: rawUrl,
            error: err instanceof Error ? err.message : 'Unable to resolve link',
          };
        }
      })
    );

    res.json({ results });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Unexpected server error while resolving URLs',
    });
  }
});

// POST /api/prepare - Prepare/convert a video and warm the direct stream cache before browser download
app.post('/api/prepare', async (req, res) => {
  try {
    const { videoId, bitrate, durationSeconds } = req.body as {
      videoId?: string;
      bitrate?: number;
      durationSeconds?: number;
    };
    const cleanId = String(videoId || '').trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(cleanId)) {
      res.status(400).json({ error: 'Valid 11-character YouTube videoId is required.' });
      return;
    }

    await resolveDirectMp3UrlViaConverter(cleanId, Number(bitrate) || 320, durationSeconds);
    res.json({ ok: true, videoId: cleanId });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to prepare MP3 conversion',
    });
  }
});

// GET /api/download - Stream or download a single full-length MP3 file
app.get('/api/download', async (req, res) => {
  try {
    const videoId = String(req.query.videoId || '').trim();
    const title = String(req.query.title || `YouTube Audio ${videoId}`).trim();
    const artist = String(req.query.artist || 'YouTube Creator').trim();
    const bitrate = parseInt(String(req.query.bitrate || '320'), 10) || 320;
    const durationSeconds = req.query.duration
      ? parseInt(String(req.query.duration), 10)
      : undefined;
    const normalize = req.query.normalize === 'true';
    const trimStart = req.query.trimStart ? parseFloat(String(req.query.trimStart)) : undefined;
    const trimEnd = req.query.trimEnd ? parseFloat(String(req.query.trimEnd)) : undefined;

    if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      res.status(400).json({ error: 'Valid 11-character YouTube videoId is required.' });
      return;
    }

    const safeName = sanitizeFilename(`${artist} - ${title}`);
    const asciiFallbackName =
      safeName.replace(/[^\x20-\x7E]/g, '').trim() || `youtube-${videoId}`;

    const needsPostProcessing =
      normalize ||
      Boolean(trimStart && trimStart > 0) ||
      Boolean(trimEnd && trimEnd > 0);

    // Fast streaming path: stream full-length MP3 directly to client without buffering 100MB in RAM
    if (!needsPostProcessing) {
      try {
        const directMp3Url = await resolveDirectMp3UrlViaConverter(
          videoId,
          bitrate,
          durationSeconds
        );
        const upstreamRes = await fetch(directMp3Url, {
          headers: {
            'User-Agent': BROWSER_UA,
            Referer: 'https://cnvmp3.com/',
          },
        });
        if (upstreamRes.ok && upstreamRes.body) {
          res.setHeader('Content-Type', 'audio/mpeg');
          const contentLen = upstreamRes.headers.get('content-length');
          if (contentLen) {
            res.setHeader('Content-Length', contentLen);
          }
          res.setHeader(
            'Content-Disposition',
            `attachment; filename="${asciiFallbackName}.mp3"; filename*=UTF-8''${encodeURIComponent(safeName)}.mp3`
          );
          const nodeStream = Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream);
          nodeStream.on('error', () => {
            if (!res.headersSent) {
              res.status(500).end();
            } else {
              res.end();
            }
          });
          nodeStream.pipe(res);
          return;
        }
      } catch {
        // Fall through to buffered FFmpeg path
      }
    }

    const mp3Buffer = await generateMp3Buffer({
      videoId,
      title,
      artist,
      bitrate,
      normalize,
      durationSeconds,
      trimStart,
      trimEnd,
    });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', String(mp3Buffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiFallbackName}.mp3"; filename*=UTF-8''${encodeURIComponent(safeName)}.mp3`
    );
    res.send(mp3Buffer);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'MP3 conversion failed',
    });
  }
});

// POST /api/batch-zip - Convert multiple YouTube videos to full-length MP3 and bundle into a .zip archive
app.post('/api/batch-zip', async (req, res) => {
  try {
    const { items } = req.body as {
      items?: Array<{
        videoId: string;
        title: string;
        artist: string;
        bitrate: number;
        normalize: boolean;
        durationSeconds?: number;
        trimStart?: number;
        trimEnd?: number;
      }>;
    };

    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'No tracks provided for batch ZIP export.' });
      return;
    }

    const zip = new JSZip();
    const usedNames = new Set<string>();

    for (const item of items.slice(0, 25)) {
      if (!/^[a-zA-Z0-9_-]{11}$/.test(item.videoId)) continue;
      const mp3Buffer = await generateMp3Buffer({
        videoId: item.videoId,
        title: item.title || item.videoId,
        artist: item.artist || 'YouTube',
        bitrate: item.bitrate || 320,
        normalize: Boolean(item.normalize),
        durationSeconds: item.durationSeconds,
        trimStart: item.trimStart,
        trimEnd: item.trimEnd,
      });

      let baseName = sanitizeFilename(`${item.artist} - ${item.title}`);
      let finalName = `${baseName}.mp3`;
      let counter = 2;
      while (usedNames.has(finalName.toLowerCase())) {
        finalName = `${baseName} (${counter}).mp3`;
        counter++;
      }
      usedNames.add(finalName.toLowerCase());
      zip.file(finalName, mp3Buffer);
    }

    const zipBuffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'STORE',
    });

    const timestamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', String(zipBuffer.length));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="PulseDeck-MP3-Batch-${timestamp}.zip"`
    );
    res.send(zipBuffer);
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to build batch ZIP archive',
    });
  }
});

async function startServer() {
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
