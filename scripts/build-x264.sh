#!/usr/bin/env bash
# Cross-compile libx264 (static) to wasm32-wasi so the full ffmpeg build can
# ENCODE H.264. Single-threaded, no asm (wasm has neither)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASI_SDK="${WASI_SDK:-$ROOT/toolchain/wasi-sdk}"
SRC="$ROOT/ffmpeg-build/x264"
PREFIX="$ROOT/ffmpeg-build/x264-install"
SYSROOT="$WASI_SDK/share/wasi-sysroot"

cd "$SRC"
git checkout -- . 2>/dev/null || true
make distclean >/dev/null 2>&1 || true

CC="$WASI_SDK/bin/clang" \
AR="$WASI_SDK/bin/llvm-ar" \
RANLIB="$WASI_SDK/bin/llvm-ranlib" \
STRIP="$WASI_SDK/bin/llvm-strip" \
./configure \
  --prefix="$PREFIX" \
  --host=i686-linux \
  --enable-static --disable-cli --disable-asm --disable-thread \
  --disable-opencl --disable-interlaced \
  --extra-cflags="--target=wasm32-wasi --sysroot=$SYSROOT -O2 -fno-exceptions -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN -include $ROOT/scripts/x264-wasi-compat.h" \
  2>&1 | tail -20

# The i686-linux host triple (used only so config.sub validates) injects -m32,
# which is meaningless for wasm32. Strip it.
sed -i '' 's/-m32//g' config.mak

make -j"$(sysctl -n hw.ncpu)" 2>&1 | tail -10
make install 2>&1 | tail -3
echo "=== x264 artifacts ==="
ls -lh "$PREFIX/lib/libx264.a" "$PREFIX/include/x264.h"
