import type { Rendition } from './renditions.js';
import { outputSize } from './renditions.js';

export function segmentCountFor(duration: number, segmentSeconds: number): number {
  return Math.max(1, Math.ceil(duration / segmentSeconds));
}

function codecString(size: number): string {
  // High profile; level 4.0 for 1080p and up, 3.1 below that.
  return size >= 1080 ? 'avc1.640028,mp4a.40.2' : 'avc1.64001f,mp4a.40.2';
}

export interface MasterVideo {
  width: number | null;
  height: number | null;
}

export function masterPlaylist(video: MasterVideo, renditions: Rendition[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS', ''];

  // Lowest first so a cold start on a phone does not open at 2160p.
  const ordered = [...renditions].sort((a, b) => a.size - b.size);

  for (const rendition of ordered) {
    const bandwidth = Math.round((rendition.bitrate + rendition.audioBitrate) * 1000);
    const peak = Math.round((rendition.maxrate + rendition.audioBitrate) * 1000);
    const frame = outputSize(video.width, video.height, rendition.size);
    const attrs = [
      `BANDWIDTH=${bandwidth}`,
      `AVERAGE-BANDWIDTH=${bandwidth}`,
      `CODECS="${codecString(rendition.size)}"`,
    ];
    if (frame.width) attrs.push(`RESOLUTION=${frame.width}x${frame.height}`);
    attrs.push(`NAME="${rendition.label}"`);
    void peak;
    lines.push(`#EXT-X-STREAM-INF:${attrs.join(',')}`);
    lines.push(`${rendition.id}/index.m3u8`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * A complete VOD playlist derived from the known duration. Segments are produced
 * lazily when the player asks for them, so this can be served instantly.
 */
export function variantPlaylist(duration: number, segmentSeconds: number): string {
  const count = segmentCountFor(duration, segmentSeconds);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${segmentSeconds}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];

  for (let i = 0; i < count; i++) {
    const remaining = duration - i * segmentSeconds;
    const length = Math.min(segmentSeconds, remaining);
    lines.push(`#EXTINF:${length.toFixed(3)},`);
    lines.push('seg-' + String(i).padStart(5, '0') + '.ts');
  }

  lines.push('#EXT-X-ENDLIST');
  lines.push('');
  return lines.join('\n');
}
