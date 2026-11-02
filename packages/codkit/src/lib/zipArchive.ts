/** @scope spec://codkit/modules/codkit/PROP-008#BUNDLES-LOAD */
// Reading a zip archive the way the bundles need it (PROP-008 ##BUNDLES-LOAD):
// the hash of the whole file, one entry read on its own, and the regular files
// under one root of the archive unpacked into a directory. The archive is
// streamed through fflate in chunks, so a large archive never sits in memory at
// once, and only the entries that are wanted are inflated.
//
// A name the archive carries is data, not a path: an absolute name, a `..` or
// a `.git` segment, a backslash, a link or an entry that is not a regular file
// refuses the whole archive before anything of it is kept.

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, mkdirSync, openSync, readSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Unzip, UnzipInflate } from 'fflate';
import type { UnzipFile } from 'fflate';

const CHUNK = 1 << 20;

/** Why an entry name cannot be a path under the destination, or null when it can. */
export function zipEntryPathProblem(name: string): string | null {
	if (name === '') return 'is empty';
	if (name.includes('\\')) return 'contains a backslash';
	if (name.startsWith('/') || /^[A-Za-z]:/u.test(name)) return 'is absolute';
	if (/[\u0000-\u001f\u007f]/u.test(name)) return 'contains a control character';
	const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return 'has an empty, dot or dot-dot segment';
	if (segments.some((segment) => segment.toLowerCase() === '.git')) return 'has a .git segment';
	return null;
}

/** Feed the archive through the unzipper chunk by chunk; the hash of the whole file comes with it. */
function stream(archivePath: string, unzipper: Unzip): { readonly sha256: string; readonly bytes: number } {
	const hash = createHash('sha256');
	const fd = openSync(archivePath, 'r');
	let bytes = 0;
	try {
		const buffer = Buffer.allocUnsafe(CHUNK);
		for (;;) {
			const read = readSync(fd, buffer, 0, CHUNK, null);
			if (read <= 0) break;
			// fflate reads past anything that is not a zip without a word; the
			// signature every zip opens with is checked here instead.
			if (bytes === 0 && (read < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b)) {
				throw new Error('the file does not open with the PK signature of a zip archive');
			}
			const chunk = new Uint8Array(buffer.subarray(0, read));
			hash.update(chunk);
			bytes += read;
			unzipper.push(chunk, false);
		}
		unzipper.push(new Uint8Array(0), true);
	} finally {
		closeSync(fd);
	}
	return { sha256: hash.digest('hex'), bytes };
}

/** The sha256 of a file, and its size. */
export function hashFile(path: string): { readonly sha256: string; readonly bytes: number } {
	const hash = createHash('sha256');
	const fd = openSync(path, 'r');
	try {
		const buffer = Buffer.allocUnsafe(CHUNK);
		for (;;) {
			const read = readSync(fd, buffer, 0, CHUNK, null);
			if (read <= 0) break;
			hash.update(buffer.subarray(0, read));
		}
		return { sha256: hash.digest('hex'), bytes: fstatSync(fd).size };
	} finally {
		closeSync(fd);
	}
}

/** The bytes of one entry of the archive, or null when there is no such entry; nothing else is inflated. */
export function readZipEntry(archivePath: string, entryName: string): Uint8Array | null {
	const unzipper = new Unzip();
	unzipper.register(UnzipInflate);
	const parts: Uint8Array[] = [];
	let found = false;
	unzipper.onfile = (file: UnzipFile) => {
		if (file.name !== entryName) return;
		found = true;
		file.ondata = (error, chunk, final) => {
			if (error) throw error;
			parts.push(chunk);
			if (final) file.terminate();
		};
		file.start();
	};
	stream(archivePath, unzipper);
	if (!found) return null;
	return Buffer.concat(parts.map((part) => Buffer.from(part.buffer, part.byteOffset, part.byteLength)));
}

export type ExtractedZip = {
	readonly sha256: string;
	readonly bytes: number;
	/** Regular files written under the destination. */
	readonly files: number;
};

/**
 * Unpack the regular files under `root` of the archive into `destination`, each
 * at its path without the root. The destination is created; what is already
 * there is overwritten file by file.
 */
export function extractZip(archivePath: string, options: { readonly root: string; readonly destination: string }): ExtractedZip {
	const root = options.root;
	const unzipper = new Unzip();
	unzipper.register(UnzipInflate);
	let files = 0;
	unzipper.onfile = (file: UnzipFile) => {
		const problem = zipEntryPathProblem(file.name);
		if (problem !== null) throw new Error(`the archive entry ${JSON.stringify(file.name)} ${problem}`);
		if (!file.name.startsWith(root) || file.name === root) return;
		const relative = file.name.slice(root.length);
		if (relative.endsWith('/')) return;
		const target = join(options.destination, ...relative.split('/'));
		mkdirSync(dirname(target), { recursive: true });
		let fd: number | null = null;
		file.ondata = (error, chunk, final) => {
			if (error) throw error;
			if (fd === null) fd = openSync(target, 'w', 0o644);
			if (chunk.byteLength > 0) writeSync(fd, chunk);
			if (final) {
				closeSync(fd);
				fd = null;
				files += 1;
				file.terminate();
			}
		};
		file.start();
	};
	mkdirSync(options.destination, { recursive: true });
	const streamed = stream(archivePath, unzipper);
	return { sha256: streamed.sha256, bytes: streamed.bytes, files };
}
