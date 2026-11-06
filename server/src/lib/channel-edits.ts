/*
 * channel-edits.ts — an administrator's changes to a channel.
 *
 * A channel's name, description and artwork normally come from its folder in
 * the media folder (tvshow.nfo, poster.jpg and so on). Edits never touch those
 * files: the media folder is mounted read-only, and Pinchflat can rewrite them
 * whenever it refreshes a source. Instead they are kept here, in the database
 * and in a folder inside /config, and take priority over what is on disk.
 *
 * library/scanner.ts applies them whenever it records a channel, so everything
 * that reads the channels table sees the edited values without knowing about
 * this file. routes/channels.ts is the API for changing them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { paths } from '../config.js';

export type ChannelArtKind = 'poster' | 'banner' | 'fanart';

export const CHANNEL_ART_KINDS: ChannelArtKind[] = ['poster', 'banner', 'fanart'];

/** What has been edited; null means "use what is in the channel's folder". */
export interface ChannelEdit {
  title: string | null;
  plot: string | null;
}

/** Where an uploaded image for a channel is kept. Channel ids are hex, so this stays in the folder. */
function artFile(channelId: string, kind: ChannelArtKind): string {
  return path.join(paths.channelArt, `${channelId}-${kind}.jpg`);
}

/** A channel's edited title and description. */
export function channelEdit(channelId: string): ChannelEdit {
  const row = db.prepare('SELECT title, plot FROM channel_edits WHERE channel_id = ?').get(channelId) as
    | ChannelEdit
    | undefined;
  return row ?? { title: null, plot: null };
}

/** The uploaded image for a channel, if there is one. */
export function editedArt(channelId: string, kind: ChannelArtKind): string | null {
  const file = artFile(channelId, kind);
  return fs.existsSync(file) ? file : null;
}

/** Which parts of a channel have been edited, for the edit dialog's reset buttons. */
export function editSummary(channelId: string): Record<'title' | 'plot' | ChannelArtKind, boolean> {
  const edit = channelEdit(channelId);
  return {
    title: edit.title !== null,
    plot: edit.plot !== null,
    poster: editedArt(channelId, 'poster') !== null,
    banner: editedArt(channelId, 'banner') !== null,
    fanart: editedArt(channelId, 'fanart') !== null,
  };
}

/** Writes a channel's edit row; `artVersion` changes the address of its images so browsers refetch them. */
function saveRow(channelId: string, edit: ChannelEdit, artVersion?: number): void {
  db.prepare(
    `INSERT INTO channel_edits (channel_id, title, plot, art_version)
     VALUES (@channelId, @title, @plot, COALESCE(@artVersion, 0))
     ON CONFLICT(channel_id) DO UPDATE SET
       title = excluded.title,
       plot = excluded.plot,
       art_version = COALESCE(@artVersion, channel_edits.art_version)`,
  ).run({ channelId, title: edit.title, plot: edit.plot, artVersion: artVersion ?? null });
}

/** Changes the title and/or description; null puts one back to what is in the channel's folder. */
export function saveChannelText(channelId: string, changes: Partial<ChannelEdit>): void {
  saveRow(channelId, { ...channelEdit(channelId), ...changes });
}

/** The path an uploaded image should be written to. */
export function artTarget(channelId: string, kind: ChannelArtKind): string {
  return artFile(channelId, kind);
}

/** Records that a channel's images changed. */
export function touchChannelArt(channelId: string): void {
  saveRow(channelId, channelEdit(channelId), Date.now());
}

/** Removes an uploaded image, so the one in the channel's folder is used again. */
export function removeChannelArt(channelId: string, kind: ChannelArtKind): void {
  fs.rmSync(artFile(channelId, kind), { force: true });
  touchChannelArt(channelId);
}
