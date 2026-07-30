import * as fs from "node:fs";
import { posix as path } from "node:path";
import { WASI } from "./wasi";
// Static import => Wrangler precompiles this to a WebAssembly.Module at deploy
// time. Runtime WebAssembly.instantiate(bytes) is blocked on Workers, this is
// the only allowed path
import programModule from "../build/app.wasm";
import { makeZip, type ZipEntry } from "./zip";

// The 128 MB isolate ceiling is shared by input + output + ffmpeg heap. Guard
// individual transfers well below it, the sum of all inputs is capped too
const MAX_INPUT = 30 * 1024 * 1024;
const MAX_INPUT_TOTAL = 80 * 1024 * 1024;
const WORK = "/tmp";

interface RunResult {
	code: number;
	log: string;
}

// One WASI command-module invocation with a fresh instance. Command modules
// consume their state on _start, so a new instance is required per ffmpeg run
// but the /tmp VFS persists across runs within a request, which is what makes
// two-pass and multi-command pipelines work
function runFfmpeg(argv: string[]): RunResult {
	const wasi = new WASI({ args: argv, preopens: ["/"] });
	const instance = new WebAssembly.Instance(
		programModule as WebAssembly.Module,
		{ wasi_snapshot_preview1: wasi.imports },
	);
	const code = wasi.start(instance);
	return { code, log: wasi.stderrText() + wasi.stdoutText() };
}

function contentTypeFor(name: string): string {
	const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
	const map: Record<string, string> = {
		mp4: "video/mp4",
		m4v: "video/mp4",
		mov: "video/quicktime",
		webm: "video/webm",
		mkv: "video/x-matroska",
		avi: "video/x-msvideo",
		ts: "video/mp2t",
		gif: "image/gif",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		bmp: "image/bmp",
		tiff: "image/tiff",
		webp: "image/webp",
		mp3: "audio/mpeg",
		m4a: "audio/mp4",
		aac: "audio/aac",
		wav: "audio/wav",
		flac: "audio/flac",
		opus: "audio/opus",
		ogg: "audio/ogg",
		m3u8: "application/vnd.apple.mpegurl",
		zip: "application/zip",
	};
	return map[ext] ?? "application/octet-stream";
}

// Confine every request-controlled path to /tmp. Rejects "..", absolute escapes,
// and anything that resolves outside the work dir
function safePath(name: string): string {
	const clean = name.startsWith("/") ? name : `${WORK}/${name}`;
	const full = path.resolve(clean);
	if (full !== WORK && !full.startsWith(`${WORK}/`))
		throw new Error(`path escapes ${WORK}: ${name}`);
	return full;
}

function b64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function walkFiles(dir: string): string[] {
	const out: string[] = [];
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return out;
	}
	for (const n of names) {
		const full = path.join(dir, n);
		let st: fs.Stats;
		try {
			st = fs.statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) out.push(...walkFiles(full));
		else out.push(full);
	}
	return out;
}

interface JobInput {
	name: string;
	url?: string;
	b64?: string;
	bytes?: Uint8Array; // internal: set by the multipart path to skip base64
}
interface Job {
	inputs?: JobInput[];
	run?: string[];
	runs?: string[][];
	outputs?: string[];
	outputUrl?: string;
	outputMethod?: string;
}

function textResponse(body: string, status: number): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/plain" },
	});
}

// Materializes inputs into /tmp, runs the command pipeline, collects outputs,
// and returns them raw (single file) or zipped (many), optionally PUT to a URL
async function runJob(job: Job): Promise<Response> {
	const commands: string[][] = job.runs ?? (job.run ? [job.run] : []);
	if (commands.length === 0)
		return textResponse(
			'job needs "run" (string[]) or "runs" (string[][])',
			400,
		);

	const inputPaths = new Set<string>();
	let totalBytes = 0;
	for (const inp of job.inputs ?? []) {
		if (!inp.name) return textResponse("input missing name", 400);
		let full: string;
		try {
			full = safePath(inp.name);
		} catch (e: any) {
			return textResponse(e.message, 400);
		}
		let bytes: Uint8Array;
		if (inp.bytes) {
			bytes = inp.bytes;
		} else if (inp.url) {
			let r: Response;
			try {
				r = await fetch(inp.url);
			} catch (e: any) {
				return textResponse(
					`fetch failed for ${inp.name}: ${e?.message ?? e}`,
					502,
				);
			}
			if (!r.ok)
				return textResponse(
					`fetch ${inp.name} -> HTTP ${r.status}`,
					502,
				);
			bytes = new Uint8Array(await r.arrayBuffer());
		} else if (inp.b64) {
			bytes = b64ToBytes(inp.b64);
		} else {
			return textResponse(`input ${inp.name} needs url or b64`, 400);
		}
		totalBytes += bytes.byteLength;
		if (bytes.byteLength > MAX_INPUT || totalBytes > MAX_INPUT_TOTAL)
			return textResponse(
				`inputs too large (${totalBytes} bytes); 128MB isolate cap`,
				413,
			);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, bytes);
		inputPaths.add(full);
	}

	const logs: string[] = [];
	let lastCode = 0;
	for (let i = 0; i < commands.length; i++) {
		const argv = ["ffmpeg", ...commands[i]];
		const { code, log } = runFfmpeg(argv);
		logs.push(`# command ${i + 1}: ${argv.join(" ")}\n${log}`);
		lastCode = code;
		if (code !== 0) {
			return new Response(
				`ffmpeg command ${i + 1} failed (exit ${code})\n\n${logs.join("\n")}`,
				{
					status: 422,
					headers: {
						"content-type": "text/plain",
						"x-exit-code": String(code),
					},
				},
			);
		}
	}

	// Resolve the output file set. Explicit `outputs` may name files or dirs
	// (dirs are captured recursively — that is how a frame sequence / segment
	// set / sprite tiling comes back). With no `outputs`, auto-capture every new
	// non-empty file under /tmp that was not an input (excluding two-pass logs).
	const files: string[] = [];
	if (job.outputs && job.outputs.length > 0) {
		for (const o of job.outputs) {
			let full: string;
			try {
				full = safePath(o);
			} catch (e: any) {
				return textResponse(e.message, 400);
			}
			let st: fs.Stats;
			try {
				st = fs.statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) files.push(...walkFiles(full));
			else files.push(full);
		}
	} else {
		for (const f of walkFiles(WORK)) {
			if (inputPaths.has(f)) continue;
			if (/(2pass|\.log|\.mbtree)$/i.test(f)) continue;
			files.push(f);
		}
	}

	const entries: ZipEntry[] = [];
	for (const f of files) {
		let data: Uint8Array;
		try {
			data = new Uint8Array(fs.readFileSync(f));
		} catch {
			continue;
		}
		if (data.byteLength === 0) continue;
		entries.push({
			name: f.startsWith(`${WORK}/`) ? f.slice(WORK.length + 1) : f,
			data,
		});
	}

	if (entries.length === 0)
		return new Response(
			`no output produced (exit ${lastCode})\n\n${logs.join("\n")}`,
			{
				status: 422,
				headers: {
					"content-type": "text/plain",
					"x-exit-code": String(lastCode),
				},
			},
		);

	let payload: Uint8Array;
	let ctype: string;
	let filename: string;
	if (entries.length === 1) {
		payload = entries[0].data;
		ctype = contentTypeFor(entries[0].name);
		filename = entries[0].name;
	} else {
		payload = makeZip(entries);
		ctype = "application/zip";
		filename = "output.zip";
	}

	const logB64 = btoa(unescape(encodeURIComponent(logs.join("\n")))).slice(
		0,
		8000,
	);

	if (job.outputUrl) {
		const method = (job.outputMethod ?? "PUT").toUpperCase();
		let up: Response;
		try {
			up = await fetch(job.outputUrl, {
				method,
				body: payload,
				headers: { "content-type": ctype },
			});
		} catch (e: any) {
			return textResponse(
				`output upload failed: ${e?.message ?? e}`,
				502,
			);
		}
		return new Response(
			JSON.stringify({
				uploaded: up.ok,
				status: up.status,
				bytes: payload.byteLength,
				files: entries.map((e) => e.name),
				contentType: ctype,
			}),
			{
				status: up.ok ? 200 : 502,
				headers: {
					"content-type": "application/json",
					"x-log": logB64,
				},
			},
		);
	}

	return new Response(payload, {
		headers: {
			"content-type": ctype,
			"x-exit-code": String(lastCode),
			"x-files": entries.map((e) => e.name).join(","),
			"x-log": logB64,
			"content-disposition": `inline; filename="${filename}"`,
		},
	});
}

// Legacy path: raw media in the body (or fetched from x-input-url), args in
// x-ffmpeg-args / x-argv. Kept for backward compatibility with the original API
async function runLegacy(req: Request): Promise<Response> {
	const inExt = req.headers.get("x-in-ext") ?? "mp4";
	const outExt = req.headers.get("x-out-ext") ?? "mp4";
	const inPath = `${WORK}/in.${inExt}`;
	const outPath = `${WORK}/out.${outExt}`;

	let input: Uint8Array;
	const inputUrl = req.headers.get("x-input-url");
	if (inputUrl) {
		let r: Response;
		try {
			r = await fetch(inputUrl);
		} catch (e: any) {
			return textResponse(`fetch failed: ${e?.message ?? e}`, 502);
		}
		if (!r.ok) return textResponse(`fetch input -> HTTP ${r.status}`, 502);
		input = new Uint8Array(await r.arrayBuffer());
	} else {
		input = new Uint8Array(await req.arrayBuffer());
	}
	if (input.byteLength === 0) return textResponse("empty body", 400);
	if (input.byteLength > MAX_INPUT)
		return textResponse(
			`input too large (${input.byteLength} bytes); 128MB isolate cap`,
			413,
		);

	fs.writeFileSync(inPath, input);
	try {
		fs.rmSync(outPath, { force: true });
	} catch {
		/* ignore */
	}

	let argv: string[];
	const fullArgv = req.headers.get("x-argv");
	if (fullArgv) {
		argv = JSON.parse(fullArgv);
	} else {
		const extra = JSON.parse(
			req.headers.get("x-ffmpeg-args") ?? "[]",
		) as string[];
		argv = ["ffmpeg", "-nostdin", "-y", "-i", inPath, ...extra, outPath];
	}

	let result: RunResult;
	try {
		result = runFfmpeg(argv);
	} catch (err: any) {
		return textResponse(`host error: ${err?.message ?? err}`, 500);
	}

	let output: Uint8Array | null = null;
	try {
		output = new Uint8Array(fs.readFileSync(outPath));
	} catch {
		/* no output produced */
	}

	if (result.code !== 0 || !output || output.byteLength === 0) {
		return new Response(
			`ffmpeg failed (exit ${result.code}, ${output?.byteLength ?? 0} bytes out)\n\n${result.log}`,
			{
				status: 422,
				headers: {
					"content-type": "text/plain",
					"x-exit-code": String(result.code),
				},
			},
		);
	}

	return new Response(output, {
		headers: {
			"content-type": contentTypeFor(outPath),
			"x-exit-code": String(result.code),
			"x-log": btoa(unescape(encodeURIComponent(result.log))).slice(
				0,
				8000,
			),
			"content-disposition": `inline; filename="out.${outExt}"`,
		},
	});
}

async function jobFromMultipart(req: Request): Promise<Job> {
	const form = await req.formData();
	const job: Job = { inputs: [] };
	for (const [key, value] of form.entries()) {
		if (typeof value === "string") {
			if (key === "job") Object.assign(job, JSON.parse(value));
			else if (key === "run") job.run = JSON.parse(value);
			else if (key === "runs") job.runs = JSON.parse(value);
			else if (key === "outputs") job.outputs = JSON.parse(value);
			else if (key === "outputUrl") job.outputUrl = value;
			continue;
		}
		// The form field name is the /tmp filename the commands reference
		// (e.g. field "in.mp4" -> /tmp/in.mp4), falling back to the upload's
		// own filename only when the field key is a generic placeholder.
		const file = value as File;
		const bytes = new Uint8Array(await file.arrayBuffer());
		const name =
			key && key !== "file" && key !== "files" ? key : file.name || key;
		job.inputs!.push({ name, bytes });
	}
	return job;
}

const HELP = `ffmpeg-on-workers — FFmpeg inside a single Cloudflare Worker isolate.

SIMPLE (raw body):
  POST /  body = media bytes
  headers:
    x-ffmpeg-args: JSON array between input and output, e.g. ["-vf","scale=320:-2"]
    x-argv:        JSON full argv (overrides wrapping); paths must be under /tmp
    x-in-ext / x-out-ext: file extensions (default mp4)
    x-input-url:   fetch the input from this URL instead of the body

JOB (Content-Type: application/json) — network in/out, multi-file, multi-pass:
  {
    "inputs": [ {"name":"in.mp4","url":"https://..."},
                {"name":"logo.png","b64":"..."} ],
    "run":  ["-i","/tmp/in.mp4",...,"/tmp/out.mp4"],
    "runs": [ [...pass1...], [...pass2...] ],       // sequential, share /tmp
    "outputs": ["/tmp/out.mp4"],                    // dir => zipped; omit => auto
    "outputUrl": "https://...", "outputMethod": "PUT"
  }
  Many output files (frames, tiles, HLS segments) come back as a ZIP.

JOB (multipart/form-data): file parts + a "job"/"run"/"runs"/"outputs" field.

GET /          this help
GET /health    liveness
GET /fsdebug   VFS self-test
`;

export default {
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);

		if (req.method === "GET") {
			if (url.pathname === "/health") return textResponse("ok", 200);
			if (url.pathname === "/fsdebug") return fsdebug();
			return textResponse(HELP, 200);
		}

		if (req.method !== "POST")
			return textResponse("method not allowed", 405);

		const ctype = req.headers.get("content-type") ?? "";
		try {
			if (ctype.includes("application/json")) {
				const job = (await req.json()) as Job;
				return await runJob(job);
			}
			if (ctype.includes("multipart/form-data")) {
				return await runJob(await jobFromMultipart(req));
			}
			return await runLegacy(req);
		} catch (err: any) {
			return textResponse(`host error: ${err?.message ?? err}`, 500);
		}
	},
};

function fsdebug(): Response {
	const out: string[] = [];
	const C = (fs as any).constants;
	try {
		const fd = fs.openSync(
			"/tmp/p.bin",
			C.O_RDWR | C.O_CREAT | C.O_TRUNC,
			0o666,
		);
		const buf = Buffer.from("ABCDEFGHIJ");
		const nw = fs.writeSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		out.push(
			`positional write nw=${nw} size=${fs.statSync("/tmp/p.bin").size} read=${fs.readFileSync("/tmp/p.bin").toString()}`,
		);
	} catch (e: any) {
		out.push("positional write ERR: " + e.message);
	}
	return new Response(out.join("\n") + "\n", {
		headers: { "content-type": "text/plain" },
	});
}
