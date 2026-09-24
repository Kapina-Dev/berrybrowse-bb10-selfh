# BerryBrowse BB10 Self-Hosted

Standalone self-hosted remote browser for BlackBerry 10.

Full BB10 WebSocket experience — screenshot stream, multi-tab, audio streaming, drag, uploads, downloads, bookmarks, zoom — without accounts, payments, or multi-user infrastructure.

## Project identity and acknowledgment

BerryBrowse is an independent proxy browser designed for BlackBerry WebKit
devices. It is not affiliated with and should not be confused with
**BerryBrowser by sw7ft**.

Respect and thanks to **sw7ft** for BerryBrowser, BerryCore, and his wider
efforts to keep BlackBerry devices alive and useful.

## Requirements

- Linux (Debian/Ubuntu recommended)
- Node.js v22.12+ (installer will set up Node 22 LTS if missing)
- Chromium or Google Chrome
- PulseAudio + ffmpeg (for audio streaming — set `AUDIO=false` to skip)

## Install

```bash
bash install-bb10.sh
```

The installer will:
- Check (and offer to install) Node.js 22 LTS, Chromium, PulseAudio, ffmpeg
- Install npm dependencies
- Prompt for a login password and port
- Create a `.env` config file

## Configure

Edit `.env` at any time:

```
PASSWORD=yourpassword
PORT=3000
CHROMIUM_PATH=/usr/bin/chromium-browser
START_URL=https://duckduckgo.com
IDLE_TIMEOUT=300
UPLOAD_LIMIT=524288000
AUDIO=true
PULSE_SERVER=unix:/var/run/pulse/native
AUDIO_BITRATE=128k
AUDIO_SAMPLE_RATE=44100
```

| Option | Description | Default |
|---|---|---|
| `PASSWORD` | Login password (leave empty for no auth) | *(empty)* |
| `PORT` | Server port | 3000 |
| `CHROMIUM_PATH` | Path to Chromium binary | /usr/bin/chromium-browser |
| `START_URL` | Page loaded on session start | https://duckduckgo.com |
| `IDLE_TIMEOUT` | Seconds before idle session closes (0 = disabled) | 300 |
| `UPLOAD_LIMIT` | Max upload size in bytes | 524288000 (500 MB) |
| `AUDIO` | Enable audio streaming (requires PulseAudio + ffmpeg) | true |
| `PULSE_SERVER` | PulseAudio socket path | unix:/var/run/pulse/native |
| `AUDIO_BITRATE` | Audio stream bitrate | 128k |
| `AUDIO_SAMPLE_RATE` | Audio sample rate | 44100 |

## Run

```bash
npm start
```

Open `http://your-server-ip:3000` in the BlackBerry 10 browser.

## Features

- Full WebSocket screenshot stream at up to 50ms intervals (MAX quality)
- All quality presets freely selectable (LOW / MED / HI / MAX)
- **Multi-tab** — open a second tab (e.g. Spotify) while browsing on tab 1
- Smart scroll — finds the scrollable element under your finger
- Audio streaming to BB10 browser (PulseAudio → ffmpeg → MP3)
- Mobile / Desktop mode toggle
- Zoom (25%–200%)
- Long-press drag for sliders and CAPTCHAs
- File downloads (no size limit)
- File uploads (no size limit)
- Bookmarks (stored in browser localStorage)
- Session history
- Physical keyboard passthrough
- Ping / latency indicator
- Fast page crash recovery (~15s)
- 30-second reconnect grace period (session survives brief disconnects)
- Single persistent Chromium profile (saved between sessions)
- Singleton lock cleanup (safe restart after crash)

## Remote access (mobile data)

Do not expose the app directly over plain HTTP: the login password, browser images,
keystrokes, uploads, and downloads would cross the network without encryption.
Put it behind an HTTPS reverse proxy or a private VPN, then open that protected URL
on the BlackBerry 10 device.

Set a strong `PASSWORD` before allowing access from another device. This small
self-hosted app does not include login rate limiting and is intended for one trusted
user, not as a public multi-user service.

## Audio setup

PulseAudio must be running as a daemon:

```bash
pulseaudio --start --daemonize=true --exit-idle-time=-1
```

If you don't need audio, set `AUDIO=false` in `.env` — PulseAudio and ffmpeg are not required in that case.

## License

MIT — see [LICENSE](LICENSE).
