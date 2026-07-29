import * as fs from "node:fs";
import { posix as path } from "node:path";

// Minimal, fully SYNCHRONOUS wasi_snapshot_preview1 host, backed by the
// Cloudflare Workers node:fs virtual filesystem (in-memory, per-request /tmp)

// Why synchronous: WebAssembly calls its imports synchronously. A Promise
// returned from an import cannot be awaited by the module, so an async WASI
// shim is impossible. node:fs on Workers performs every op synchronously, which
// is exactly what a WASI command module (ffmpeg) needs. No JSPI required
const E = {
	SUCCESS: 0,
	BADF: 8,
	EXIST: 20,
	INVAL: 28,
	IO: 29,
	ISDIR: 31,
	NOENT: 44,
	NOSYS: 52,
	NOTDIR: 54,
	NOTEMPTY: 55,
} as const;

const FILETYPE = {
	UNKNOWN: 0,
	DIRECTORY: 3,
	REGULAR_FILE: 4,
	CHARACTER_DEVICE: 2,
} as const;

// oflags
const O_CREAT = 1 << 0;
const O_DIRECTORY = 1 << 1;
const O_EXCL = 1 << 2;
const O_TRUNC = 1 << 3;
// fdflags
const FD_APPEND = 1 << 0;
// rights
const RIGHT_FD_READ = 1n << 1n;
const RIGHT_FD_WRITE = 1n << 6n;

const C = fs.constants;

type Entry = {
	nodeFd: number | null; // node:fs file descriptor, null for dirs/std streams
	path: string; // absolute VFS path
	offset: number; // current file position
	filetype: number;
	isPreopen: boolean;
	preopenName?: string;
};

export class WASIExit extends Error {
	constructor(public code: number) {
		super(`wasi proc_exit(${code})`);
	}
}

export interface WASIOptions {
	args: string[];
	env?: Record<string, string>;
	preopens?: string[]; // absolute VFS dirs to expose; default ["/"]
}

export class WASI {
	memory!: WebAssembly.Memory;
	private args: string[];
	private env: string[];
	private fds = new Map<number, Entry>();
	private nextFd = 3;
	stdout: number[] = [];
	stderr: number[] = [];

	constructor(opts: WASIOptions) {
		this.args = opts.args;
		this.env = Object.entries(opts.env ?? {}).map(([k, v]) => `${k}=${v}`);

		// Standard streams
		this.fds.set(0, {
			nodeFd: null,
			path: "<stdin>",
			offset: 0,
			filetype: FILETYPE.CHARACTER_DEVICE,
			isPreopen: false,
		});
		this.fds.set(1, {
			nodeFd: null,
			path: "<stdout>",
			offset: 0,
			filetype: FILETYPE.CHARACTER_DEVICE,
			isPreopen: false,
		});
		this.fds.set(2, {
			nodeFd: null,
			path: "<stderr>",
			offset: 0,
			filetype: FILETYPE.CHARACTER_DEVICE,
			isPreopen: false,
		});

		// Preopened directories. wasi-libc scans these (starting at fd 3) to
		// resolve absolute paths like /tmp/in into (dirfd, relative-path).
		const preopens = opts.preopens ?? ["/"];
		for (const p of preopens) {
			const fd = this.nextFd++;
			this.fds.set(fd, {
				nodeFd: null,
				path: p,
				offset: 0,
				filetype: FILETYPE.DIRECTORY,
				isPreopen: true,
				preopenName: p,
			});
		}
	}

	get imports(): WebAssembly.ModuleImports {
		// Bind every method so wasm can call them directly.
		const self = this;
		const wrap =
			<T extends (...a: any[]) => number>(fn: T) =>
			(...a: Parameters<T>): number => {
				try {
					return fn.apply(self, a);
				} catch (err) {
					if (err instanceof WASIExit) throw err;
					// Surface unexpected host errors as EIO rather than crashing the isolate.
					return E.IO;
				}
			};

		const raw: Record<string, (...a: any[]) => number> = {
			proc_exit: (code: number) => {
				throw new WASIExit(code);
			},
			args_sizes_get: this.args_sizes_get,
			args_get: this.args_get,
			environ_sizes_get: this.environ_sizes_get,
			environ_get: this.environ_get,
			clock_res_get: this.clock_res_get,
			clock_time_get: this.clock_time_get,
			random_get: this.random_get,
			sched_yield: () => E.SUCCESS,
			fd_prestat_get: this.fd_prestat_get,
			fd_prestat_dir_name: this.fd_prestat_dir_name,
			fd_fdstat_get: this.fd_fdstat_get,
			fd_fdstat_set_flags: () => E.SUCCESS,
			fd_filestat_get: this.fd_filestat_get,
			fd_read: this.fd_read,
			fd_pread: this.fd_pread,
			fd_write: this.fd_write,
			fd_pwrite: this.fd_pwrite,
			fd_seek: this.fd_seek,
			fd_tell: this.fd_tell,
			fd_close: this.fd_close,
			fd_sync: () => E.SUCCESS,
			fd_datasync: () => E.SUCCESS,
			fd_readdir: this.fd_readdir,
			path_open: this.path_open,
			path_filestat_get: this.path_filestat_get,
			path_unlink_file: this.path_unlink_file,
			path_create_directory: this.path_create_directory,
			path_remove_directory: this.path_remove_directory,
			path_rename: this.path_rename,
			poll_oneoff: () => E.NOSYS,
		};

		const out: WebAssembly.ModuleImports = {};
		for (const [k, v] of Object.entries(raw)) out[k] = wrap(v as any);
		return out;
	}

	private dv(): DataView {
		return new DataView(this.memory.buffer);
	}
	private u8(): Uint8Array {
		return new Uint8Array(this.memory.buffer);
	}
	private readStr(ptr: number, len: number): string {
		return new TextDecoder().decode(this.u8().subarray(ptr, ptr + len));
	}
	private resolve(dirfd: number, rel: string): string {
		const base = this.fds.get(dirfd);
		const baseDir = base?.isPreopen ? base.path : "/";
		return path.resolve(baseDir, rel);
	}

	private args_sizes_get = (argcPtr: number, bufSizePtr: number): number => {
		const dv = this.dv();
		dv.setUint32(argcPtr, this.args.length, true);
		const bytes = this.args.reduce(
			(n, a) => n + Buffer.byteLength(a) + 1,
			0,
		);
		dv.setUint32(bufSizePtr, bytes, true);
		return E.SUCCESS;
	};
	private args_get = (argvPtr: number, bufPtr: number): number => {
		const dv = this.dv();
		const mem = this.u8();
		let p = bufPtr;
		for (let i = 0; i < this.args.length; i++) {
			dv.setUint32(argvPtr + i * 4, p, true);
			const b = Buffer.from(this.args[i] + "\0");
			mem.set(b, p);
			p += b.length;
		}
		return E.SUCCESS;
	};
	private environ_sizes_get = (
		countPtr: number,
		bufSizePtr: number,
	): number => {
		const dv = this.dv();
		dv.setUint32(countPtr, this.env.length, true);
		dv.setUint32(
			bufSizePtr,
			this.env.reduce((n, e) => n + Buffer.byteLength(e) + 1, 0),
			true,
		);
		return E.SUCCESS;
	};
	private environ_get = (environPtr: number, bufPtr: number): number => {
		const dv = this.dv();
		const mem = this.u8();
		let p = bufPtr;
		for (let i = 0; i < this.env.length; i++) {
			dv.setUint32(environPtr + i * 4, p, true);
			const b = Buffer.from(this.env[i] + "\0");
			mem.set(b, p);
			p += b.length;
		}
		return E.SUCCESS;
	};

	private clock_res_get = (_id: number, resPtr: number): number => {
		this.dv().setBigUint64(resPtr, 1000n, true);
		return E.SUCCESS;
	};
	private clock_time_get = (
		_id: number,
		_prec: bigint,
		timePtr: number,
	): number => {
		this.dv().setBigUint64(timePtr, BigInt(Date.now()) * 1_000_000n, true);
		return E.SUCCESS;
	};
	private random_get = (bufPtr: number, len: number): number => {
		crypto.getRandomValues(this.u8().subarray(bufPtr, bufPtr + len));
		return E.SUCCESS;
	};

	private fd_prestat_get = (fd: number, buf: number): number => {
		const e = this.fds.get(fd);
		if (!e || !e.isPreopen) return E.BADF;
		const dv = this.dv();
		dv.setUint8(buf, 0); // preopentype dir
		dv.setUint32(buf + 4, Buffer.byteLength(e.preopenName!), true);
		return E.SUCCESS;
	};
	private fd_prestat_dir_name = (
		fd: number,
		ptr: number,
		len: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e || !e.isPreopen) return E.BADF;
		const b = Buffer.from(e.preopenName!);
		this.u8().set(b.subarray(0, len), ptr);
		return E.SUCCESS;
	};

	private writeFdstat(buf: number, filetype: number, flags = 0): void {
		const dv = this.dv();
		dv.setUint8(buf, filetype);
		dv.setUint16(buf + 2, flags, true);
		dv.setBigUint64(buf + 8, 0xffffffffffffffffn, true); // rights_base: all
		dv.setBigUint64(buf + 16, 0xffffffffffffffffn, true); // rights_inheriting: all
	}
	private fd_fdstat_get = (fd: number, buf: number): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		this.writeFdstat(buf, e.filetype);
		return E.SUCCESS;
	};

	private writeFilestat(buf: number, st: fs.Stats, filetype: number): void {
		const dv = this.dv();
		dv.setBigUint64(buf + 0, 0n, true); // dev
		dv.setBigUint64(buf + 8, BigInt(st.ino || 0), true); // ino
		dv.setUint8(buf + 16, filetype);
		dv.setBigUint64(buf + 24, BigInt(st.nlink || 1), true); // nlink
		dv.setBigUint64(buf + 32, BigInt(st.size), true); // size
		const ns = (ms: number) => BigInt(Math.round(ms * 1_000_000));
		dv.setBigUint64(buf + 40, ns(st.atimeMs), true);
		dv.setBigUint64(buf + 48, ns(st.mtimeMs), true);
		dv.setBigUint64(buf + 56, ns(st.ctimeMs), true);
	}
	private fd_filestat_get = (fd: number, buf: number): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		if (e.nodeFd !== null) {
			this.writeFilestat(buf, fs.fstatSync(e.nodeFd), e.filetype);
		} else {
			const st = fs.statSync(e.path);
			this.writeFilestat(
				buf,
				st,
				st.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE,
			);
		}
		return E.SUCCESS;
	};
	private path_filestat_get = (
		dirfd: number,
		_flags: number,
		pathPtr: number,
		pathLen: number,
		buf: number,
	): number => {
		const full = this.resolve(dirfd, this.readStr(pathPtr, pathLen));
		let st: fs.Stats;
		try {
			st = fs.statSync(full);
		} catch {
			return E.NOENT;
		}
		this.writeFilestat(
			buf,
			st,
			st.isDirectory() ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE,
		);
		return E.SUCCESS;
	};

	private path_open = (
		dirfd: number,
		_dirflags: number,
		pathPtr: number,
		pathLen: number,
		oflags: number,
		rightsBase: bigint,
		_rightsInherit: bigint,
		fdflags: number,
		openedFdPtr: number,
	): number => {
		const full = this.resolve(dirfd, this.readStr(pathPtr, pathLen));

		if (oflags & O_DIRECTORY) {
			let st: fs.Stats;
			try {
				st = fs.statSync(full);
			} catch {
				return E.NOENT;
			}
			if (!st.isDirectory()) return E.NOTDIR;
			const fd = this.nextFd++;
			this.fds.set(fd, {
				nodeFd: null,
				path: full,
				offset: 0,
				filetype: FILETYPE.DIRECTORY,
				isPreopen: false,
			});
			this.dv().setUint32(openedFdPtr, fd, true);
			return E.SUCCESS;
		}

		const wantWrite = (rightsBase & RIGHT_FD_WRITE) !== 0n;
		const wantRead = (rightsBase & RIGHT_FD_READ) !== 0n || !wantWrite;
		let flags =
			wantWrite && wantRead
				? C.O_RDWR
				: wantWrite
					? C.O_WRONLY
					: C.O_RDONLY;
		if (oflags & O_CREAT) flags |= C.O_CREAT;
		if (oflags & O_TRUNC) flags |= C.O_TRUNC;
		if (oflags & O_EXCL) flags |= C.O_EXCL;
		if (fdflags & FD_APPEND) flags |= C.O_APPEND;

		let nodeFd: number;
		try {
			nodeFd = fs.openSync(full, flags, 0o666);
		} catch (err: any) {
			if (err?.code === "ENOENT") return E.NOENT;
			if (err?.code === "EEXIST") return E.EXIST;
			if (err?.code === "EISDIR") return E.ISDIR;
			return E.IO;
		}
		const fd = this.nextFd++;
		this.fds.set(fd, {
			nodeFd,
			path: full,
			offset: 0,
			filetype: FILETYPE.REGULAR_FILE,
			isPreopen: false,
		});
		this.dv().setUint32(openedFdPtr, fd, true);
		return E.SUCCESS;
	};

	private readIovs(
		iovsPtr: number,
		iovsLen: number,
	): { ptr: number; len: number }[] {
		const dv = this.dv();
		const v: { ptr: number; len: number }[] = [];
		for (let i = 0; i < iovsLen; i++) {
			v.push({
				ptr: dv.getUint32(iovsPtr + i * 8, true),
				len: dv.getUint32(iovsPtr + i * 8 + 4, true),
			});
		}
		return v;
	}

	private doRead(
		e: Entry,
		iovs: { ptr: number; len: number }[],
		atOffset: number | null,
	): number {
		if (e.nodeFd === null) return 0; // stdin -> EOF
		const mem = this.u8();
		let total = 0;
		let pos = atOffset ?? e.offset;
		for (const io of iovs) {
			if (io.len === 0) continue;
			// Buffer.alloc (not allocUnsafe) to guarantee byteOffset 0; workerd's
			// fs.*Sync reject pooled TypedArrays that view a buffer at an offset.
			const buf = Buffer.alloc(io.len);
			const n = fs.readSync(e.nodeFd, buf, 0, io.len, pos);
			if (n <= 0) break;
			mem.set(buf.subarray(0, n), io.ptr);
			total += n;
			pos += n;
			if (n < io.len) break;
		}
		if (atOffset === null) e.offset = pos;
		return total;
	}

	private fd_read = (
		fd: number,
		iovsPtr: number,
		iovsLen: number,
		nreadPtr: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		const total = this.doRead(e, this.readIovs(iovsPtr, iovsLen), null);
		this.dv().setUint32(nreadPtr, total, true);
		return E.SUCCESS;
	};
	private fd_pread = (
		fd: number,
		iovsPtr: number,
		iovsLen: number,
		offset: bigint,
		nreadPtr: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		const total = this.doRead(
			e,
			this.readIovs(iovsPtr, iovsLen),
			Number(offset),
		);
		this.dv().setUint32(nreadPtr, total, true);
		return E.SUCCESS;
	};

	private doWrite(
		e: Entry,
		iovs: { ptr: number; len: number }[],
		atOffset: number | null,
	): number {
		const mem = this.u8();
		let total = 0;
		for (const io of iovs) {
			if (e.nodeFd === null) {
				const sink = e.path === "<stderr>" ? this.stderr : this.stdout;
				const chunk = mem.subarray(io.ptr, io.ptr + io.len);
				for (let i = 0; i < chunk.length; i++) sink.push(chunk[i]);
				total += chunk.length;
			} else {
				// workerd's fs.writeSync rejects a TypedArray that views Wasm memory at
				// a non-zero byteOffset ("offset is outside of buffer bounds"). Copy the
				// slice into a standalone Buffer (byteOffset 0) before writing.
				const chunk = Buffer.from(
					mem.subarray(io.ptr, io.ptr + io.len),
				);
				const pos = atOffset === null ? e.offset : atOffset + total;
				const n = fs.writeSync(e.nodeFd, chunk, 0, chunk.length, pos);
				total += n;
				if (atOffset === null) e.offset += n;
			}
		}
		return total;
	}

	private fd_write = (
		fd: number,
		iovsPtr: number,
		iovsLen: number,
		nwrittenPtr: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		const total = this.doWrite(e, this.readIovs(iovsPtr, iovsLen), null);
		this.dv().setUint32(nwrittenPtr, total, true);
		return E.SUCCESS;
	};
	private fd_pwrite = (
		fd: number,
		iovsPtr: number,
		iovsLen: number,
		offset: bigint,
		nwrittenPtr: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		const total = this.doWrite(
			e,
			this.readIovs(iovsPtr, iovsLen),
			Number(offset),
		);
		this.dv().setUint32(nwrittenPtr, total, true);
		return E.SUCCESS;
	};

	private fd_seek = (
		fd: number,
		offset: bigint,
		whence: number,
		newOffsetPtr: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e || e.nodeFd === null) return E.BADF;
		let base = 0;
		if (whence === 0)
			base = 0; // SET
		else if (whence === 1)
			base = e.offset; // CUR
		else if (whence === 2)
			base = fs.fstatSync(e.nodeFd).size; // END
		else return E.INVAL;
		e.offset = base + Number(offset);
		this.dv().setBigUint64(newOffsetPtr, BigInt(e.offset), true);
		return E.SUCCESS;
	};
	private fd_tell = (fd: number, ptr: number): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		this.dv().setBigUint64(ptr, BigInt(e.offset), true);
		return E.SUCCESS;
	};

	private fd_close = (fd: number): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		if (e.nodeFd !== null) {
			try {
				fs.closeSync(e.nodeFd);
			} catch {
				/* ignore */
			}
		}
		this.fds.delete(fd);
		return E.SUCCESS;
	};

	private fd_readdir = (
		fd: number,
		bufPtr: number,
		bufLen: number,
		cookie: bigint,
		usedPtr: number,
	): number => {
		const e = this.fds.get(fd);
		if (!e) return E.BADF;
		let names: string[];
		try {
			names = fs.readdirSync(e.path);
		} catch {
			return E.NOTDIR;
		}
		const dv = this.dv();
		const mem = this.u8();
		let offset = 0;
		let idx = Number(cookie);
		for (; idx < names.length; idx++) {
			const name = names[idx];
			const nameBuf = Buffer.from(name);
			const entLen = 24 + nameBuf.length;
			if (offset + entLen > bufLen) break;
			dv.setBigUint64(bufPtr + offset, BigInt(idx + 1), true); // d_next
			dv.setBigUint64(bufPtr + offset + 8, 0n, true); // d_ino
			dv.setUint32(bufPtr + offset + 16, nameBuf.length, true); // d_namlen
			let ft: number = FILETYPE.REGULAR_FILE;
			try {
				if (fs.statSync(path.join(e.path, name)).isDirectory())
					ft = FILETYPE.DIRECTORY;
			} catch {
				/* ignore */
			}
			dv.setUint8(bufPtr + offset + 20, ft);
			mem.set(nameBuf, bufPtr + offset + 24);
			offset += entLen;
		}
		dv.setUint32(usedPtr, offset, true);
		return E.SUCCESS;
	};

	private path_unlink_file = (
		dirfd: number,
		pathPtr: number,
		pathLen: number,
	): number => {
		try {
			fs.unlinkSync(this.resolve(dirfd, this.readStr(pathPtr, pathLen)));
			return E.SUCCESS;
		} catch (err: any) {
			return err?.code === "ENOENT" ? E.NOENT : E.IO;
		}
	};
	private path_create_directory = (
		dirfd: number,
		pathPtr: number,
		pathLen: number,
	): number => {
		try {
			fs.mkdirSync(this.resolve(dirfd, this.readStr(pathPtr, pathLen)));
			return E.SUCCESS;
		} catch (err: any) {
			return err?.code === "EEXIST" ? E.EXIST : E.IO;
		}
	};
	private path_remove_directory = (
		dirfd: number,
		pathPtr: number,
		pathLen: number,
	): number => {
		try {
			fs.rmdirSync(this.resolve(dirfd, this.readStr(pathPtr, pathLen)));
			return E.SUCCESS;
		} catch (err: any) {
			if (err?.code === "ENOENT") return E.NOENT;
			if (err?.code === "ENOTEMPTY") return E.NOTEMPTY;
			return E.IO;
		}
	};
	private path_rename = (
		oldDirfd: number,
		oldPtr: number,
		oldLen: number,
		newDirfd: number,
		newPtr: number,
		newLen: number,
	): number => {
		try {
			fs.renameSync(
				this.resolve(oldDirfd, this.readStr(oldPtr, oldLen)),
				this.resolve(newDirfd, this.readStr(newPtr, newLen)),
			);
			return E.SUCCESS;
		} catch {
			return E.IO;
		}
	};

	// Run a WASI command module to completion. Returns the process exit code.
	start(instance: WebAssembly.Instance): number {
		this.memory = instance.exports.memory as WebAssembly.Memory;
		const startFn = instance.exports._start as CallableFunction;
		try {
			startFn();
			return 0;
		} catch (err) {
			if (err instanceof WASIExit) return err.code;
			throw err;
		}
	}

	stdoutBytes(): Uint8Array {
		return new Uint8Array(this.stdout);
	}
	stdoutText(): string {
		return new TextDecoder().decode(new Uint8Array(this.stdout));
	}
	stderrText(): string {
		return new TextDecoder().decode(new Uint8Array(this.stderr));
	}
}
