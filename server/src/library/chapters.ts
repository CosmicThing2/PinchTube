export interface Chapter {
  start: number;
  end: number;
  title: string;
  /** SponsorBlock segments arrive as chapters too; they get a different tint. */
  kind: 'chapter' | 'sponsor';
}

const SPONSORBLOCK_PREFIX = /^\[SponsorBlock\]:\s*/i;
const MIN_CHAPTER_SECONDS = 1;

function finalise(raw: { start: number; title: string; kind: Chapter['kind'] }[], duration: number | null): Chapter[] {
  const sorted = raw
    .filter((c) => Number.isFinite(c.start) && c.start >= 0)
    .sort((a, b) => a.start - b.start);

  const out: Chapter[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i].start;
    const end = i + 1 < sorted.length ? sorted[i + 1].start : (duration ?? start);
    if (end - start < MIN_CHAPTER_SECONDS) continue;
    out.push({ start, end, title: sorted[i].title, kind: sorted[i].kind });
  }
  return out;
}

/** Chapters embedded in the container, as ffprobe's `-show_chapters` reports them. */
export function chaptersFromProbe(raw: unknown, duration: number | null): Chapter[] {
  if (!Array.isArray(raw)) return [];
  const entries = raw
    .map((entry: any) => {
      const start = Number(entry?.start_time);
      const end = Number(entry?.end_time);
      const rawTitle = String(entry?.tags?.title ?? '').trim();
      const sponsor = SPONSORBLOCK_PREFIX.test(rawTitle);
      const title = rawTitle.replace(SPONSORBLOCK_PREFIX, '') || `Chapter ${raw.indexOf(entry) + 1}`;
      return { start, end, title, kind: (sponsor ? 'sponsor' : 'chapter') as Chapter['kind'] };
    })
    .filter((c) => Number.isFinite(c.start));

  // Embedded chapters carry their own end times, which are more trustworthy
  // than inferring from the next start (SponsorBlock segments can overlap).
  return entries
    .sort((a, b) => a.start - b.start)
    .map((c) => ({
      ...c,
      end: Number.isFinite(c.end) && c.end > c.start ? c.end : (duration ?? c.start),
    }))
    .filter((c) => c.end - c.start >= MIN_CHAPTER_SECONDS);
}

// A timestamp anywhere on the line: "0:00 Intro", "Intro - 0:00", "[1:02:03] Outro".
const LINE_STAMP = /(?:^|[\s(\[])((?:\d{1,2}:)?\d{1,2}:\d{2})(?=$|[\s)\]])/;

function stampToSeconds(stamp: string): number | null {
  const parts = stamp.split(':').map(Number);
  if (parts.some((n) => !Number.isInteger(n))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/**
 * The same rule YouTube applies to a description: a list of timestamped lines
 * starting at 0:00, at least three of them. Used when nothing is embedded.
 */
export function chaptersFromDescription(text: string | null, duration: number | null): Chapter[] {
  if (!text) return [];

  const found: { start: number; title: string; kind: Chapter['kind'] }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LINE_STAMP.exec(line);
    if (!match) continue;
    const seconds = stampToSeconds(match[1]);
    if (seconds === null) continue;
    if (duration && seconds > duration) continue;

    const title = line
      .replace(match[1], ' ')
      .replace(/^[\s\-–—:|·•()\[\]]+|[\s\-–—:|·•()\[\]]+$/g, '')
      .trim();
    if (!title) continue;
    found.push({ start: seconds, title, kind: 'chapter' });
  }

  // Nothing at 0:00, or too few entries, and YouTube would not show chapters either.
  if (found.length < 3 || !found.some((c) => c.start === 0)) return [];

  // Keep one entry per start time (a description can repeat the list).
  const unique = new Map<number, (typeof found)[number]>();
  for (const entry of found) if (!unique.has(entry.start)) unique.set(entry.start, entry);

  return finalise(Array.from(unique.values()), duration);
}

/** Pulls an 11-character YouTube id out of a filename like "Title [dQw4w9WgXcQ].mp4". */
export function youtubeIdFromName(name: string): string | null {
  const match = /\[([A-Za-z0-9_-]{11})\]/.exec(name);
  return match ? match[1] : null;
}

export function isYoutubeId(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{11}$/.test(value);
}
