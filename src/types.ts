export type BitrateOption = 128 | 192 | 320;

export type TrackStatus = 'waiting' | 'converting' | 'done' | 'error';

export interface Track {
  id: string;
  videoId: string;
  url: string;
  title: string;
  author: string;
  thumbnailUrl: string;
  durationSeconds: number;
  status: TrackStatus;
  error?: string;
}
