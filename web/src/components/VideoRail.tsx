/*
 * VideoRail.tsx — one horizontally scrolling row of video cards.
 *
 * The rows of the home page (pages/Home.tsx): a heading (with the channel's
 * avatar for a channel row, and a "See all" link where there is one), then
 * cards (components/VideoCard.tsx) that scroll sideways, with arrow buttons
 * on a wide screen.
 */

import { useRef } from 'react';
import { Link } from 'react-router-dom';
import type { ChannelDto, VideoDto } from '../lib/api';
import { urls } from '../lib/api';
import { VideoCard } from './VideoCard';
import { IconChevronLeft, IconChevronRight } from './Icons';

interface Props {
  title: string;
  items: VideoDto[];
  channel?: ChannelDto;
  link?: string;
  showChannel?: boolean;
}

export function VideoRail({ title, items, channel, link, showChannel = true }: Props) {
  const railRef = useRef<HTMLDivElement>(null);

  /** The arrow buttons scroll by most of a screen's width. */
  const scrollBy = (direction: 1 | -1) => {
    const el = railRef.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.round(el.clientWidth * 0.85), behavior: 'smooth' });
  };

  if (!items.length) return null;

  return (
    <section className="section">
      {/* Heading: avatar, title, "See all" */}
      <div className="section-head">
        {channel ? (
          <Link to={`/channel/${channel.id}`}>
            <img
              className="avatar"
              src={urls.channelArt(channel.id, 'poster', 160)}
              alt=""
              loading="lazy"
              onError={(event) => {
                (event.currentTarget as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          </Link>
        ) : null}
        <h2>{link ? <Link to={link}>{title}</Link> : title}</h2>
        {link ? (
          <Link className="section-more" to={link}>
            See all
          </Link>
        ) : null}
      </div>

      {/* The scrolling row of cards between two arrow buttons */}
      <div className="rail-wrap">
        <button className="rail-arrow left" onClick={() => scrollBy(-1)} aria-label="Scroll left">
          <IconChevronLeft />
        </button>
        <div className="rail" ref={railRef}>
          {items.map((video) => (
            <VideoCard
              key={video.id}
              video={video}
              showChannel={showChannel}
              showAvatar={!channel}
              thumbWidth={480}
            />
          ))}
        </div>
        <button className="rail-arrow right" onClick={() => scrollBy(1)} aria-label="Scroll right">
          <IconChevronRight />
        </button>
      </div>
    </section>
  );
}
