// Rigorous, ffprobe-validated matrix for the FULL (Paid) build, run locally in
// Miniflare (real workerd, no plan limits). Operates on a REAL internet video
// (test/fixtures/input.mp4). Every case asserts the Worker's output with ffprobe
// (codec/format/dimensions/duration/rate) — not just "non-empty".
//
// Decode of codecs the wasm build can't ENCODE (hevc/vp9/vp8/mp3/opus) is tested
// against fixtures derived from the same real file by scripts/gen-fixtures.sh
import { Miniflare } from "miniflare";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const F = "test/fixtures";
const IN = `${F}/input.mp4`;
if (!existsSync(IN)) {
	console.error(`missing ${IN}`);
	process.exit(1);
}

const mf = new Miniflare({
	modules: true,
	scriptPath: "dist-bundle/index.js",
	modulesRoot: "dist-bundle",
	modulesRules: [{ type: "CompiledWasm", include: ["**/*.wasm"] }],
	compatibilityDate: "2026-01-01",
	compatibilityFlags: ["nodejs_compat"],
});

function probe(path) {
	try {
		const out = execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-print_format",
				"json",
				"-show_format",
				"-show_streams",
				path,
			],
			{ encoding: "utf8" },
		);
		return JSON.parse(out);
	} catch {
		return null;
	}
}
const vstream = (p) => p?.streams?.find((s) => s.codec_type === "video");
const astream = (p) => p?.streams?.find((s) => s.codec_type === "audio");

async function callWorker(inPath, outExt, args) {
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "x-out-ext": outExt, "x-ffmpeg-args": JSON.stringify(args) },
		body: readFileSync(inPath),
	});
	const buf = Buffer.from(await res.arrayBuffer());
	const path = `/tmp/fm_out.${outExt}`;
	if (res.status === 200) writeFileSync(path, buf);
	return {
		status: res.status,
		exit: res.headers.get("x-exit-code"),
		size: buf.length,
		path,
		body: buf,
	};
}

const results = [];
function record(group, name, pass, detail) {
	results.push({ group, name, pass, detail });
	console.log(`${pass ? "PASS" : "FAIL"}  [${group}] ${name} — ${detail}`);
}

// expect: {v, a, w, h, fmt, dur, sr, ch}  (only provided fields are checked)
async function T(group, name, inPath, outExt, args, expect = {}, opts = {}) {
	const r = await callWorker(inPath, outExt, args);
	if (opts.expectFail) {
		const pass = r.status !== 200;
		record(
			group,
			name,
			pass,
			`expected failure -> http=${r.status} exit=${r.exit}`,
		);
		return;
	}
	if (r.status !== 200 || r.size === 0) {
		record(
			group,
			name,
			false,
			`http=${r.status} exit=${r.exit} size=${r.size} :: ${r.body.toString("utf8").split("\n").slice(-2).join(" ").slice(0, 160)}`,
		);
		return;
	}
	const p = probe(r.path);
	const v = vstream(p),
		a = astream(p);
	const checks = [];
	const fail = [];
	const eq = (label, got, want) => {
		checks.push(`${label}=${got}`);
		if (want !== undefined && String(got) !== String(want))
			fail.push(`${label} want ${want} got ${got}`);
	};
	const near = (label, got, want, tol) => {
		checks.push(`${label}=${got}`);
		if (want !== undefined && !(Math.abs(Number(got) - want) <= tol))
			fail.push(`${label} want ~${want} got ${got}`);
	};
	if (expect.v !== undefined) eq("v", v?.codec_name, expect.v);
	if (expect.a !== undefined) eq("a", a?.codec_name, expect.a);
	if (expect.w !== undefined) eq("w", v?.width, expect.w);
	if (expect.h !== undefined) eq("h", v?.height, expect.h);
	if (expect.fmt !== undefined) {
		const fmt = p?.format?.format_name || "";
		checks.push(`fmt=${fmt}`);
		if (!fmt.split(",").includes(expect.fmt))
			fail.push(`fmt want ${expect.fmt} got ${fmt}`);
	}
	if (expect.dur !== undefined)
		near("dur", p?.format?.duration, expect.dur, expect.durTol ?? 0.6);
	if (expect.sr !== undefined) eq("sr", a?.sample_rate, expect.sr);
	if (expect.ch !== undefined) eq("ch", a?.channels, expect.ch);
	record(
		group,
		name,
		fail.length === 0,
		`http=200 exit=${r.exit} size=${r.size} [${checks.join(" ")}]${fail.length ? " :: " + fail.join("; ") : ""}`,
	);
}

const V = ["-t", "2", "-vf", "scale=480:-2", "-an"]; // common video-encode prefix

console.log("=== VIDEO ENCODERS ===");
await T(
	"venc",
	"H.264 (libx264)",
	IN,
	"mp4",
	[...V, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30"],
	{ v: "h264" },
);
await T("venc", "MPEG-4", IN, "mp4", [...V, "-c:v", "mpeg4", "-q:v", "5"], {
	v: "mpeg4",
});
await T("venc", "MPEG-2", IN, "ts", [...V, "-c:v", "mpeg2video", "-q:v", "5"], {
	v: "mpeg2video",
});
await T("venc", "MPEG-1", IN, "ts", [...V, "-c:v", "mpeg1video", "-q:v", "5"], {
	v: "mpeg1video",
});
await T("venc", "MJPEG", IN, "avi", [...V, "-c:v", "mjpeg", "-q:v", "3"], {
	v: "mjpeg",
});
await T("venc", "FLV1", IN, "flv", [...V, "-c:v", "flv", "-q:v", "5"], {
	v: "flv1",
});
await T(
	"venc",
	"MSMPEG4v2",
	IN,
	"avi",
	[...V, "-c:v", "msmpeg4v2", "-q:v", "5"],
	{ v: "msmpeg4v2" },
);
await T("venc", "WMV2", IN, "avi", [...V, "-c:v", "wmv2", "-q:v", "5"], {
	v: "wmv2",
});
await T("venc", "FFV1 (lossless)", IN, "mkv", [...V, "-c:v", "ffv1"], {
	v: "ffv1",
});
await T("venc", "HuffYUV", IN, "avi", [...V, "-c:v", "huffyuv"], {
	v: "huffyuv",
});
await T("venc", "ProRes", IN, "mov", [...V, "-c:v", "prores"], { v: "prores" });
await T(
	"venc",
	"GIF",
	IN,
	"gif",
	["-t", "2", "-vf", "scale=240:-2,fps=8", "-an"],
	{ v: "gif" },
);
await T(
	"venc",
	"PNG (frame)",
	IN,
	"png",
	["-frames:v", "1", "-vf", "scale=320:-2", "-c:v", "png", "-an"],
	{ v: "png", w: 320 },
);
await T(
	"venc",
	"BMP (frame)",
	IN,
	"bmp",
	["-frames:v", "1", "-vf", "scale=320:-2", "-c:v", "bmp", "-an"],
	{ v: "bmp" },
);
await T(
	"venc",
	"TIFF (frame)",
	IN,
	"tiff",
	["-frames:v", "1", "-vf", "scale=320:-2", "-c:v", "tiff", "-an"],
	{ v: "tiff" },
);

console.log("\n=== AUDIO ENCODERS ===");
const A = ["-t", "2", "-vn"];
await T("aenc", "AAC", IN, "m4a", [...A, "-c:a", "aac", "-b:a", "128k"], {
	a: "aac",
});
await T("aenc", "AC-3", IN, "ac3", [...A, "-c:a", "ac3"], { a: "ac3" });
await T("aenc", "E-AC-3", IN, "eac3", [...A, "-c:a", "eac3"], { a: "eac3" });
await T("aenc", "FLAC", IN, "flac", [...A, "-c:a", "flac"], { a: "flac" });
await T("aenc", "Opus", IN, "ogg", [...A, "-c:a", "opus", "-strict", "-2"], {
	a: "opus",
});
await T(
	"aenc",
	"Vorbis",
	IN,
	"ogg",
	[...A, "-c:a", "vorbis", "-strict", "-2"],
	{ a: "vorbis" },
);
await T("aenc", "MP2", IN, "mp2", [...A, "-c:a", "mp2"], { a: "mp2" });
await T("aenc", "ALAC", IN, "m4a", [...A, "-c:a", "alac"], { a: "alac" });
await T("aenc", "PCM s16 WAV", IN, "wav", [...A, "-c:a", "pcm_s16le"], {
	a: "pcm_s16le",
});
await T("aenc", "WavPack", IN, "wv", [...A, "-c:a", "wavpack"], {
	a: "wavpack",
});
await T("aenc", "WMAv2", IN, "asf", [...A, "-c:a", "wmav2"], { a: "wmav2" });
await T(
	"aenc",
	"MP3 (libmp3lame) — expected absent",
	IN,
	"mp3",
	[...A, "-c:a", "libmp3lame"],
	{},
	{ expectFail: true },
);

console.log("\n=== DECODERS (via real-file-derived fixtures) ===");
await T("dec", "H.265/HEVC", `${F}/hevc.mp4`, "mp4", [...V, "-c:v", "mpeg4"], {
	v: "mpeg4",
});
await T("dec", "VP9", `${F}/vp9.webm`, "mp4", [...V, "-c:v", "mpeg4"], {
	v: "mpeg4",
});
await T("dec", "VP8", `${F}/vp8.webm`, "mp4", [...V, "-c:v", "mpeg4"], {
	v: "mpeg4",
});
await T("dec", "MP3", `${F}/audio.mp3`, "m4a", [...A, "-c:a", "aac"], {
	a: "aac",
});
await T("dec", "Opus", `${F}/audio.opus`, "m4a", [...A, "-c:a", "aac"], {
	a: "aac",
});
// h264 + aac decode are proven by every test above (real input is h264/aac).

console.log("\n=== CONTAINERS / REMUX (stream copy) ===");
await T("mux", "MP4", IN, "mp4", ["-c", "copy"], { fmt: "mp4" });
await T("mux", "MKV", IN, "mkv", ["-c", "copy"], { fmt: "matroska" });
await T("mux", "MOV", IN, "mov", ["-c", "copy"], { fmt: "mov" });
await T("mux", "AVI", IN, "avi", ["-c", "copy"], { fmt: "avi" });
await T("mux", "MPEG-TS", IN, "ts", ["-c", "copy"], { fmt: "mpegts" });
await T("mux", "WebM (vp9 fixture)", `${F}/vp9.webm`, "webm", ["-c", "copy"], {
	fmt: "matroska",
});

console.log("\n=== FILTERS / OPERATIONS ===");
await T(
	"filter",
	"scale 320x180",
	IN,
	"mp4",
	["-t", "2", "-vf", "scale=320:180", "-c:v", "mpeg4", "-an"],
	{ w: 320, h: 180 },
);
await T(
	"filter",
	"crop 200x200",
	IN,
	"mp4",
	["-t", "2", "-vf", "crop=200:200", "-c:v", "mpeg4", "-an"],
	{ w: 200, h: 200 },
);
await T(
	"filter",
	"pad 700x400",
	IN,
	"mp4",
	[
		"-t",
		"2",
		"-vf",
		"scale=640:360,pad=700:400:30:20",
		"-c:v",
		"mpeg4",
		"-an",
	],
	{ w: 700, h: 400 },
);
await T(
	"filter",
	"transpose (swap)",
	IN,
	"mp4",
	["-t", "2", "-vf", "scale=480:270,transpose=1", "-c:v", "mpeg4", "-an"],
	{ w: 270, h: 480 },
);
await T(
	"filter",
	"hflip",
	IN,
	"mp4",
	["-t", "2", "-vf", "scale=320:-2,hflip", "-c:v", "mpeg4", "-an"],
	{ v: "mpeg4" },
);
await T(
	"filter",
	"fps=5",
	IN,
	"mp4",
	["-t", "2", "-vf", "scale=320:-2,fps=5", "-c:v", "mpeg4", "-an"],
	{ v: "mpeg4" },
);
await T(
	"filter",
	"trim -t 2",
	IN,
	"mp4",
	["-t", "2", "-vf", "scale=320:-2", "-c:v", "mpeg4", "-an"],
	{ dur: 2.0 },
);
await T(
	"filter",
	"seek -ss 3 -t 2",
	IN,
	"mp4",
	["-ss", "3", "-t", "2", "-vf", "scale=320:-2", "-c:v", "mpeg4", "-an"],
	{ dur: 2.0 },
);
await T(
	"filter",
	"thumbnail @5s",
	IN,
	"png",
	["-ss", "5", "-frames:v", "1", "-vf", "scale=320:-2", "-c:v", "png", "-an"],
	{ v: "png" },
);
await T(
	"filter",
	"fade-in",
	IN,
	"mp4",
	[
		"-t",
		"2",
		"-vf",
		"scale=320:-2,fade=t=in:st=0:d=1",
		"-c:v",
		"mpeg4",
		"-an",
	],
	{ v: "mpeg4" },
);
await T(
	"filter",
	"drawbox",
	IN,
	"mp4",
	[
		"-t",
		"2",
		"-vf",
		"scale=320:-2,drawbox=10:10:100:100:red",
		"-c:v",
		"mpeg4",
		"-an",
	],
	{ v: "mpeg4" },
);
await T(
	"filter",
	"concat (2x1s)",
	IN,
	"mp4",
	[
		"-filter_complex",
		"[0:v]trim=0:1,setpts=PTS-STARTPTS[a];[0:v]trim=1:2,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[v]",
		"-map",
		"[v]",
		"-vf",
		"",
		"-c:v",
		"mpeg4",
	].filter((x) => x !== "-vf" && x !== ""),
	{ dur: 2.0 },
);
// 2x speed: 10s source -> ~5s (setpts halves timestamps). Proves the speedup.
await T(
	"filter",
	"setpts 2x speed",
	IN,
	"mp4",
	["-vf", "scale=320:-2,setpts=0.5*PTS", "-c:v", "mpeg4", "-an"],
	{ dur: 5.0, durTol: 1.0 },
);
await T(
	"filter",
	"audio resample 22050 mono",
	IN,
	"m4a",
	["-t", "2", "-vn", "-ar", "22050", "-ac", "1", "-c:a", "aac"],
	{ sr: 22050, ch: 1 },
);
await T(
	"filter",
	"audio volume",
	IN,
	"m4a",
	["-t", "2", "-vn", "-af", "volume=0.5", "-c:a", "aac"],
	{ a: "aac" },
);

await mf.dispose();

const fails = results.filter((r) => !r.pass);
const byGroup = {};
for (const r of results) {
	byGroup[r.group] = byGroup[r.group] || { p: 0, n: 0 };
	byGroup[r.group].n++;
	if (r.pass) byGroup[r.group].p++;
}
console.log("\n=== SUMMARY ===");
for (const [g, s] of Object.entries(byGroup))
	console.log(`  ${g.padEnd(8)} ${s.p}/${s.n}`);
console.log(
	`  TOTAL    ${results.filter((r) => r.pass).length}/${results.length}`,
);
if (fails.length) {
	console.log("\nFAILURES:");
	fails.forEach((f) => console.log(`  [${f.group}] ${f.name}: ${f.detail}`));
}
process.exit(fails.length ? 1 : 0);
