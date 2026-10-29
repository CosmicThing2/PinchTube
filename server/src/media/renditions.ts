export interface Rendition {
  id: string;
  label: string;
  /**
   * The shorter side of the picture, which is what the name means, as on
   * YouTube: the height of a landscape video, the width of a portrait one.
   */
  size: number;
  /** Target video bitrate in kbit/s. */
  bitrate: number;
  maxrate: number;
  bufsize: number;
  audioBitrate: number;
}

/** Highest first — the order the quality menu shows them in. */
export const LADDER: Rendition[] = [
  { id: '2160p', label: '2160p', size: 2160, bitrate: 14000, maxrate: 18000, bufsize: 28000, audioBitrate: 192 },
  { id: '1440p', label: '1440p', size: 1440, bitrate: 8000, maxrate: 10000, bufsize: 16000, audioBitrate: 192 },
  { id: '1080p', label: '1080p', size: 1080, bitrate: 4800, maxrate: 6000, bufsize: 9600, audioBitrate: 160 },
  { id: '720p', label: '720p', size: 720, bitrate: 2600, maxrate: 3200, bufsize: 5200, audioBitrate: 128 },
  { id: '480p', label: '480p', size: 480, bitrate: 1200, maxrate: 1500, bufsize: 2400, audioBitrate: 128 },
  { id: '360p', label: '360p', size: 360, bitrate: 700, maxrate: 900, bufsize: 1400, audioBitrate: 96 },
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
  size: 0,
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
 * The ladder rungs that make sense for a source whose shorter side is
 * `sourceSize`. Never upscales, always offers at least one low rung so a slow
 * phone connection has somewhere to go.
 */
export function renditionsFor(sourceSize: number | null, maxQuality: string): Rendition[] {
  const size = sourceSize && sourceSize > 0 ? sourceSize : 1080;

  const capRendition = maxQuality === 'original' ? undefined : findRendition(maxQuality);
  const cap = maxQuality === 'original' || !capRendition ? Infinity : capRendition.size;

  // Allow a rung slightly above the source (e.g. 1088px sources map onto 1080p).
  const usable = LADDER.filter((r) => r.size <= Math.max(size * 1.05, 240) && r.size <= cap);

  if (usable.length === 0) {
    const smallest = LADDER[LADDER.length - 1];
    return [cap === Infinity ? smallest : (LADDER.filter((r) => r.size <= cap).pop() ?? smallest)];
  }
  return usable;
}

/** Whether the untouched file should be offered as an "Original" option. */
export function allowOriginal(maxQuality: string): boolean {
  return maxQuality === 'original';
}

/** The shorter side of a video, which names its quality (1080×1920 is 1080p). */
export function shortSide(width: number | null, height: number | null): number | null {
  if (width && height) return Math.min(width, height);
  return height || null;
}

/**
 * The frame a rendition is encoded at: the shorter side becomes `size` and
 * the other keeps the aspect ratio, rounded to an even number as encoders
 * need. Without known dimensions only the height is fixed (width null).
 */
export function outputSize(
  sourceWidth: number | null,
  sourceHeight: number | null,
  size: number,
): { width: number | null; height: number } {
  if (!sourceWidth || !sourceHeight) return { width: null, height: size };
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  if (sourceHeight > sourceWidth) return { width: size, height: even((sourceHeight * size) / sourceWidth) };
  return { width: even((sourceWidth * size) / sourceHeight), height: size };
}
