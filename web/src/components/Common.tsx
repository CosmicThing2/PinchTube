/*
 * Common.tsx — small building blocks used on many pages.
 *
 *   Select        a drop-down that looks the same in every browser
 *   Spinner       the loading indicator
 *   EmptyState    the "nothing here" message with an icon
 *   ChannelCard   a channel's avatar, name and video count (Channels and
 *                 Downloads pages)
 *   SkeletonGrid  grey placeholder cards shown while a page loads
 *   Dialog        a pop-up window (a sheet from the bottom on a phone)
 */

import { Link } from 'react-router-dom';
import type { ChannelDto } from '../lib/api';
import { urls } from '../lib/api';
import { formatCount } from '../lib/format';
import { IconChevronDown, IconClose, IconFilm } from './Icons';
import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A select with the native arrow removed and our own drawn on top, so it looks
 * and behaves identically in every browser.
 */
export function Select({
  value,
  onChange,
  options,
  className = 'select',
  ariaLabel,
  style,
  wrapStyle,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  ariaLabel?: string;
  style?: CSSProperties;
  wrapStyle?: CSSProperties;
}) {
  return (
    <span className="select-wrap" style={wrapStyle}>
      <select
        className={className}
        value={value}
        aria-label={ariaLabel}
        style={style}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <IconChevronDown />
    </span>
  );
}

/** The spinning loading indicator. */
export function Spinner({ center = false }: { center?: boolean }) {
  return <div className={center ? 'spinner center' : 'spinner'} role="status" aria-label="Loading" />;
}

/** A friendly message when a list is empty, with an optional button. */
export function EmptyState({
  title,
  message,
  action,
}: {
  title: string;
  message?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <IconFilm />
      <h3>{title}</h3>
      {message ? <p>{message}</p> : null}
      {action ? <div className="mt-16">{action}</div> : null}
    </div>
  );
}

/** A channel tile: avatar, name, video count and how many are new. */
export function ChannelCard({
  channel,
  to = `/channel/${channel.id}`,
  detail,
}: {
  channel: Pick<ChannelDto, 'id' | 'title' | 'videoCount' | 'unwatchedCount'>;
  /** Where it leads; the channel's own page unless given. */
  to?: string;
  /** Shown in place of the video count. */
  detail?: ReactNode;
}) {
  return (
    <Link className="channel-card" to={to}>
      <img
        className="avatar-lg"
        src={urls.channelArt(channel.id, 'poster', 240)}
        alt=""
        loading="lazy"
        onError={(event) => {
          (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
        }}
      />
      <div className="channel-card-body">
        <h3>{channel.title}</h3>
        <p>
          {detail ?? (
            <>
              {formatCount(channel.videoCount, 'video')}
              {channel.unwatchedCount > 0 ? (
                <span className="new"> · {channel.unwatchedCount} new</span>
              ) : null}
            </>
          )}
        </p>
      </div>
    </Link>
  );
}

/** Grey placeholder cards in the shape of the video grid, shown while loading. */
export function SkeletonGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="grid">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="skeleton" style={{ aspectRatio: '16 / 9' }} />
          <div className="skeleton" style={{ height: 13, marginTop: 10, width: '85%' }} />
          <div className="skeleton" style={{ height: 11, marginTop: 7, width: '55%' }} />
        </div>
      ))}
    </div>
  );
}

/**
 * A centred dialog on a wide screen, a sheet rising from the bottom on a phone.
 * Escape or a tap outside closes it.
 */
export function Dialog({
  title,
  onClose,
  children,
  width = 440,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  // Escape closes it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Drawn at the end of the page (a portal), so it sits above everything else.
  return createPortal(
    <div className="dialog-scrim" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width }}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
