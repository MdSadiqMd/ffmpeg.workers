import { defineConfig } from "vitest/config";

// Node-environment vitest (NOT vitest-pool-workers): tests drive the Worker
// through Miniflare (real workerd) and validate ffmpeg output with `ffprobe`,
// which must run in Node — pool-workers would execute the test body inside the
// isolate where child_process/ffprobe are unavailable. Miniflare enforces no CPU
// or bundle-size cap, so this exercises the full (Paid-equivalent) build
export default defineConfig({
	test: {
		include: ["test/**/*.spec.{ts,mts}"],
		globalSetup: ["test/global-setup.ts"],
		testTimeout: 180_000,
		hookTimeout: 180_000,
		fileParallelism: false,
		pool: "forks",
	},
});
