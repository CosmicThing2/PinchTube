import type { Chapter } from './api';

/*
 * Chapters as stored can overlap: SponsorBlock segments sit on top of the
 * video's own chapters, and some files carry the same chapter list more than
 * once. Anything that draws a timeline needs each moment to belong to exactly
 * one chapter, which is what these helpers work out.
 */

/** The same chapter listed more than once is shown once. */
export function uniqueChapters(chapters: Chapter[]): Chapter[] {
  const seen = new Set<string>();
  return chapters.filter((chapter) => {
    const key = `${chapter.kind}|${chapter.start}|${chapter.end}|${chapter.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The chapter that owns a moment when several cover it: a SponsorBlock
 * segment over an ordinary chapter, otherwise whichever started most recently
 * (a chapter inside a longer one), and the first listed on a tie.
 */
export function chapterOwning(chapters: Chapter[], seconds: number): Chapter | null {
  let owner: Chapter | null = null;
  for (const chapter of chapters) {
    if (seconds < chapter.start || seconds >= chapter.end) continue;
    if (!owner) {
      owner = chapter;
      continue;
    }
    const sponsor = chapter.kind === 'sponsor';
    const ownerSponsor = owner.kind === 'sponsor';
    if ((sponsor && !ownerSponsor) || (sponsor === ownerSponsor && chapter.start > owner.start)) owner = chapter;
  }
  return owner;
}

/**
 * One non-overlapping run of pieces from 0 to `duration`, each taking its
 * title and kind from the chapter that owns it. Stretches no chapter covers
 * become untitled pieces, so the pieces always add up to the whole video.
 */
export function flattenChapters(chapters: Chapter[], duration: number): Chapter[] {
  const items = chapters
    .map((chapter) => ({ ...chapter, start: Math.max(0, chapter.start), end: Math.min(chapter.end, duration) }))
    .filter((chapter) => chapter.end > chapter.start);
  if (!items.length || !(duration > 0)) return [];

  const cuts = new Set<number>([0, duration]);
  for (const chapter of items) {
    cuts.add(chapter.start);
    cuts.add(chapter.end);
  }
  const points = Array.from(cuts).sort((a, b) => a - b);

  const pieces: Chapter[] = [];
  let lastOwner: Chapter | null | undefined;
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    const owner = chapterOwning(items, (start + end) / 2);
    const previous = pieces[pieces.length - 1];
    if (previous && owner === lastOwner) {
      previous.end = end;
    } else {
      pieces.push(owner ? { ...owner, start, end } : { start, end, title: '', kind: 'chapter' });
    }
    lastOwner = owner;
  }
  return pieces;
}
