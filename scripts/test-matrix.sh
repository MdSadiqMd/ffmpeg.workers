#!/usr/bin/env bash
# Rigorous, ffprobe-validated codec/encoder/filter matrix against the FULL build,
# run locally via Miniflare, operating on a REAL internet video
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
F=test/fixtures
mkdir -p "$F"

if [ ! -f "$F/input.mp4" ] || ! ffprobe -v error "$F/input.mp4" >/dev/null 2>&1; then
  echo "==> downloading real sample"
  curl -sL -o "$F/input.mp4" "https://samplelib.com/lib/preview/mp4/sample-10s.mp4" \
    || curl -sL -o "$F/input.mp4" "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4"
fi

echo "==> generating decode fixtures (host ffmpeg, derived from the real file)"
bash scripts/gen-fixtures.sh || true

[ -f build/app.full.wasm ] || { echo "run: pnpm build:ffmpeg (full) first"; exit 1; }
cp build/app.full.wasm build/app.wasm
echo "==> bundling full build"
rm -rf dist-bundle && npx wrangler deploy --dry-run --outdir dist-bundle -c wrangler.paid.toml >/dev/null 2>&1

echo "==> running matrix in Miniflare"
node test/full-matrix.mjs
