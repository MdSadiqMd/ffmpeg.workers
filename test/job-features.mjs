// Exercises the Worker-layer capabilities added on top of the WASI ffmpeg core:
// remote input (fetch), multi-file input, multi-output -> ZIP, multi-command
// (two-pass), remote output (PUT), and multipart uploads. Runs against whatever
// build/app.wasm is bundled into dist-bundle/ (default: the free `min` build).
//
//   cp build/app.min.wasm build/app.wasm
//   npx wrangler deploy --dry-run --outdir dist-bundle -c wrangler.toml
//   node test/job-features.mjs
import { Miniflare } from "miniflare";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIX = "test/fixtures/input.mp4";
const tmp = mkdtempSync(join(tmpdir(), "ffjob-"));

// Local origin server: GET /input.mp4 serves the fixture (remote input);
// PUT /out/* captures the uploaded bytes (remote output)
const uploads = new Map();
const origin = createServer((req, res) => {
	if (req.method === "GET") {
		res.writeHead(200, { "content-type": "video/mp4" });
		res.end(readFileSync(FIX));
		return;
	}
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		uploads.set(req.url, Buffer.concat(chunks));
		res.writeHead(200);
		res.end("ok");
	});
});
await new Promise((r) => origin.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${origin.address().port}`;

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
		return "(probe failed)";
	}
}

let allPass = true;
function report(name, pass, detail) {
	allPass = allPass && pass;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}  [${detail}]`);
}

async function json(body) {
	return mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

// 1. Legacy raw-body still works
{
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: {
			"x-out-ext": "mp4",
			"x-ffmpeg-args": JSON.stringify([
				"-t",
				"1",
				"-vf",
				"scale=160:-2",
				"-c:v",
				"mpeg4",
				"-q:v",
				"5",
				"-an",
			]),
		},
		body: readFileSync(FIX),
	});
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/legacy.mp4`, buf);
	report(
		"legacy raw body transcode",
		res.status === 200 && buf.length > 0,
		`${res.status} ${probe(`${tmp}/legacy.mp4`)}`,
	);
}

// 2. Remote input via legacy x-input-url header
{
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: {
			"x-input-url": `${ORIGIN}/input.mp4`,
			"x-out-ext": "mp4",
			"x-ffmpeg-args": JSON.stringify([
				"-t",
				"1",
				"-vf",
				"scale=160:-2",
				"-c:v",
				"mpeg4",
				"-q:v",
				"5",
				"-an",
			]),
		},
	});
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/remotein.mp4`, buf);
	report(
		"remote input (x-input-url)",
		res.status === 200 && buf.length > 0,
		`${res.status} ${probe(`${tmp}/remotein.mp4`)}`,
	);
}

// 3. JSON job: remote input by URL
{
	const res = await json({
		inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
		run: [
			"-i",
			"/tmp/in.mp4",
			"-t",
			"1",
			"-vf",
			"scale=160:-2",
			"-c:v",
			"mpeg4",
			"-q:v",
			"5",
			"-an",
			"/tmp/out.mp4",
		],
		outputs: ["/tmp/out.mp4"],
	});
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/job.mp4`, buf);
	report(
		"JSON job remote input -> transcode",
		res.status === 200 && buf.length > 0,
		`${res.status} ${probe(`${tmp}/job.mp4`)}`,
	);
}

// 4. Multi-input watermark/overlay (video + inline PNG logo)
{
	execFileSync("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=red:size=48x48:d=1",
		"-frames:v",
		"1",
		"-y",
		`${tmp}/logo.png`,
	]);
	const logo = readFileSync(`${tmp}/logo.png`).toString("base64");
	const res = await json({
		inputs: [
			{ name: "in.mp4", url: `${ORIGIN}/input.mp4` },
			{ name: "logo.png", b64: logo },
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
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/overlay.mp4`, buf);
	report(
		"multi-input overlay (watermark)",
		res.status === 200 && buf.length > 0,
		`${res.status} ${probe(`${tmp}/overlay.mp4`)}`,
	);
}

// 5. Multi-output: frame extraction -> ZIP of PNGs
{
	const res = await json({
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
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/frames.zip`, buf);
	const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
	let count = 0;
	try {
		count = execFileSync("unzip", ["-l", `${tmp}/frames.zip`], {
			encoding: "utf8",
		})
			.split("\n")
			.filter((l) => /\.png\s*$/.test(l)).length;
	} catch {}
	report(
		"multi-output frames -> ZIP",
		res.status === 200 && isZip && count > 1,
		`${res.status} zip=${isZip} pngs=${count} ctype=${res.headers.get("content-type")}`,
	);
}

// 6. Two-pass encoding (multi-command sharing /tmp)
{
	const res = await json({
		inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
		runs: [
			[
				"-y",
				"-i",
				"/tmp/in.mp4",
				"-t",
				"1",
				"-vf",
				"scale=160:-2",
				"-c:v",
				"mpeg4",
				"-b:v",
				"300k",
				"-passlogfile",
				"/tmp/pass",
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
				"-vf",
				"scale=160:-2",
				"-c:v",
				"mpeg4",
				"-b:v",
				"300k",
				"-passlogfile",
				"/tmp/pass",
				"-pass",
				"2",
				"-an",
				"/tmp/out.mp4",
			],
		],
		outputs: ["/tmp/out.mp4"],
	});
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/twopass.mp4`, buf);
	report(
		"two-pass encode (runs[])",
		res.status === 200 && buf.length > 0,
		`${res.status} ${probe(`${tmp}/twopass.mp4`)}`,
	);
}

// 7. Remote output: PUT the result to the origin server
{
	const res = await json({
		inputs: [{ name: "in.mp4", url: `${ORIGIN}/input.mp4` }],
		run: [
			"-i",
			"/tmp/in.mp4",
			"-t",
			"1",
			"-vf",
			"scale=120:-2",
			"-c:v",
			"mpeg4",
			"-q:v",
			"8",
			"-an",
			"/tmp/out.mp4",
		],
		outputs: ["/tmp/out.mp4"],
		outputUrl: `${ORIGIN}/out/result.mp4`,
	});
	const meta = await res.json();
	const got = uploads.get("/out/result.mp4");
	report(
		"remote output (outputUrl PUT)",
		res.status === 200 && meta.uploaded === true && got && got.length > 0,
		`${res.status} uploaded=${meta.uploaded} recv=${got ? got.length : 0}B`,
	);
}

// 8. Multipart upload (binary file part + job field)
{
	const form = new FormData();
	// Field key "in.mp4" is the /tmp name; the upload's own filename differs on
	// purpose to prove the field key wins (matches how `curl -F` behaves)
	form.append("in.mp4", new Blob([readFileSync(FIX)]), "original-upload.mp4");
	form.append(
		"run",
		JSON.stringify([
			"-i",
			"/tmp/in.mp4",
			"-t",
			"1",
			"-vf",
			"scale=160:-2",
			"-c:v",
			"mpeg4",
			"-q:v",
			"5",
			"-an",
			"/tmp/out.mp4",
		]),
	);
	form.append("outputs", JSON.stringify(["/tmp/out.mp4"]));
	const serialized = new Request("http://x/", { method: "POST", body: form });
	const ct = serialized.headers.get("content-type");
	const mpBody = Buffer.from(await serialized.arrayBuffer());
	const res = await mf.dispatchFetch("http://x/", {
		method: "POST",
		headers: { "content-type": ct },
		body: mpBody,
	});
	const buf = Buffer.from(await res.arrayBuffer());
	writeFileSync(`${tmp}/multipart.mp4`, buf);
	report(
		"multipart upload",
		res.status === 200 && buf.length > 0,
		`${res.status} ${probe(`${tmp}/multipart.mp4`)}`,
	);
}

await mf.dispose();
origin.close();
console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
