# PinchTube — the full guide

Everything about installing, configuring and running PinchTube. For the short version, see
the [README](../README.md).

PinchTube is a small, self-hosted web app for watching a library of downloaded YouTube
videos. It reads your media folder directly, reads the Kodi-style `.nfo` sidecars that
downloaders such as Pinchflat or ytdl-sub write, and presents everything as a YouTube-style
site with rows of videos, per-channel pages, resume support, playlists and on-demand
transcoding with a real quality menu.

It runs as a single Docker container. It is designed for a private network — see
[Security](#security) before putting it anywhere else.

---

## What it does

- **Reads your library in place.** Nothing is copied or moved; the media folder is mounted
  read-only. Titles, descriptions and dates come from the `.nfo` files, artwork from the
  `-thumb.jpg` / `poster.jpg` / `banner.jpg` / `fanart.jpg` files.
- **Keeps itself up to date.** An incremental scan runs on a schedule (hourly by default)
  and a filesystem watcher picks up new downloads within seconds.
- **Plays anywhere.** Direct play of the original file when your browser can decode it, and
  on-demand HLS transcoding (2160p down to 360p) when it cannot, or when you pick a lower
  quality, plus an audio-only mode. Hardware-accelerated on AMD, Intel and NVIDIA GPUs.
- **Has room for everyone.** Multiple accounts, each with its own watch history, queue,
  playlists and personal settings. Administrators decide which channels each person can see.
- **Remembers where you were.** Watch progress, a Continue Watching row, watched badges and
  an unwatched filter.
- **Playlists and a play queue.** Build playlists like on YouTube — reorder by dragging,
  loop, shuffle, a fixed quality per playlist — and optionally share them with the other
  users. The queue collects videos to play one after another.
- **Works properly on a phone.** Bottom tab bar, touch scrubbing, double-tap to skip,
  fullscreen swipe gestures, a data saver mode, installable to the home screen.
- **Bends to how you like it.** Theater mode, chapters, SponsorBlock segments, adjustable
  subtitle size, and a home page whose rows — including each channel row — you can reorder
  and switch off.
- **Is private.** scrypt password hashing, optional two-factor sign-in with any
  authenticator app, signed HTTP-only session cookies and every API route behind
  authentication.

---

## Quick start

1. **Copy `.env.example` to `.env`** and set at least `MEDIA_PATH` to the folder holding your
   downloads. Everything else has a sensible default.

2. **Turn on hardware transcoding (optional).** Uncomment the block for your GPU at the
   bottom of `docker-compose.yml` — see [Hardware acceleration](#hardware-acceleration).

3. **Build and start it:**

   ```bash
   docker compose up -d --build
   ```

4. **Find the setup code.** Until the first account exists, creating it needs a one-off code
   that is printed to the log, so that nobody else on the network can claim your server
   first:

   ```bash
   docker logs pinchtube
   ```

5. **Open `http://<server-ip>:8150`**, enter the setup code and create the first account.
   It becomes the administrator. Further accounts are added under **Settings → Users**.

6. The first scan starts automatically. Watch its progress under **Settings → Library**.
   The first pass runs `ffprobe` over every video to work out durations and resolutions, so
   for a large library it can take a few minutes. Later scans only look at folders whose
   contents changed.

---

## Expected folder layout

Either with season folders:

```
/media/
  Channel Name/
    tvshow.nfo          <title> and <plot> for the channel
    poster.jpg          used as the channel avatar
    banner.jpg          used as the channel header
    fanart.jpg          fallback header
    Season 2026/
      video.mp4
      video.nfo         <title>, <plot>, <aired>, <uniqueid type="youtube">
      video-thumb.jpg
      video.en.srt      optional — picked up automatically
```

or with the videos straight inside the channel folder:

```
/media/
  Channel Name/
    tvshow.nfo
    poster.jpg
    video.mp4
    video.nfo
    video-thumb.jpg
```

Anything that does not fit is handled gracefully: a missing `.nfo` falls back to the
filename and the file's modification time, a missing thumbnail is extracted from the video
itself, and `.mkv`, `.webm`, `.m4v` and friends are scanned alongside `.mp4`. Partial
downloads (`.part`, `.temp.mp4` and similar) are ignored.

`<aired>` is parsed from `2026-07-10 00:00:00Z`, `2026-07-10T00:00:00Z` and plain
`2026-07-10`. It is what "release date" sorting uses. "Recently added" uses the file's
modification time instead, which is when the downloader wrote it.

---

## Configuration

Almost everything is configured in the app itself, under **Settings**, and stored in the
database. Library and transcoding settings are shared by the whole server and only
administrators can change them; everything else — home page layout, playback preferences,
theme — is each user's own.

The variables in `.env` only cover things Docker needs before the app starts:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEDIA_PATH` | `./media` | Folder on the host holding your downloads (mounted read-only) |
| `HOST_PORT` | `8150` | Port on the host |
| `BIND_ADDRESS` | `0.0.0.0` | `127.0.0.1` to accept connections from this machine only |
| `TZ` | `Etc/UTC` | Time zone for log timestamps |
| `PUID` / `PGID` | `1000` | The user the app runs as |
| `RENDER_GID` | `44` | AMD/Intel only: host group owning `/dev/dri/renderD128` |
| `SECURE_COOKIES` | `auto` | `auto` marks cookies Secure on HTTPS requests; or force `true`/`false` |
| `TRUST_PROXY` | `false` | `true` only behind a reverse proxy |
| `LOG_LEVEL` | `info` | `debug` is useful for tracing transcode jobs |

Inside the container the media folder is always `/media`, which is also the default path in
**Settings → Library**.

### Running as a normal user

The app process runs as `PUID:PGID` (1000:1000 by default), never as root. Nothing in it
needs root: the port is above 1024, the media mount is read-only, and GPU access comes from
a supplementary group.

When a bind-mounted host path does not exist yet, the *Docker daemon* creates it, as root,
before the container starts — so the container cannot create those folders with the right
owner. To deal with that, the entrypoint starts as root, takes ownership of `/config` and
`/cache` if it is wrong, then drops to `PUID:PGID` and hands over to the app. Root exists
only for those few milliseconds, and only to call `chown`.

If you would rather it never ran as root at all, set `user: "1000:1000"` in the compose
file and create the folders yourself first. The entrypoint detects that it is already
unprivileged and execs straight through.

### Machine-specific changes

`docker compose` automatically merges a `docker-compose.override.yml` next to the main file,
which is a tidy place for changes only your machine needs (a GPU block, extra volumes) so
that `docker-compose.yml` itself can be updated freely. That file is in `.gitignore`.

---

## Users

- The first account is an **administrator**. Administrators can change library and
  transcoding settings, manage users and see the system overview. There is always at least
  one administrator: the last one cannot be demoted or deleted.
- Everyone else sees the **personal** parts of Settings only — home page, playback,
  interface, password and two-factor sign-in.
- Each user has their own watch progress, watched badges, Continue Watching row, queue,
  playlists and settings.
- **Channel access.** New users can see every channel, including ones added later. Turn
  off **All channels** for a user to pick the channels they may see instead; everything
  else — videos, thumbnails, streams, search, shared playlists — is hidden from them.

### Two-factor sign-in

Optional, per user, under **Settings → Two-factor sign-in**. Scan the QR code with any
authenticator app (Google Authenticator, Authy, 1Password, Aegis, Bitwarden…), enter a code
to confirm, and save the ten recovery codes it shows — each signs you in once if you lose the
phone. Turning it off again needs your password. An administrator can reset it for a user
who has lost both phone and codes.

The QR code is drawn by the server itself; the secret is never sent to a third-party
service.

---

## Playlists and the queue

**Playlists** live under *Playlists* in the sidebar (on a phone, under the *Library* tab).
Add a video to one with **Save** under the player. On a playlist's page you can drag videos
into order, remove them, rename the list, and tick **Share with everyone** to let the other
users play it (read-only). Loop and shuffle are in the box beside the player.

- **Quality** is per person: everyone who plays a playlist, owner or not, can pick the
  quality it plays at for them without affecting anyone else.
- **Strict access permissions** (on by default) means people only see the videos in a shared
  playlist from channels they have access to. Turn it off to let everyone it is shared with
  play every video in it — a way to hand someone a few particular videos without giving them
  the whole channel. Those videos still do not appear in their search, home page or channel
  lists.

**The queue** collects videos to play one after another. **Queue → Add videos** puts the app
into collecting mode: every video card becomes a one-tap "add to queue", so a queue can be
built quickly on a phone. **Play all** then works through it, dropping each video as it
finishes (configurable under Settings → Playback).

Data saver always wins over a playlist's or the queue's own quality, since its whole point is
a ceiling on data use.

---

## Transcoding

The quality menu offers:

- **Original** — the file is streamed byte-for-byte with range requests. No CPU cost.
- **Auto** — adaptive bitrate across the transcoded ladder; the player picks a rung from
  the measured bandwidth.
- **A specific rung** — 2160p / 1440p / 1080p / 720p / 480p / 360p, never above the source
  resolution.
- **Audio only** — the video stream is dropped entirely. It sits outside the adaptive
  ladder deliberately, so a bandwidth dip can never silently take the picture away.

Transcoding is on demand: the playlist is generated instantly from the known duration, and
each segment is encoded only when the player asks for it. Seeking far ahead restarts the
encoder at that point. Finished segments are cached under an LRU budget (20 GB by default),
so rewatching costs nothing.

If the browser cannot decode the original file — a VP9 or AV1 download on Safari, for
example — the player notices the media error and switches itself to Auto.

### Hardware acceleration

At start-up the app runs a short test encode with each GPU route it finds, and only uses the
ones that actually work. **Settings → Transcoding** shows the result for each, and lets you
pick one or leave it on **Auto** (NVIDIA first, then VAAPI, then Quick Sync). If the GPU
pipeline fails on a particular video, that video is retried in software and remembered.

**AMD (VAAPI).** Uncomment the AMD/Intel block in `docker-compose.yml` and set `RENDER_GID`
in `.env` to the group that owns the render node:

```bash
stat -c '%g' /dev/dri/renderD128
```

The image is based on Debian 13 (trixie), whose Mesa 25 supports video encode on recent
AMD GPUs including RDNA3 iGPUs such as the Radeon 780M. To confirm the GPU is visible:

```bash
docker compose exec pinchtube vainfo
```

You should see `VAEntrypointEncSlice` for `VAProfileH264*`.

**Intel (VAAPI or Quick Sync).** Same compose block as AMD. The image includes Intel's
media driver and oneVPL runtime (x86-64 only), so both **VAAPI** and **Quick Sync** are
available; VAAPI is the more forgiving of the two, Quick Sync can be a little faster.

**NVIDIA (NVENC).** Install the
[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)
on the host, then uncomment the NVIDIA block in `docker-compose.yml` (and the two
environment variables it mentions). Scaling runs on the GPU when the ffmpeg build includes
CUDA filters, and on the CPU otherwise. If Settings → Transcoding reports that this ffmpeg
build has no NVENC support, point `FFMPEG_PATH` / `FFPROBE_PATH` at an ffmpeg that has it.

Without any GPU, `libx264` is used; a modern desktop CPU handles a couple of simultaneous
1080p transcodes comfortably, and **Original** quality needs no transcoding at all.

---

## Security

PinchTube is meant to be reached over a private network — a LAN, or a VPN such as WireGuard
or Tailscale. **Exposing it directly to the internet is not recommended.** However, that
also doesn't mean it compromises on security:

- Every `/api/` route requires a session unless it is explicitly public (sign-in, status,
  health). The check uses the route Fastify actually matched, not the raw URL.
- Passwords are hashed with scrypt; a sign-in for a username that does not exist takes as
  long as one with a wrong password.
- Repeated failed sign-ins lock out both the source address and the username for 15
  minutes.
- Optional TOTP two-factor sign-in, with replay protection and single-use recovery codes.
- The first account can only be created with a setup code from the server log.
- Session cookies are signed, `HttpOnly` and `SameSite=Lax`, and `Secure` over HTTPS.
- Requests that change anything must carry an `X-Requested-With` header, which blocks
  cross-site request forgery.
- A strict Content Security Policy, `X-Frame-Options: DENY`, `nosniff` and a same-origin
  referrer policy on every response; API responses are never cached.
- Users can only see, stream or list videos from channels they have access to, plus any
  videos in a shared playlist whose owner turned strict access permissions off.
- The media folder is mounted read-only and the app never runs as root.

If you must expose it, put it behind HTTPS and turn on two-factor sign-in for every account.

### Behind a reverse proxy

Set `TRUST_PROXY=true` so the real client address is used for sign-in throttling, and
`BIND_ADDRESS=127.0.0.1` if the proxy runs on the same machine. A minimal Caddyfile:

```
media.example.internal {
    reverse_proxy localhost:8150
}
```

Serving over HTTPS also enables the service worker and full PWA install. Over plain HTTP
the app still works and iOS will still add it to the home screen in fullscreen mode.

---

## Upgrading

Pull or copy the new version, then `docker compose up -d --build`. Database changes are
applied automatically on start. When upgrading from a single-user version, the existing
account becomes the administrator and keeps its watch history, queue and settings.

---

## Development

Node 22 and ffmpeg are needed locally.

```bash
cd server && npm install && npm run dev
```

```bash
cd web && npm install && npm run dev
```

The Vite dev server on `http://localhost:5173` proxies `/api` to `http://localhost:8080`.
Point the server at a local library with environment variables:

```bash
DATA_DIR=./.data CACHE_DIR=./.cache MEDIA_DIR=/path/to/media npm run dev
```

Both packages are transpiled without type checking so a stray type error can never break a
Docker build. Run the checks explicitly when you want them:

```bash
cd server && npm run typecheck
cd web && npm run typecheck
```

---

## How it is put together

```
server/src
  index.ts              Fastify setup, auth gate, security headers, SPA hosting
  config.ts             environment configuration and paths
  db.ts                 SQLite schema and migrations
  settings.ts           global and per-user settings, validation, persistence
  auth.ts               scrypt hashing, sessions, throttling, setup code
  totp.ts               two-factor codes (RFC 6238) and recovery codes
  library/
    scanner.ts          incremental filesystem scan
    manager.ts          scan schedule and filesystem watcher
    nfo.ts              Kodi-style .nfo parsing
    ffprobe.ts          duration, resolution, codec and chapter probing
  media/
    renditions.ts       the quality ladder
    hwaccel.ts          GPU detection and start-up test encodes
    transcoder.ts       on-demand segment production
    hls.ts              playlist generation
    cache.ts            LRU eviction of cached segments
    images.ts           thumbnail resizing
  routes/               HTTP endpoints
  lib/videos.ts         library queries, channel access, queue
  lib/playlists.ts      playlists

web/src
  main.tsx              routing
  lib/                  API client, formatting, app state
  components/           shell, cards, rails, panels, dialogs
  pages/                home, videos, channels, watch, playlists, search, settings
  player/Player.tsx     the video player and its controls
```

State lives in SQLite at `/config/ytmedia.db`. Video IDs are a hash of the path relative to
the media root, so watch progress survives a file being removed and downloaded again.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Space` / `K` | Play or pause |
| `←` / `→` | Skip back / forward |
| `J` / `L` | Skip 30 seconds |
| `0`–`9` | Jump to 0%–90% |
| `Shift` + `N` / `P` | Next / previous in the queue or playlist |
| `F` | Fullscreen |
| `T` | Theater mode |
| `M` | Mute |
| `C` | Toggle subtitles |

On a phone: tap to show controls, double-tap the left or right half to skip, drag the
progress bar to scrub; in fullscreen, swipe up and down on the right for volume and on the
left for brightness.

---

## Troubleshooting

**"That setup code is not right"** — the code is printed by `docker logs pinchtube` each time
the server starts, until the first account exists. Restarting prints a new one.

**"Media folder does not exist"** — the path in settings is the path *inside* the
container, which is `/media` with the supplied compose file whatever the folder is called on
the host. Use the **Check** button next to the path to list the channel folders it can see.

**New downloads do not appear** — if the media folder is on NFS or SMB, inotify events
never fire. Turn on **Use polling for the watcher** in Settings → Library, or rely on the
scheduled scan.

**Playback stalls on the first segment** — the encoder is starting up. If it never
recovers, check `docker compose logs pinchtube` for ffmpeg errors, and try forcing
**Software only** under Settings → Transcoding to rule out a GPU problem.

**A video shows no quality options** — its duration is unknown, which means `ffprobe`
could not read it. Run a **Full rescan** from Settings → Library.

**A user cannot see a channel** — check **All channels**, or the channel ticks, for that
user under Settings → Users.

**The container will not start, with a permission error** — the entrypoint should fix
`data` ownership on its own. If you have set `user:` in the compose file it cannot, so
correct it by hand: `sudo chown -R 1000:1000 data`.

**The container will not start: "error gathering device information" for `/dev/dri`** —
the host has no GPU render node. Comment the `devices:` block out again.
