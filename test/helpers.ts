import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";

export function makeMiniflare(): Miniflare {
	return new Miniflare({
		modules: true,
		scriptPath: "dist-bundle/index.js",
		modulesRoot: "dist-bundle",
		modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
		compatibilityDate: "2026-01-01",
		compatibilityFlags: ["nodejs_compat"],
	});
}

const OUT = mkdtempSync(join(tmpdir(), "ffvitest-"));
let seq = 0;

export function fixture(name: string): Buffer {
	return readFileSync(join("test/fixtures", name));
}

// ffprobe the given bytes; returns the requested show_entries as one line
export function probe(
	bytes: Uint8Array | Buffer,
	ext: string,
	entries = "stream=codec_name",
): string {
	const p = join(OUT, `p${seq++}.${ext}`);
	writeFileSync(p, bytes);
	try {
		return execFileSync(
			"ffprobe",
			["-v", "error", "-show_entries", entries, "-of", "csv=p=0", p],
			{ encoding: "utf8" },
		)
			.trim()
			.replace(/\s+/g, " ");
	} catch (e: any) {
		return `(ffprobe error: ${e?.message ?? e})`;
	}
}

export interface Result {
	status: number;
	exitCode: string | null;
	bytes: Buffer;
	contentType: string | null;
	files: string | null;
	log: string;
}

type DispatchedResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;

async function toResult(res: DispatchedResponse): Promise<Result> {
	const bytes = Buffer.from(await res.arrayBuffer());
	let log = "";
	const b64 = res.headers.get("x-log");
	if (b64) {
		try {
			log = Buffer.from(b64, "base64").toString("utf8");
		} catch {
			/* ignore */
		}
	}
	return {
		status: res.status,
		exitCode: res.headers.get("x-exit-code"),
		bytes,
		contentType: res.headers.get("content-type"),
		files: res.headers.get("x-files"),
		log: bytes.length && res.status !== 200 ? bytes.toString("utf8") : log,
	};
}

// Legacy raw-body request: media bytes + x-ffmpeg-args
export async function transcode(
	mf: Miniflare,
	input: Uint8Array | Buffer,
	outExt: string,
	args: string[],
): Promise<Result> {
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "x-out-ext": outExt, "x-ffmpeg-args": JSON.stringify(args) },
		body: input,
	});
	return toResult(res);
}

export async function postJson(mf: Miniflare, job: unknown): Promise<Result> {
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(job),
	});
	return toResult(res);
}

export async function postMultipart(
	mf: Miniflare,
	form: FormData,
): Promise<Result> {
	// dispatchFetch(url, init) does not derive the multipart content-type from a
	// FormData body, so serialize via Request (which sets the boundary) and pass
	// the raw bytes — exactly what `curl -F` sends.
	const serialized = new Request("http://x/", { method: "POST", body: form });
	const ct = serialized.headers.get("content-type")!;
	const body = Buffer.from(await serialized.arrayBuffer());
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "content-type": ct },
		body,
	});
	return toResult(res);
}

export function unzipList(zip: Uint8Array | Buffer): string[] {
	const p = join(OUT, `z${seq++}.zip`);
	writeFileSync(p, zip);
	try {
		return execFileSync("unzip", ["-Z1", p], { encoding: "utf8" })
			.trim()
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}
