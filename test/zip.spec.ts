import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeZip } from "../src/zip";

const dir = mkdtempSync(join(tmpdir(), "zipspec-"));

describe("makeZip", () => {
	it("produces an archive `unzip` reads back byte-for-byte", () => {
		const a = new Uint8Array([1, 2, 3, 4, 5, 0, 255, 128]);
		const b = new TextEncoder().encode("hello zip\n".repeat(500));
		const zip = makeZip([
			{ name: "bin/a.dat", data: a },
			{ name: "b.txt", data: b },
		]);
		expect(zip[0]).toBe(0x50); // 'P'
		expect(zip[1]).toBe(0x4b); // 'K'

		const zp = join(dir, "out.zip");
		writeFileSync(zp, zip);
		// `unzip -t` verifies every CRC; a bad archive exits non-zero.
		execFileSync("unzip", ["-t", zp]);
		execFileSync("unzip", ["-o", zp, "-d", dir]);

		expect(new Uint8Array(readFileSync(join(dir, "bin/a.dat")))).toEqual(a);
		expect(new Uint8Array(readFileSync(join(dir, "b.txt")))).toEqual(b);
	});

	it("handles an empty file list", () => {
		// An empty archive is just the 22-byte End-Of-Central-Directory record.
		const zip = makeZip([]);
		expect(zip.length).toBe(22);
		const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
		expect(dv.getUint32(0, true)).toBe(0x06054b50); // EOCD signature
		expect(dv.getUint16(10, true)).toBe(0); // total entries = 0
	});
});
