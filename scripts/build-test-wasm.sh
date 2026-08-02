#!/usr/bin/env bash
# Compiles the tiny WASI verification program to test/prog.wasm.
# That artifact is checked into the repo so `pnpm test:node` works without the
# wasi-sdk toolchain. Rebuild it here only when test/prog.c changes
set -euo pipefail
cd "$(dirname "$0")/.."
WASI_SDK="${WASI_SDK:-$PWD/toolchain/wasi-sdk}"
OUT="${OUT:-test/prog.wasm}"
"$WASI_SDK/bin/clang" \
  --target=wasm32-wasi \
  --sysroot="$WASI_SDK/share/wasi-sysroot" \
  -O2 -o "$OUT" test/prog.c
"$WASI_SDK/bin/llvm-strip" -o "$OUT.tmp" "$OUT" 2>/dev/null && mv "$OUT.tmp" "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
