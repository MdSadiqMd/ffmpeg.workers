# ffmpeg-workers

A general FFmpeg HTTP API that executes entirely inside a single Cloudflare worker isolate(no third-party services nor other Cloudflare services)

Send a media file the worker runs `ffmpeg` (compiled to `wasm32-wasi`) against an in-memory `/tmp`, and returns the output

Brief info of how it works
1. A media file arrives as a POST - raw bytes, multipart, or a JSON job spec
2. The worker writes it to the in-memory /tmp virtual filesystem and builds the ffmpeg argv
3. ffmpeg runs as a single-threaded wasm32-wasi command module (--disable-pthreads, the ≥6.1 CLI needs threads Workers lacks)
4. It's statically imported, so Wrangler precompiles it to a WebAssembly. Module at deploy time, runtime compilation is blocked by the embedder
5. Workers node:wasi is a throwing stub, so we wrote our own synchronous wasi_snapshot_preview1 shim over node:fs
6. Wasm calls its imports synchronously, so every syscall ffmpeg makes (path_open, fd_read, fd_write, …) maps 1:1 to a blocking openSync/readSync/writeSync(an async shim or JSPI is impossible ig)
7. workerd rejects reads/writes against Wasm-memory subarrays, so the shim copies every slice into a standalone Buffer first
8. A fresh WASI instance starts, and inside the module ffmpeg demuxes /tmp/in, decodes, runs the filtergraph (scale, overlay, …), re-encodes, and muxes /tmp/out
9. The Worker reads /tmp/out back and streams it to the client with x-exit-code and x-log headers
10. Input, output, and the ffmpeg heap all share one 128 MB isolate, so inputs are guarded at 30 MB each / 80 MB per job
11. The WASI sandbox has no network, so the Worker layer fetch()es inputs[].url before ffmpeg runs and PUTs results to outputUrl after
12. Multi-file outputs (frames, HLS segments) come back as a ZIP, two-pass works via runs[] sequential ffmpeg commands sharing the same /tmp
13. Deploy is plan-aware: scripts/deploy.sh tries the full build (6.16 MB gzip, libx264, cpu_ms=300000 via wrangler.paid.toml) and falls back to the trimmed build (1.54 MB gzip, 3 MiB Free cap) when Cloudflare rejects it
## Architecture Diagram
```mermaid

flowchart TD

CL[Client] -->|"POST / — raw media bytes, JSON job, or multipart"| WH["Worker fetch handler<br/>(parse, size guard, build argv)"]

  

subgraph ONE["Inside ONE Cloudflare Worker isolate"]

WH -->|"writes input to /tmp, runs ffmpeg"| FS["node:fs VFS<br/>in-memory /tmp"]

FS -->|"synchronous syscalls"| SH["WASI shim<br/>(wasi_snapshot_preview1)"]

SH -->|"path_open / fd_read / fd_write / proc_exit"| FF["ffmpeg.wasm<br/>(wasm32-wasi, single-thread)<br/>demux → decode → filter → encode → mux"]

FF -->|"writes output to /tmp"| FS

FS -->|"reads /tmp/out"| WH

end

  

WH -->|"200 media bytes, ZIP,<br/>or 422 + ffmpeg log"| CL

```
### In depth Protocol Flow
```mermaid

sequenceDiagram

participant C as Client

participant W as Worker (fetch handler)

participant J as job runner

participant SH as WASI shim (wasi_snapshot_preview1)

participant M as Wasm linear memory

participant FS as node:fs VFS (/tmp, in-memory)

participant FF as ffmpeg.wasm (CLI main)

participant DEM as demuxer (mp4/mkv/…)

participant DEC as decoder (h264/aac/…)

participant FLT as filtergraph (scale/crop/…)

participant ENC as encoder (mpeg4/x264/aac/…)

participant MUX as muxer (mp4/gif/…)

participant DEV as Developer

participant SDK as wasi-sdk (clang)

participant WR as Wrangler (esbuild)

participant CF as Cloudflare API

  

Note over DEV,CF: PHASE 0 — BUILD & DEPLOY (once, diagram 5)

DEV->>SDK: configure ffmpeg 4.4 (single-thread) + zlib + libx264

SDK-->>DEV: build/app.{full,min}.wasm

DEV->>WR: pnpm deploy (scripts/deploy.sh)

WR->>WR: static import ../build/app.wasm → precompile to WebAssembly.Module

WR->>CF: upload (full + cpu_ms via wrangler.paid.toml)

alt Paid plan

CF-->>WR: Deployed (10 MiB, cpu_ms=300000)

else Free plan (100328 / 10027)

WR->>WR: swap to app.min.wasm, drop cpu_ms

WR->>CF: upload (wrangler.toml)

CF-->>WR: Deployed (3 MiB, default CPU)

end

  

Note over C,FS: PHASE 1 — REQUEST HANDLING (diagram 2)

C->>W: POST / — raw media bytes + headers,<br/>JSON job, or multipart form

alt GET /

W-->>C: help text

else GET /health

W-->>C: ok

else GET /fsdebug

W-->>C: VFS self-test

end

W->>W: route by content-type → runLegacy / runJob [worker.ts:473]

alt legacy — body bytes (or fetch x-input-url)

W->>W: input = await req.arrayBuffer()

alt input == 0 bytes

W-->>C: 400 empty body

else input > 30 MB

W-->>C: 413 too large (128MB isolate cap)

end

W->>W: argv = x-argv OR ["ffmpeg","-nostdin","-y","-i",in,...args,out]

W->>FS: writeFileSync("/tmp/in.ext", body) → rm(out)

W->>J: runFfmpeg(argv) [worker.ts:25]

else job (JSON/multipart) — inputs[] via url fetch, b64, or file parts

W->>FS: each input: writeFileSync("/tmp/name", bytes)

alt any input > 30 MB or total > 80 MB

W-->>C: 413 too large (128MB isolate cap)

end

W->>J: runFfmpeg per run/runs entry — /tmp shared across passes

end

J->>J: new WASI({args, preopens:["/"]}) → new WebAssembly.Instance(module, {shim}) →<br/>wasi.start(_start) [wasi.ts:673]

  

Note over FF,SH: Wasm calls imports SYNCHRONOUSLY — a Promise can't be awaited,<br/>so every syscall maps to a blocking node:fs call.

  

Note over FF,MUX: PHASE 2 — FFMPEG INTERNAL PIPELINE (diagram 4, all inside the Wasm module)

FF->>DEM: open /tmp/in via file protocol (WASI fd)

DEM->>DEC: compressed packets

loop each frame

DEC->>FLT: decoded frame

FLT->>ENC: filtered frame

ENC->>MUX: encoded packet

MUX->>SH: fd_write(iovs, nwritten*) — write /tmp/out (WASI fd)

SH->>FS: writeSync(fd, Buffer.from(slice), ...) — all sync

FS-->>SH: bytes / status

SH-->>MUX: WASI errno + data

end

MUX-->>FF: trailer / moov written

FF-->>SH: proc_exit(0)

SH-->>J: exit code + captured log (stderr, then stdout)

  

Note over FF,SH: PHASE 3 — WASI SYSCALL MAPPING, zoomed (diagram 3,<br/>every FF ↔ FS exchange above resolves like this)

FF->>SH: path_open(dirfd=3 "/", "tmp/in.ext", oflags, rights)

SH->>FS: openSync(resolvePreopen(path), flags)

FS-->>SH: node fd

SH-->>FF: WASI fd (via fd table)

FF->>SH: fd_read(fd, iovs, nread*)

SH->>FS: readSync(fd, Buffer.alloc(len), 0, len, offset)

Note right of SH: Buffer.alloc (not pooled) + copy —<br/>workerd rejects Wasm-memory subarrays

FS-->>SH: n bytes

SH->>M: copy bytes into iovec ptrs → write nread

SH-->>FF: ESUCCESS

FF->>SH: fd_seek / fd_write / fd_close / clock_time_get / random_get

SH->>FS: writeSync(fd, Buffer.from(slice), ...) etc.

FF->>SH: proc_exit(code)

SH-->>FF: throw WASIExit(code) → caught, returned as exit code

  

Note over W,C: PHASE 4 — RESPONSE (diagrams 1 + 2)

J-->>W: {code, log}

W->>FS: readFileSync("/tmp/out.ext")

alt no output produced

W-->>C: 422 + ffmpeg log (x-exit-code)

else ok

W-->>C: 200 bytes (content-type by ext, x-exit-code, x-log base64)

end

```
  
## Usage
#### Simple mode (raw body)
Body = media bytes; `x-ffmpeg-args` is spliced between the input and the output of the argv (`-i /tmp/in.ext …args… /tmp/out.ext`). Responses carry `x-exit-code` and `x-log` (base64) headers
```bash
# Transcode: scale + re-encode the uploaded clip
curl -X POST -H 'x-ffmpeg-args:["-vf","scale=160:-2","-c:v","mpeg4","-q:v","5","-an"]' \
--data-binary @clip.mp4 <WORKERS_URL> -o out.mp4

# Full argv control: x-argv overrides the wrapping (paths must stay under /tmp)
curl -X POST -H 'x-argv:["ffmpeg","-nostdin","-y","-i","/tmp/in.mp4","-c:v","mpeg4","-an","/tmp/out.mp4"]' \
--data-binary @clip.mp4 <WORKERS_URL> -o out.mp4

# Network input: worker fetches the source instead of reading the body
curl -X POST -H 'x-input-url: https://example.com/clip.mp4' <WORKERS_URL> -o out.mp4

# Help text, liveness, VFS self-test
curl <WORKERS_URL>/
curl <WORKERS_URL>/health
curl <WORKERS_URL>/fsdebug
```
`x-in-ext` / `x-out-ext` set the `/tmp/in.*` / `/tmp/out.*` extensions (default `mp4`)
#### Job mode (`Content-Type: application/json`)
`inputs` land in `/tmp` (fetched from `url`, decoded from `b64`), `run` /`runs` are the ffmpeg commands; `outputs` names the files to return
```bash
# Remote input + watermark overlay, result streamed back
curl -X POST -H 'content-type: application/json' <WORKERS_URL> -o out.mp4 -d '{
"inputs": [ {"name":"in.mp4","url":"https://example.com/clip.mp4"},
{"name":"logo.png","b64":"<base64 PNG>"} ],
"run": ["-i","/tmp/in.mp4","-i","/tmp/logo.png","-t","1",
"-filter_complex","[0:v]scale=240:-2[v];[v][1:v]overlay=10:10",
"-c:v","mpeg4","-q:v","5","-an","/tmp/out.mp4"],
"outputs": ["/tmp/out.mp4"]
}'

# Two-pass encode: sequential runs share /tmp (keep the passlog under /tmp)
curl -X POST -H 'content-type: application/json' <WORKERS_URL> -o out.mp4 -d '{
"inputs": [ {"name":"in.mp4","url":"https://example.com/clip.mp4"} ],
"runs": [
["-y","-i","/tmp/in.mp4","-c:v","mpeg4","-b:v","300k","-passlogfile","/tmp/pass","-pass","1","-an","-f","null","-"],
["-y","-i","/tmp/in.mp4","-c:v","mpeg4","-b:v","300k","-passlogfile","/tmp/pass","-pass","2","-an","/tmp/out.mp4"]
],
"outputs": ["/tmp/out.mp4"]
}'

# Frame extraction: many outputs come back as a ZIP (x-files lists the entries)
curl -X POST -H 'content-type: application/json' <WORKERS_URL> -o frames.zip -d '{
"inputs": [ {"name":"in.mp4","url":"https://example.com/clip.mp4"} ],
"run": ["-i","/tmp/in.mp4","-t","1","-vf","fps=5,scale=160:-2","/tmp/frames/f%03d.png"],
"outputs": ["/tmp/frames/"]
}'

# Remote output: PUT the result to an outputUrl instead of returning it
curl -X POST -H 'content-type: application/json' <WORKERS_URL> -d '{
"inputs": [ {"name":"in.mp4","url":"https://example.com/clip.mp4"} ],
"run": ["-i","/tmp/in.mp4","-c:v","mpeg4","-q:v","5","-an","/tmp/out.mp4"],
"outputs": ["/tmp/out.mp4"],
"outputUrl": "https://example.com/upload/out.mp4"
}'
```
#### Job mode (`multipart/form-data`)
File parts avoid base64 bloat: the field **name** becomes the `/tmp` filename, `run` / `runs` / `outputs` / `outputUrl` travel as text fields
```bash
# Upload the clip as a file part + the job as a text field
curl -X POST <WORKERS_URL> -o out.mp4 \
-F 'in.mp4=@clip.mp4;type=video/mp4' \
-F 'run=["-i","/tmp/in.mp4","-vf","scale=160:-2","-c:v","mpeg4","-q:v","5","-an","/tmp/out.mp4"]' \
-F 'outputs=["/tmp/out.mp4"]'
```
All paths must live under `/tmp`. One output file → returned raw with a content-type by extension; many → a single `application/zip` (`x-files` lists the entries)
## Develop
```bash
pnpm install
pnpm build:ffmpeg # cross-compile ffmpeg -> build/app.{full,min}.wasm (needs toolchain/wasi-sdk)
pnpm test:node # fast WASI-shim logic check in Node (uses the checked-in test/prog.wasm, no toolchain)
pnpm test # vitest: codec matrix + job API + zip, ffprobe-validated
pnpm test:features # job API (remote in/out, multi-file, zip, two-pass) in Miniflare
pnpm dev # wrangler dev (workerd) on :8787
pnpm test:e2e # end-to-end transcode against wrangler dev
pnpm deploy # deploy
```
