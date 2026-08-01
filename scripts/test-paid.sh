#!/usr/bin/env bash
# Validate the FULL (Paid-plan) build locally via Miniflare, which runs the real
# workerd runtime WITHOUT enforcing Cloudflare plan limits (no CPU cap, no
# 3/10 MiB bundle check) i.e. equivalent to an unlimited/Paid plan
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

[ -f build/app.full.wasm ] || { echo "run: pnpm build:ffmpeg (full) first"; exit 1; }
cp build/app.full.wasm build/app.wasm

echo "==> Bundling full build (paid config)"
rm -rf dist-bundle
npx wrangler deploy --dry-run --outdir dist-bundle -c wrangler.paid.toml >/dev/null 2>&1
echo "==> Running Miniflare validation"
node test/miniflare-paid.mjs
