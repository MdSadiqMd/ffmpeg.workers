import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import {
	fixture,
	makeMiniflare,
	postJson,
	postMultipart,
	probe,
	transcode,
	unzipList,
} from "./helpers";

// The Worker-layer capabilities layered on top of the WASI core: remote input
// (fetch), inline/multipart aux files, multi-output ZIP, multi-command pipelines
// (two-pass), and remote output (PUT)
let mf: Miniflare;
let origin: Server;
let ORIGIN: string;
const uploads = new Map<string, Buffer>();

beforeAll(async () => {
	mf = makeMiniflare();
	origin = createServer((req, res) => {
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "video/mp4" });
			res.end(fixture("input.mp4"));
			return;
		}
		const chunks: Buffer[] = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			uploads.set(req.url ?? "", Buffer.concat(chunks));
			res.writeHead(200);
			res.end("ok");
		});
	});
	await new Promise<void>((r) => origin.listen(0, "127.0.0.1", () => r()));
	const addr = origin.address();
	ORIGIN = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(async () => {
	await mf.dispose();
	origin.close();
});

const light = [
	"-t",
	"1",
	"-vf",
	"scale=160:-2",
	"-c:v",
	"mpeg4",
	"-q:v",
	"5",
	"-an",
];

describe("remote input", () => {
	it("legacy x-input-url fetches and transcodes", async () => {
		const res = await mf.dispatchFetch("http://x/", {
			method: "POST",
			headers: {
				"x-input-url": `${ORIGIN}/input.mp4`,
				"x-out-ext": "mp4",
				"x-ffmpeg-args": JSON.stringify(light),
			},
		});
		const bytes = Buffer.from(await res.arrayBuffer());
		expect(res.status).toBe(200);
		expect(probe(bytes, "mp4")).toContain("mpeg4");
	});

	it("JSON job inputs[].url fetches into /tmp", async () => {
		const r = await postJson(mf, {
			inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
			run: ["-i", "/tmp/in.mp4", ...light, "/tmp/out.mp4"],
			outputs: ["/tmp/out.mp4"],
		});
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "mp4")).toContain("mpeg4");
	});
});

describe("multi-file input", () => {
	it("overlays an inline base64 logo (watermark)", async () => {
		const logo = execFileSync("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"error",
			"-f",
			"lavfi",
			"-i",
			"color=red:size=48x48:d=1",
			"-frames:v",
			"1",
			"-f",
			"image2pipe",
			"-c:v",
			"png",
			"-",
		]);
		const r = await postJson(mf, {
			inputs: [
				{ name: "in.mp4", url: `${ORIGIN}/input.mp4` },
				{ name: "logo.png", b64: Buffer.from(logo).toString("base64") },
			],
			run: [
				"-i",
				"/tmp/in.mp4",
				"-i",
				"/tmp/logo.png",
				"-t",
				"1",
				"-filter_complex",
				"[0:v]scale=240:-2[v];[v][1:v]overlay=10:10",
				"-c:v",
				"mpeg4",
				"-q:v",
				"5",
				"-an",
				"/tmp/out.mp4",
			],
			outputs: ["/tmp/out.mp4"],
		});
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "mp4", "stream=codec_name,width")).toContain(
			"240",
		);
	});
});

describe("multi-output -> ZIP", () => {
	it("returns a frame sequence as a zip", async () => {
		const r = await postJson(mf, {
			inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
			run: [
				"-i",
				"/tmp/in.mp4",
				"-t",
				"1",
				"-vf",
				"fps=5,scale=160:-2",
				"/tmp/frames/f%03d.png",
			],
			outputs: ["/tmp/frames/"],
		});
		expect(r.status, r.log).toBe(200);
		expect(r.contentType).toBe("application/zip");
		const names = unzipList(r.bytes);
		expect(names.length).toBeGreaterThan(1);
		expect(names.every((n) => n.endsWith(".png"))).toBe(true);
	});

	it("HLS segmenting returns m3u8 + ts segments", async () => {
		const r = await postJson(mf, {
			inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
			run: [
				"-i",
				"/tmp/in.mp4",
				"-t",
				"2",
				"-vf",
				"scale=160:-2",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-an",
				"-f",
				"hls",
				"-hls_time",
				"1",
				"-hls_list_size",
				"0",
				"-hls_segment_filename",
				"/tmp/hls/seg%03d.ts",
				"/tmp/hls/index.m3u8",
			],
			outputs: ["/tmp/hls/"],
		});
		expect(r.status, r.log).toBe(200);
		expect(r.contentType).toBe("application/zip");
		const names = unzipList(r.bytes);
		expect(names.some((n) => n.endsWith(".m3u8"))).toBe(true);
		expect(names.some((n) => n.endsWith(".ts"))).toBe(true);
	});
});

describe("multi-command pipeline", () => {
	it("runs two-pass encoding sharing /tmp", async () => {
		const common = [
			"-vf",
			"scale=160:-2",
			"-c:v",
			"mpeg4",
			"-b:v",
			"300k",
			"-passlogfile",
			"/tmp/pass",
		];
		const r = await postJson(mf, {
			inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
			runs: [
				[
					"-y",
					"-i",
					"/tmp/in.mp4",
					"-t",
					"1",
					...common,
					"-pass",
					"1",
					"-an",
					"-f",
					"null",
					"-",
				],
				[
					"-y",
					"-i",
					"/tmp/in.mp4",
					"-t",
					"1",
					...common,
					"-pass",
					"2",
					"-an",
					"/tmp/out.mp4",
				],
			],
			outputs: ["/tmp/out.mp4"],
		});
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "mp4")).toContain("mpeg4");
	});
});

describe("remote output", () => {
	it("PUTs the result to outputUrl", async () => {
		const r = await postJson(mf, {
			inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
			run: ["-i", "/tmp/in.mp4", ...light, "/tmp/out.mp4"],
			outputs: ["/tmp/out.mp4"],
			outputUrl: `${ORIGIN}/out/result.mp4`,
		});
		expect(r.status, r.log).toBe(200);
		const meta = JSON.parse(r.bytes.toString("utf8"));
		expect(meta.uploaded).toBe(true);
		expect(uploads.get("/out/result.mp4")?.length).toBeGreaterThan(0);
	});
});

describe("multipart upload", () => {
	it("uses the field name as the /tmp filename", async () => {
		const form = new FormData();
		form.append(
			"in.mp4",
			new Blob([fixture("input.mp4")]),
			"original-upload.mp4",
		);
		form.append(
			"run",
			JSON.stringify(["-i", "/tmp/in.mp4", ...light, "/tmp/out.mp4"]),
		);
		form.append("outputs", JSON.stringify(["/tmp/out.mp4"]));
		const r = await postMultipart(mf, form);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "mp4")).toContain("mpeg4");
	});
});

describe("guards", () => {
	it("rejects a path escaping /tmp with 400", async () => {
		const r = await postJson(mf, {
			inputs: [{ name: "../evil.mp4", b64: "AAAA" }],
			run: ["-i", "/tmp/in.mp4", "/tmp/out.mp4"],
			outputs: ["/tmp/out.mp4"],
		});
		expect(r.status).toBe(400);
	});

	it("400s a job with no run/runs", async () => {
		const r = await postJson(mf, { inputs: [] });
		expect(r.status).toBe(400);
	});

	it("422s when ffmpeg produces no output", async () => {
		const r = await transcode(mf, fixture("input.mp4"), "mp4", [
			"-c:v",
			"definitely_not_a_codec",
		]);
		expect(r.status).toBe(422);
	});

	it("413s an oversized raw body", async () => {
		const big = Buffer.alloc(31 * 1024 * 1024, 0x41); // > 30 MB MAX_INPUT
		const res = await mf.dispatchFetch("http://x/", {
			method: "POST",
			headers: { "x-out-ext": "mp4", "x-ffmpeg-args": "[]" },
			body: big,
		});
		expect(res.status).toBe(413);
	});
});
