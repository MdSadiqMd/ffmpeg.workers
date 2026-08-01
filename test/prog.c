// Tiny WASI command module used to verify the Worker-side WASI pipeline
// (argv, path_open, fd_read, fd_write, fd_seek, stderr) end to end.
// Usage: prog <in> <out>   -> copies <in> to <out>, uppercasing ASCII, and
// prints a summary to stderr. Mimics how ffmpeg does file-based I/O
#include <stdio.h>
#include <stdlib.h>
#include <ctype.h>

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <in> <out>\n", argv[0]);
    return 2;
  }
  FILE *in = fopen(argv[1], "rb");
  if (!in) { fprintf(stderr, "cannot open input %s\n", argv[1]); return 3; }
  FILE *out = fopen(argv[2], "wb");
  if (!out) { fprintf(stderr, "cannot open output %s\n", argv[2]); return 4; }

  // Determine size via seek to exercise fd_seek.
  fseek(in, 0, SEEK_END);
  long size = ftell(in);
  fseek(in, 0, SEEK_SET);

  unsigned char buf[8192];
  size_t n, total = 0;
  while ((n = fread(buf, 1, sizeof buf, in)) > 0) {
    for (size_t i = 0; i < n; i++) buf[i] = (unsigned char)toupper(buf[i]);
    fwrite(buf, 1, n, out);
    total += n;
  }
  fclose(in);
  fclose(out);
  fprintf(stderr, "prog: in=%ld copied=%zu bytes -> %s\n", size, total, argv[2]);
  return 0;
}
