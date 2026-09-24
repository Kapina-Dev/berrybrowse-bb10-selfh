#!/bin/bash
set -e

echo ""
echo "BerryBrowse BB10 Self-Hosted — Installer"
echo "========================================="
echo ""

# ── Helpers ────────────────────────────────────────────────────────────────────

HAS_APT=false
if command -v apt-get &>/dev/null; then HAS_APT=true; fi

MISSING_APT=()
NEED_NODE=false

# ── Check Node.js ──────────────────────────────────────────────────────────────

NODE_OK=false
if command -v node &>/dev/null; then
  NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
  NODE_MAJOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f1)
  NODE_MINOR=$(printf '%s' "$NODE_VERSION" | cut -d. -f2)
  if { [ "${NODE_MAJOR:-0}" -gt 22 ] || { [ "${NODE_MAJOR:-0}" -eq 22 ] && [ "${NODE_MINOR:-0}" -ge 12 ]; }; } 2>/dev/null; then
    echo "Node.js:    $(node --version)  OK"
    NODE_OK=true
  else
    echo "Node.js:    $(node --version)  (too old, need v22.12+)"
    NEED_NODE=true
  fi
else
  echo "Node.js:    not found"
  NEED_NODE=true
fi

if $NEED_NODE; then
  if $HAS_APT; then
    MISSING_APT+=("nodejs (via NodeSource — Node 22 LTS)")
  else
    echo ""
    echo "ERROR: Node.js v22.12+ is required."
    echo "  Install from https://nodejs.org or use your package manager."
    exit 1
  fi
fi

# ── Check Chromium ─────────────────────────────────────────────────────────────

CHROMIUM_FOUND=""
for bin in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v $bin &>/dev/null; then
    CHROMIUM_FOUND=$(command -v $bin)
    break
  fi
done

if [ -n "$CHROMIUM_FOUND" ]; then
  echo "Chromium:   $CHROMIUM_FOUND  OK"
else
  echo "Chromium:   not found"
  if $HAS_APT; then MISSING_APT+=("chromium"); fi
fi

# ── Check Xvfb ─────────────────────────────────────────────────────────────────

XVFB_OK=false
if command -v Xvfb &>/dev/null; then
  echo "Xvfb:       OK"
  XVFB_OK=true
else
  echo "Xvfb:       not found  (virtual display — required for headless Chromium)"
  if $HAS_APT; then MISSING_APT+=("xvfb"); fi
fi

# ── Check PulseAudio ───────────────────────────────────────────────────────────

PULSE_OK=false
if command -v pulseaudio &>/dev/null && command -v pactl &>/dev/null; then
  echo "PulseAudio: $(pulseaudio --version 2>/dev/null | head -1)  OK"
  PULSE_OK=true
else
  echo "PulseAudio: not found  (needed for audio — set AUDIO=false to skip)"
  if $HAS_APT; then MISSING_APT+=("pulseaudio pulseaudio-utils"); fi
fi

# ── Check ffmpeg ───────────────────────────────────────────────────────────────

FFMPEG_OK=false
if command -v ffmpeg &>/dev/null; then
  echo "ffmpeg:     $(ffmpeg -version 2>&1 | head -1 | cut -d' ' -f1-3)  OK"
  FFMPEG_OK=true
else
  echo "ffmpeg:     not found  (needed for audio — set AUDIO=false to skip)"
  if $HAS_APT; then MISSING_APT+=("ffmpeg"); fi
fi

# ── Offer to install missing deps ──────────────────────────────────────────────

if [ ${#MISSING_APT[@]} -gt 0 ]; then
  echo ""
  echo "Missing dependencies:"
  for dep in "${MISSING_APT[@]}"; do echo "  - $dep"; done
  echo ""
  if $NEED_NODE; then
    echo "  Node.js will be installed via:"
    echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "    sudo apt-get install -y nodejs"
    echo ""
  fi
  read -r -p "Install missing packages now? [Y/n]: " REPLY
  REPLY=${REPLY:-Y}
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    if $NEED_NODE; then
      echo ""
      echo "Setting up NodeSource (Node 22 LTS)..."
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
      echo "Node.js: $(node --version)  OK"
      OTHER_PKGS=()
      for dep in "${MISSING_APT[@]}"; do
        [[ "$dep" == nodejs* ]] && continue
        OTHER_PKGS+=("$dep")
      done
      if [ ${#OTHER_PKGS[@]} -gt 0 ]; then
        echo ""
        sudo apt-get install -y "${OTHER_PKGS[@]}"
      fi
    else
      sudo apt-get install -y "${MISSING_APT[@]}"
    fi

    # Re-detect after install
    if [ -z "$CHROMIUM_FOUND" ]; then
      for bin in chromium chromium-browser google-chrome google-chrome-stable; do
        if command -v $bin &>/dev/null; then
          CHROMIUM_FOUND=$(command -v $bin)
          break
        fi
      done
    fi
    if ! $XVFB_OK && command -v Xvfb &>/dev/null;                                    then XVFB_OK=true;  fi
    if ! $PULSE_OK && command -v pulseaudio &>/dev/null && command -v pactl &>/dev/null; then PULSE_OK=true; fi
    if ! $FFMPEG_OK && command -v ffmpeg &>/dev/null;                                 then FFMPEG_OK=true; fi
  else
    echo "Skipping. You can install them manually and re-run this script."
  fi
fi

# ── Install npm dependencies ───────────────────────────────────────────────────

echo ""
echo "Installing npm dependencies..."
npm install
echo "Dependencies installed."

# ── Create .env interactively ─────────────────────────────────────────────────

echo ""
if [ -f .env ]; then
  echo ".env already exists — skipping."
else
  # Resolve Chromium path — prefer detected binary, fall back to common locations
  CPATH=""
  if [ -n "$CHROMIUM_FOUND" ]; then
    CPATH="$CHROMIUM_FOUND"
  else
    for bin in /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome /usr/bin/google-chrome-stable; do
      if [ -x "$bin" ]; then CPATH="$bin"; break; fi
    done
    CPATH="${CPATH:-/usr/bin/chromium}"
  fi

  # Resolve PulseAudio socket — prefer user session socket, fall back to system socket
  PULSE_SOCKET="unix:/run/user/$(id -u)/pulse/native"
  if [ -S "/var/run/pulse/native" ]; then
    PULSE_SOCKET="unix:/var/run/pulse/native"
  fi

  # Enable audio only if all required deps are present
  if $PULSE_OK && $FFMPEG_OK && $XVFB_OK; then
    AUDIO_VAL=true
  else
    AUDIO_VAL=false
  fi

  read -r -p "Set a login password (leave empty for no auth): " BB_PASS
  if [ -z "$BB_PASS" ]; then
    echo "  WARNING: No password set — anyone on your network can access the browser."
  fi

  read -r -p "Port [3000]: " BB_PORT
  BB_PORT=${BB_PORT:-3000}

  cat > .env <<EOF
PASSWORD=$BB_PASS
PORT=$BB_PORT
CHROMIUM_PATH=$CPATH
START_URL=https://duckduckgo.com
IDLE_TIMEOUT=300
UPLOAD_LIMIT=524288000
AUDIO=$AUDIO_VAL
PULSE_SERVER=$PULSE_SOCKET
EOF
  echo ".env created."

  # Verify Chromium path is actually executable
  if [ ! -x "$CPATH" ]; then
    echo ""
    echo "  WARNING: CHROMIUM_PATH=$CPATH does not exist or is not executable."
    echo "  Edit .env and set the correct path before starting the server."
    echo "  Common locations: /usr/bin/chromium  /usr/bin/chromium-browser  /usr/bin/google-chrome"
  fi

  if [ "$AUDIO_VAL" = "false" ] && ( $PULSE_OK || $FFMPEG_OK ); then
    echo ""
    echo "  NOTE: AUDIO=false — some audio dependencies were missing."
    echo "  Install pulseaudio, ffmpeg, and xvfb, then set AUDIO=true in .env."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────────────

LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
BB_PORT_DISPLAY=$(grep '^PORT=' .env 2>/dev/null | cut -d= -f2 || echo "3000")

echo ""
echo "========================================="
echo "  Installation complete."
echo ""
echo "  Start the server:"
echo "    node server-bb10.js"
echo ""
if [ -n "$LAN_IP" ]; then
  echo "  Then open on your BlackBerry 10:"
  echo "    http://${LAN_IP}:${BB_PORT_DISPLAY}"
  echo ""
fi
echo "  For remote access (mobile data):"
echo "    Port-forward ${BB_PORT_DISPLAY} on your router to this machine."
echo "    Use your public IP or a dynamic DNS hostname."
echo "========================================="
echo ""
