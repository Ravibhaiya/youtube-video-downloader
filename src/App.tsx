import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  Download,
  FolderArchive,
  Play,
  Pause,
  Trash2,
  Sliders,
  Plus,
  CheckSquare,
  Square,
  Search,
  Upload,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Music,
  Volume2,
  X,
  RotateCcw,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';
import { BitrateOption, QueueTrack, HistoryEntry } from './types';

const SAMPLE_BATCH_LINKS = [
  'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  'https://www.youtube.com/watch?v=fJ9rUzIMcZQ',
  'https://www.youtube.com/watch?v=09R8_2nJtjg',
  'https://www.youtube.com/watch?v=JGwWNGJdvx8',
];

interface SearchResultVideo {
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  isLive: boolean;
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const hrs = Math.floor(safe / 3600);
  const mins = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function estimateFileSizeMB(durationSeconds: number, bitrate: BitrateOption): number {
  const effectiveDuration = Math.max(30, durationSeconds || 180);
  const megabytes = (effectiveDuration * bitrate) / 8 / 1024;
  return Math.max(0.4, Number(megabytes.toFixed(2)));
}

function isYoutubeUrlOrId(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.includes('youtube.com/') ||
    trimmed.includes('youtu.be/') ||
    /^[a-zA-Z0-9_-]{11}$/.test(trimmed)
  );
}

function parseMultipleUrls(rawText: string): string[] {
  const lines = rawText
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = new Set<string>();
  for (const line of lines) {
    if (isYoutubeUrlOrId(line)) {
      const tokens = line.split(/\s+/).filter(Boolean);
      for (const token of tokens) {
        if (isYoutubeUrlOrId(token)) {
          unique.add(token);
        }
      }
    } else if (line.length >= 2) {
      unique.add(line);
    }
  }
  return Array.from(unique);
}

interface TrackThumbnailProps {
  src: string;
  title: string;
  videoId: string;
}

function TrackThumbnail({ src, title, videoId }: TrackThumbnailProps) {
  const [failed, setFailed] = useState(false);

  if (failed || !src) {
    return (
      <div
        className="w-16 h-11 rounded bg-slate-900 border border-slate-800 flex items-center justify-center shrink-0 overflow-hidden"
        aria-label={title}
      >
        <svg
          className="w-6 h-6 text-orange-500/80"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
        >
          <path d="M2 12h2l2-5 4 10 4-8 3 6 2-3h3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }

  return (
    <div className="w-16 h-11 rounded bg-slate-900 border border-slate-800 overflow-hidden shrink-0 relative">
      <img
        src={src}
        alt={`Thumbnail for ${title} (${videoId})`}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
        className="w-full h-full object-cover"
      />
    </div>
  );
}

export default function App() {
  // Input Mode & URL states
  const [inputMode, setInputMode] = useState<'single' | 'batch'>('single');
  const [singleUrl, setSingleUrl] = useState('');
  const [batchUrlsText, setBatchUrlsText] = useState('');
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Keyword Search Results (like vd6s.net search dropdown/panel)
  const [searchResults, setSearchResults] = useState<SearchResultVideo[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  // Global Studio Presets (defaultNormalize = false for fast bit-accurate full-length MP3 delivery)
  const [defaultBitrate, setDefaultBitrate] = useState<BitrateOption>(320);
  const [defaultNormalize, setDefaultNormalize] = useState<boolean>(false);

  // Queue & Filtering
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [statusFilter, setStatusFilter] = useState<'all' | 'queued' | 'completed' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isBatchProcessing, setIsBatchProcessing] = useState(false);
  const [isZipping, setIsZipping] = useState(false);

  // Active Conversion Modal (like vd6s.net conversion progress & instant download modal)
  const [activeModalTrack, setActiveModalTrack] = useState<QueueTrack | null>(null);

  // Edit Track Modal State
  const [editingTrackId, setEditingTrackId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editArtist, setEditArtist] = useState('');
  const [editBitrate, setEditBitrate] = useState<BitrateOption>(320);
  const [editNormalize, setEditNormalize] = useState(false);
  const [editTrimStart, setEditTrimStart] = useState<number>(0);
  const [editTrimEnd, setEditTrimEnd] = useState<number>(0);

  // Live Audio Preview Player
  const [previewTrack, setPreviewTrack] = useState<QueueTrack | null>(null);
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Persistent Download History
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try {
      const saved = localStorage.getItem('pulsedeck_mp3_history');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('pulsedeck_mp3_history', JSON.stringify(history.slice(0, 50)));
    } catch {
      // Ignore storage quota errors
    }
  }, [history]);

  // Seed initial studio batch on first mount so the workspace is immediately populated and testable
  useEffect(() => {
    let mounted = true;
    async function seedInitialTracks() {
      setIsResolving(true);
      try {
        const res = await fetch('/api/resolve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: SAMPLE_BATCH_LINKS.slice(0, 3) }),
        });
        if (!res.ok || !mounted) return;
        const payload = await res.json();
        const resolvedTracks: QueueTrack[] = [];
        for (const item of payload.results || []) {
          if (item.ok && item.data) {
            const dur = item.data.durationSeconds || 210;
            resolvedTracks.push({
              id: `${item.data.videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              videoId: item.data.videoId,
              url: item.data.url,
              title: item.data.title,
              author: item.data.author,
              thumbnailUrl: item.data.thumbnailUrl,
              durationSeconds: dur,
              bitrate: 320,
              normalize: false,
              trimStart: 0,
              trimEnd: dur,
              status: 'queued',
              progress: 0,
              selected: true,
              estimatedSizeMB: estimateFileSizeMB(dur, 320),
            });
          }
        }
        if (mounted && resolvedTracks.length > 0) {
          setQueue(resolvedTracks);
        }
      } catch {
        // Ignore initial seed error
      } finally {
        if (mounted) setIsResolving(false);
      }
    }
    seedInitialTracks();
    return () => {
      mounted = false;
    };
  }, []);

  const detectedBatchUrls = useMemo(() => parseMultipleUrls(batchUrlsText), [batchUrlsText]);

  function addVideoMetaToQueue(meta: SearchResultVideo, customBitrate?: BitrateOption): QueueTrack {
    const duration = meta.durationSeconds || 210;
    const rate = customBitrate || defaultBitrate;
    const newTrack: QueueTrack = {
      id: `${meta.videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      videoId: meta.videoId,
      url: meta.url,
      title: meta.title,
      author: meta.author,
      thumbnailUrl: meta.thumbnailUrl,
      durationSeconds: duration,
      bitrate: rate,
      normalize: defaultNormalize,
      trimStart: 0,
      trimEnd: duration,
      status: 'queued',
      progress: 0,
      selected: true,
      estimatedSizeMB: estimateFileSizeMB(duration, rate),
    };
    setQueue((prev) => [newTrack, ...prev]);
    return newTrack;
  }

  async function handleResolveUrls(urlsToResolve: string[]) {
    if (urlsToResolve.length === 0) {
      setResolveError('Paste a valid YouTube video URL or enter search keywords.');
      return;
    }

    setIsResolving(true);
    setResolveError(null);
    setSearchResults([]);

    try {
      const response = await fetch('/api/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: urlsToResolve }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to resolve YouTube links.');
      }

      const newTracks: QueueTrack[] = [];
      const errors: string[] = [];

      for (const item of data.results || []) {
        if (item.ok && item.data) {
          const duration = item.data.durationSeconds || 210;
          newTracks.push({
            id: `${item.data.videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            videoId: item.data.videoId,
            url: item.data.url,
            title: item.data.title,
            author: item.data.author,
            thumbnailUrl: item.data.thumbnailUrl,
            durationSeconds: duration,
            bitrate: defaultBitrate,
            normalize: defaultNormalize,
            trimStart: 0,
            trimEnd: duration,
            status: 'queued',
            progress: 0,
            selected: true,
            estimatedSizeMB: estimateFileSizeMB(duration, defaultBitrate),
          });
        } else {
          errors.push(item.input || 'Invalid link');
        }
      }

      if (newTracks.length > 0) {
        setQueue((prev) => [...newTracks, ...prev]);
        if (inputMode === 'single') {
          setSingleUrl('');
        } else {
          setBatchUrlsText('');
        }
      }

      if (errors.length > 0) {
        setResolveError(
          `Added ${newTracks.length} video(s). Could not resolve ${errors.length} input(s): ${errors.slice(0, 2).join(', ')}`
        );
      }
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Network error while resolving links.');
    } finally {
      setIsResolving(false);
    }
  }

  async function handleKeywordSearch(query: string) {
    setIsSearching(true);
    setResolveError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Search failed');
      }
      setSearchResults(data.results || []);
      if ((data.results || []).length === 0) {
        setResolveError(`No YouTube videos found for "${query}".`);
      }
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Unable to search YouTube videos.');
    } finally {
      setIsSearching(false);
    }
  }

  function handleFormSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (inputMode === 'single') {
      const trimmed = singleUrl.trim();
      if (!trimmed) {
        setResolveError('Paste a YouTube video link or enter keywords to search.');
        return;
      }
      // If the user pasted multiple links into the single box, resolve all of them
      const multi = parseMultipleUrls(trimmed);
      if (multi.length > 1 || isYoutubeUrlOrId(trimmed)) {
        handleResolveUrls(multi.length > 0 ? multi : [trimmed]);
      } else {
        // Keyword search (like vd6s.net)
        handleKeywordSearch(trimmed);
      }
    } else {
      handleResolveUrls(detectedBatchUrls);
    }
  }

  function handleSingleInputPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const pasted = e.clipboardData.getData('text').trim();
    if (pasted && isYoutubeUrlOrId(pasted)) {
      // Automatically resolve pasted YouTube URLs immediately (like vd6s.net)
      setTimeout(() => {
        const urls = parseMultipleUrls(pasted);
        if (urls.length > 0) {
          handleResolveUrls(urls);
        }
      }, 60);
    }
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const content = String(reader.result || '');
      setInputMode('batch');
      setBatchUrlsText((prev) => (prev ? `${prev}\n${content}` : content));
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function buildDownloadUrl(track: QueueTrack): string {
    const params = new URLSearchParams({
      videoId: track.videoId,
      title: track.title,
      artist: track.author,
      bitrate: String(track.bitrate),
      duration: String(track.durationSeconds || 0),
      normalize: String(track.normalize),
    });
    if (track.trimStart > 0) {
      params.set('trimStart', String(track.trimStart));
    }
    if (track.trimEnd > 0 && track.trimEnd < track.durationSeconds) {
      params.set('trimEnd', String(track.trimEnd));
    }
    return `/api/download?${params.toString()}`;
  }

  async function downloadSingleTrack(track: QueueTrack, showModal = false) {
    const updatedConverting: QueueTrack = {
      ...track,
      status: 'converting',
      progress: 45,
      errorMessage: undefined,
    };

    if (showModal) {
      setActiveModalTrack(updatedConverting);
    }

    setQueue((prev) => prev.map((t) => (t.id === track.id ? updatedConverting : t)));

    try {
      const prepRes = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: track.videoId,
          bitrate: track.bitrate,
          durationSeconds: track.durationSeconds,
        }),
      });

      if (!prepRes.ok) {
        const errData = await prepRes.json().catch(() => ({}));
        throw new Error(errData.error || 'MP3 conversion failed');
      }

      setQueue((prev) => prev.map((t) => (t.id === track.id ? { ...t, progress: 92 } : t)));
      if (showModal) {
        setActiveModalTrack((prev) => (prev ? { ...prev, progress: 92 } : null));
      }

      const downloadUrl = buildDownloadUrl(track);
      const safeName = `${track.author} - ${track.title}`
        .replace(/[<>:"/\\|?*\x00-\x1F#]/g, '')
        .trim()
        .slice(0, 100);

      // Trigger native browser download stream immediately (supports 50MB-200MB+ long videos without RAM buffering)
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${safeName || track.videoId}.mp3`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);

      const nowIso = new Date().toISOString();
      const completedTrack: QueueTrack = {
        ...track,
        status: 'completed',
        progress: 100,
        completedAt: nowIso,
      };

      setQueue((prev) => prev.map((t) => (t.id === track.id ? completedTrack : t)));
      if (showModal) {
        setActiveModalTrack(completedTrack);
      }

      setHistory((prev) => [
        {
          id: `${track.videoId}-${Date.now()}`,
          videoId: track.videoId,
          title: track.title,
          author: track.author,
          url: track.url,
          bitrate: track.bitrate,
          durationSeconds: track.durationSeconds,
          downloadedAt: nowIso,
        },
        ...prev,
      ]);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : 'Download error';
      const erroredTrack: QueueTrack = {
        ...track,
        status: 'error',
        progress: 0,
        errorMessage: errMsg,
      };
      setQueue((prev) => prev.map((t) => (t.id === track.id ? erroredTrack : t)));
      if (showModal) {
        setActiveModalTrack(erroredTrack);
      }
    }
  }

  async function handleBatchDownloadIndividual() {
    const selectedTracks = queue.filter((t) => t.selected);
    if (selectedTracks.length === 0) return;

    setIsBatchProcessing(true);
    try {
      for (const track of selectedTracks) {
        await downloadSingleTrack(track, false);
      }
    } finally {
      setIsBatchProcessing(false);
    }
  }

  async function handleBatchExportZip() {
    const targetTracks = queue.filter((t) => t.selected);
    if (targetTracks.length === 0) return;

    setIsZipping(true);
    setQueue((prev) =>
      prev.map((t) => (t.selected ? { ...t, status: 'converting', progress: 50 } : t))
    );

    try {
      const response = await fetch('/api/batch-zip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: targetTracks.map((t) => ({
            videoId: t.videoId,
            title: t.title,
            artist: t.author,
            bitrate: t.bitrate,
            normalize: t.normalize,
            durationSeconds: t.durationSeconds,
            trimStart: t.trimStart > 0 ? t.trimStart : undefined,
            trimEnd: t.trimEnd < t.durationSeconds ? t.trimEnd : undefined,
          })),
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Batch ZIP archive failed');
      }

      const zipBlob = await response.blob();
      const blobUrl = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `PulseDeck-MP3-Batch-${targetTracks.length}-Tracks.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);

      const nowIso = new Date().toISOString();
      setQueue((prev) =>
        prev.map((t) =>
          t.selected ? { ...t, status: 'completed', progress: 100, completedAt: nowIso } : t
        )
      );

      const newHistoryEntries: HistoryEntry[] = targetTracks.map((t) => ({
        id: `${t.videoId}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        videoId: t.videoId,
        title: t.title,
        author: t.author,
        url: t.url,
        bitrate: t.bitrate,
        durationSeconds: t.durationSeconds,
        downloadedAt: nowIso,
      }));
      setHistory((prev) => [...newHistoryEntries, ...prev]);
    } catch (err) {
      setQueue((prev) =>
        prev.map((t) =>
          t.selected
            ? {
                ...t,
                status: 'error',
                progress: 0,
                errorMessage: err instanceof Error ? err.message : 'Batch ZIP error',
              }
            : t
        )
      );
    } finally {
      setIsZipping(false);
    }
  }

  function applyGlobalBitrateToQueue(bitrate: BitrateOption) {
    setDefaultBitrate(bitrate);
    setQueue((prev) =>
      prev.map((t) => ({
        ...t,
        bitrate,
        estimatedSizeMB: estimateFileSizeMB(t.trimEnd - t.trimStart || t.durationSeconds, bitrate),
      }))
    );
  }

  function toggleAllSelection() {
    const allSelected = filteredQueue.length > 0 && filteredQueue.every((t) => t.selected);
    const filteredIds = new Set(filteredQueue.map((t) => t.id));
    setQueue((prev) =>
      prev.map((t) => (filteredIds.has(t.id) ? { ...t, selected: !allSelected } : t))
    );
  }

  function openEditModal(track: QueueTrack) {
    setEditingTrackId(track.id);
    setEditTitle(track.title);
    setEditArtist(track.author);
    setEditBitrate(track.bitrate);
    setEditNormalize(track.normalize);
    setEditTrimStart(track.trimStart);
    setEditTrimEnd(track.trimEnd);
  }

  function saveEditModal(e: React.FormEvent) {
    e.preventDefault();
    if (!editingTrackId) return;
    setQueue((prev) =>
      prev.map((t) => {
        if (t.id !== editingTrackId) return t;
        const clampedStart = Math.max(0, Math.min(editTrimStart, t.durationSeconds - 2));
        const clampedEnd = Math.max(clampedStart + 2, Math.min(editTrimEnd, t.durationSeconds));
        return {
          ...t,
          title: editTitle.trim() || t.title,
          author: editArtist.trim() || t.author,
          bitrate: editBitrate,
          normalize: editNormalize,
          trimStart: clampedStart,
          trimEnd: clampedEnd,
          estimatedSizeMB: estimateFileSizeMB(clampedEnd - clampedStart, editBitrate),
        };
      })
    );
    setEditingTrackId(null);
  }

  function togglePreviewTrack(track: QueueTrack) {
    if (previewTrack?.id === track.id) {
      if (audioRef.current) {
        if (isPlayingPreview) {
          audioRef.current.pause();
          setIsPlayingPreview(false);
        } else {
          audioRef.current.play().catch(() => setIsPlayingPreview(false));
          setIsPlayingPreview(true);
        }
      }
      return;
    }
    setPreviewTrack(track);
    setIsPlayingPreview(true);
  }

  useEffect(() => {
    if (previewTrack && audioRef.current) {
      audioRef.current.src = buildDownloadUrl(previewTrack);
      audioRef.current
        .play()
        .then(() => setIsPlayingPreview(true))
        .catch(() => setIsPlayingPreview(false));
    }
  }, [previewTrack]);

  const filteredQueue = useMemo(() => {
    return queue.filter((track) => {
      if (statusFilter !== 'all' && track.status !== statusFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          track.title.toLowerCase().includes(q) ||
          track.author.toLowerCase().includes(q) ||
          track.videoId.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [queue, statusFilter, searchQuery]);

  const selectedCount = useMemo(() => queue.filter((t) => t.selected).length, [queue]);
  const totalSelectedSizeMB = useMemo(
    () =>
      queue
        .filter((t) => t.selected)
        .reduce((sum, t) => sum + t.estimatedSizeMB, 0)
        .toFixed(1),
    [queue]
  );

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="sticky top-0 z-30 bg-[#0B0F17]/95 backdrop-blur border-b border-slate-800/80">
        <div className="max-w-[1320px] mx-auto flex items-center justify-between gap-8 px-6 py-4">
          {/* Zone 1: Single text element wordmark */}
          <a
            href="#extractor"
            className="text-lg font-bold tracking-tight text-white font-display whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-orange-500"
          >
            PulseDeck MP3
          </a>

          {/* Zone 2: 4 concise single-line text navigation links */}
          <nav className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400">
            <a
              href="#extractor"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              YouTube to MP3
            </a>
            <a
              href="#batch-queue"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Batch Queue
            </a>
            <a
              href="#studio-presets"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              Bitrate Presets
            </a>
            <a
              href="#download-history"
              className="hover:text-white transition-colors whitespace-nowrap shrink-0"
            >
              History
            </a>
          </nav>

          {/* Zone 3: 1 primary action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={handleBatchExportZip}
              disabled={selectedCount === 0 || isZipping}
              className="px-4 py-2 text-xs font-semibold text-slate-950 bg-orange-500 rounded-lg hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {isZipping ? 'Archiving Batch ZIP...' : `Export Batch ZIP (${selectedCount})`}
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-[1320px] w-full mx-auto px-6 py-10 space-y-12">
        {/* Section 1: 2-Column Hero & Multi-Link Extractor Workspace */}
        <section id="extractor" className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
          {/* Left Column: URL / Keyword Input & Multi-Video Batch Console */}
          <div className="lg:col-span-7 bg-[#111827] border border-slate-800 rounded-xl p-6 md:p-8 flex flex-col justify-between">
            <div className="space-y-6">
              <div className="space-y-2">
                <p className="text-xs font-medium text-orange-400 tracking-wide">
                  Full-Length 320kbps & 128kbps YouTube Audio Extractor
                </p>
                <h1
                  className="text-2xl md:text-4xl font-bold tracking-tight text-white font-display"
                  style={{ textWrap: 'balance' }}
                >
                  YouTube to MP3 Converter & Multi-Video Downloader
                </h1>
                <p className="text-sm text-slate-400 leading-relaxed max-w-2xl">
                  Paste a YouTube link, search by song or artist keywords, or switch to Batch Mode
                  to convert multiple YouTube videos at once in full-length 128kbps to 320kbps MP3.
                </p>
              </div>

              {/* Interactive Mode Selector & Sample Batch Loader */}
              <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => setInputMode('single')}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      inputMode === 'single'
                        ? 'bg-slate-800 text-white shadow-xs'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Single Link or Keyword Search
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputMode('batch');
                      setSearchResults([]);
                    }}
                    className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      inputMode === 'batch'
                        ? 'bg-slate-800 text-white shadow-xs'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Multiple Videos (Batch Mode)
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".txt,.csv"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Upload className="w-3.5 h-3.5 text-slate-400" />
                    Import .TXT List
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputMode('batch');
                      setSearchResults([]);
                      setBatchUrlsText(SAMPLE_BATCH_LINKS.join('\n'));
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-orange-300 bg-orange-500/10 hover:bg-orange-500/20 border border-orange-500/20 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Load 4 Sample URLs
                  </button>
                </div>
              </div>

              {/* Input Form */}
              <form onSubmit={handleFormSubmit} className="space-y-4">
                {inputMode === 'single' ? (
                  <div className="space-y-2">
                    <label
                      htmlFor="single-youtube-url"
                      className="block text-xs font-medium text-slate-300"
                    >
                      Search Keywords or Paste YouTube Video Link
                    </label>
                    <div className="flex flex-col sm:flex-row gap-3">
                      <div className="relative flex-1">
                        <input
                          id="single-youtube-url"
                          type="text"
                          value={singleUrl}
                          onChange={(e) => setSingleUrl(e.target.value)}
                          onPaste={handleSingleInputPaste}
                          placeholder="Search keywords or paste video link here (e.g. https://youtu.be/...)"
                          className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-4 pr-9 py-3 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:border-orange-500"
                        />
                        {singleUrl && (
                          <button
                            type="button"
                            onClick={() => {
                              setSingleUrl('');
                              setSearchResults([]);
                            }}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white cursor-pointer"
                            aria-label="Clear input"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                      <button
                        type="submit"
                        disabled={isResolving || isSearching}
                        className="inline-flex items-center justify-center gap-2 px-5 py-3 text-sm font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {isResolving || isSearching ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <ArrowRight className="w-4 h-4" />
                        )}
                        {isResolving
                          ? 'Analyzing Video...'
                          : isSearching
                          ? 'Searching...'
                          : 'Convert / Search'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <label htmlFor="batch-youtube-urls" className="font-medium text-slate-300">
                        Paste Multiple YouTube Links (one per line or comma-separated)
                      </label>
                      <span className="text-slate-400 font-mono tabular-nums">
                        {detectedBatchUrls.length} item{detectedBatchUrls.length === 1 ? '' : 's'}{' '}
                        detected
                      </span>
                    </div>
                    <textarea
                      id="batch-youtube-urls"
                      rows={5}
                      value={batchUrlsText}
                      onChange={(e) => setBatchUrlsText(e.target.value)}
                      placeholder={`https://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://www.youtube.com/watch?v=fJ9rUzIMcZQ\nhttps://youtu.be/09R8_2nJtjg`}
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg p-3.5 text-xs md:text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-orange-500 font-mono leading-relaxed resize-y"
                    />
                    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                      <p className="text-xs text-slate-400">
                        Supports watch links, shortened <span className="font-mono">youtu.be</span>{' '}
                        links, YouTube Shorts, or song titles on each line.
                      </p>
                      <div className="flex items-center gap-2">
                        {batchUrlsText && (
                          <button
                            type="button"
                            onClick={() => setBatchUrlsText('')}
                            className="px-3 py-2 text-xs font-medium text-slate-400 hover:text-white transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Clear Input
                          </button>
                        )}
                        <button
                          type="submit"
                          disabled={isResolving}
                          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 disabled:opacity-50 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          {isResolving ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <Plus className="w-4 h-4" />
                          )}
                          {isResolving
                            ? 'Analyzing Batch...'
                            : `Queue ${detectedBatchUrls.length > 0 ? detectedBatchUrls.length : ''} Video${detectedBatchUrls.length === 1 ? '' : 's'}`}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {resolveError && (
                  <div className="flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-lg px-3.5 py-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span>{resolveError}</span>
                  </div>
                )}
              </form>

              {/* Keyword Search Results Panel (like vd6s.net search results) */}
              {searchResults.length > 0 && (
                <div className="space-y-2.5 pt-2 border-t border-slate-800">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-200">
                      YouTube Search Results ({searchResults.length})
                    </span>
                    <button
                      type="button"
                      onClick={() => setSearchResults([])}
                      className="text-slate-400 hover:text-white cursor-pointer"
                    >
                      Close Results
                    </button>
                  </div>
                  <div className="divide-y divide-slate-800/70 max-h-72 overflow-y-auto pr-1">
                    {searchResults.map((item) => (
                      <div
                        key={item.videoId}
                        className="py-2.5 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <TrackThumbnail
                            src={item.thumbnailUrl}
                            title={item.title}
                            videoId={item.videoId}
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-semibold text-white truncate">
                              {item.title}
                            </div>
                            <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-0.5">
                              <span className="truncate">{item.author}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums">
                                {formatDuration(item.durationSeconds)}
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => {
                              addVideoMetaToQueue(item, defaultBitrate);
                            }}
                            className="px-2.5 py-1.5 text-xs font-medium text-slate-200 bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            + Queue
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              const added = addVideoMetaToQueue(item, 320);
                              downloadSingleTrack(added, true);
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            <Download className="w-3.5 h-3.5" />
                            <span>320k MP3</span>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Quiet Unboxed Footer Metadata inside Left Panel */}
            <div className="pt-6 mt-6 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
              <div className="flex flex-wrap items-center gap-2">
                <span>Full-Length Audio Extraction</span>
                <span aria-hidden="true">·</span>
                <span>128kbps & 320kbps MP3</span>
                <span aria-hidden="true">·</span>
                <span>Multi-Video Batch ZIP</span>
              </div>
              <span className="font-mono tabular-nums text-slate-300">
                Active Quality: {defaultBitrate} kbps
              </span>
            </div>
          </div>

          {/* Right Column: Studio Mastering & Batch Presets Card */}
          <div
            id="studio-presets"
            className="lg:col-span-5 bg-[#111827] border border-slate-800 rounded-xl p-6 md:p-8 flex flex-col justify-between"
          >
            <div className="space-y-6">
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-slate-400">Global Conversion Profile</p>
                <h2 className="text-xl font-bold text-white font-display">
                  MP3 Bitrate & Batch Controls
                </h2>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Select 320kbps for maximum fidelity or 128kbps for smaller file sizes and longer
                  mixes. Changes apply to all selected tracks in your queue.
                </p>
              </div>

              {/* Bitrate Selector */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-slate-300">Target MP3 Bitrate</span>
                  <span className="font-mono tabular-nums text-orange-400">
                    {defaultBitrate} kbps · Stereo MP3
                  </span>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {([320, 256, 192, 128] as BitrateOption[]).map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      onClick={() => applyGlobalBitrateToQueue(rate)}
                      className={`py-2.5 px-3 rounded-lg border text-center transition-colors cursor-pointer ${
                        defaultBitrate === rate
                          ? 'bg-orange-500/15 border-orange-500 text-white font-semibold'
                          : 'bg-slate-950 border-slate-800 text-slate-400 hover:text-slate-200 hover:border-slate-700'
                      }`}
                    >
                      <div className="text-xs font-mono tabular-nums whitespace-nowrap">
                        {rate} kbps
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5 whitespace-nowrap">
                        {rate === 320
                          ? 'Best'
                          : rate === 256
                          ? 'High'
                          : rate === 192
                          ? 'Standard'
                          : 'Fast'}
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Loudness Normalization Toggle */}
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium text-slate-200">
                    Dynamic Loudness Normalization
                  </div>
                  <p className="text-xs text-slate-400">
                    Keep disabled for fastest direct stream extraction, or enable to balance volume.
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={defaultNormalize}
                  onClick={() => {
                    const next = !defaultNormalize;
                    setDefaultNormalize(next);
                    setQueue((prev) => prev.map((t) => ({ ...t, normalize: next })));
                  }}
                  className={`px-3.5 py-1.5 rounded-lg text-xs font-mono font-medium border transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    defaultNormalize
                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                      : 'bg-slate-950 border-slate-800 text-slate-400'
                  }`}
                >
                  {defaultNormalize ? 'Enabled' : 'Direct Stream (Fast)'}
                </button>
              </div>

              {/* Live Queue Telemetry Summary */}
              <div className="pt-4 border-t border-slate-800/80 grid grid-cols-3 gap-4">
                <div>
                  <div className="text-xs text-slate-400">Queued Videos</div>
                  <div className="text-xl font-bold text-white font-mono tabular-nums mt-0.5">
                    {queue.length}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">Selected Batch</div>
                  <div className="text-xl font-bold text-orange-400 font-mono tabular-nums mt-0.5">
                    {selectedCount}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-slate-400">Est. Batch Size</div>
                  <div className="text-xl font-bold text-white font-mono tabular-nums mt-0.5">
                    {totalSelectedSizeMB} MB
                  </div>
                </div>
              </div>
            </div>

            {/* Primary Batch Action Controls inside Right Card */}
            <div className="pt-6 mt-6 border-t border-slate-800/80 flex flex-col sm:flex-row gap-3">
              <button
                type="button"
                onClick={handleBatchDownloadIndividual}
                disabled={selectedCount === 0 || isBatchProcessing}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:pointer-events-none border border-slate-700 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isBatchProcessing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                {isBatchProcessing
                  ? 'Downloading MP3s...'
                  : `Download ${selectedCount} MP3${selectedCount === 1 ? '' : 's'}`}
              </button>
              <button
                type="button"
                onClick={handleBatchExportZip}
                disabled={selectedCount === 0 || isZipping}
                className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 disabled:pointer-events-none rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                {isZipping ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <FolderArchive className="w-4 h-4" />
                )}
                {isZipping ? 'Building ZIP...' : `Download All as .ZIP (${selectedCount})`}
              </button>
            </div>
          </div>
        </section>

        {/* Live Audio Preview Bar (when a track is auditioned) */}
        {previewTrack && (
          <section
            aria-label="Audio Preview Player"
            className="bg-[#111827] border border-orange-500/40 rounded-xl p-4 flex flex-col sm:flex-row items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3.5 min-w-0">
              <button
                type="button"
                onClick={() => togglePreviewTrack(previewTrack)}
                className="w-10 h-10 rounded-lg bg-orange-500 text-slate-950 flex items-center justify-center hover:bg-orange-400 transition-colors shrink-0 cursor-pointer"
                aria-label={isPlayingPreview ? 'Pause preview' : 'Play preview'}
              >
                {isPlayingPreview ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs text-orange-400">
                  <Volume2 className="w-3.5 h-3.5 shrink-0" />
                  <span>Full-Length MP3 Stream Preview</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">{previewTrack.bitrate} kbps</span>
                </div>
                <div className="text-sm font-semibold text-white truncate">
                  {previewTrack.title}
                </div>
                <div className="text-xs text-slate-400 truncate">{previewTrack.author}</div>
              </div>
            </div>

            <div className="flex items-center gap-4 w-full sm:w-auto">
              <audio
                ref={audioRef}
                controls
                onPlay={() => setIsPlayingPreview(true)}
                onPause={() => setIsPlayingPreview(false)}
                onEnded={() => setIsPlayingPreview(false)}
                className="h-9 flex-1 sm:w-72"
              />
              <button
                type="button"
                onClick={() => {
                  if (audioRef.current) audioRef.current.pause();
                  setPreviewTrack(null);
                  setIsPlayingPreview(false);
                }}
                className="p-2 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
                aria-label="Close audio preview"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </section>
        )}

        {/* Section 2: High-Density Multi-Video Batch Queue Table */}
        <section id="batch-queue" className="space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-white font-display">
                YouTube to MP3 Conversion Queue
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Click <span className="text-white font-medium">Download MP3</span> on any video for
                instant full-length audio, or select multiple videos to download in bulk.
              </p>
            </div>

            {/* Filter Tabs & Search Bar */}
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1 p-1 bg-[#111827] border border-slate-800 rounded-lg">
                {(
                  [
                    { id: 'all', label: `All (${queue.length})` },
                    {
                      id: 'queued',
                      label: `Queued (${queue.filter((t) => t.status === 'queued').length})`,
                    },
                    {
                      id: 'completed',
                      label: `Completed (${queue.filter((t) => t.status === 'completed').length})`,
                    },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      statusFilter === tab.id
                        ? 'bg-slate-800 text-white'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter queue..."
                  aria-label="Filter queue tracks"
                  className="bg-[#111827] border border-slate-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-slate-500 focus:outline-none focus:border-orange-500 w-44 md:w-56"
                />
              </div>

              {queue.length > 0 && (
                <button
                  type="button"
                  onClick={() => setQueue([])}
                  className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-rose-400 bg-[#111827] border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Clear All
                </button>
              )}
            </div>
          </div>

          {/* Queue Data Grid */}
          <div className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
            {filteredQueue.length === 0 ? (
              <div className="py-16 px-6 text-center space-y-4">
                <div className="w-12 h-12 rounded-xl bg-slate-900 border border-slate-800 flex items-center justify-center mx-auto text-slate-400">
                  <Music className="w-6 h-6" />
                </div>
                <div className="space-y-1 max-w-md mx-auto">
                  <h3 className="text-base font-semibold text-white">
                    No YouTube videos in the active queue
                  </h3>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    Paste one or more YouTube URLs above, search by song title, or load our sample
                    batch to convert and download full-length MP3 files.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleResolveUrls(SAMPLE_BATCH_LINKS)}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  Load 4 Sample YouTube Tracks
                </button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-slate-800 text-[11px] font-semibold text-slate-400 bg-slate-900/50">
                      <th className="py-3 pl-4 pr-2 w-10">
                        <button
                          type="button"
                          onClick={toggleAllSelection}
                          className="text-slate-400 hover:text-white flex items-center cursor-pointer"
                          aria-label="Toggle select all tracks"
                        >
                          {filteredQueue.every((t) => t.selected) ? (
                            <CheckSquare className="w-4 h-4 text-orange-500" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </th>
                      <th className="py-3 px-3">Video & Channel</th>
                      <th className="py-3 px-3">MP3 Quality</th>
                      <th className="py-3 px-3 text-right">Duration</th>
                      <th className="py-3 px-3 text-right">Est. Size</th>
                      <th className="py-3 px-3">Status</th>
                      <th className="py-3 pl-3 pr-5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 text-sm">
                    {filteredQueue.map((track) => {
                      const isTrimmed =
                        track.trimStart > 0 || track.trimEnd < track.durationSeconds;
                      return (
                        <tr
                          key={track.id}
                          className={`hover:bg-slate-900/40 transition-colors ${
                            track.selected ? 'bg-slate-900/20' : ''
                          }`}
                        >
                          <td className="py-3 pl-4 pr-2 align-middle">
                            <button
                              type="button"
                              onClick={() =>
                                setQueue((prev) =>
                                  prev.map((t) =>
                                    t.id === track.id ? { ...t, selected: !t.selected } : t
                                  )
                                )
                              }
                              className="text-slate-400 hover:text-white flex items-center cursor-pointer"
                              aria-label={`Select ${track.title}`}
                            >
                              {track.selected ? (
                                <CheckSquare className="w-4 h-4 text-orange-500" />
                              ) : (
                                <Square className="w-4 h-4" />
                              )}
                            </button>
                          </td>

                          {/* Track & Channel */}
                          <td className="py-3 px-3 align-middle max-w-xs md:max-w-md">
                            <div className="flex items-center gap-3">
                              <TrackThumbnail
                                src={track.thumbnailUrl}
                                title={track.title}
                                videoId={track.videoId}
                              />
                              <div className="min-w-0">
                                <div className="font-medium text-white truncate">
                                  {track.title}
                                </div>
                                <div className="flex items-center gap-1.5 text-xs text-slate-400 mt-0.5 truncate">
                                  <span className="truncate">{track.author}</span>
                                  <span aria-hidden="true">·</span>
                                  <span className="font-mono text-[11px] text-slate-500">
                                    {track.videoId}
                                  </span>
                                </div>
                              </div>
                            </div>
                          </td>

                          {/* Per-Track Bitrate Selector */}
                          <td className="py-3 px-3 align-middle whitespace-nowrap">
                            <div className="flex items-center gap-2">
                              <select
                                aria-label={`Bitrate for ${track.title}`}
                                value={track.bitrate}
                                onChange={(e) => {
                                  const rate = Number(e.target.value) as BitrateOption;
                                  setQueue((prev) =>
                                    prev.map((t) =>
                                      t.id === track.id
                                        ? {
                                            ...t,
                                            bitrate: rate,
                                            estimatedSizeMB: estimateFileSizeMB(
                                              t.trimEnd - t.trimStart || t.durationSeconds,
                                              rate
                                            ),
                                          }
                                        : t
                                    )
                                  );
                                }}
                                className="bg-slate-950 border border-slate-800 rounded px-2 py-1 text-xs font-mono tabular-nums text-slate-200 focus:outline-none focus:border-orange-500 cursor-pointer"
                              >
                                <option value={320}>MP3 320kbps</option>
                                <option value={256}>MP3 256kbps</option>
                                <option value={192}>MP3 192kbps</option>
                                <option value={128}>MP3 128kbps</option>
                              </select>
                            </div>
                          </td>

                          {/* Duration / Trim */}
                          <td className="py-3 px-3 align-middle text-right font-mono tabular-nums text-xs whitespace-nowrap">
                            <div className="text-slate-200">
                              {formatDuration(track.trimEnd - track.trimStart)}
                            </div>
                            {isTrimmed && (
                              <div className="text-[11px] text-orange-400">
                                Trim: {formatDuration(track.trimStart)}–{formatDuration(track.trimEnd)}
                              </div>
                            )}
                          </td>

                          {/* Estimated File Size */}
                          <td className="py-3 px-3 align-middle text-right font-mono tabular-nums text-xs text-slate-300 whitespace-nowrap">
                            {track.estimatedSizeMB.toFixed(1)} MB
                          </td>

                          {/* Semantic Status */}
                          <td className="py-3 px-3 align-middle whitespace-nowrap">
                            {track.status === 'queued' && (
                              <span className="text-xs text-slate-400">Ready</span>
                            )}
                            {track.status === 'converting' && (
                              <div className="flex items-center gap-1.5 text-xs text-amber-400 font-mono tabular-nums">
                                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                                <span>Converting {track.progress}%</span>
                              </div>
                            )}
                            {track.status === 'completed' && (
                              <div className="flex items-center gap-1.5 text-xs text-emerald-400">
                                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                                <span>Downloaded</span>
                              </div>
                            )}
                            {track.status === 'error' && (
                              <div
                                className="flex items-center gap-1.5 text-xs text-rose-400"
                                title={track.errorMessage}
                              >
                                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                <span>Failed</span>
                              </div>
                            )}
                          </td>

                          {/* Row Actions */}
                          <td className="py-3 pl-3 pr-5 align-middle text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              <button
                                type="button"
                                onClick={() => togglePreviewTrack(track)}
                                className="p-2 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors cursor-pointer"
                                title="Preview Full Audio Stream"
                                aria-label={`Preview ${track.title}`}
                              >
                                {previewTrack?.id === track.id && isPlayingPreview ? (
                                  <Pause className="w-3.5 h-3.5 text-orange-400" />
                                ) : (
                                  <Play className="w-3.5 h-3.5" />
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => openEditModal(track)}
                                className="p-2 text-slate-400 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors cursor-pointer"
                                title="Trim Audio & Edit ID3 Tags"
                                aria-label={`Trim and edit tags for ${track.title}`}
                              >
                                <Sliders className="w-3.5 h-3.5" />
                              </button>

                              <button
                                type="button"
                                onClick={() => downloadSingleTrack(track, true)}
                                disabled={track.status === 'converting'}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 disabled:opacity-40 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                              >
                                <Download className="w-3.5 h-3.5" />
                                <span>Download MP3</span>
                              </button>

                              <button
                                type="button"
                                onClick={() =>
                                  setQueue((prev) => prev.filter((t) => t.id !== track.id))
                                }
                                className="p-2 text-slate-500 hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
                                title="Remove from queue"
                                aria-label={`Remove ${track.title}`}
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>

        {/* Section 3: Completed MP3 Download History */}
        <section id="download-history" className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-bold text-white font-display">
                Recent MP3 Conversions
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Stored locally in your browser for instant re-queueing or direct MP3 download.
              </p>
            </div>
            {history.length > 0 && (
              <button
                type="button"
                onClick={() => setHistory([])}
                className="px-3 py-1.5 text-xs font-medium text-slate-400 hover:text-white bg-[#111827] border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                Clear History
              </button>
            )}
          </div>

          <div className="bg-[#111827] border border-slate-800 rounded-xl overflow-hidden">
            {history.length === 0 ? (
              <div className="p-8 text-center text-xs text-slate-400">
                No completed downloads yet. Click{' '}
                <span className="text-white font-medium">Download MP3</span> on any video above or{' '}
                <span className="text-white font-medium">Download All as .ZIP</span> to save your
                first batch.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {history.slice(0, 10).map((item) => (
                  <div
                    key={item.id}
                    className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-900/30 transition-colors"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white truncate">{item.title}</div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400 mt-0.5">
                        <span>{item.author}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">{item.bitrate} kbps MP3</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {formatDuration(item.durationSeconds)}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {new Date(item.downloadedAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs text-slate-400 hover:text-white bg-slate-900 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                        <span>Source</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => handleResolveUrls([item.url])}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-800 rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Re-Queue</span>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </main>

      {/* Conversion Progress & Complete Modal (inspired by vd6s.net) */}
      {activeModalTrack && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-[#111827] border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-slate-800 pb-4">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-white font-display truncate">
                  {activeModalTrack.title}
                </h3>
                <p className="text-xs text-slate-400 mt-0.5 truncate">
                  {activeModalTrack.author} · MP3 {activeModalTrack.bitrate}kbps ·{' '}
                  {formatDuration(activeModalTrack.durationSeconds)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setActiveModalTrack(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer shrink-0"
                aria-label="Close conversion modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {activeModalTrack.status === 'converting' && (
              <div className="space-y-4 py-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-slate-300 font-medium flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-orange-400" />
                    Converting full YouTube audio to {activeModalTrack.bitrate}kbps MP3...
                  </span>
                  <span className="font-mono tabular-nums text-orange-400">
                    {activeModalTrack.progress}%
                  </span>
                </div>
                <div className="w-full h-2 bg-slate-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-orange-500 transition-transform duration-200 origin-left"
                    style={{
                      transform: `scaleX(${Math.max(0.1, activeModalTrack.progress / 100)})`,
                    }}
                  />
                </div>
                <p className="text-xs text-slate-400 text-center">
                  Please wait a few seconds while the full-length audio stream is extracted.
                </p>
              </div>
            )}

            {activeModalTrack.status === 'completed' && (
              <div className="space-y-4 py-2 text-center">
                <div className="w-12 h-12 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto text-emerald-400">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-white">
                    MP3 File Ready & Downloaded!
                  </div>
                  <p className="text-xs text-slate-400">
                    Your browser has started downloading the {activeModalTrack.bitrate}kbps MP3
                    file. If it didn't start automatically, click the link below:
                  </p>
                </div>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <a
                    href={buildDownloadUrl(activeModalTrack)}
                    download
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors whitespace-nowrap shrink-0"
                  >
                    <Download className="w-4 h-4" />
                    Download MP3 Again
                  </a>
                  <button
                    type="button"
                    onClick={() => setActiveModalTrack(null)}
                    className="px-4 py-2.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    Convert Another
                  </button>
                </div>
              </div>
            )}

            {activeModalTrack.status === 'error' && (
              <div className="space-y-4 py-2 text-center">
                <div className="w-12 h-12 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center mx-auto text-rose-400">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-white">Conversion Error</div>
                  <p className="text-xs text-rose-300">
                    {activeModalTrack.errorMessage ||
                      'Could not convert this video right now. Please try again.'}
                  </p>
                </div>
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => downloadSingleTrack(activeModalTrack, true)}
                    className="px-4 py-2 text-xs font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 rounded-lg transition-colors cursor-pointer"
                  >
                    Retry Conversion
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveModalTrack(null)}
                    className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ID3 Tag & Audio Trim Editor Modal */}
      {editingTrackId && (
        <div
          className="fixed inset-0 z-50 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-modal-title"
        >
          <div className="bg-[#111827] border border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-4">
              <div>
                <h3 id="edit-modal-title" className="text-base font-bold text-white font-display">
                  Audio Trim & ID3v2 Metadata
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Customize embedded MP3 tags or cut start/end timestamps before downloading.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingTrackId(null)}
                className="p-1.5 text-slate-400 hover:text-white rounded-lg cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={saveEditModal} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="id3-title" className="block text-xs font-medium text-slate-300">
                  MP3 Track Title
                </label>
                <input
                  id="id3-title"
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
                />
              </div>

              <div className="space-y-1.5">
                <label htmlFor="id3-artist" className="block text-xs font-medium text-slate-300">
                  Artist / Channel Name
                </label>
                <input
                  id="id3-artist"
                  type="text"
                  value={editArtist}
                  onChange={(e) => setEditArtist(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-white focus:outline-none focus:border-orange-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <label htmlFor="trim-start" className="block text-xs font-medium text-slate-300">
                    Trim Start (seconds)
                  </label>
                  <input
                    id="trim-start"
                    type="number"
                    min={0}
                    value={editTrimStart}
                    onChange={(e) => setEditTrimStart(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-white font-mono tabular-nums focus:outline-none focus:border-orange-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="trim-end" className="block text-xs font-medium text-slate-300">
                    Trim End (seconds)
                  </label>
                  <input
                    id="trim-end"
                    type="number"
                    min={2}
                    value={editTrimEnd}
                    onChange={(e) => setEditTrimEnd(Number(e.target.value))}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3.5 py-2 text-sm text-white font-mono tabular-nums focus:outline-none focus:border-orange-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 pt-1">
                <div className="space-y-1.5">
                  <label
                    htmlFor="modal-bitrate"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Bitrate
                  </label>
                  <select
                    id="modal-bitrate"
                    value={editBitrate}
                    onChange={(e) => setEditBitrate(Number(e.target.value) as BitrateOption)}
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono tabular-nums focus:outline-none focus:border-orange-500"
                  >
                    <option value={320}>320 kbps (Best)</option>
                    <option value={256}>256 kbps (High)</option>
                    <option value={192}>192 kbps (Standard)</option>
                    <option value={128}>128 kbps (Fast)</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <span className="block text-xs font-medium text-slate-300">
                    Loudness Normalization
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditNormalize(!editNormalize)}
                    className={`w-full py-2 px-3 rounded-lg border text-xs font-mono font-medium transition-colors cursor-pointer ${
                      editNormalize
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-slate-950 border-slate-800 text-slate-400'
                    }`}
                  >
                    {editNormalize ? 'Active' : 'Direct Stream (Fast)'}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setEditingTrackId(null)}
                  className="px-4 py-2 text-xs font-medium text-slate-300 hover:text-white rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-xs font-semibold text-slate-950 bg-orange-500 hover:bg-orange-400 rounded-lg transition-colors cursor-pointer"
                >
                  Save Track Settings
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Clean Footer */}
      <footer className="border-t border-slate-800/80 py-6 px-6 text-xs text-slate-500">
        <div className="max-w-[1320px] mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>PulseDeck MP3 — YouTube to MP3 [320kbps / 128kbps] & Batch Downloader</div>
          <div className="flex items-center gap-4">
            <a href="#extractor" className="hover:text-slate-300 transition-colors">
              YouTube to MP3
            </a>
            <span aria-hidden="true">·</span>
            <a href="#batch-queue" className="hover:text-slate-300 transition-colors">
              Batch Queue
            </a>
            <span aria-hidden="true">·</span>
            <a href="#download-history" className="hover:text-slate-300 transition-colors">
              Download History
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
