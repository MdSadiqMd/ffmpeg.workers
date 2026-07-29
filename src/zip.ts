// Minimal ZIP writer (STORE method, no compression). Used to return multiple
// ffmpeg output files (frame sequences, sprite tiles, HLS segments) as a single
// archive — the whole thing runs in the Worker, no external library or service
//
// STORE (not DEFLATE) is deliberate: media outputs (h264/jpeg/png/ts) are
// already compressed, so DEFLATE would burn CPU for ~0% gain against the 300 s
// budget. We only need a valid container

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++)
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

function crc32(buf: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++)
		c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
	name: string;
	data: Uint8Array;
}

export function makeZip(entries: ZipEntry[]): Uint8Array {
	const enc = new TextEncoder();
	const chunks: Uint8Array[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;

	for (const e of entries) {
		const nameBytes = enc.encode(e.name);
		const crc = crc32(e.data);
		const size = e.data.length;

		const local = new Uint8Array(30 + nameBytes.length);
		const ldv = new DataView(local.buffer);
		ldv.setUint32(0, 0x04034b50, true); // local file header signature
		ldv.setUint16(4, 20, true); // version needed
		ldv.setUint16(6, 0, true); // flags
		ldv.setUint16(8, 0, true); // compression: store
		ldv.setUint16(10, 0, true); // mod time
		ldv.setUint16(12, 0x21, true); // mod date (1980-01-01, valid non-zero)
		ldv.setUint32(14, crc, true);
		ldv.setUint32(18, size, true); // compressed size
		ldv.setUint32(22, size, true); // uncompressed size
		ldv.setUint16(26, nameBytes.length, true);
		ldv.setUint16(28, 0, true); // extra len
		local.set(nameBytes, 30);
		chunks.push(local, e.data);

		const cd = new Uint8Array(46 + nameBytes.length);
		const cdv = new DataView(cd.buffer);
		cdv.setUint32(0, 0x02014b50, true); // central dir signature
		cdv.setUint16(4, 20, true); // version made by
		cdv.setUint16(6, 20, true); // version needed
		cdv.setUint16(8, 0, true);
		cdv.setUint16(10, 0, true); // compression: store
		cdv.setUint16(12, 0, true);
		cdv.setUint16(14, 0x21, true);
		cdv.setUint32(16, crc, true);
		cdv.setUint32(20, size, true);
		cdv.setUint32(24, size, true);
		cdv.setUint16(28, nameBytes.length, true);
		cdv.setUint16(30, 0, true); // extra
		cdv.setUint16(32, 0, true); // comment
		cdv.setUint16(34, 0, true); // disk number
		cdv.setUint16(36, 0, true); // internal attrs
		cdv.setUint32(38, 0, true); // external attrs
		cdv.setUint32(42, offset, true); // local header offset
		cd.set(nameBytes, 46);
		central.push(cd);

		offset += local.length + size;
	}

	const centralSize = central.reduce((n, c) => n + c.length, 0);
	const eocd = new Uint8Array(22);
	const edv = new DataView(eocd.buffer);
	edv.setUint32(0, 0x06054b50, true); // EOCD signature
	edv.setUint16(4, 0, true); // disk number
	edv.setUint16(6, 0, true); // cd start disk
	edv.setUint16(8, entries.length, true); // entries this disk
	edv.setUint16(10, entries.length, true); // total entries
	edv.setUint32(12, centralSize, true);
	edv.setUint32(16, offset, true); // cd offset
	edv.setUint16(20, 0, true); // comment len

	const total = offset + centralSize + eocd.length;
	const out = new Uint8Array(total);
	let p = 0;
	for (const c of chunks) {
		out.set(c, p);
		p += c.length;
	}
	for (const c of central) {
		out.set(c, p);
		p += c.length;
	}
	out.set(eocd, p);
	return out;
}
