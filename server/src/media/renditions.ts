export interface Rendition {
  id: string;
  label: string;
  height: number;
  /** Target video bitrate in kbit/s. */
  bitrate: number;
  maxrate: number;
  bufsize: number;
  audioBitrate: number;
}

/** Highest first — the order the quality menu shows them in. */
export const LADDER: Rendition[] = [
  { id: '2160p', label: '2160p', height: 2160, bitrate: 14000, maxrate: 18000, bufsize: 28000, audioBitrate: 192 },
  { id: '1440p', label: '1440p', height: 1440, bitrate: 8000, maxrate: 10000, bufsize: 16000, audioBitrate: 192 },
  { id: '1080p', label: '1080p', height: 1080, bitrate: 4800, maxrate: 6000, bufsize: 9600, audioBitrate: 160 },
  { id: '720p', label: '720p', height: 720, bitrate: 2600, maxrate: 3200, bufsize: 5200, audioBitrate: 128 },
  { id: '480p', label: '480p', height: 480, bitrate: 1200, maxrate: 1500, bufsize: 2400, audioBitrate: 128 },
  { id: '360p', label: '360p', height: 360, bitrate: 700, maxrate: 900, bufsize: 1400, audioBitrate: 96 },
];

/**
 * Audio with the video stream dropped entirely — a fraction of the data of even
 * the smallest video rung. Deliberately kept out of the adaptive ladder so that
 * a bandwidth dip can never silently drop the picture; it is only ever chosen
 * explicitly from the quality menu.
 */
export const AUDIO_RENDITION: Rendition = {
  id: 'audio',
  label: 'Audio only',
  height: 0,
  bitrate: 0,
  maxrate: 0,
  bufsize: 0,
  audioBitrate: 96,
};

export function isAudioOnly(rendition: Rendition): boolean {
  return rendition.id === AUDIO_RENDITION.id;
}

export const QUALITY_CHOICES = ['original', ...LADDER.map((r) => r.id), AUDIO_RENDITION.id];

export function findRendition(id: string): Rendition | undefined {
  if (id === AUDIO_RENDITION.id) return AUDIO_RENDITION;
  return LADDER.find((r) => r.id === id);
}

/**
 * The ladder rungs that make sense for a given source. Never upscales, always
 * offers at least one low rung so a slow phone connection has somewhere to go.
 */
export function renditionsFor(sourceHeight: number | null, maxQuality: string): Rendition[] {
  const height = sourceHeight && sourceHeight > 0 ? sourceHeight : 1080;

  const capRendition = maxQuality === 'original' ? undefined : findRendition(maxQuality);
  const cap = maxQuality === 'original' || !capRendition ? Infinity : capRendition.height;

  // Allow a rung slightly above the source (e.g. 1088px sources map onto 1080p).
  const usable = LADDER.filter((r) => r.height <= Math.max(height * 1.05, 240) && r.height <= cap);

  if (usable.length === 0) {
    const smallest = LADDER[LADDER.length - 1];
    return [cap === Infinity ? smallest : (LADDER.filter((r) => r.height <= cap).pop() ?? smallest)];
  }
  return usable;
}

/** Whether the untouched file should be offered as an "Original" option. */
export function allowOriginal(maxQuality: string): boolean {
  return maxQuality === 'original';
}

/** Even-numbered width preserving the source aspect ratio. */
export function scaledWidth(
  sourceWidth: number | null,
  sourceHeight: number | null,
  targetHeight: number,
): number | null {
  if (!sourceWidth || !sourceHeight) return null;
  const width = Math.round((sourceWidth * targetHeight) / sourceHeight / 2) * 2;
  return width > 0 ? width : null;
}
