import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  type AppSettings,
  type HomeChannelDto,
  type ScanStatus,
  type SystemInfo,
} from '../lib/api';
import { useApp } from '../lib/app-context';
import { Select, Spinner } from '../components/Common';
import { SortableList } from '../components/SortableList';
import { SizeCharts } from '../components/SizeCharts';
import { TwoFactorPanel } from '../components/TwoFactorPanel';
import { UsersPanel } from '../components/UsersPanel';
import { formatBytes } from '../lib/format';
import {
  ACCENT_PRESETS,
  SPONSOR_PRESETS,
  applyColours,
  colourOf,
  isCustomColour,
  type ColourPreset,
} from '../lib/accent';
import { IconFolder, IconPin, IconRefresh } from '../components/Icons';

const QUALITY_LABELS: Record<string, string> = {
  original: 'Original (direct play, no transcoding)',
  '2160p': '2160p',
  '1440p': '1440p',
  '1080p': '1080p',
  '720p': '720p',
  '480p': '480p',
  '360p': '360p',
};

const QUALITY_ORDER = ['original', '2160p', '1440p', '1080p', '720p', '480p', '360p'];

const SUBTITLE_SIZES = [
  { value: '75', label: 'Small' },
  { value: '100', label: 'Standard' },
  { value: '125', label: 'Large' },
  { value: '150', label: 'Larger' },
  { value: '200', label: 'Huge' },
  { value: '250', label: 'Enormous' },
];

const ROW_DESCRIPTIONS: Record<string, string> = {
  continue: 'Videos you started but have not finished.',
  recent: 'The newest downloads across every channel.',
  random: 'A shuffled pick of older, unwatched videos.',
  channels: 'One row per channel, newest first.',
};

const ROW_LABELS: Record<string, string> = {
  continue: 'Continue watching',
  recent: 'Recently added',
  random: 'Rediscover',
  channels: 'Per-channel rows',
};

function Row({
  label,
  hint,
  children,
  disabled = false,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? 'settings-row is-disabled' : 'settings-row'}>
      <div className="grow">
        <div className="label">{label}</div>
        {hint ? <div className="hint">{hint}</div> : null}
      </div>
      <div style={{ flexShrink: 0 }}>{children}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? 'switch is-disabled' : 'switch'}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="track" />
    </label>
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <input
        className="input"
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        style={{ width: 110, height: 38 }}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(parsed);
        }}
      />
      {suffix ? <span className="muted" style={{ fontSize: 13 }}>{suffix}</span> : null}
    </span>
  );
}

function Choice({
  value,
  onChange,
  options,
  width = 230,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  width?: number;
}) {
  return (
    <Select
      className="select"
      style={{ width, height: 38 }}
      wrapStyle={{ maxWidth: '100%' }}
      value={value}
      options={options}
      onChange={onChange}
    />
  );
}

function ColourPicker({
  value,
  onChange,
  presets,
  fallback,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  presets: ColourPreset[];
  /** The preset used when the stored value is unknown. */
  fallback: string;
  label: string;
}) {
  const custom = isCustomColour(value);
  return (
    <div className="accent-picker" role="radiogroup" aria-label={label}>
      {presets.map((preset) => (
        <button
          key={preset.id}
          type="button"
          role="radio"
          aria-checked={value === preset.id}
          aria-label={preset.label}
          title={preset.label}
          className={value === preset.id ? 'accent-swatch is-selected' : 'accent-swatch'}
          style={{ background: preset.color }}
          onClick={() => onChange(preset.id)}
        />
      ))}
      <label
        className={custom ? 'accent-swatch accent-custom is-selected' : 'accent-swatch accent-custom'}
        title="Custom colour"
        style={custom ? { background: value } : undefined}
      >
        <input
          type="color"
          aria-label="Custom colour"
          value={colourOf(presets, value, fallback)}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    </div>
  );
}

export function Settings() {
  const { settings, saveSettings, refreshSettings, user, logout, dataSaver, setDataSaver } =
    useApp();
  // Library, transcoding, users and the system overview are server-wide, so
  // only administrators see them; everything else is each user's own.
  const isAdmin = Boolean(user?.isAdmin);
  const [draft, setDraft] = useState<AppSettings | null>(settings);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [scan, setScan] = useState<ScanStatus | null>(null);
  const [pathCheck, setPathCheck] = useState<any>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const loadSystem = () => {
    if (!isAdmin) return;
    api
      .get<SystemInfo>('/api/system')
      .then((info) => {
        setSystem(info);
        setScan(info.scan);
      })
      .catch(() => {});
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadSystem, [isAdmin]);

  // Poll while a scan is running so the progress line stays live.
  useEffect(() => {
    if (!scan?.running) return;
    const timer = window.setInterval(() => {
      api
        .get<{ scan: ScanStatus }>('/api/settings/scan-status')
        .then((data) => {
          setScan(data.scan);
          if (!data.scan.running) loadSystem();
        })
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [scan?.running]);

  const dirty = useMemo(
    () => Boolean(draft && settings && JSON.stringify(draft) !== JSON.stringify(settings)),
    [draft, settings],
  );

  // Preview the colours while choosing; leaving without saving puts the saved ones back.
  const draftAccent = draft?.appearance.accent;
  const draftSponsor = draft?.appearance.sponsorColor;
  const savedAccent = settings?.appearance.accent;
  const savedSponsor = settings?.appearance.sponsorColor;
  useEffect(() => {
    if (!draftAccent) return;
    applyColours({ accent: draftAccent, sponsor: draftSponsor });
    return () => applyColours({ accent: savedAccent, sponsor: savedSponsor });
  }, [draftAccent, draftSponsor, savedAccent, savedSponsor]);

  if (!draft || !settings) return <Spinner center />;

  const update = (patch: (current: AppSettings) => AppSettings) => {
    setDraft((current) => (current ? patch(structuredClone(current)) : current));
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings(draft);
      setMessage({ kind: 'ok', text: 'Settings saved.' });
      loadSystem();
    } catch (err: any) {
      setMessage({ kind: 'error', text: err?.message ?? 'Could not save settings' });
    } finally {
      setSaving(false);
    }
  };

  const startScan = async (full: boolean) => {
    setMessage(null);
    try {
      await api.post('/api/settings/scan', { full });
      setScan({ ...(scan as ScanStatus), running: true, phase: 'starting', error: null });
    } catch (err: any) {
      setMessage({ kind: 'error', text: err?.message ?? 'Could not start the scan' });
    }
  };

  const checkPath = async () => {
    setPathCheck({ checking: true });
    try {
      const result = await api.get(
        `/api/settings/validate-path?path=${encodeURIComponent(draft.library.mediaPath)}`,
      );
      setPathCheck(result);
    } catch (err: any) {
      setPathCheck({ ok: false, error: err?.message ?? 'Could not check that path' });
    }
  };

  const moveRowTo = (from: number, to: number) => {
    update((current) => {
      const rows = current.home.rows.slice();
      const [row] = rows.splice(from, 1);
      rows.splice(to, 0, row);
      current.home.rows = rows;
      return current;
    });
  };

  const qualityOptions = QUALITY_ORDER.map((value) => ({ value, label: QUALITY_LABELS[value] }));
  const autoOption = { value: 'auto', label: 'Auto (adapt to connection speed)' };
  const audioOption = { value: 'audio', label: 'Audio only (lowest data use)' };
  const playableOptions = [autoOption, ...qualityOptions, audioOption];

  return (
    <div style={{ maxWidth: 860, paddingBottom: dirty ? 90 : 0 }}>
      <h1 className="page-title">Settings</h1>

      {message ? <div className={`notice ${message.kind}`}>{message.text}</div> : null}

      {/* ------------------------------------------------------------ library */}
      {isAdmin ? (
      <section className="panel">
        <h2>Library</h2>
        <p className="panel-sub">Where your downloads live, and how often to look for new files.</p>

        <div className="field">
          <label htmlFor="mediaPath">Media folder on the server</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <input
              id="mediaPath"
              className="input"
              style={{ flex: 1, minWidth: 220 }}
              value={draft.library.mediaPath}
              onChange={(event) =>
                update((current) => {
                  current.library.mediaPath = event.target.value;
                  return current;
                })
              }
            />
            <button className="btn" onClick={() => void checkPath()}>
              <IconFolder />
              Check
            </button>
          </div>
          <div className="hint">
            This is the path <strong>inside the container</strong>. With the default docker-compose it is{' '}
            <code>/media</code>. Expected layout: <code>/media/Channel Name/Season 2026/video.mp4</code> or{' '}
            <code>/media/Channel Name/video.mp4</code>
          </div>
          {pathCheck?.checking ? <div className="hint">Checking…</div> : null}
          {pathCheck && !pathCheck.checking ? (
            <div className={pathCheck.ok ? 'notice ok' : 'notice error'} style={{ marginTop: 10 }}>
              {pathCheck.ok
                ? `Found ${pathCheck.channelCount} channel folder(s): ${(pathCheck.sample ?? []).join(', ')}${
                    pathCheck.channelCount > (pathCheck.sample?.length ?? 0) ? '…' : ''
                  }`
                : pathCheck.error}
            </div>
          ) : null}
        </div>

        <Row label="Scan interval" hint="How often to scan for new videos.">
          <NumberField
            value={draft.library.scanIntervalMinutes}
            min={1}
            max={10080}
            suffix="minutes"
            onChange={(value) =>
              update((current) => {
                current.library.scanIntervalMinutes = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Watch media folder for changes"
          hint="Picks up new videos within seconds instead of waiting for the next scan."
        >
          <Toggle
            checked={draft.library.watcherEnabled}
            onChange={(value) =>
              update((current) => {
                current.library.watcherEnabled = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Use polling for the watcher"
          hint="Only needed if the media folder is on a network share (NFS/SMB), where file events do not fire."
          disabled={!draft.library.watcherEnabled}
        >
          <Toggle
            checked={draft.library.watcherUsePolling}
            disabled={!draft.library.watcherEnabled}
            onChange={(value) =>
              update((current) => {
                current.library.watcherUsePolling = value;
                return current;
              })
            }
          />
        </Row>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <button className="btn primary" onClick={() => void startScan(false)} disabled={scan?.running}>
            <IconRefresh />
            {scan?.running ? 'Scanning…' : 'Scan now'}
          </button>
          <button className="btn" onClick={() => void startScan(true)} disabled={scan?.running}>
            Full rescan
          </button>
        </div>

        {scan ? (
          <div className={scan.error ? 'notice error' : 'notice info'} style={{ marginTop: 12 }}>
            {scan.error
              ? scan.error
              : scan.running
                ? `${scan.phase} — ${scan.videosAdded} added, ${scan.videosUpdated} updated`
                : scan.finishedAt
                  ? `Last scan finished ${new Date(scan.finishedAt).toLocaleString()} — ${scan.channelsSeen} channels, ${scan.videosAdded} added, ${scan.videosUpdated} updated, ${scan.videosRemoved} removed.`
                  : 'No scan has run yet.'}
          </div>
        ) : null}
      </section>
      ) : null}

      {/* --------------------------------------------------------- home rows */}
      <section className="panel">
        <h2>Home page</h2>
        <p className="panel-sub">Choose which rows appear, what they are called, and in what order.</p>

        <p className="hint" style={{ marginBottom: 10 }}>
          Drag the handle to change the order rows appear in.
        </p>

        <SortableList
          items={draft.home.rows}
          keyOf={(row) => row.id}
          onMove={moveRowTo}
          renderItem={(row, index, { handle, dragging }) => (
            <div className={`homerow draggable${dragging ? ' dragging' : ''}`}>
              {handle}

              <div className="grow" style={{ minWidth: 0 }}>
                <input
                  className="input homerow-title"
                  value={row.title}
                  aria-label="Row title"
                  onChange={(event) =>
                    update((current) => {
                      current.home.rows[index].title = event.target.value;
                      return current;
                    })
                  }
                />
                <div className="hint">{ROW_DESCRIPTIONS[row.id] ?? ROW_LABELS[row.id]}</div>

                <div className="homerow-controls">
                  <label className="switch">
                    <input
                      type="checkbox"
                      checked={row.enabled}
                      onChange={(event) =>
                        update((current) => {
                          current.home.rows[index].enabled = event.target.checked;
                          return current;
                        })
                      }
                    />
                    <span className="track" />
                    <span className="switch-text">Show</span>
                  </label>

                  <label className="num-field">
                    <input
                      type="number"
                      min={4}
                      max={100}
                      value={row.limit}
                      onChange={(event) =>
                        update((current) => {
                          current.home.rows[index].limit = Number(event.target.value) || 4;
                          return current;
                        })
                      }
                    />
                    <span>{row.id === 'channels' ? 'channels' : 'videos'}</span>
                  </label>

                  {row.id === 'channels' ? (
                    <label className="num-field">
                      <input
                        type="number"
                        min={4}
                        max={50}
                        value={row.videosPerChannel ?? 15}
                        onChange={(event) =>
                          update((current) => {
                            current.home.rows[index].videosPerChannel =
                              Number(event.target.value) || 4;
                            return current;
                          })
                        }
                      />
                      <span>videos per channel</span>
                    </label>
                  ) : null}
                </div>
              </div>
            </div>
          )}
        />
      </section>

      <section className="panel">
        <h2>Channel rows</h2>
        <p className="panel-sub">
          Enable or disable specific channels. Pinned channels override the default channel row order.
        </p>

        <Row label="Default channel row order">
          <Choice
            value={draft.home.channelOrder}
            options={[
              { value: 'recent', label: 'Most recently active' },
              { value: 'name', label: 'Alphabetical' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.home.channelOrder = value as any;
                return current;
              })
            }
          />
        </Row>

        <ChannelRowsEditor
          rows={draft.home.channelRows}
          onChange={(rows) =>
            update((current) => {
              current.home.channelRows = rows;
              return current;
            })
          }
        />
      </section>

      {/* ---------------------------------------------------------- playback */}
      <section className="panel">
        <h2>Playback</h2>
        <p className="panel-sub">
          Defaults for the quality menu. Anything other than “Original” is transcoded on the fly.
        </p>

        <Row label="Default quality" hint="Used whenever data saving mode is off.">
          <Choice
            value={draft.playback.defaultQualityWifi}
            options={playableOptions}
            width={280}
            onChange={(value) =>
              update((current) => {
                current.playback.defaultQualityWifi = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Default quality on data saving mode" hint="Used whenever data saving mode is on.">
          <Choice
            value={draft.playback.defaultQualityCellular}
            options={playableOptions}
            width={280}
            onChange={(value) =>
              update((current) => {
                current.playback.defaultQualityCellular = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Data saving"
          hint="Enable data saving mode: all videos are locked to the quality above. Saved per device."
        >
          <Toggle checked={dataSaver} onChange={setDataSaver} />
        </Row>

        <Row label="Maximum quality" hint="Caps the quality menu. Set below Original to always transcode.">
          <Choice
            value={draft.playback.maxQuality}
            options={qualityOptions}
            width={280}
            onChange={(value) =>
              update((current) => {
                current.playback.maxQuality = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Show subtitles by default" hint="When a video has a sidecar .srt or .vtt file.">
          <Toggle
            checked={draft.playback.subtitlesDefault}
            onChange={(value) =>
              update((current) => {
                current.playback.subtitlesDefault = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Show play/pause button over the video"
          hint="Show a play/pause button in the middle of the video while the controls are visible."
        >
          <Toggle
            checked={draft.playback.centerPlayButton}
            onChange={(value) =>
              update((current) => {
                current.playback.centerPlayButton = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Skip sponsor segments automatically"
          hint="Jumps straight over SponsorBlock-marked sponsor segments as they start, with a moment to undo it."
        >
          <Toggle
            checked={draft.playback.sponsorAutoSkip}
            onChange={(value) =>
              update((current) => {
                current.playback.sponsorAutoSkip = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Show a skip button on sponsor segments"
          hint={
            draft.playback.sponsorAutoSkip
              ? 'Not needed while sponsor segments are skipped automatically.'
              : 'Pops up during SponsorBlock-marked sponsor segments; one tap jumps to where the segment ends.'
          }
          disabled={draft.playback.sponsorAutoSkip}
        >
          <Toggle
            disabled={draft.playback.sponsorAutoSkip}
            checked={draft.playback.sponsorSkipPrompt && !draft.playback.sponsorAutoSkip}
            onChange={(value) =>
              update((current) => {
                current.playback.sponsorSkipPrompt = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Swipe for volume"
          hint="On a phone in fullscreen, drag up or down on the right half of the video."
        >
          <Toggle
            checked={draft.playback.gestureVolume}
            onChange={(value) =>
              update((current) => {
                current.playback.gestureVolume = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Swipe for brightness"
          hint="On a phone in fullscreen, drag up or down on the left half. This dims the picture — a web page cannot change the screen's own brightness."
        >
          <Toggle
            checked={draft.playback.gestureBrightness}
            onChange={(value) =>
              update((current) => {
                current.playback.gestureBrightness = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Fade audio out when pausing" hint="Eases the sound down instead of cutting it dead.">
          <Choice
            value={String(draft.playback.fadeOutSeconds)}
            options={[
              { value: '0', label: 'Off' },
              { value: '1', label: '1 second' },
              { value: '2', label: '2 seconds' },
              { value: '3', label: '3 seconds' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.playback.fadeOutSeconds = Number(value) || 0;
                return current;
              })
            }
          />
        </Row>

        <Row label="Subtitle size" hint="Subtitles also sit clear of the control bar so nothing covers them.">
          <Choice
            value={String(draft.playback.subtitleFontScale)}
            options={SUBTITLE_SIZES}
            onChange={(value) =>
              update((current) => {
                current.playback.subtitleFontScale = Number(value) || 125;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Play automatically when opened"
          hint="Some browsers block this until you have interacted with the site; the play button is always there."
        >
          <Toggle
            checked={draft.playback.autoplayOnOpen}
            onChange={(value) =>
              update((current) => {
                current.playback.autoplayOnOpen = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Autoplay the next video" hint="Plays the next video from the same channel when one ends.">
          <Toggle
            checked={draft.playback.autoplayNext}
            onChange={(value) =>
              update((current) => {
                current.playback.autoplayNext = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Skip step" hint="How far the skip buttons, arrow keys and double-taps jump.">
          <NumberField
            value={draft.playback.seekStep}
            min={5}
            max={60}
            suffix="seconds"
            onChange={(value) =>
              update((current) => {
                current.playback.seekStep = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Counts as watched at" hint="Portion of a video that must be played before it is marked watched.">
          <NumberField
            value={Math.round(draft.playback.watchedThreshold * 100)}
            min={50}
            max={99}
            suffix="%"
            onChange={(value) =>
              update((current) => {
                current.playback.watchedThreshold = value / 100;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Mark and remove queued videos"
          hint="When to mark a queued video as watched and then remove it from the queue when advancing. A video that plays to the end is always marked watched; it stays queued only with Never."
        >
          <Choice
            value={draft.playback.queueAdvance}
            width={280}
            options={[
              { value: 'always', label: 'Always' },
              { value: 'threshold', label: 'If watched past “Counts as watched at”' },
              { value: 'custom', label: 'If watched past a custom percentage' },
              { value: 'complete', label: 'Only if watched to the end' },
              { value: 'never', label: 'Never (remove videos by hand)' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.playback.queueAdvance = value as any;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Custom percentage"
          hint="Used when the option above is set to a custom percentage."
          disabled={draft.playback.queueAdvance !== 'custom'}
        >
          <NumberField
            value={draft.playback.queueAdvancePercent}
            min={1}
            max={100}
            suffix="%"
            onChange={(value) =>
              update((current) => {
                current.playback.queueAdvancePercent = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Resume if past" hint="Below this point a video restarts from the beginning instead of resuming.">
          <NumberField
            value={draft.playback.resumeThresholdSeconds}
            min={0}
            max={600}
            suffix="seconds"
            onChange={(value) =>
              update((current) => {
                current.playback.resumeThresholdSeconds = value;
                return current;
              })
            }
          />
        </Row>
      </section>

      {/* ------------------------------------------------------- transcoding */}
      {isAdmin ? (
      <section className="panel">
        <h2>Transcoding</h2>
        <p className="panel-sub">{system?.transcode.status ?? 'Checking ffmpeg…'}</p>

        {system?.transcode.error ? <div className="notice error">{system.transcode.error}</div> : null}

        <Row
          label="Hardware acceleration"
          hint="Auto uses the first GPU encoder that passed a test when the server started — NVIDIA, then VAAPI, then Quick Sync — and the CPU otherwise. A GPU also has to be passed through to the container; see the README."
        >
          <Choice
            value={draft.transcode.hwaccel}
            width={260}
            options={[
              { value: 'auto', label: 'Auto (recommended)' },
              { value: 'vaapi', label: 'VAAPI (Requires AMD or Intel)' },
              { value: 'qsv', label: 'Quick Sync (Requires Intel)' },
              { value: 'nvenc', label: 'NVENC (Requires NVIDIA)' },
              { value: 'none', label: 'Software only (CPU)' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.transcode.hwaccel = value as any;
                return current;
              })
            }
          />
        </Row>

        {system?.transcode.tested ? (
          <>
            {(() => {
              // Picking a GPU this server cannot use is allowed — it may be
              // fixed later — but say plainly that the CPU is doing the work.
              const mode = draft.transcode.hwaccel;
              const { available, tested } = system.transcode;
              if (mode === 'none') return null;
              if (mode === 'auto') {
                return available.vaapi || available.qsv || available.nvenc ? null : (
                  <div className="notice info">
                    No GPU encoder is available on this server, so videos are transcoded in software on the CPU.
                  </div>
                );
              }
              if (available[mode]) return null;
              const name = { vaapi: 'VAAPI', qsv: 'Quick Sync', nvenc: 'NVENC' }[mode];
              return (
                <div className="notice error">
                  {name} is not available on this server ({tested[mode].toLowerCase()}), so videos are transcoded
                  in software on the CPU instead.
                </div>
              );
            })()}

            <div className="hw-tests">
              {(
                [
                  ['vaapi', 'VAAPI (AMD / Intel)'],
                  ['qsv', 'Quick Sync (Intel)'],
                  ['nvenc', 'NVENC (NVIDIA)'],
                ] as const
              ).map(([kind, label]) => {
                const detail = system.transcode.details?.[kind];
                return (
                  <div key={kind} className="hw-test">
                    <span className={system.transcode.available[kind] ? 'hw-dot ok' : 'hw-dot'} aria-hidden="true" />
                    <span className="hw-name">{label}</span>
                    {detail ? (
                      <details className="hw-result">
                        <summary>{system.transcode.tested[kind]}</summary>
                        <pre className="hw-detail">{detail}</pre>
                      </details>
                    ) : (
                      <span className="hw-result">{system.transcode.tested[kind]}</span>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ) : null}

        <Row label="Software encoder preset" hint="Only used when falling back to libx264. Faster presets use less CPU.">
          <Choice
            value={draft.transcode.preset}
            options={['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium'].map((value) => ({
              value,
              label: value,
            }))}
            onChange={(value) =>
              update((current) => {
                current.transcode.preset = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Segment length" hint="Shorter segments start faster; longer ones are more efficient.">
          <NumberField
            value={draft.transcode.segmentSeconds}
            min={2}
            max={10}
            suffix="seconds"
            onChange={(value) =>
              update((current) => {
                current.transcode.segmentSeconds = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Concurrent transcodes" hint="How many ffmpeg jobs may run at once before the oldest is stopped.">
          <NumberField
            value={draft.transcode.maxConcurrentJobs}
            min={1}
            max={10}
            onChange={(value) =>
              update((current) => {
                current.transcode.maxConcurrentJobs = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Transcode cache limit"
          hint={
            system
              ? `Currently using ${formatBytes(system.cache.bytes)} of ${formatBytes(system.cache.limitBytes)}.`
              : 'Cached segments make rewatching instant.'
          }
        >
          <NumberField
            value={draft.transcode.cacheSizeGb}
            min={1}
            max={2000}
            suffix="GB"
            onChange={(value) =>
              update((current) => {
                current.transcode.cacheSizeGb = value;
                return current;
              })
            }
          />
        </Row>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <button
            className="btn"
            onClick={async () => {
              await api.post('/api/settings/cache/clear', { which: 'transcode' });
              setMessage({ kind: 'ok', text: 'Transcode cache cleared.' });
              loadSystem();
            }}
          >
            Clear transcode cache
          </button>
          <button
            className="btn"
            onClick={async () => {
              await api.post('/api/settings/cache/clear', { which: 'images' });
              setMessage({ kind: 'ok', text: 'Thumbnail cache cleared.' });
              loadSystem();
            }}
          >
            Clear thumbnail cache
          </button>
        </div>
      </section>
      ) : null}

      {/* --------------------------------------------------------- interface */}
      <section className="panel">
        <h2>Interface</h2>
        <p className="panel-sub">How lists look and behave across the app.</p>

        <Row label="Theme" hint="Follows your phone or computer when set to System.">
          <Choice
            value={draft.appearance.theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.appearance.theme = value as any;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Accent colour"
          hint="Used for buttons, switches, progress bars and highlights. Very light or very dark custom colours can be hard to see in one of the themes."
        >
          <ColourPicker
            label="Accent colour"
            presets={ACCENT_PRESETS}
            fallback="red"
            value={draft.appearance.accent}
            onChange={(value) =>
              update((current) => {
                current.appearance.accent = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="SponsorBlock colour"
          hint="Marks sponsor segments on the progress bar and in the chapter list. Pick one that stands out from your accent colour."
        >
          <ColourPicker
            label="SponsorBlock colour"
            presets={SPONSOR_PRESETS}
            fallback="green"
            value={draft.appearance.sponsorColor}
            onChange={(value) =>
              update((current) => {
                current.appearance.sponsorColor = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Card size"
          hint="Applies to every grid and to the rows on the home page. Smaller sizes fit two or more columns on a phone."
        >
          <Choice
            value={draft.appearance.cardSize}
            options={[
              { value: 'xs', label: 'Extra small' },
              { value: 'sm', label: 'Small' },
              { value: 'md', label: 'Medium' },
              { value: 'lg', label: 'Large' },
              { value: 'xl', label: 'Extra large' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.appearance.cardSize = value as any;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Fade watched thumbnails"
          hint="Dims the thumbnail of anything you have finished, on top of the watched badge."
        >
          <Toggle
            checked={draft.appearance.dimWatched}
            onChange={(value) =>
              update((current) => {
                current.appearance.dimWatched = value;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Channels page layout"
          hint="Automatic uses the poster grid on a wide screen and a compact list on a phone."
        >
          <Choice
            value={draft.appearance.channelLayout}
            options={[
              { value: 'auto', label: 'Automatic' },
              { value: 'grid', label: 'Poster grid' },
              { value: 'list', label: 'Compact list' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.appearance.channelLayout = value as any;
                return current;
              })
            }
          />
        </Row>

        <Row
          label="Animate the side menu"
          hint="In theater mode, slide the menu in from the left when the ☰ button opens it, instead of it just appearing."
        >
          <Toggle
            checked={draft.appearance.animateMenu !== false}
            onChange={(value) =>
              update((current) => {
                current.appearance.animateMenu = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Default sort order" hint="Used by the all-videos and channel pages.">
          <Choice
            value={draft.ui.defaultSort}
            options={[
              { value: 'date_desc', label: 'Newest first' },
              { value: 'date_asc', label: 'Oldest first' },
              { value: 'added_desc', label: 'Recently added' },
              { value: 'title_asc', label: 'Title A–Z' },
              { value: 'title_desc', label: 'Title Z–A' },
            ]}
            onChange={(value) =>
              update((current) => {
                current.ui.defaultSort = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Hide watched videos by default" hint="You can still switch the filter off on any page.">
          <Toggle
            checked={draft.ui.hideWatched}
            onChange={(value) =>
              update((current) => {
                current.ui.hideWatched = value;
                return current;
              })
            }
          />
        </Row>

        <Row label="Videos per page" hint="Applies to the all-videos, channel and search pages.">
          <NumberField
            value={draft.ui.pageSize}
            min={12}
            max={200}
            onChange={(value) =>
              update((current) => {
                current.ui.pageSize = value;
                return current;
              })
            }
          />
        </Row>
      </section>

      <PasswordPanel />

      <TwoFactorPanel />

      {isAdmin ? <UsersPanel /> : null}

      {/* ------------------------------------------------------------ system */}
      {isAdmin ? (
      <section className="panel">
        <h2>System</h2>
        <p className="panel-sub">
          PinchTube {system?.version ? (/^\d/.test(system.version) ? `v${system.version}` : system.version) : ''}
        </p>

        {system ? (
          <div className="stat-grid">
            <div className="stat">
              <div className="k">Videos</div>
              <div className="v">{system.library.videos.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="k">Channels</div>
              <div className="v">{system.library.channels.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="k">Watched</div>
              <div className="v">{system.library.watched.toLocaleString()}</div>
            </div>
            <div className="stat">
              <div className="k">Cache</div>
              <div className="v">{formatBytes(system.cache.bytes)}</div>
            </div>
            <div className="stat">
              <div className="k">ffmpeg</div>
              <div className="v" style={{ fontSize: 14 }}>
                {system.transcode.ffmpegVersion ?? 'unknown'}
              </div>
            </div>
            <div className="stat">
              <div className="k">Active transcodes</div>
              <div className="v">{system.transcode.activeJobs.length}</div>
            </div>
            <div className="stat">
              <div className="k">Media path</div>
              <div className="v" style={{ fontSize: 13 }}>
                {system.paths.media}
              </div>
            </div>
          </div>
        ) : (
          <Spinner />
        )}

        <div className="viz-panel">
          <SizeCharts />
        </div>
      </section>
      ) : null}

      {/* ----------------------------------------------------------- account */}
      <section className="panel">
        <h2>Account</h2>
        <p className="panel-sub">
          Signed in as <strong>{user?.username}</strong>
          {isAdmin ? ' (administrator)' : ''}.
        </p>
        <button className="btn" onClick={() => void logout()}>
          Sign out
        </button>
      </section>

      {dirty ? (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 'calc(var(--tabbar-h) + var(--safe-b))',
            padding: '12px 16px',
            background: 'var(--surface)',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            justifyContent: 'flex-end',
            zIndex: 44,
          }}
        >
          <span className="muted" style={{ marginRight: 'auto', fontSize: 13 }}>
            You have unsaved changes
          </span>
          <button className="btn" onClick={() => setDraft(settings)} disabled={saving}>
            Discard
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ChannelRowsEditor({
  rows,
  onChange,
}: {
  rows: { id: string; enabled: boolean; pinned: boolean }[];
  onChange: (rows: { id: string; enabled: boolean; pinned: boolean }[]) => void;
}) {
  const [channels, setChannels] = useState<HomeChannelDto[] | null>(null);

  useEffect(() => {
    api
      .get<{ items: HomeChannelDto[] }>('/api/home/channels')
      .then((data) => setChannels(data.items))
      .catch(() => setChannels([]));
  }, []);

  // Pinned channels first in their saved order, then everything else. Channels
  // the settings have never mentioned are simply unpinned and visible.
  const list = useMemo(() => {
    if (!channels) return [] as HomeChannelDto[];
    const byId = new Map(channels.map((channel) => [channel.id, channel]));
    const saved = new Map(rows.map((row) => [row.id, row]));

    const pinned: HomeChannelDto[] = [];
    for (const row of rows) {
      const channel = byId.get(row.id);
      if (channel && row.pinned) pinned.push({ ...channel, enabled: row.enabled, pinned: true });
    }

    const pinnedIds = new Set(pinned.map((channel) => channel.id));
    const rest = channels
      .filter((channel) => !pinnedIds.has(channel.id))
      .map((channel) => {
        const row = saved.get(channel.id);
        return { ...channel, enabled: row ? row.enabled : true, pinned: false };
      });

    return [...pinned, ...rest];
  }, [channels, rows]);

  const pinnedCount = list.filter((channel) => channel.pinned).length;

  const emit = (next: HomeChannelDto[]) =>
    onChange(
      next.map((channel) => ({
        id: channel.id,
        enabled: channel.enabled,
        pinned: channel.pinned,
      })),
    );

  const setAt = (index: number, changes: Partial<HomeChannelDto>) => {
    const next = list.slice();
    next[index] = { ...next[index], ...changes };
    const [moved] = next.splice(index, 1);
    if (changes.pinned === undefined) {
      next.splice(index, 0, moved);
    } else {
      // Pinning appends to the pinned block; unpinning drops in just after it.
      next.splice(next.filter((c) => c.pinned).length, 0, moved);
    }
    emit(next);
  };

  const moveTo = (from: number, to: number) => {
    const next = list.slice();
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    emit(next);
  };

  if (!channels) return <Spinner />;
  if (list.length === 0) {
    return (
      <p className="muted" style={{ fontSize: 13 }}>
        No channels have been scanned yet.
      </p>
    );
  }

  const hidden = list.filter((channel) => !channel.enabled).length;

  return (
    <>
      <SortableList
        items={list}
        keyOf={(channel) => channel.id}
        canDrag={(channel) => channel.pinned}
        // Pinned rows can only be shuffled among themselves.
        canMove={(_from, to) => to < pinnedCount}
        onMove={moveTo}
        renderItem={(channel, index, { handle, dragging }) => (
          <div
            className={`homerow${channel.pinned ? ' pinned draggable' : ''}${
              dragging ? ' dragging' : ''
            }`}
          >
            {handle}

            <button
              type="button"
              className={channel.pinned ? 'pin-btn on' : 'pin-btn'}
              onClick={() => setAt(index, { pinned: !channel.pinned })}
              aria-pressed={channel.pinned}
              title={channel.pinned ? 'Unpin' : 'Pin to the top'}
            >
              <IconPin />
            </button>

            <div className="grow" style={{ minWidth: 0 }}>
              <div className="label" style={{ overflowWrap: 'anywhere' }}>
                {channel.title}
              </div>
              <div className="hint">
                {channel.videoCount.toLocaleString()} videos
                {channel.pinned ? ' · pinned' : ''}
                {channel.enabled ? '' : ' · hidden from home'}
              </div>
            </div>

            <label className="switch" title="Show this channel's row on the home page">
              <input
                type="checkbox"
                checked={channel.enabled}
                onChange={(event) => setAt(index, { enabled: event.target.checked })}
              />
              <span className="track" />
            </label>
          </div>
        )}
      />

      <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        {pinnedCount > 0 ? `${pinnedCount} pinned to the top. ` : ''}
        {hidden > 0 ? `${hidden} hidden from the home page.` : ''}
        {pinnedCount === 0 && hidden === 0 ? 'Every channel follows the default order.' : ''}
      </p>
    </>
  );
}

function PasswordPanel() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [state, setState] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setState(null);
    if (next !== confirm) {
      setState({ kind: 'error', text: 'The two new passwords do not match' });
      return;
    }
    setBusy(true);
    try {
      await api.post('/api/auth/password', { current, next });
      setState({ kind: 'ok', text: 'Password changed. Other devices have been signed out.' });
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err: any) {
      setState({ kind: 'error', text: err?.message ?? 'Could not change the password' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel">
      <h2>Password</h2>
      <p className="panel-sub">Changing this signs out every other device.</p>

      {state ? <div className={`notice ${state.kind}`}>{state.text}</div> : null}

      <form onSubmit={submit}>
        <div className="row">
          <div className="field">
            <label htmlFor="current-pw">Current password</label>
            <input
              id="current-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="new-pw">New password</label>
            <input
              id="new-pw"
              className="input"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              required
            />
          </div>
          <div className="field">
            <label htmlFor="confirm-pw">Confirm new password</label>
            <input
              id="confirm-pw"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </div>
        </div>
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
