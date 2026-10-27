import { useEffect, useRef, useState, type FocusEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, type CodecKey, type SizeBreakdown } from '../lib/api';
import { formatBytes, formatCount } from '../lib/format';
import { Spinner } from './Common';

const CODEC_LABELS: Record<CodecKey, string> = {
  h264: 'H.264',
  vp9: 'VP9',
  av1: 'AV1',
  hevc: 'HEVC',
  other: 'Other',
};

interface Tip {
  x: number;
  y: number;
  value: string;
  detail: string;
}

function percent(part: number, whole: number): string {
  if (!whole) return '0%';
  const value = (part / whole) * 100;
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

/**
 * Library size by channel (stacked by codec) and by codec. Colour follows the
 * codec — a fixed slot per codec, never by rank — so both charts share one
 * legend and a channel keeps its look whatever else is on screen.
 */
export function SizeCharts() {
  const [data, setData] = useState<SizeBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get<SizeBreakdown>('/api/stats/sizes')
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message ?? 'Could not load size breakdown');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const place = (event: { clientX: number; clientY: number }, value: string, detail: string) => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, value, detail });
  };

  const placeAtElement = (event: FocusEvent<HTMLElement>, value: string, detail: string) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const target = event.currentTarget.getBoundingClientRect();
    if (!rect) return;
    setTip({ x: target.left - rect.left + 120, y: target.top - rect.top + 12, value, detail });
  };

  if (error) return <div className="notice error">{error}</div>;
  if (!data) return <Spinner />;

  const { channels, codecs, totalBytes, totalVideos } = data;
  const maxBytes = channels[0]?.bytes ?? 0;
  const maxCodecBytes = codecs[0] ? Math.max(...codecs.map((c) => c.bytes)) : 0;

  if (channels.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        Nothing has been scanned yet.
      </p>
    );
  }

  return (
    <div className="viz-root" ref={rootRef} onPointerLeave={() => setTip(null)}>
      <div className="viz-head">
        <div>
          <div className="viz-title">Library size</div>
          <div className="viz-hero">{formatBytes(totalBytes)}</div>
          <div className="viz-sub">
            {formatCount(totalVideos, 'video')} across {formatCount(channels.length, 'channel')}
          </div>
        </div>
        <button className={showTable ? 'chip active' : 'chip'} onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Show chart' : 'Show table'}
        </button>
      </div>

      {/* Two or more series, so a legend is always present. */}
      <div className="viz-legend" aria-label="Codec key">
        {codecs.map((codec) => (
          <span className="viz-key" key={codec.codec}>
            <span className={`viz-swatch viz-${codec.codec}`} />
            {codec.label}
          </span>
        ))}
      </div>

      {showTable ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="viz-table">
            <thead>
              <tr>
                <th>Channel</th>
                {codecs.map((codec) => (
                  <th key={codec.codec}>{codec.label}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <td>
                    <Link to={`/channel/${channel.id}`}>{channel.title}</Link>
                  </td>
                  {codecs.map((codec) => {
                    const seg = channel.segments.find((s) => s.codec === codec.codec);
                    return <td key={codec.codec}>{seg ? formatBytes(seg.bytes) : '—'}</td>;
                  })}
                  <td>
                    <strong>{formatBytes(channel.bytes)}</strong>
                  </td>
                </tr>
              ))}
              <tr className="viz-total">
                <td>All channels</td>
                {codecs.map((codec) => (
                  <td key={codec.codec}>{formatBytes(codec.bytes)}</td>
                ))}
                <td>
                  <strong>{formatBytes(totalBytes)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className="viz-chart" role="list" aria-label="Size per channel">
            {channels.map((channel) => (
              <Link
                key={channel.id}
                to={`/channel/${channel.id}`}
                className="viz-row"
                role="listitem"
                title={`${channel.title} — ${formatBytes(channel.bytes)}`}
                onFocus={(event) =>
                  placeAtElement(
                    event,
                    formatBytes(channel.bytes),
                    `${channel.title} · ${formatCount(channel.videos, 'video')}`,
                  )
                }
                onBlur={() => setTip(null)}
              >
                <span className="viz-label">{channel.title}</span>
                <span className="viz-bar">
                  {/* Width is a share of the room left after the value label, so
                      the longest bar's value still fits at its tip. */}
                  <span
                    className="viz-track"
                    style={{ width: `calc((100% - 64px) * ${channel.bytes / maxBytes})` }}
                  >
                    {channel.segments.map((seg) => (
                      <span
                        key={seg.codec}
                        className={`viz-seg viz-${seg.codec}`}
                        style={{ flexGrow: seg.bytes }}
                        onPointerMove={(event: ReactPointerEvent) =>
                          place(
                            event,
                            formatBytes(seg.bytes),
                            `${channel.title} · ${CODEC_LABELS[seg.codec]} · ${percent(seg.bytes, channel.bytes)} of channel`,
                          )
                        }
                      />
                    ))}
                  </span>
                  <span className="viz-value">{formatBytes(channel.bytes)}</span>
                </span>
              </Link>
            ))}
          </div>

          <div className="viz-section-title">Size per codec</div>
          <div className="viz-chart viz-chart-small" role="list" aria-label="Size per codec">
            {codecs.map((codec) => (
              <div
                key={codec.codec}
                className="viz-row viz-row-static"
                role="listitem"
                tabIndex={0}
                onFocus={(event) =>
                  placeAtElement(
                    event,
                    formatBytes(codec.bytes),
                    `${codec.label} · ${formatCount(codec.videos, 'video')} · ${percent(codec.bytes, totalBytes)} of library`,
                  )
                }
                onBlur={() => setTip(null)}
              >
                <span className="viz-label">{codec.label}</span>
                <span className="viz-bar">
                  <span
                    className="viz-track"
                    style={{ width: `calc((100% - 64px) * ${codec.bytes / maxCodecBytes})` }}
                  >
                    <span
                      className={`viz-seg viz-${codec.codec}`}
                      style={{ flexGrow: 1 }}
                      onPointerMove={(event: ReactPointerEvent) =>
                        place(
                          event,
                          formatBytes(codec.bytes),
                          `${codec.label} · ${formatCount(codec.videos, 'video')} · ${percent(codec.bytes, totalBytes)} of library`,
                        )
                      }
                    />
                  </span>
                  <span className="viz-value">{formatBytes(codec.bytes)}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {tip ? (
        <div className="viz-tip" style={{ left: tip.x, top: tip.y }} role="status">
          <strong>{tip.value}</strong>
          <span>{tip.detail}</span>
        </div>
      ) : null}
    </div>
  );
}
