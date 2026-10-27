import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, urls, type PlaylistDto } from '../lib/api';
import { EmptyState, Spinner } from '../components/Common';
import { LibrarySwitch } from '../components/LibrarySwitch';
import { formatCount, formatDuration } from '../lib/format';
import { IconPlaylist, IconPlus } from '../components/Icons';

function PlaylistCard({ playlist }: { playlist: PlaylistDto }) {
  return (
    <Link to={`/playlist/${playlist.id}`} className="playlist-card">
      <div className="playlist-cover">
        {playlist.coverVideoId ? (
          <img src={urls.videoThumb(playlist.coverVideoId, 480)} alt="" loading="lazy" />
        ) : (
          <IconPlaylist className="playlist-cover-empty" />
        )}
        <span className="playlist-count">
          <IconPlaylist />
          {playlist.count}
        </span>
      </div>
      <div className="playlist-name">{playlist.name}</div>
      <div className="playlist-meta">
        {playlist.mine ? (playlist.shared ? 'Shared' : 'Private') : `by ${playlist.owner}`}
        {playlist.duration ? ` · ${formatDuration(playlist.duration)}` : ''}
      </div>
    </Link>
  );
}

export function Playlists() {
  const navigate = useNavigate();
  const [items, setItems] = useState<PlaylistDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  useEffect(() => {
    api
      .get<{ items: PlaylistDto[] }>('/api/playlists')
      .then((data) => setItems(data.items))
      .catch((err) => setError(err?.message ?? 'Could not load playlists'));
  }, []);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    setError(null);
    try {
      const data = await api.post<{ playlist: PlaylistDto }>('/api/playlists', { name: name.trim() });
      navigate(`/playlist/${data.playlist.id}`);
    } catch (err: any) {
      setError(err?.message ?? 'Could not create the playlist');
    }
  };

  const mine = items?.filter((playlist) => playlist.mine) ?? [];
  const shared = items?.filter((playlist) => !playlist.mine) ?? [];

  return (
    <div>
      <LibrarySwitch current="playlists" />
      <h1 className="page-title">Playlists</h1>

      <div className="toolbar">
        {creating ? (
          <form onSubmit={create} style={{ display: 'flex', gap: 8, flex: 1, maxWidth: 480 }}>
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
            <button className="btn" type="button" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <IconPlus />
            New playlist
          </button>
        )}
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {!items ? (
        <Spinner center />
      ) : items.length === 0 ? (
        <EmptyState
          title="No playlists yet"
          message="Make one here, or use “Save” under any video to start one with that video in it."
        />
      ) : (
        <>
          {mine.length ? (
            <>
              <h2 className="section-title">Your playlists · {formatCount(mine.length, 'playlist')}</h2>
              <div className="playlist-grid">
                {mine.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            </>
          ) : null}
          {shared.length ? (
            <>
              <h2 className="section-title">Shared by others</h2>
              <div className="playlist-grid">
                {shared.map((playlist) => (
                  <PlaylistCard key={playlist.id} playlist={playlist} />
                ))}
              </div>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
