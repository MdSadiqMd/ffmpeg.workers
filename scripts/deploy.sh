#!/usr/bin/env bash
# Auto plan-aware deploy.
#   Paid plan -> full all-codecs build + cpu_ms=300000 (wrangler.paid.toml)
#   Free plan -> trimmed build, no CPU limit (wrangler.toml)
# It always TRIES the Paid path first and automatically falls back to Free when
# Cloudflare rejects the CPU limit (100328) or the 3 MiB size cap (10027)
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

need() { [ -f "$1" ] || { echo "missing $1 — run: pnpm build:ffmpeg $2"; exit 1; }; }
need build/app.full.wasm full
need build/app.min.wasm min

echo "==> Attempting Paid deploy (full all-codecs build + cpu_ms)"
cp build/app.full.wasm build/app.wasm
OUT="$(npx wrangler deploy -c wrangler.paid.toml 2>&1)"
echo "$OUT" | tail -8

if echo "$OUT" | grep -qiE 'code: 100328|code: 10027|exceeded the size limit|not supported for the Free plan'; then
  echo
  echo "==> Free plan detected — falling back to trimmed build without CPU limit"
  cp build/app.min.wasm build/app.wasm
  npx wrangler deploy -c wrangler.toml 2>&1 | tail -8
elif echo "$OUT" | grep -qiE 'Deployed|Current Version ID'; then
  echo "==> Paid deploy succeeded (full build, cpu_ms=300000)"
else
  echo "==> Deploy failed for another reason (see output above)"; exit 1
fi
