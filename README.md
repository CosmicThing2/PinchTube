<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/logo-light.svg">
    <img alt="PinchTube" src="docs/assets/logo-light.svg" width="480">
  </picture>
</p>

<p align="center">
  <strong>A self-hosted media server for your Pinchflat video library.</strong>
</p>

<p align="center">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-2ea44f">
  <img alt="Docker Compose" src="https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white">
  <img alt="Hardware transcoding" src="https://img.shields.io/badge/GPU-AMD%20%7C%20Intel%20%7C%20NVIDIA-555">
  <img alt="Mobile friendly" src="https://img.shields.io/badge/mobile-friendly-ff3d5e">
  <a href="LICENSE"><img alt="Licence: GPL-3.0" src="https://img.shields.io/badge/licence-GPL--3.0-blue"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#requirements">Requirements</a> ·
  <a href="#installation">Installation</a> ·
  <a href="docs/GUIDE.md">Full guide</a>
</p>

## About

PinchTube is a self-hosted web app that turns a folder of videos into a familiar,
easy-to-browse streaming site. Point it at a library organised by
[Pinchflat](https://github.com/kieraneglin/pinchflat) and it reads the channels, titles,
descriptions and artwork straight from the files, with nothing copied or changed. You get a home page of rows, channel pages, search, playlists and a player with a
proper quality menu that transcodes on the fly, so the same library plays smoothly on a
desktop or on a phone on mobile data. It runs as a single Docker container on
your own server, with accounts for everyone in the house.

<!--
  Screenshots: add images to docs/assets/ and uncomment this block.

<p align="center">
  <img alt="Home page" src="docs/assets/screenshot-home.png" width="49%">
  <img alt="Watch page" src="docs/assets/screenshot-watch.png" width="49%">
</p>
-->

## Features

- **A familiar home page** — Continue watching, Recently added, Rediscover and a row per
  channel, all reorderable and switchable per user.
- **Reads your library in place** — channels, titles, descriptions, dates and artwork from
  Kodi-style `.nfo` and image files, plus chapters and subtitles; the media folder is
  mounted read-only.
- **Stays up to date by itself** — new videos appear within seconds, with a scheduled
  scan as a safety net.
- **Plays anything, anywhere** — direct play of the original file, or on-demand transcoding
  from 2160p down to 360p plus an audio-only mode.
- **Hardware transcoding** — AMD and Intel (VAAPI, Quick Sync) and NVIDIA (NVENC), tested
  automatically at start-up with a fallback to the CPU.
- **Playlists and a play queue** — drag to reorder, loop, shuffle, per-person quality, and
  optional sharing with the other users.
- **Multiple users** — everyone gets their own watch history, queue, playlists and settings;
  administrators choose which channels each person can see.
- **Built for phones** — bottom tab bar, touch gestures, a data saver mode with its own
  quality, and installable to the home screen.
- **A proper player** — resume where you left off, chapters, SponsorBlock segments with a
  skip button, theater mode, keyboard shortcuts and media controls on the lock screen.
- **Private and secure** — optional two-factor sign-in with any authenticator app, scrypt
  password hashing, sign-in throttling and strict security headers.

## Requirements

| Component | Requirement |
| --- | --- |
| **Host** | A Linux machine running [Docker Engine](https://docs.docker.com/engine/install/) with the Compose plugin (`docker compose`) |
| **CPU** | x86-64. A few cores is plenty; transcoding without a GPU is the heaviest job |
| **Memory** | 1 GB free is comfortable |
| **Disk** | Space for the transcode cache — 20 GB by default, adjustable in settings |
| **Library** | A video library organised by [Pinchflat](https://github.com/kieraneglin/pinchflat) or [Pinchflat-NGX](https://github.com/TheBadFella/pinchflat-ngx), or any folder of videos with Kodi-style `.nfo` files |
| **GPU** *(optional but recommended)* | AMD or Intel with `/dev/dri`, or NVIDIA with the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) |
| **Browser** | Any current version of Chrome, Edge, Firefox or Safari, on desktop or mobile |

## Installation

### Set up Pinchflat/Pinchflat-NGX (Optional but recommended)
> Pinchflat is not required, but without it you'll need to set up all the
> paths, permissions and directories yourself or have another media
> management client which is able to do so. See the [Guide](docs/GUIDE.md) for
> more information.

1. First follow the instructions detailed on [Pinchflat](https://github.com/kieraneglin/pinchflat) or [Pinchflat-NGX](https://github.com/TheBadFella/pinchflat-ngx) to setup and install Pinchflat. Make note of where you set your `/downloads` volume as PinchTube will need read access to the same directory. For this example, assuming you created `/YouTube` on your server to store your videos, you would set the following in your docker-compose.yaml:
```bash
volumes:
      - ./config:/config
      - /YouTube:/downloads
```
2. Now create a media profile for the content (channels or playlists) you wish to download. For the media to be recognised by PinchTube, it should be organised in either of the following formats:

   
`/Downloads Folder/Channel Name/Season 2026/video.mp4`


`/Downloads Folder/Channel Name/video.mp4`


Pinchflat and Pinchflat-NGX both provide a preset called 'Media Center' to pre-populate most of what you need, select this under presets. But the important part is the 'Output path template' which you should set to: `/{{ source_custom_name }}/{{ season_by_year__episode_by_date_and_index }} - {{ title }}.{{ ext }}` which would place your channel folders directly in the 'YouTube' folder.

Other settings can be configured as you wish but the following settings I would recommend:
```
Download Subtitles: On
Embed Subtitles: On
Subtitle Languages: en-orig (just 'en' seems to fail sometimes)
Download Thumbnail: On
Embed Thumbnail: On
Download Metadata: Off
Embed Metadata: On
Redownload Delay (days): 1
Create NFO data: On
Download Series Images: On
Sponsorblock: I'd recommend marking rather than removing, PinchTube is able to recognise marked segments, but up to you
```
3. Next add your sources, these are channels or playlists you wish to download. Follow the normal process in Pinchflat to add these. If you have channel(s) that upload frequently or you want to add many channels, I'd also recommend setting up Fast Indexing but this requires a YouTube [API key](https://github.com/kieraneglin/pinchflat/wiki/Generating-a-YouTube-API-key).

4. Finally confirm that Pinchflat is downloading media correctly. Note that indexing a channel, especially without Fast Indexing, can take quite a while for larger channels, be patient! Once indexed it should start downloading. Confirm the video files land fine, you should end up with the following format if set up like in step 2 above:

```
Channel Name/  
  tvshow.nfo                     
  poster.jpg                      
  Season 2026/                   
    video.mp4                      
    video.nfo                       
    video-thumb.jpg
```

### 1. Download PinchTube

```bash
git clone https://github.com/CosmicThing2/PinchTube.git
cd PinchTube
```

### 2. Configure it

```bash
cp .env.example .env
```

Open `.env` and set `MEDIA_PATH` to Pinchflat's media folder. Everything else has a
sensible default — the port (`8150`), time zone and user IDs are there if you need them.

### 3. Turn on hardware transcoding *(optional)*

Uncomment the block for your GPU at the bottom of `docker-compose.yml`. For AMD and Intel,
also set `RENDER_GID` in `.env` to the output of:

```bash
stat -c '%g' /dev/dri/renderD128
```

Skip this step and PinchTube transcodes on the CPU instead. See
[Hardware acceleration](docs/GUIDE.md#hardware-acceleration) for the details.

### 4. Start it

```bash
docker compose up -d --build
```

The first build takes a few minutes.

### 5. Create your account

The first account needs a one-time setup code, so that nobody else on your network can claim
the server before you do. It is printed in the log:

```bash
docker logs pinchtube
```

Open **`http://<your-server>:8150`**, enter the code and choose a username and password. This
account is the administrator. Add more people under **Settings → Users**.

The first library scan starts on its own; you can follow it under **Settings → Library**.

> [!WARNING]
> PinchTube is designed for a private network: your LAN, or a VPN such as WireGuard or
> Tailscale. I do not recommend exposing it to the public internet. If you do, put it
> behind HTTPS and turn on two-factor sign-in for every account. See
> [Security](docs/GUIDE.md#security).

### Updating

```bash
git pull
docker compose up -d --build
```

Your accounts, history and settings are kept, and database changes are applied
automatically.

## Documentation

The **[full guide](docs/GUIDE.md)** covers everything else: configuration, users and channel
access, two-factor sign-in, playlists, transcoding and GPUs, running behind a reverse proxy,
keyboard shortcuts and troubleshooting.

## Licence

PinchTube is free software, released under the
[GNU General Public License v3.0](LICENSE). You may use, study, share and modify it; if you
distribute a modified version, it must be under the same licence, with its source code
available.

---

<sub>PinchTube is an independent project. It is not affiliated with, endorsed by or
connected to YouTube, Google or Pinchflat.</sub>
