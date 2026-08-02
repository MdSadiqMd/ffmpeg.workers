#!/usr/bin/env bash
# End-to-end test against a running `wrangler dev` on :8787.
# Generates a tiny clip (host ffmpeg, used only to make an input), sends it to
# the Worker for processing, and validates the returned bytes
set -uo pipefail
PORT="${PORT:-8787}"
BASE="http://localhost:$PORT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if [ -n "${SAMPLE:-}" ]; then
  cp "$SAMPLE" "$TMP/in.mp4"
elif command -v ffmpeg >/dev/null; then
  ffmpeg -y -f lavfi -i testsrc=size=320x240:rate=15:duration=2 \
    -f lavfi -i sine=frequency=440:duration=2 \
    -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest "$TMP/in.mp4" >/dev/null 2>&1
else
  echo "provide SAMPLE=path/to.mp4 (no host ffmpeg to synthesize one)"; exit 1
fi
echo "input: $(wc -c < "$TMP/in.mp4") bytes"

pass=0; fail=0
run() { # name  out-ext  args-json
  local name="$1" ext="$2" args="$3"
  local code
  code=$(curl -s -o "$TMP/out.$ext" -D "$TMP/h.txt" -w '%{http_code}' \
    -X POST -H "x-out-ext: $ext" -H "x-ffmpeg-args: $args" \
    --data-binary @"$TMP/in.mp4" "$BASE/")
  local exit_code size
  exit_code=$(grep -i '^x-exit-code' "$TMP/h.txt" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  size=$(wc -c < "$TMP/out.$ext" 2>/dev/null | tr -d ' ')
  if [ "$code" = "200" ] && [ "${size:-0}" -gt 0 ]; then
    echo "PASS  $name -> http=$code exit=$exit_code out=${size}B"
    pass=$((pass+1))
  else
    echo "FAIL  $name -> http=$code exit=$exit_code out=${size}B"
    grep -i '^x-log' "$TMP/h.txt" | sed 's/^[^:]*: //' | tr -d '\r' | base64 -d 2>/dev/null | tail -8
    fail=$((fail+1))
  fi
}

run "transcode mpeg4"     mp4 '["-vf","scale=160:-2","-c:v","mpeg4","-q:v","5","-an"]'
run "thumbnail png"       png '["-frames:v","1","-vf","scale=160:-2","-c:v","png"]'
run "remux copy"          mp4 '["-c","copy"]'
run "audio extract"       m4a '["-vn","-c:a","copy"]'
run "resize mjpeg"        mjpeg '["-frames:v","1","-c:v","mjpeg","-q:v","3"]'

echo "=== $pass passed, $fail failed ==="
[ "$fail" -eq 0 ]
