// Fast logic check for the WASI shim, run in plain Node against real fs.
// This validates the syscall implementations (args, path_open, read, write,
// seek, stderr, proc_exit) before running inside workerd. It uses a real temp
// dir; on Workers the identical code runs against the in-memory /tmp VFS
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WASI } from "../dist/wasi.mjs";

const wasmBytes = readFileSync(new URL("../build/app.wasm", import.meta.url));
const module = await WebAssembly.compile(wasmBytes);

const dir = mkdtempSync(join(tmpdir(), "wasi-test-"));
const inPath = join(dir, "in.txt");
const outPath = join(dir, "out.txt");
const payload =
	"hello from the wasi shim, running a real command module!\n".repeat(3);
writeFileSync(inPath, payload);

const wasi = new WASI({ args: ["prog", inPath, outPath], preopens: ["/"] });
const instance = new WebAssembly.Instance(module, {
	wasi_snapshot_preview1: wasi.imports,
});
const code = wasi.start(instance);

const out = readFileSync(outPath, "utf8");
console.log("exit code:", code);
console.log("stderr:   ", wasi.stderrText().trim());
console.log("output ok:", out === payload.toUpperCase());
if (code !== 0 || out !== payload.toUpperCase()) {
	console.error("FAIL");
	process.exit(1);
}
console.log("PASS (node)");
