#!/bin/bash
# Download Windows ffmpeg binary for cross-platform Electron builds.
# ffmpeg-static npm package only downloads the host platform binary,
# so when building on Linux for Windows we need to fetch it separately.

set -euo pipefail

FFMPEG_DIR="resources/ffmpeg"
FFMPEG_EXE="$FFMPEG_DIR/ffmpeg.exe"

if [ -f "$FFMPEG_EXE" ]; then
  echo "ffmpeg.exe already present at $FFMPEG_EXE"
  exit 0
fi

mkdir -p "$FFMPEG_DIR"

# ffmpeg-static v5.x uses GitHub releases from eugeneware/ffmpeg-static
# Binary URL pattern: https://github.com/eugeneware/ffmpeg-static/releases/download/b5.0.1/win32-x64.gz
VERSION="b5.0.1"
URL="https://github.com/eugeneware/ffmpeg-static/releases/download/${VERSION}/win32-x64.gz"

echo "Downloading Windows ffmpeg from $URL..."
curl -L --fail "$URL" | gunzip > "$FFMPEG_EXE"
chmod +x "$FFMPEG_EXE"

echo "Saved to $FFMPEG_EXE ($(du -h "$FFMPEG_EXE" | cut -f1))"
