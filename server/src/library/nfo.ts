import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

// parseTagValue:false keeps everything a string — otherwise a title like "2026"
// would silently become a number.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
});

function first(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return first(value[0]);
  if (typeof value === 'object') {
    const text = (value as any)['#text'];
    return text === undefined ? null : String(text).trim() || null;
  }
  const s = String(value).trim();
  return s || null;
}

/**
 * Kodi-style dates arrive as "2026-07-10 00:00:00Z", "2026-07-10T00:00:00Z" or
 * plain "2026-07-10". Returns epoch milliseconds, or null.
 */
export function parseNfoDate(raw: string | null): number | null {
  if (!raw) return null;
  const value = raw.trim();
  if (!value) return null;

  let normalised = value.replace(' ', 'T');
  // A bare date has no timezone; treat it as UTC midnight so ordering is stable.
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalised)) normalised += 'T00:00:00Z';

  const ms = Date.parse(normalised);
  if (Number.isFinite(ms)) return ms;

  const fallback = Date.parse(value);
  return Number.isFinite(fallback) ? fallback : null;
}

export interface VideoNfo {
  title: string | null;
  plot: string | null;
  credits: string | null;
  aired: number | null;
  showTitle: string | null;
  youtubeId: string | null;
  season: string | null;
  episode: string | null;
}

export function readVideoNfo(file: string): VideoNfo | null {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  // Kodi-style video .nfo files use <episodedetails>, but be tolerant of other roots.
  const root =
    doc?.episodedetails ??
    doc?.movie ??
    doc?.musicvideo ??
    doc?.video ??
    (typeof doc === 'object' ? Object.values(doc).find((v) => typeof v === 'object') : null);
  if (!root || typeof root !== 'object') return null;

  const node = Array.isArray(root) ? root[0] : root;

  return {
    title: first(node.title),
    plot: first(node.plot) ?? first(node.outline),
    credits: first(node.credits) ?? first(node.director) ?? first(node.studio),
    aired: parseNfoDate(first(node.aired) ?? first(node.premiered) ?? first(node.dateadded)),
    showTitle: first(node.showtitle),
    youtubeId: first(node.uniqueid) ?? first(node.id),
    season: first(node.season),
    episode: first(node.episode),
  };
}

export interface ChannelNfo {
  title: string | null;
  plot: string | null;
  youtubeId: string | null;
}

export function readChannelNfo(file: string): ChannelNfo | null {
  let xml: string;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return null;
  }

  const root = doc?.tvshow ?? doc?.show ?? (typeof doc === 'object' ? Object.values(doc).find((v) => typeof v === 'object') : null);
  if (!root || typeof root !== 'object') return null;
  const node = Array.isArray(root) ? root[0] : root;

  return {
    title: first(node.title),
    plot: first(node.plot) ?? first(node.outline),
    youtubeId: first(node.uniqueid) ?? first(node.id),
  };
}
