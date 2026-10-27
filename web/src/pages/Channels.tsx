import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, urls, type ChannelDto } from '../lib/api';
import { ChannelCard, EmptyState, Spinner } from '../components/Common';
import { useApp } from '../lib/app-context';
import { VideoBrowser } from '../components/VideoBrowser';
import { formatCount, formatRelative } from '../lib/format';

export function Channels() {
  const { settings, user } = useApp();
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);
  const [order, setOrder] = useState<'name' | 'recent'>('name');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChannels(null);
    api
      .get<{ items: ChannelDto[] }>(`/api/channels?order=${order}`)
      .then((data) => {
        if (!cancelled) setChannels(data.items);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load channels');
      });
    return () => {
      cancelled = true;
    };
  }, [order]);

  return (
    <div>
      <h1 className="page-title">Channels</h1>

      <div className="toolbar">
        <button className={order === 'name' ? 'chip active' : 'chip'} onClick={() => setOrder('name')}>
          A–Z
        </button>
        <button className={order === 'recent' ? 'chip active' : 'chip'} onClick={() => setOrder('recent')}>
          Recently active
        </button>
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {!channels ? (
        <Spinner center />
      ) : channels.length === 0 ? (
        <EmptyState
          title="No channels yet"
          message={
            user?.isAdmin
              ? 'Point the app at your media folder in settings, then run a scan.'
              : 'No channels have been shared with you yet. Ask an administrator for access.'
          }
        />
      ) : (
        <div className={`channel-${settings?.appearance.channelLayout ?? 'auto'}`}>
          {channels.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Channel() {
  const { id = '' } = useParams();
  const [channel, setChannel] = useState<ChannelDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setChannel(null);
    api
      .get<{ channel: ChannelDto }>(`/api/channels/${id}`)
      .then((data) => {
        if (!cancelled) setChannel(data.channel);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load this channel');
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <div className="notice error">{error}</div>;
  if (!channel) return <Spinner center />;

  return (
    <div>
      <div className="channel-hero">
        {channel.hasBanner || channel.hasFanart ? (
          <img
            className="channel-hero-banner"
            src={urls.channelArt(channel.id, channel.hasBanner ? 'banner' : 'fanart', 1280)}
            alt=""
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : null}

        <div className="channel-hero-body">
          <img
            className="avatar-lg"
            src={urls.channelArt(channel.id, 'poster', 240)}
            alt=""
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
          <div style={{ minWidth: 0 }}>
            <h1>{channel.title}</h1>
            <div className="sub">
              {formatCount(channel.videoCount, 'video')}
              {channel.unwatchedCount > 0 ? ` · ${channel.unwatchedCount} unwatched` : ''}
              {channel.latestAired ? ` · latest ${formatRelative(channel.latestAired)}` : ''}
            </div>
            {channel.plot ? (
              <>
                <div className={expanded ? '' : 'clamp-3'} style={{ whiteSpace: 'pre-wrap' }}>
                  {channel.plot}
                </div>
                <button
                  className="muted"
                  style={{ fontSize: 13, fontWeight: 650, marginTop: 6 }}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? 'Show less' : 'Show more'}
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <VideoBrowser
        channelId={channel.id}
        showChannel={false}
        emptyMessage="This channel has no videos matching those filters."
      />
    </div>
  );
}
