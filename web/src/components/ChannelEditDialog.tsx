/*
 * ChannelEditDialog.tsx — the pop-up behind a channel's Edit button, for
 * administrators.
 *
 * Changes the channel's name and description, and its icon, banner and fanart.
 * The icon can be an uploaded picture or one of the ready-made ones in
 * lib/channel-icons.ts. Pictures are saved as soon as they are chosen; the name
 * and description when "Save" is pressed. Every edit can be reset, which goes
 * back to what is in the channel's folder.
 *
 * Edits are kept in PinchTube's own storage and never written to the media
 * folder (server/src/routes/channels.ts), so Pinchflat cannot overwrite them.
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { api, urls, type ChannelDto, type ChannelEdits } from '../lib/api';
import { CHANNEL_ICONS, renderChannelIcon, type ChannelIcon } from '../lib/channel-icons';
import { Dialog } from './Common';

type ArtKind = 'poster' | 'banner' | 'fanart';

/** The largest picture the server accepts. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** The three pictures, in the order they are listed. */
const ART_ROWS: { kind: ArtKind; label: string; hint: string }[] = [
  { kind: 'poster', label: 'Channel icon', hint: 'Shown as a circle, so a square picture works best.' },
  { kind: 'banner', label: 'Banner', hint: 'The wide strip across the top of the channel page.' },
  { kind: 'fanart', label: 'Fanart', hint: 'A large background, used up there when there is no banner.' },
];

export function ChannelEditDialog({
  channel,
  onChanged,
  onClose,
}: {
  channel: ChannelDto;
  onChanged: (channel: ChannelDto) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(channel.title);
  const [plot, setPlot] = useState(channel.plot ?? '');
  const [edits, setEdits] = useState<ChannelEdits | null>(null);
  const [choosingIcon, setChoosingIcon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Which parts have been edited, so only those offer a reset.
  const loadEdits = () =>
    api
      .get<ChannelEdits>(`/api/channels/${channel.id}/edits`)
      .then(setEdits)
      .catch(() => setEdits(null));

  useEffect(() => {
    void loadEdits();
    // Only needed once per channel; each change below reloads it too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  /** Runs one change, then shows its result on the page behind the dialog. */
  const change = async (work: () => Promise<{ channel: ChannelDto }>): Promise<ChannelDto | null> => {
    setBusy(true);
    setError(null);
    try {
      const result = await work();
      onChanged(result.channel);
      await loadEdits();
      return result.channel;
    } catch (err: any) {
      setError(err?.message ?? 'That could not be saved');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const uploadArt = (kind: ArtKind, file: Blob) =>
    change(() => api.putFile<{ channel: ChannelDto }>(`/api/channels/${channel.id}/art/${kind}`, file));

  /** A picture was chosen from the device. */
  const onPickFile = (kind: ArtKind) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!UPLOAD_TYPES.includes(file.type)) {
      setError('Use a JPEG, PNG or WebP picture.');
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError('That picture is too large; the limit is 15 MB.');
      return;
    }
    void uploadArt(kind, file);
  };

  /** A ready-made icon was chosen. */
  const pickIcon = async (icon: ChannelIcon) => {
    try {
      const blob = await renderChannelIcon(icon);
      if (await uploadArt('poster', blob)) setChoosingIcon(false);
    } catch (err: any) {
      setError(err?.message ?? 'That icon could not be used');
    }
  };

  const resetArt = (kind: ArtKind) =>
    change(() => api.del<{ channel: ChannelDto }>(`/api/channels/${channel.id}/art/${kind}`));

  /** Puts the name or description back to what is in the channel's folder. */
  const resetText = async (field: 'title' | 'plot') => {
    const updated = await change(() =>
      api.put<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, { [field]: null }),
    );
    if (updated && field === 'title') setTitle(updated.title);
    if (updated && field === 'plot') setPlot(updated.plot ?? '');
  };

  /** Saves the name and description, if they changed, and closes. */
  const save = async () => {
    const changes: { title?: string; plot?: string } = {};
    if (title.trim() !== channel.title) changes.title = title;
    if (plot.trim() !== (channel.plot ?? '')) changes.plot = plot;
    if (!Object.keys(changes).length) {
      onClose();
      return;
    }
    const updated = await change(() => api.put<{ channel: ChannelDto }>(`/api/channels/${channel.id}`, changes));
    if (updated) onClose();
  };

  return (
    <Dialog title="Edit channel" onClose={onClose} width={560}>
      {error ? <div className="notice error">{error}</div> : null}

      {/* Name and description */}
      <div className="field">
        <label htmlFor="channel-edit-title">Name</label>
        <input
          id="channel-edit-title"
          className="input"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
        {edits?.title ? (
          <button type="button" className="muted" style={{ fontSize: 13, marginTop: 6 }} disabled={busy} onClick={() => void resetText('title')}>
            Reset to the original name
          </button>
        ) : null}
      </div>
      <div className="field">
        <label htmlFor="channel-edit-plot">Description</label>
        <textarea
          id="channel-edit-plot"
          className="input channel-edit-plot"
          value={plot}
          maxLength={20000}
          onChange={(event) => setPlot(event.target.value)}
        />
        {edits?.plot ? (
          <button type="button" className="muted" style={{ fontSize: 13, marginTop: 6 }} disabled={busy} onClick={() => void resetText('plot')}>
            Reset to the original description
          </button>
        ) : null}
      </div>

      {/* The three pictures, each saved as soon as it is chosen */}
      {ART_ROWS.map(({ kind, label, hint }) => (
        <div key={kind}>
          <div className="channel-edit-art">
            <img
              className={kind === 'poster' ? 'channel-edit-preview round' : 'channel-edit-preview'}
              src={urls.channelArt(channel.id, kind, 240, channel.artVersion)}
              alt=""
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
              onLoad={(event) => {
                (event.currentTarget as HTMLImageElement).style.visibility = 'visible';
              }}
            />
            <div className="grow">
              <div className="label">{label}</div>
              <div className="hint">{hint}</div>
            </div>
            <div className="channel-edit-buttons">
              <label className={busy ? 'btn is-disabled' : 'btn'}>
                Upload
                <input
                  type="file"
                  accept={UPLOAD_TYPES.join(',')}
                  disabled={busy}
                  style={{ display: 'none' }}
                  onChange={onPickFile(kind)}
                />
              </label>
              {kind === 'poster' ? (
                <button className="btn" disabled={busy} onClick={() => setChoosingIcon((open) => !open)}>
                  Choose icon
                </button>
              ) : null}
              {edits?.[kind] ? (
                <button className="btn" disabled={busy} onClick={() => void resetArt(kind)}>
                  Reset
                </button>
              ) : null}
            </div>
          </div>

          {/* The ready-made icons, under the channel icon row */}
          {kind === 'poster' && choosingIcon ? (
            <div className="channel-icon-grid">
              {CHANNEL_ICONS.map((icon) => (
                <button
                  key={icon.id}
                  className="channel-icon-choice"
                  disabled={busy}
                  title={icon.label}
                  aria-label={icon.label}
                  onClick={() => void pickIcon(icon)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                    <path d={icon.path} />
                  </svg>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      <p className="hint" style={{ marginTop: 4 }}>
        Edits are for PinchTube only. The files in the channel’s folder are left as they are, so Pinchflat and other
        apps will not see these changes, and cannot overwrite them.
      </p>

      <div className="download-actions" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn" onClick={onClose}>
          Close
        </button>
        <button className="btn primary" disabled={busy || !title.trim()} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Dialog>
  );
}
