import { useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { AlertCircle, Archive, Check, Download, Loader2, RotateCcw, Trash2, X } from 'lucide-react';
import type { BitrateOption, Track } from './types';

const MAX_TRACKS = 50;
const BITRATES: BitrateOption[] = [128, 192, 320];
const LONG_VIDEO_SECONDS = 20 * 60;
const POLL_MS = 1500;
const GIVE_UP_MS = 95 * 60 * 1000;

type Notice = { kind: 'error' | 'info'; text: string };

// ---------- helpers ----------

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function formatDuration(seconds: number): string {
  if (!seconds) return '';
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Keeps the order in which links were written. Anything that is not a YouTube link is reported, not guessed at.
function parseLinks(text: string): { links: string[]; ignored: number } {
  const seen = new Set<string>();
  const links: string[] = [];
  let ignored = 0;
  for (const token of text.split(/[\s,]+/)) {
    if (!token) continue;
    if (/(?:youtube\.com|youtu\.be)\//i.test(token)) {
      if (!seen.has(token)) {
        seen.add(token);
        links.push(token);
      }
    } else {
      ignored++;
    }
  }
  return { links, ignored };
}

// "01", "02"... wide enough for the whole list, so files sort in the order they were given
function orderPrefix(index: number, total: number): string {
  return String(index + 1).padStart(Math.max(2, String(total).length), '0');
}

function fileName(track: Track, index: number, total: number): string {
  const base = `${track.author} - ${track.title}`
    .replace(/[<>:"/\\|?*\x00-\x1F#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  return `${orderPrefix(index, total)} - ${base || track.videoId}.mp3`;
}

function downloadUrl(track: Track, index: number, total: number, bitrate: BitrateOption): string {
  const params = new URLSearchParams({
    videoId: track.videoId,
    title: track.title,
    artist: track.author,
    bitrate: String(bitrate),
    duration: String(track.durationSeconds || 0),
    prefix: orderPrefix(index, total),
  });
  return `/api/download?${params.toString()}`;
}

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => null);
  return (data && typeof data.error === 'string' && data.error) || fallback;
}

// Converting a long video can take minutes, so the server works in the background and we ask how it is going
async function prepareTrack(track: Track, bitrate: BitrateOption): Promise<void> {
  const start = () =>
    fetch('/api/prepare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: track.videoId,
        bitrate,
        durationSeconds: track.durationSeconds,
      }),
    });

  let res = await start();
  if (!res.ok) throw new Error(await readError(res, 'Conversion failed.'));
  let state = await res.json();

  const deadline = Date.now() + GIVE_UP_MS;
  while (state.state !== 'ready') {
    if (state.state === 'error') throw new Error(state.error || 'Conversion failed.');
    if (Date.now() > deadline) throw new Error('This is taking too long. Try again later.');
    await sleep(POLL_MS);
    const status = await fetch(
      `/api/prepare/status?videoId=${encodeURIComponent(track.videoId)}&bitrate=${bitrate}`
    );
    if (!status.ok) throw new Error(await readError(status, 'Lost contact with the server.'));
    state = await status.json();
    if (state.state === 'idle') {
      // the server restarted and forgot the job: start it again
      res = await start();
      if (!res.ok) throw new Error(await readError(res, 'Conversion failed.'));
      state = await res.json();
    }
  }
}

function saveFromUrl(href: string, name: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ---------- component ----------

export default function App() {
  const [text, setText] = useState('');
  const [bitrate, setBitrate] = useState<BitrateOption>(192);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<null | 'files' | 'zip'>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const stopRef = useRef(false);

  const doneCount = useMemo(() => tracks.filter((t) => t.status === 'done').length, [tracks]);
  const hasLongVideo = useMemo(
    () => tracks.some((t) => t.durationSeconds > LONG_VIDEO_SECONDS),
    [tracks]
  );
  const detected = useMemo(() => parseLinks(text).links.length, [text]);

  function patch(id: string, changes: Partial<Track>) {
    setTracks((prev) => prev.map((t) => (t.id === id ? { ...t, ...changes } : t)));
  }

  // 1. Add links: resolved by the server in the same order they were pasted, then appended to the end of the list
  async function addLinks() {
    const { links, ignored } = parseLinks(text);
    if (links.length === 0) {
      setNotice({ kind: 'error', text: 'Paste at least one YouTube link, one per line.' });
      return;
    }
    const room = MAX_TRACKS - tracks.length;
    if (room <= 0) {
      setNotice({ kind: 'error', text: `The list is full (${MAX_TRACKS} videos). Remove some to add more.` });
      return;
    }

    setAdding(true);
    setNotice(null);
    try {
      const res = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: links.slice(0, room) }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Could not read those links.'));
      const data = await res.json();

      const known = new Set(tracks.map((t) => t.videoId));
      const added: Track[] = [];
      const failed: string[] = [];
      let firstReason = '';
      let duplicates = 0;

      for (const item of data.results || []) {
        if (!item.ok) {
          failed.push(item.input);
          if (!firstReason) firstReason = item.error || '';
        } else if (known.has(item.data.videoId)) {
          duplicates++;
        } else {
          known.add(item.data.videoId);
          added.push({
            id: `${item.data.videoId}-${Date.now()}-${added.length}`,
            videoId: item.data.videoId,
            url: item.data.url,
            title: item.data.title,
            author: item.data.author,
            thumbnailUrl: item.data.thumbnailUrl,
            durationSeconds: item.data.durationSeconds,
            status: 'waiting',
          });
        }
      }

      setTracks((prev) => [...prev, ...added]);
      // Whatever could not be added stays in the box so it can be fixed and tried again
      setText([...failed, ...links.slice(room)].join('\n'));

      const notes: string[] = [];
      if (duplicates) notes.push(`${duplicates} already in the list`);
      if (failed.length) notes.push(`${failed.length} could not be read${firstReason ? ` (${firstReason.replace(/\.$/, '')})` : ''}`);
      if (links.length > room) notes.push(`${links.length - room} left out because the list is full`);
      if (ignored) notes.push(`${ignored} ignored because they are not YouTube links`);
      if (notes.length) {
        setNotice({
          kind: added.length ? 'info' : 'error',
          text: `${added.length ? `Added ${added.length}. ` : ''}${notes.join(', ')}.`,
        });
      }
    } catch (err) {
      setNotice({ kind: 'error', text: err instanceof Error ? err.message : 'Network error. Try again.' });
    } finally {
      setAdding(false);
    }
  }

  // 2. Convert one track on the server, then hand it to the browser as a numbered MP3 file
  async function saveOne(track: Track, index: number, total: number): Promise<boolean> {
    patch(track.id, { status: 'converting', error: undefined });
    try {
      await prepareTrack(track, bitrate);
      saveFromUrl(downloadUrl(track, index, total, bitrate), fileName(track, index, total));
      patch(track.id, { status: 'done' });
      return true;
    } catch (err) {
      patch(track.id, { status: 'error', error: err instanceof Error ? err.message : 'Conversion failed.' });
      return false;
    }
  }

  // 3a. Download all: one file at a time, top to bottom, so the files start downloading in list order
  async function downloadAll() {
    stopRef.current = false;
    setBusy('files');
    setNotice(null);
    const total = tracks.length;
    const everythingSaved = tracks.every((t) => t.status === 'done');
    if (everythingSaved) setTracks((prev) => prev.map((t) => ({ ...t, status: 'waiting' })));
    let failed = 0;
    let stopped = false;
    for (let i = 0; i < total; i++) {
      // Skip what is already saved, unless that is everything (then the person wants it all again)
      if (!everythingSaved && tracks[i].status === 'done') continue;
      if (stopRef.current) {
        stopped = true;
        break;
      }
      const ok = await saveOne(tracks[i], i, total);
      if (ok) await sleep(800); // gives the browser a moment to start each download before the next one
      else failed++;
    }
    setBusy(null);
    if (stopped) setNotice({ kind: 'info', text: 'Stopped. Press Download all to continue with the rest.' });
    else if (failed) setNotice({ kind: 'error', text: `${failed} failed. Press Download all to try those again.` });
  }

  // 3b. ZIP: fetch each MP3 in list order and add it to one archive, named 01, 02, 03...
  async function downloadZip() {
    stopRef.current = false;
    setBusy('zip');
    setNotice(null);
    setTracks((prev) => prev.map((t) => ({ ...t, status: 'waiting', error: undefined })));
    const zip = new JSZip();
    const total = tracks.length;
    let added = 0;
    let failed = 0;
    for (let i = 0; i < total; i++) {
      if (stopRef.current) break;
      const track = tracks[i];
      patch(track.id, { status: 'converting', error: undefined });
      try {
        await prepareTrack(track, bitrate);
        const res = await fetch(downloadUrl(track, i, total, bitrate));
        if (!res.ok) throw new Error(await readError(res, 'Conversion failed.'));
        zip.file(fileName(track, i, total), await res.blob());
        patch(track.id, { status: 'done' });
        added++;
      } catch (err) {
        patch(track.id, { status: 'error', error: err instanceof Error ? err.message : 'Conversion failed.' });
        failed++;
      }
    }
    try {
      if (added > 0) {
        const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
        const href = URL.createObjectURL(blob);
        saveFromUrl(href, `pulsedeck-mp3-${new Date().toISOString().slice(0, 10)}.zip`);
        setTimeout(() => URL.revokeObjectURL(href), 30000);
      }
      const parts = [added ? `ZIP saved with ${added} MP3${added === 1 ? '' : 's'}.` : 'No ZIP was created.'];
      if (failed) parts.push(`${failed} ${failed === 1 ? 'video failed and is' : 'videos failed and are'} not in the ZIP.`);
      setNotice({ kind: failed || !added ? 'error' : 'info', text: parts.join(' ') });
    } catch {
      setNotice({ kind: 'error', text: 'Could not build the ZIP. Try Download all instead.' });
    } finally {
      setBusy(null);
    }
  }

  function removeTrack(id: string) {
    setTracks((prev) => prev.filter((t) => t.id !== id));
  }

  function clearList() {
    setTracks([]);
    setNotice(null);
  }

  const locked = busy !== null;

  return (
    <div className="min-h-screen bg-paper text-ink">
      <header className="mx-auto w-full max-w-[640px] px-4 pt-6">
        <span className="text-[17px] font-semibold tracking-tight">PulseDeck MP3</span>
      </header>

      <main className="mx-auto w-full max-w-[640px] px-4 pb-40 pt-8">
        <h1 className="text-[28px] font-bold leading-tight tracking-tight sm:text-[32px]">
          YouTube links to MP3
        </h1>
        <p className="mt-2 max-w-[52ch] text-[15px] leading-relaxed text-muted">
          Paste one link per line. Files are numbered 01, 02, 03 in the order you pasted them.
        </p>

        {/* Input */}
        <section className="mt-6" aria-label="Add links">
          <label htmlFor="links" className="mb-2 block text-sm font-medium">
            YouTube links
          </label>
          <textarea
            id="links"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={adding}
            rows={5}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={'https://youtu.be/…\nhttps://www.youtube.com/watch?v=…'}
            className="w-full resize-y rounded-lg border border-line bg-card px-3.5 py-3 text-[15px] leading-relaxed placeholder:text-muted/70 disabled:opacity-60"
          />

          <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Quality (kbps)</legend>
              <div className="inline-flex overflow-hidden rounded-lg border border-line bg-card">
                {BITRATES.map((rate) => (
                  <label
                    key={rate}
                    className="relative cursor-pointer border-r border-line px-4 py-2.5 text-sm font-medium last:border-r-0 has-[:checked]:bg-accent has-[:checked]:text-accent-ink has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-accent"
                  >
                    <input
                      type="radio"
                      name="bitrate"
                      value={rate}
                      checked={bitrate === rate}
                      onChange={() => setBitrate(rate)}
                      disabled={locked}
                      className="absolute inset-0 opacity-0"
                    />
                    {rate}
                  </label>
                ))}
              </div>
            </fieldset>

            <button
              type="button"
              onClick={addLinks}
              disabled={adding || locked || detected === 0}
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-[15px] font-semibold text-accent-ink disabled:opacity-45"
            >
              {adding && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
              {adding ? 'Reading links…' : detected > 1 ? `Add ${detected} links` : 'Add link'}
            </button>
          </div>
        </section>

        {notice && (
          <p
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={`mt-4 flex items-start gap-2 text-sm leading-relaxed ${
              notice.kind === 'error' ? 'text-bad' : 'text-muted'
            }`}
          >
            {notice.kind === 'error' && <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <span>{notice.text}</span>
          </p>
        )}

        {/* List */}
        {tracks.length > 0 && (
          <section className="mt-10" aria-label="Download list">
            <div className="flex items-baseline justify-between">
              <h2 className="text-base font-semibold">
                {tracks.length} {tracks.length === 1 ? 'video' : 'videos'}, in download order
              </h2>
              <button
                type="button"
                onClick={clearList}
                disabled={locked}
                className="inline-flex items-center gap-1.5 rounded px-1 py-1 text-sm text-muted hover:text-ink disabled:opacity-45"
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Clear list
              </button>
            </div>
            {hasLongVideo && (
              <p className="mt-1 text-sm text-muted">
                Long videos make big files, roughly 60 to 145 MB per hour. For those, use Download all instead of ZIP.
              </p>
            )}

            <ol className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-card">
              {tracks.map((track, index) => (
                <li key={track.id} className="flex items-center gap-3 px-3 py-3">
                  <span className="w-7 shrink-0 text-right text-[15px] font-semibold tabular-nums text-muted">
                    {orderPrefix(index, tracks.length)}
                  </span>
                  <img
                    src={track.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden';
                    }}
                    className="hidden aspect-video w-20 shrink-0 rounded bg-line object-cover min-[480px]:block"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[15px] font-medium leading-snug [overflow-wrap:anywhere]">{track.title}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[13px] text-muted">
                      <span className="truncate">{track.author}</span>
                      {track.durationSeconds > 0 && (
                        <span className="tabular-nums">{formatDuration(track.durationSeconds)}</span>
                      )}
                    </p>
                    <StatusLine track={track} />
                  </div>
                  <div className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => saveOne(track, index, tracks.length)}
                      disabled={locked}
                      aria-label={
                        track.status === 'error'
                          ? `Retry ${track.title}`
                          : `Download ${track.title} as MP3`
                      }
                      className="grid size-11 place-items-center rounded-lg text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
                    >
                      {track.status === 'converting' ? (
                        <Loader2 className="size-5 animate-spin" aria-hidden="true" />
                      ) : track.status === 'error' ? (
                        <RotateCcw className="size-5" aria-hidden="true" />
                      ) : (
                        <Download className="size-5" aria-hidden="true" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => removeTrack(track.id)}
                      disabled={locked}
                      aria-label={`Remove ${track.title}`}
                      className="grid size-11 place-items-center rounded-lg text-muted hover:bg-paper hover:text-ink disabled:opacity-40"
                    >
                      <X className="size-5" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>

            <p className="mt-3 text-sm leading-relaxed text-muted">
              If your browser asks to allow multiple downloads, choose Allow. A ZIP is a good choice on phones.
            </p>
          </section>
        )}
      </main>

      {/* Actions */}
      {tracks.length > 0 && (
        <div
          className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-paper/95 backdrop-blur"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          <div className="mx-auto flex w-full max-w-[640px] items-center gap-3 px-4 py-3">
            <p className="min-w-0 flex-1 text-sm tabular-nums text-muted" aria-live="polite">
              {busy ? `${doneCount} of ${tracks.length} done` : `${tracks.length} ready`}
            </p>
            {busy ? (
              <button
                type="button"
                onClick={() => {
                  stopRef.current = true;
                }}
                className="inline-flex h-11 items-center rounded-lg border border-line bg-card px-5 text-[15px] font-semibold"
              >
                Stop
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={downloadZip}
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-line bg-card px-4 text-[15px] font-semibold"
                >
                  <Archive className="size-4" aria-hidden="true" />
                  ZIP
                </button>
                <button
                  type="button"
                  onClick={downloadAll}
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-accent px-5 text-[15px] font-semibold text-accent-ink"
                >
                  <Download className="size-4" aria-hidden="true" />
                  Download all
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusLine({ track }: { track: Track }) {
  if (track.status === 'converting') {
    return <p className="mt-1 text-[13px] font-medium text-accent">Converting…</p>;
  }
  if (track.status === 'done') {
    return (
      <p className="mt-1 flex items-center gap-1 text-[13px] font-medium text-ok">
        <Check className="size-3.5" aria-hidden="true" />
        Saved
      </p>
    );
  }
  if (track.status === 'error') {
    return <p className="mt-1 text-[13px] font-medium text-bad">Failed: {track.error || 'Conversion failed.'}</p>;
  }
  return null;
}
