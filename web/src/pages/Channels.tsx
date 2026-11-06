/*
 * Channels.tsx — the Channels page (/channels) and a single channel's page
 * (/channel/:id).
 *
 *   Channels  every channel the user may see, A–Z or by latest upload, as a
 *             grid or list (the "Channel layout" setting)
 *   Channel   one channel: banner, avatar, name, counts and description,
 *             then its videos (components/VideoBrowser.tsx); administrators
 *             also get an Edit button (components/ChannelEditDialog.tsx)
 * Data comes from /api/channels (server/src/routes/library.ts).
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, urls, type ChannelDto } from '../lib/api';
import { ChannelCard, EmptyState, Spinner } from '../components/Common';
import { useApp } from '../lib/app-context';
import { VideoBrowser } from '../components/VideoBrowser';
import { ChannelEditDialog } from '../components/ChannelEditDialog';
import { IconEdit } from '../components/Icons';
import { formatCount, formatRelative } from '../lib/format';

/** Every channel, as cards. */
export function Channels() {
  const { settings, user } = useApp();
  const [channels, setChannels] = useState<ChannelDto[] | null>(null);
  const [order, setOrder] = useState<'name' | 'recent'>('name');
  const [error, setError] = useState<string | null>(null);

  // Reload whenever the order changes.
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

/** A channel's description, cut to three lines with "Show more" if there is more to show. */
function ChannelPlot({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  // Measured rather than guessed from its length, and again if the page resizes.
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <>
      <div ref={body} className={expanded ? 'channel-plot' : 'channel-plot clamp-3'}>
        {text}
      </div>
      {overflows ? (
        <button
          className="muted"
          style={{ fontSize: 13, fontWeight: 650, marginTop: 6 }}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </>
  );
}

/** One channel's page. */
export function Channel() {
  const { id = '' } = useParams();
  const { user } = useApp();
  const [channel, setChannel] = useState<ChannelDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Load the channel's details when the address changes.
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
      {/* Banner, avatar, name, counts and a description that expands */}
      <div className="channel-hero">
        {channel.hasBanner || channel.hasFanart ? (
          <img
            className="channel-hero-banner"
            src={urls.channelArt(channel.id, channel.hasBanner ? 'banner' : 'fanart', 1280, channel.artVersion)}
            alt=""
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.display = 'none';
            }}
          />
        ) : null}

        <div className="channel-hero-body">
          <img
            className="avatar-lg"
            src={urls.channelArt(channel.id, 'poster', 240, channel.artVersion)}
            alt=""
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
            }}
          />
          <div className="grow" style={{ minWidth: 0 }}>
            <h1>{channel.title}</h1>
            <div className="sub">
              {formatCount(channel.videoCount, 'video')}
              {channel.unwatchedCount > 0 ? ` · ${channel.unwatchedCount} unwatched` : ''}
              {channel.latestAired ? ` · latest ${formatRelative(channel.latestAired)}` : ''}
            </div>
            {channel.plot ? <ChannelPlot text={channel.plot} /> : null}
          </div>
          {user?.isAdmin ? (
            <button
              className="btn"
              style={{ flexShrink: 0 }}
              onClick={() => setEditing(true)}
              aria-label="Edit channel"
              title="Edit channel"
            >
              <IconEdit />
              <span className="hide-sm">Edit</span>
            </button>
          ) : null}
        </div>
      </div>

      {editing ? (
        <ChannelEditDialog channel={channel} onChanged={setChannel} onClose={() => setEditing(false)} />
      ) : null}

      {/* The channel's videos */}
      <VideoBrowser
        channelId={channel.id}
        showChannel={false}
        emptyMessage="This channel has no videos matching those filters."
      />
    </div>
  );
}
