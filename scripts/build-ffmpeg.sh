#!/usr/bin/env bash
# Cross-compile the ffmpeg CLI to a single-threaded wasm32-wasi command module
# for Cloudflare Workers (no threads / no SharedArrayBuffer there)
#
# Pinned to ffmpeg 4.4: its CLI does NOT depend on `threads` and has no threaded
# scheduler, so it runs correctly single-threaded. FFmpeg >= 5.1 rewrote the CLI
# around a mandatory thread scheduler and cannot run without threads
#
# MODE (arg 1 or $MODE):
#   full (default) -> all built-in codecs. ~5.9 MB gzip. Needs Workers Paid (10 MiB)
#   min            -> curated subset + -Oz + LTO. ~1.5 MB gzip. Fits Free (3 MiB)
set -euo pipefail
MODE="${1:-${MODE:-full}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WASI_SDK="${WASI_SDK:-$ROOT/toolchain/wasi-sdk}"
FF_VERSION="${FF_VERSION:-release/4.4}"
FF_DIR="$ROOT/ffmpeg-build/ffmpeg44"
BUILD="$ROOT/ffmpeg-build/out44"
CC="$WASI_SDK/bin/clang"
ZLIB="$ROOT/ffmpeg-build/zlib-install"

if [ ! -d "$FF_DIR" ]; then
  git clone --depth 1 --branch "$FF_VERSION" https://git.ffmpeg.org/ffmpeg.git "$FF_DIR"
fi

COMMON_DISABLES="--disable-runtime-cpudetect --disable-autodetect --disable-doc --disable-network \
--disable-w32threads --disable-os2threads --disable-pthreads \
--disable-bzlib --disable-iconv --enable-zlib --disable-lzma --disable-sdl2 \
--disable-asm --disable-inline-asm --disable-x86asm --disable-debug \
--disable-ffprobe --disable-ffplay"

if [ "$MODE" = "min" ]; then
  OPT="-Oz"
  DISABLES="$COMMON_DISABLES --enable-lto"
  # Curated broad set that fits the 3 MiB Free-plan cap
  ENABLES="--disable-everything \
--enable-protocol=file,pipe,data \
--enable-demuxer=mov,mp4,m4a,matroska,webm,mp3,wav,aac,flac,ogg,image2,image2pipe,avi,flv,gif,concat,mpegts,asf \
--enable-muxer=mp4,mov,mp3,wav,adts,image2,image2pipe,gif,matroska,webm,flac,ipod,mjpeg,null,ogg \
--enable-decoder=h264,mpeg4,mpeg2video,vp8,theora,aac,mp3,flac,vorbis,opus,pcm_s16le,pcm_s16be,pcm_u8,pcm_f32le,mjpeg,png,gif,bmp,rawvideo,ac3 \
--enable-encoder=mpeg4,mjpeg,png,gif,bmp,aac,ac3,flac,pcm_s16le,rawvideo,ljpeg \
--enable-parser=h264,mpeg4video,mpegvideo,aac,aac_latm,vp8,mjpeg,png,flac,vorbis,opus,mpegaudio,gif \
--enable-filter=scale,scale2ref,crop,fps,format,overlay,transpose,hflip,vflip,pad,rotate,setsar,setdar,drawbox,fade,aformat,aresample,anull,volume,atrim,trim,setpts,asetpts,concat,null,acopy,copy,amix,amerge,silencedetect \
--enable-bsf=h264_mp4toannexb,aac_adtstoasc,extract_extradata,null,vp9_superframe,mpeg4_unpack_bframes"
else
  # full: every built-in codec/format/filter + libx264 (H.264 encode). Paid plan
  OPT="-O2"
  DISABLES="$COMMON_DISABLES"
  ENABLES=""
fi

X264="$ROOT/ffmpeg-build/x264-install"
X264_CFLAGS=""; X264_LDFLAGS=""; X264_ENABLE=""
if [ "$MODE" = "full" ] && [ -f "$X264/lib/libx264.a" ]; then
  X264_CFLAGS="-I$X264/include"
  X264_LDFLAGS="-L$X264/lib"
  X264_ENABLE="--enable-gpl --enable-libx264"
fi

# Stub object for POSIX fns wasi-libc declares but doesn't implement (madvise),
# referenced by libx264. Linked into ffmpeg via extra-ldflags
STUB_OBJ="$ROOT/ffmpeg-build/wasi_stubs.o"
"$CC" --target=wasm32-wasi --sysroot="$WASI_SDK/share/wasi-sysroot" -O2 -c "$ROOT/scripts/wasi_stubs.c" -o "$STUB_OBJ"

EXTRA_CFLAGS="-DWASM32_WASI $OPT -fno-exceptions -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_GETPID --target=wasm32-wasi -I$ZLIB/include $X264_CFLAGS"
EXTRA_LDFLAGS="-lwasi-emulated-process-clocks -lwasi-emulated-signal -lwasi-emulated-mman -lwasi-emulated-getpid --target=wasm32-wasi -Wl,-z,stack-size=1048576 -L$ZLIB/lib $X264_LDFLAGS $STUB_OBJ"
DISABLES="$DISABLES $X264_ENABLE"

rm -rf "$BUILD" && mkdir -p "$BUILD" && cd "$BUILD"

"$FF_DIR/configure" \
  --prefix="$BUILD/install" \
  --arch=wasm32 --target-os=android --enable-cross-compile \
  --cc="$CC" --cxx="$WASI_SDK/bin/clang++" --ld="$CC" \
  --ar="$WASI_SDK/bin/llvm-ar" --nm="$WASI_SDK/bin/llvm-nm" \
  --ranlib="$WASI_SDK/bin/llvm-ranlib" --strip="$WASI_SDK/bin/llvm-strip" \
  --objcc="$CC" --dep-cc="$CC" \
  $DISABLES $ENABLES \
  --extra-cflags="$EXTRA_CFLAGS" --extra-ldflags="$EXTRA_LDFLAGS" \
  2>&1 | tail -20

echo "=== configure: CONFIG_FFMPEG ==="
grep -E '^!?CONFIG_FFMPEG=' ffbuild/config.mak || true

echo "=== building ($MODE) ==="
make -j"$(sysctl -n hw.ncpu)" >/tmp/ff44make.log 2>&1
if [ -f ffmpeg ]; then
  OUT="$ROOT/build/app.$MODE.wasm"
  cp ffmpeg "$OUT"
  echo "BUILT $MODE: $(ls -lh "$OUT" | awk '{print $5}') raw, $(gzip -9 -c "$OUT" | wc -c | awk '{printf "%.2f MB",$1/1048576}') gzip -> $OUT"
else
  echo "BUILD FAILED ($MODE)"; grep -iE 'error:|undefined symbol|make: \*\*\*' /tmp/ff44make.log | tail -20; exit 1
fi
