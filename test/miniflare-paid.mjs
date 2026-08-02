// Validates the FULL (Paid-plan) build locally with Miniflare
//
// Why this works: Miniflare runs the real workerd runtime but does NOT enforce
// Cloudflare plan limits — it neither caps CPU time nor checks the 3/10 MiB
// bundle size. So loading the 6.16 MB all-codecs build here is equivalent to
// running on an unlimited/Paid plan. This lets us exercise Paid-only
// capabilities (H.264 encode via libx264, HEVC/VP9 decode) without deploying.
//
// Prereqs (handled by scripts/test-paid.sh):
//   test/fixtures/input.mp4 (+ hevc.mp4, vp9.webm via scripts/gen-fixtures.sh)
//   cp build/app.full.wasm build/app.wasm
//   npx wrangler deploy --dry-run --outdir dist-bundle -c wrangler.paid.toml
import { Miniflare } from "miniflare";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const FIX = new URL("../test/fixtures/", import.meta.url).pathname;
const OUT = mkdtempSync(join(tmpdir(), "mfpaid-"));

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
		return execFileSync(
			"ffprobe",
			[
				"-v",
				"error",
				"-show_entries",
				"stream=codec_name,width,height",
				"-of",
				"csv=p=0",
				path,
			],
			{ encoding: "utf8" },
		)
			.trim()
			.replace(/\n/g, " ");
	} catch {
		return "(ffprobe unavailable)";
	}
}

async function run(name, inFile, outExt, args, expect) {
	const body = readFileSync(inFile);
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "x-out-ext": outExt, "x-ffmpeg-args": JSON.stringify(args) },
		body,
	});
	const buf = Buffer.from(await res.arrayBuffer());
	const out = join(OUT, `out.${outExt}`);
	writeFileSync(out, buf);
	const ok = res.status === 200 && buf.length > 0;
	const info = ok
		? probe(out)
		: Buffer.from(buf).toString("utf8").split("\n").slice(0, 1).join("");
	const pass = ok && (!expect || info.includes(expect));
	console.log(
		`${pass ? "PASS" : "FAIL"}  ${name} -> http=${res.status} exit=${res.headers.get("x-exit-code")} out=${buf.length}B  [${info}]`,
	);
	return pass;
}

let allPass = true;
const t = async (...a) => {
	allPass = (await run(...a)) && allPass;
};

console.log("=== Miniflare: FULL build (Paid-plan emulation) ===");
// Paid-only capabilities:
await t(
	"H.264 ENCODE (libx264)",
	FIX + "input.mp4",
	"mp4",
	[
		"-vf",
		"scale=160:-2",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-crf",
		"30",
		"-c:a",
		"aac",
	],
	"h264",
);
await t(
	"HEVC decode -> mpeg4",
	FIX + "hevc.mp4",
	"mp4",
	["-c:v", "mpeg4", "-q:v", "5", "-an"],
	"mpeg4",
);
await t(
	"VP9 decode -> h264",
	FIX + "vp9.webm",
	"mp4",
	["-c:v", "libx264", "-preset", "ultrafast", "-an"],
	"h264",
);
// General ops:
await t(
	"transcode mpeg4",
	FIX + "input.mp4",
	"mp4",
	["-vf", "scale=160:-2", "-c:v", "mpeg4", "-q:v", "5", "-an"],
	"mpeg4",
);
await t(
	"thumbnail png",
	FIX + "input.mp4",
	"png",
	["-frames:v", "1", "-c:v", "png"],
	null,
);
await t(
	"gif",
	FIX + "input.mp4",
	"gif",
	["-vf", "scale=120:-2,fps=8", "-t", "1"],
	"gif",
);

await mf.dispose();
console.log(allPass ? "\nALL PASS (Miniflare paid build)" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
