import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { fixture, makeMiniflare, probe, transcode } from "./helpers";

// Exercises the FULL build across many source codecs and output codecs, each
// validated with ffprobe (not just "non-empty"). Runs in Miniflare, which does
// not cap CPU — i.e. the Paid-plan capability set
let mf: Miniflare;
beforeAll(() => {
	mf = makeMiniflare();
});
afterAll(() => mf.dispose());

describe("video decoders -> mpeg4", () => {
	const cases: [string, string][] = [
		["h264 (mp4)", "input.mp4"],
		["hevc (mp4)", "hevc.mp4"],
		["vp8 (webm)", "vp8.webm"],
		["vp9 (webm)", "vp9.webm"],
		["mpeg2 (ts)", "mpeg2.ts"],
	];
	it.each(cases)("decodes %s", async (_label, file) => {
		const r = await transcode(mf, fixture(file), "mp4", [
			"-t",
			"1",
			"-vf",
			"scale=160:-2",
			"-c:v",
			"mpeg4",
			"-q:v",
			"5",
			"-an",
		]);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "mp4")).toContain("mpeg4");
	});
});

describe("video encoders (from h264 source)", () => {
	const cases: [string, string, string[], string][] = [
		[
			"H.264 (libx264)",
			"mp4",
			["-c:v", "libx264", "-preset", "ultrafast"],
			"h264",
		],
		["MPEG-4", "mp4", ["-c:v", "mpeg4", "-q:v", "5"], "mpeg4"],
		["MPEG-2", "mkv", ["-c:v", "mpeg2video", "-q:v", "5"], "mpeg2video"],
		["MJPEG", "avi", ["-c:v", "mjpeg", "-q:v", "5"], "mjpeg"],
		["ProRes", "mov", ["-c:v", "prores"], "prores"],
		["FFV1", "mkv", ["-c:v", "ffv1"], "ffv1"],
	];
	it.each(cases)("encodes %s", async (_label, ext, venc, expected) => {
		const r = await transcode(mf, fixture("input.mp4"), ext, [
			"-t",
			"1",
			"-vf",
			"scale=160:-2",
			...venc,
			"-an",
		]);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, ext)).toContain(expected);
	});

	const images: [string, string, string[], string][] = [
		["PNG", "png", ["-c:v", "png"], "png"],
		["BMP", "bmp", ["-c:v", "bmp"], "bmp"],
		["single-frame MJPEG", "jpg", ["-c:v", "mjpeg"], "mjpeg"],
	];
	it.each(images)(
		"extracts %s frame",
		async (_label, ext, venc, expected) => {
			const r = await transcode(mf, fixture("input.mp4"), ext, [
				"-frames:v",
				"1",
				"-vf",
				"scale=160:-2",
				...venc,
			]);
			expect(r.status, r.log).toBe(200);
			expect(probe(r.bytes, ext)).toContain(expected);
		},
	);

	it("makes a gif", async () => {
		const r = await transcode(mf, fixture("input.mp4"), "gif", [
			"-t",
			"1",
			"-vf",
			"scale=120:-2,fps=8",
		]);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "gif")).toContain("gif");
	});
});

describe("audio decoders -> aac", () => {
	const cases: [string, string][] = [
		["aac (mp4)", "input.mp4"],
		["mp3", "audio.mp3"],
		["opus", "audio.opus"],
		["mp2 (ts)", "mpeg2.ts"],
		["pcm (wav)", "audio.wav"],
	];
	it.each(cases)("decodes %s", async (_label, file) => {
		const r = await transcode(mf, fixture(file), "m4a", [
			"-t",
			"2",
			"-vn",
			"-c:a",
			"aac",
			"-b:a",
			"96k",
		]);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, "m4a")).toContain("aac");
	});
});

describe("audio encoders (from aac source)", () => {
	const cases: [string, string, string[], string][] = [
		["AAC", "m4a", ["-c:a", "aac"], "aac"],
		["AC-3", "ac3", ["-c:a", "ac3"], "ac3"],
		["E-AC-3", "eac3", ["-c:a", "eac3"], "eac3"],
		["FLAC", "flac", ["-c:a", "flac"], "flac"],
		["MP2", "mp2", ["-c:a", "mp2"], "mp2"],
		["PCM s16le (wav)", "wav", ["-c:a", "pcm_s16le"], "pcm_s16le"],
		["ALAC", "m4a", ["-c:a", "alac"], "alac"],
	];
	it.each(cases)("encodes %s", async (_label, ext, aenc, expected) => {
		const r = await transcode(mf, fixture("input.mp4"), ext, [
			"-t",
			"2",
			"-vn",
			...aenc,
		]);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, ext)).toContain(expected);
	});
});

describe("MP3 encode is absent (proves the trimmed codec claim)", () => {
	it("rejects libmp3lame with 422", async () => {
		const r = await transcode(mf, fixture("input.mp4"), "mp3", [
			"-t",
			"2",
			"-vn",
			"-c:a",
			"libmp3lame",
		]);
		expect(r.status).toBe(422);
	});
});

describe("containers / muxers (mpeg4 video + aac audio)", () => {
	const cases: [string, string, string[], string][] = [
		["MP4", "mp4", [], "mp4"],
		["Matroska (MKV)", "mkv", [], "matroska"],
		["QuickTime (MOV)", "mov", [], "mov"],
		["AVI", "avi", ["-c:a", "mp2"], "avi"],
		["MPEG-TS", "ts", ["-c:v", "mpeg2video", "-c:a", "mp2"], "mpegts"],
	];
	it.each(cases)("muxes %s", async (_label, ext, extra, expectedFormat) => {
		const args = [
			"-t",
			"1",
			"-vf",
			"scale=160:-2",
			"-c:v",
			"mpeg4",
			"-q:v",
			"5",
		];
		if (!extra.includes("-c:a")) args.push("-c:a", "aac");
		args.push(...extra);
		const r = await transcode(mf, fixture("input.mp4"), ext, args);
		expect(r.status, r.log).toBe(200);
		expect(probe(r.bytes, ext, "format=format_name")).toContain(
			expectedFormat,
		);
	});
});
