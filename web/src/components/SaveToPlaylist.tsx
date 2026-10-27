import { useEffect, useState, type FormEvent } from 'react';
import { api, type PlaylistDto } from '../lib/api';
import { Dialog, Spinner } from './Common';
import { IconPlus } from './Icons';

/**
 * YouTube's "Save to…" box: tick or untick each of your playlists, or make a
 * new one with this video already in it. Changes save as they are made.
 */
export function SaveToPlaylist({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const [playlists, setPlaylists] = useState<PlaylistDto[] | null>(null);
  const [containing, setContaining] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .get<{ items: PlaylistDto[]; containing: number[] }>(`/api/playlists?video=${encodeURIComponent(videoId)}`)
      .then((data) => {
        setPlaylists(data.items.filter((playlist) => playlist.mine));
        setContaining(new Set(data.containing));
      })
      .catch((err) => setError(err?.message ?? 'Could not load your playlists'));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  const toggle = async (playlist: PlaylistDto) => {
    const inIt = containing.has(playlist.id);
    setBusy(playlist.id);
    setError(null);
    try {
      if (inIt) {
        await api.del(`/api/playlists/${playlist.id}/items/${encodeURIComponent(videoId)}`);
      } else {
        await api.post(`/api/playlists/${playlist.id}/items`, { videoId });
      }
      setContaining((current) => {
        const next = new Set(current);
        if (inIt) next.delete(playlist.id);
        else next.add(playlist.id);
        return next;
      });
    } catch (err: any) {
      setError(err?.message ?? 'Could not update the playlist');
    } finally {
      setBusy(null);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      await api.post('/api/playlists', { name: name.trim(), videoId });
      setName('');
      setCreating(false);
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Could not create the playlist');
    }
  };

  return (
    <Dialog title="Save to playlist" onClose={onClose} width={400}>
      {error ? <div className="notice error">{error}</div> : null}

      {!playlists ? (
        <Spinner />
      ) : (
        <div className="save-list">
          {playlists.length === 0 && !creating ? (
            <p className="muted" style={{ fontSize: 13, margin: '4px 0 12px' }}>
              You have no playlists yet.
            </p>
          ) : null}
          {playlists.map((playlist) => (
            <label key={playlist.id} className="save-row">
              <input
                type="checkbox"
                checked={containing.has(playlist.id)}
                disabled={busy === playlist.id}
                onChange={() => void toggle(playlist)}
              />
              <span className="save-name">{playlist.name}</span>
              {playlist.shared ? <span className="save-tag">Shared</span> : null}
            </label>
          ))}
        </div>
      )}

      {creating ? (
        <form onSubmit={create} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <input
            className="input"
            placeholder="Playlist name"
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            style={{ flex: 1 }}
          />
          <button className="btn primary" type="submit" disabled={!name.trim()}>
            Create
          </button>
        </form>
      ) : (
        <button className="btn" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
          <IconPlus />
          New playlist
        </button>
      )}
    </Dialog>
  );
}
