#!/usr/bin/env bash
# Compiles the tiny WASI verification program to build/app.wasm
set -euo pipefail
cd "$(dirname "$0")/.."
WASI_SDK="${WASI_SDK:-$PWD/toolchain/wasi-sdk}"
"$WASI_SDK/bin/clang" \
  --target=wasm32-wasi \
  --sysroot="$WASI_SDK/share/wasi-sysroot" \
  -O2 -o build/app.wasm test/prog.c
echo "built build/app.wasm ($(du -h build/app.wasm | cut -f1))"
