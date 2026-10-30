// Self-hosted converter: yt-dlp downloads the audio and ffmpeg turns it into MP3.
// Runs on your own server, has no 20 minute limit and does not depend on any third-party website.
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const BIN = process.env.YTDLP_PATH || 'yt-dlp';
const FFMPEG = process.env.FFMPEG_PATH || '';
const COOKIES = process.env.YTDLP_COOKIES || '';
const EXTRA_ARGS = (process.env.YTDLP_ARGS || '').split(/\s+/).filter(Boolean);
const MAX_PARALLEL = Math.max(1, Number(process.env.MAX_PARALLEL_CONVERSIONS) || 2);
const JOB_TIMEOUT_MS = 90 * 60 * 1000;
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

export const CACHE_DIR = process.env.CACHE_DIR || path.join(os.tmpdir(), 'pulsedeck-mp3');
export const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS) || 6 * 60 * 60;

export interface YtdlpMetadata {
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  isLive: boolean;
}

let available = false;
let version: string | null = null;
let supportsJsRuntimes = false;

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => {
      // only the tail matters, which is where yt-dlp prints its ERROR line
      stderr = (stderr + d).slice(-8000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('yt-dlp took too long and was stopped'));
      else resolve({ code, stdout, stderr });
    });
  });
}

function commonArgs(): string[] {
  const args = ['--ignore-config', '--no-playlist', '--no-warnings'];
  // Current YouTube needs a JavaScript runtime to solve its player challenges; Node is already installed here.
  if (supportsJsRuntimes) args.push('--js-runtimes', 'node');
  if (COOKIES) args.push('--cookies', COOKIES);
  if (FFMPEG) args.push('--ffmpeg-location', FFMPEG);
  return [...args, ...EXTRA_ARGS];
}

// Turns yt-dlp's raw stderr into one sentence a person can act on
function friendlyError(stderr: string): string {
  const line =
    stderr
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('ERROR:'))
      .pop() || stderr.trim().split('\n').pop() || 'yt-dlp failed';
  const text = line.replace(/^ERROR:\s*/, '').replace(/^\[[^\]]+\]\s*[\w-]{11}:\s*/, '');
  if (/sign in to confirm|not a bot|cookies/i.test(text)) {
    return 'YouTube is asking this server to prove it is not a bot. Set YTDLP_COOKIES (see README).';
  }
  if (/private video|video unavailable|removed|terminated|not available/i.test(text)) {
    return `This video is not available: ${text.slice(0, 120)}`;
  }
  if (/live event|is live|premiere/i.test(text)) {
    return 'Live streams and premieres cannot be converted until they have ended.';
  }
  return text.slice(0, 200);
}

export async function detectYtdlp(): Promise<string | null> {
  try {
    const v = await run(['--version'], 15000);
    if (v.code !== 0) return null;
    version = v.stdout.trim();
    const help = await run(['--help'], 15000);
    supportsJsRuntimes = help.stdout.includes('--js-runtimes');
    available = true;
    return version;
  } catch {
    available = false;
    version = null;
    return null;
  }
}

export function ytdlpInfo() {
  return { available, version };
}

export async function fetchMetadata(videoId: string): Promise<YtdlpMetadata> {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const res = await run([...commonArgs(), '--skip-download', '--dump-single-json', url], 60000);
  if (res.code !== 0) throw new Error(friendlyError(res.stderr));
  const json = JSON.parse(res.stdout) as {
    id?: string;
    title?: string;
    uploader?: string;
    channel?: string;
    duration?: number;
    is_live?: boolean;
    live_status?: string;
  };
  return {
    videoId,
    url,
    title: json.title || videoId,
    author: json.uploader || json.channel || 'YouTube',
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: Math.round(Number(json.duration) || 0),
    isLive: Boolean(json.is_live) || json.live_status === 'is_live' || json.live_status === 'is_upcoming',
  };
}

// ---------- MP3 file cache and conversion jobs ----------

function cacheKey(videoId: string, bitrate: number) {
  return `${videoId}_${bitrate}`;
}

export function finalPath(videoId: string, bitrate: number): string {
  return path.join(CACHE_DIR, `${cacheKey(videoId, bitrate)}.mp3`);
}

export function tempPath(videoId: string, bitrate: number): string {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  return path.join(CACHE_DIR, `${cacheKey(videoId, bitrate)}.tmp${Date.now()}.mp3`);
}

export function cachedFile(videoId: string, bitrate: number): string | null {
  const file = path.join(CACHE_DIR, `${cacheKey(videoId, bitrate)}.mp3`);
  try {
    if (fs.statSync(file).size > 10000) {
      const now = new Date();
      fs.utimesSync(file, now, now); // keeps files that are still being used
      return file;
    }
  } catch {
    // not cached
  }
  return null;
}

const inFlight = new Map<string, Promise<string>>();
let running = 0;
const waiting: Array<() => void> = [];

async function acquireSlot() {
  if (running < MAX_PARALLEL) {
    running++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
}

function releaseSlot() {
  running--;
  waiting.shift()?.();
}

function removeTempFiles(prefix: string) {
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (name.startsWith(prefix)) fs.rmSync(path.join(CACHE_DIR, name), { force: true });
    }
  } catch {
    // ignore
  }
}

async function convert(videoId: string, bitrate: number): Promise<string> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const key = cacheKey(videoId, bitrate);
  const finalFile = path.join(CACHE_DIR, `${key}.mp3`);
  const tmpBase = `${key}.tmp${Date.now()}`;

  await acquireSlot();
  try {
    const res = await run(
      [
        ...commonArgs(),
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        `${bitrate}K`,
        '--embed-metadata',
        '--no-mtime',
        '-N',
        '4',
        '--retries',
        '5',
        '--fragment-retries',
        '5',
        '-o',
        path.join(CACHE_DIR, `${tmpBase}.%(ext)s`),
        `https://www.youtube.com/watch?v=${videoId}`,
      ],
      JOB_TIMEOUT_MS
    );
    const produced = path.join(CACHE_DIR, `${tmpBase}.mp3`);
    if (res.code !== 0 || !fs.existsSync(produced)) {
      throw new Error(friendlyError(res.stderr));
    }
    fs.renameSync(produced, finalFile); // only a finished file ever gets the final name
    return finalFile;
  } finally {
    removeTempFiles(tmpBase);
    releaseSlot();
  }
}

// Same video + quality requested twice (for example Prepare, then Download) shares one conversion
export function convertToMp3(videoId: string, bitrate: number): Promise<string> {
  const existing = cachedFile(videoId, bitrate);
  if (existing) return Promise.resolve(existing);
  const key = cacheKey(videoId, bitrate);
  let job = inFlight.get(key);
  if (!job) {
    job = convert(videoId, bitrate).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

export function sweepCache() {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const file = path.join(CACHE_DIR, name);
      if (now - fs.statSync(file).mtimeMs > CACHE_TTL_MS) fs.rmSync(file, { force: true });
    }
  } catch {
    // cache folder does not exist yet
  }
}
