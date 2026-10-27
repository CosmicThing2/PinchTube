import type { ReactNode } from 'react';

// One pass over the text, matching either a URL or a timestamp. Keeping them in
// a single alternation means a URL is consumed whole, so the "12:34" inside
// something like http://host:8080/12:34 can never be mistaken for a cue.
// Trailing punctuation is left out of URLs so a full stop at the end of a
// sentence is not swallowed.
const TOKEN_PATTERN =
  /((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,!?;:)\]}])|(\b\d{1,2}:\d{2}(?::\d{2})?\b)/gi;

export interface LinkifyOptions {
  /** Runtime in seconds; timestamps beyond it are left as plain text. */
  duration?: number | null;
  onSeek?: (seconds: number) => void;
}

/**
 * Converts "1:23" or "1:02:03" into seconds, rejecting anything that is not a
 * real time — 34:87 has 87 seconds, so it is prose, not a cue.
 */
export function parseTimestamp(raw: string): number | null {
  const parts = raw.split(':').map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0)) return null;

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (parts.length === 2) {
    [minutes, seconds] = parts;
  } else if (parts.length === 3) {
    [hours, minutes, seconds] = parts;
    if (minutes > 59) return null;
  } else {
    return null;
  }

  if (seconds > 59) return null;

  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * Turns bare URLs and timestamps in plain text into links. Everything is
 * rendered as React nodes rather than HTML, so nothing in a description can
 * inject markup.
 */
export function linkify(text: string, options: LinkifyOptions = {}): ReactNode[] {
  const { duration, onSeek } = options;
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TOKEN_PATTERN.lastIndex = 0;

  while ((match = TOKEN_PATTERN.exec(text)) !== null) {
    const [raw, url, stamp] = match;
    const start = match.index;

    const push = (node: ReactNode) => {
      if (start > lastIndex) nodes.push(text.slice(lastIndex, start));
      nodes.push(node);
      lastIndex = start + raw.length;
    };

    if (url) {
      const href = url.toLowerCase().startsWith('www.') ? `https://${url}` : url;
      push(
        <a
          key={`${start}-link`}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="desc-link"
        >
          {url}
        </a>,
      );
      continue;
    }

    if (!stamp || !onSeek) continue;

    const seconds = parseTimestamp(stamp);
    // Past the end of the video it is almost certainly not a cue at all.
    if (seconds === null) continue;
    if (duration != null && duration > 0 && seconds > duration) continue;

    push(
      <button
        key={`${start}-time`}
        type="button"
        className="desc-timestamp"
        onClick={() => onSeek(seconds)}
      >
        {stamp}
      </button>,
    );
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}
