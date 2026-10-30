// Makes sure a converted file really is the audio we asked for before it is handed to the person.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

function ffprobeBin(): string {
  if (process.env.FFPROBE_PATH) return process.env.FFPROBE_PATH;
  if (process.env.FFMPEG_PATH) {
    const dir = path.dirname(process.env.FFMPEG_PATH);
    return dir && dir !== '.' ? path.join(dir, 'ffprobe') : 'ffprobe';
  }
  return 'ffprobe';
}

// Real MP3 data starts with an ID3 tag or contains an MPEG frame sync (0xFF 0xE?) near the start.
// HTML, JSON and text never contain a 0xFF byte, so an error page saved as ".mp3" is caught here.
function looksLikeMp3(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(16384);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n < 4) return false;
    if (buf.toString('latin1', 0, 3) === 'ID3') return true;
    for (let i = 0; i < n - 1; i++) {
      if (buf[i] === 0xff && (buf[i + 1] & 0xe0) === 0xe0) return true;
    }
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

// Returns the length in seconds, or null when ffprobe is not installed (the check is then skipped)
function probeSeconds(file: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffprobeBin(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      const seconds = parseFloat(out.trim());
      if (code === 0 && Number.isFinite(seconds)) resolve(seconds);
      else reject(new Error('The file is not valid audio.'));
    });
  });
}

export interface Mp3Report {
  bytes: number;
  seconds: number | null;
}

function fmt(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// expectedSeconds <= 0 or undefined means "length unknown", so only the format is checked
export async function verifyMp3(file: string, expectedSeconds?: number): Promise<Mp3Report> {
  const bytes = fs.statSync(file).size;
  if (bytes < 10000) throw new Error('The converter returned an empty or incomplete file.');
  if (!looksLikeMp3(file)) throw new Error('The converter returned something that is not an MP3 (probably an error page).');

  const seconds = await probeSeconds(file);
  if (seconds !== null) {
    if (seconds < 1) throw new Error('The converted audio is empty.');
    if (expectedSeconds && expectedSeconds > 0) {
      const tolerance = Math.max(15, expectedSeconds * 0.08);
      if (Math.abs(seconds - expectedSeconds) > tolerance) {
        throw new Error(
          `The converted audio is ${fmt(seconds)} long but the video is ${fmt(expectedSeconds)}. It was cut short or is the wrong audio.`
        );
      }
    }
  }
  return { bytes, seconds };
}
