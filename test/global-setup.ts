import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";

// Builds the Worker bundle once for the whole run. The codec matrix needs every
// decoder/encoder, so it targets the FULL build; Miniflare emulates the Paid
// plan (no CPU/size caps). deploy.sh restores the correct wasm for real deploys,
// so leaving build/app.wasm = full here is harmless
export default function setup() {
	const full = "build/app.full.wasm";
	if (!existsSync(full)) {
		throw new Error(
			`${full} not found — run \`pnpm build:all\` (needs the wasi-sdk toolchain) before the codec tests.`,
		);
	}
	copyFileSync(full, "build/app.wasm");
	rmSync("dist-bundle", { recursive: true, force: true });
	execFileSync(
		"npx",
		[
			"wrangler",
			"deploy",
			"--dry-run",
			"--outdir",
			"dist-bundle",
			"-c",
			"wrangler.paid.toml",
		],
		{ stdio: "inherit" },
	);
}
