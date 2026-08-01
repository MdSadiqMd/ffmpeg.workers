/* No-op stubs for POSIX functions that wasi-libc declares but does not
 * implement, and that pulled-in static libs (e.g. libx264) reference */
#include <stddef.h>

int madvise(void *addr, size_t length, int advice) {
    (void)addr; (void)length; (void)advice;
    return 0; /* advisory only; safe to ignore */
}

int posix_madvise(void *addr, size_t length, int advice) {
    (void)addr; (void)length; (void)advice;
    return 0;
}
