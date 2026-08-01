/* Force-included when cross-compiling x264 to wasm32-wasi.
 * wasi-libc has no memalign(); map it onto posix_memalign(). x264 only aligns
 * to powers of two (HUGE_PAGE_SIZE / natural alignments), which posix_memalign
 * accepts */
#ifndef X264_WASI_COMPAT_H
#define X264_WASI_COMPAT_H
#include <stdlib.h>
static inline void *x264_wasi_memalign(size_t alignment, size_t size) {
    void *p = 0;
    if (alignment < sizeof(void *)) alignment = sizeof(void *);
    return posix_memalign(&p, alignment, size) ? 0 : p;
}
#define memalign(a, s) x264_wasi_memalign((a), (s))
#endif
