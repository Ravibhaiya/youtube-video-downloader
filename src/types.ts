export type BitrateOption = 128 | 192 | 256 | 320;

export type QueueStatus = 'queued' | 'converting' | 'completed' | 'error';

export interface QueueTrack {
  id: string;
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  bitrate: BitrateOption;
  normalize: boolean;
  trimStart: number;
  trimEnd: number;
  status: QueueStatus;
  progress: number;
  selected: boolean;
  errorMessage?: string;
  completedAt?: string;
  estimatedSizeMB: number;
}

export interface HistoryEntry {
  id: string;
  videoId: string;
  title: string;
  author: string;
  url: string;
  bitrate: BitrateOption;
  durationSeconds: number;
  downloadedAt: string;
}
