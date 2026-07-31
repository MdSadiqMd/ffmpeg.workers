#!/usr/bin/env bash
# Generate DECODE-test fixtures derived from the real internet sample, for codecs
# the wasm build cannot ENCODE (so we can't round-trip them through the Worker)
# Uses the host ffmpeg only to PRODUCE inputs; decoding is then done by the Worker
set -uo pipefail
cd "$(dirname "$0")/.."
F=test/fixtures
IN="$F/input.mp4"
[ -f "$IN" ] || { echo "missing $IN"; exit 1; }
command -v ffmpeg >/dev/null || { echo "host ffmpeg required to generate fixtures"; exit 1; }

mk(){ [ -f "$2" ] && return 0; echo "gen $2"; ffmpeg -y -i "$IN" $1 "$2" >/dev/null 2>&1 || echo "  WARN: failed to generate $2"; }

mk "-t 2 -vf scale=480:-2 -c:v libx265 -an"                 "$F/hevc.mp4"
mk "-t 2 -vf scale=480:-2 -c:v libvpx-vp9 -b:v 300k -an"    "$F/vp9.webm"
mk "-t 2 -vf scale=480:-2 -c:v libvpx    -b:v 300k -an"     "$F/vp8.webm"
mk "-t 2 -vn -c:a libmp3lame -b:a 128k"                     "$F/audio.mp3"
mk "-t 2 -vn -c:a libopus -b:a 96k"                         "$F/audio.opus"

echo "=== fixtures ==="
for f in hevc.mp4 vp9.webm vp8.webm audio.mp3 audio.opus; do
  printf "%-14s %s\n" "$f" "$(ffprobe -v error -show_entries stream=codec_name -of csv=p=0 "$F/$f" 2>/dev/null | head -1)"
done
