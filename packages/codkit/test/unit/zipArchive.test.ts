// unit: the zip reader of the bundles (PROP-008 ##BUNDLES-LOAD): the hash of
// the whole archive, one entry read on its own, the regular files under one
// root unpacked into a directory, and the names the reader refuses before it
// keeps anything. The archives are made in the test with fflate itself, so the
// suite proves the reader and not a fixture file; the forms fflate's writer
// does not produce - a data descriptor, the ZIP64 records, a mode, a flag - are
// written byte by byte.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { deflateSync, strToU8, zipSync } from 'fflate';
import { afterAll, describe, expect, it } from 'vitest';
import { extractZip, hashFile, readZipEntry, zipEntryPathProblem } from '../../src/lib/zipArchive.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

function archive(dir: string, name: string, entries: Readonly<Record<string, Uint8Array | string>>): string {
	const path = join(dir, name);
	const data: Record<string, Uint8Array> = {};
	for (const [entry, content] of Object.entries(entries)) data[entry] = typeof content === 'string' ? strToU8(content) : content;
	writeFileSync(path, zipSync(data, { level: 6 }));
	return path;
}

function sha256Of(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

type HandEntry = {
	readonly name: string;
	readonly data: Uint8Array;
	/** 8, the default, deflates at level 0, so the bytes of the data stand in the compressed stream as they are; 0 stores. */
	readonly method?: number;
	/** The sizes and the CRC-32 follow the data in a data descriptor (flag bit 3), the local header carries zeros. */
	readonly descriptor?: boolean;
	readonly flags?: number;
	/** A Unix mode in the external attributes, the central directory then saying the entry was made on Unix. */
	readonly unixMode?: number;
	/** The CRC-32 the records state, when it is not the data's. */
	readonly crc?: number;
};

/** A zip written byte by byte: local headers, data, descriptors, the central directory and its end, in the ZIP64 form on request. */
function handZip(entries: readonly HandEntry[], options: { readonly zip64?: boolean } = {}): Buffer {
	const zip64 = options.zip64 === true;
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const method = entry.method ?? 8;
		const compressed = Buffer.from(method === 8 ? deflateSync(entry.data, { level: 0 }) : entry.data);
		const crc = entry.crc ?? crc32(entry.data);
		const descriptor = entry.descriptor === true;
		const flags = (entry.flags ?? 0) | 0x800 | (descriptor ? 0x8 : 0);
		const name = Buffer.from(entry.name, 'utf8');
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(zip64 ? 45 : 20, 4);
		local.writeUInt16LE(flags, 6);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(descriptor ? 0 : crc, 14);
		local.writeUInt32LE(descriptor ? 0 : compressed.byteLength, 18);
		local.writeUInt32LE(descriptor ? 0 : entry.data.byteLength, 22);
		local.writeUInt16LE(name.byteLength, 26);
		parts.push(local, name, compressed);
		let length = local.byteLength + name.byteLength + compressed.byteLength;
		if (descriptor) {
			const trailer = Buffer.alloc(16);
			trailer.writeUInt32LE(0x08074b50, 0);
			trailer.writeUInt32LE(crc, 4);
			trailer.writeUInt32LE(compressed.byteLength, 8);
			trailer.writeUInt32LE(entry.data.byteLength, 12);
			parts.push(trailer);
			length += trailer.byteLength;
		}
		const extra = Buffer.alloc(zip64 ? 28 : 0);
		if (zip64) {
			extra.writeUInt16LE(0x0001, 0);
			extra.writeUInt16LE(24, 2);
			extra.writeBigUInt64LE(BigInt(entry.data.byteLength), 4);
			extra.writeBigUInt64LE(BigInt(compressed.byteLength), 12);
			extra.writeBigUInt64LE(BigInt(offset), 20);
		}
		const record = Buffer.alloc(46);
		record.writeUInt32LE(0x02014b50, 0);
		record.writeUInt16LE(entry.unixMode === undefined ? 20 : 0x0314, 4);
		record.writeUInt16LE(zip64 ? 45 : 20, 6);
		record.writeUInt16LE(flags, 8);
		record.writeUInt16LE(method, 10);
		record.writeUInt32LE(crc, 16);
		record.writeUInt32LE(zip64 ? 0xffffffff : compressed.byteLength, 20);
		record.writeUInt32LE(zip64 ? 0xffffffff : entry.data.byteLength, 24);
		record.writeUInt16LE(name.byteLength, 28);
		record.writeUInt16LE(extra.byteLength, 30);
		record.writeUInt32LE(entry.unixMode === undefined ? 0 : (entry.unixMode << 16) >>> 0, 38);
		record.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
		central.push(record, name, extra);
		offset += length;
	}
	const directory = Buffer.concat(central);
	const end: Buffer[] = [];
	if (zip64) {
		const record = Buffer.alloc(56);
		record.writeUInt32LE(0x06064b50, 0);
		record.writeBigUInt64LE(44n, 4);
		record.writeUInt16LE(45, 12);
		record.writeUInt16LE(45, 14);
		record.writeBigUInt64LE(BigInt(entries.length), 24);
		record.writeBigUInt64LE(BigInt(entries.length), 32);
		record.writeBigUInt64LE(BigInt(directory.byteLength), 40);
		record.writeBigUInt64LE(BigInt(offset), 48);
		const locator = Buffer.alloc(20);
		locator.writeUInt32LE(0x07064b50, 0);
		locator.writeBigUInt64LE(BigInt(offset + directory.byteLength), 8);
		locator.writeUInt32LE(1, 16);
		end.push(record, locator);
	}
	const record = Buffer.alloc(22);
	record.writeUInt32LE(0x06054b50, 0);
	record.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
	record.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
	record.writeUInt32LE(zip64 ? 0xffffffff : directory.byteLength, 12);
	record.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
	end.push(record);
	return Buffer.concat([...parts, directory, ...end]);
}

/** Bytes that carry the signature of a data descriptor, with sizes after it, at several places. */
function bytesWithDescriptorSignatures(length: number): Uint8Array {
	const data = new Uint8Array(length);
	for (let index = 0; index < length; index += 1) data[index] = (index * 31 + (index >> 8)) & 0xff;
	for (const at of [1000, length >> 1, length - 64])
		data.set([0x50, 0x4b, 0x07, 0x08, 0x12, 0x34, 0x56, 0x78, 0x10, 0, 0, 0, 0x10, 0, 0, 0], at);
	return data;
}

describe('reading an archive', () => {
	const dir = makeTempRoot('zip-read');
	const path = archive(dir, 'pack.zip', {
		'addon/addon.json': '{ "name": "acme.pack", "version": "1.0.0" }\n',
		'addon/main.js': 'module.exports = 1;\n',
		'addon/lib/util.js': 'exports.x = 1;\n',
		'README.md': '# outside the root\n'
	});

	it('hashes the whole file', () => {
		expect(hashFile(path)).toEqual({ sha256: sha256Of(path), bytes: readFileSync(path).byteLength });
	});

	it('reads one entry on its own, and answers null for a name the archive does not carry', () => {
		const manifest = readZipEntry(path, 'addon/addon.json');
		expect(manifest === null ? null : Buffer.from(manifest).toString('utf8')).toBe('{ "name": "acme.pack", "version": "1.0.0" }\n');
		expect(readZipEntry(path, 'addon/missing.json')).toBeNull();
	});

	it('refuses a file that is not a zip', () => {
		const text = join(dir, 'not-a-zip.zip');
		writeFileSync(text, 'just text\n', 'utf8');
		expect(() => readZipEntry(text, 'addon/addon.json')).toThrow();
	});

	it('unpacks the regular files under the root, at their path without the root, and nothing else', () => {
		const destination = join(dir, 'unpacked');
		const extracted = extractZip(path, { root: 'addon/', destination });
		expect(extracted.files).toBe(3);
		expect(extracted.sha256).toBe(sha256Of(path));
		expect(readFileSync(join(destination, 'main.js'), 'utf8')).toBe('module.exports = 1;\n');
		expect(readFileSync(join(destination, 'lib', 'util.js'), 'utf8')).toBe('exports.x = 1;\n');
		expect(readFileSync(join(destination, 'addon.json'), 'utf8')).toContain('acme.pack');
		expect(existsSync(join(destination, 'README.md'))).toBe(false);
		expect(existsSync(join(destination, 'addon'))).toBe(false);
	});

	it('streams an entry larger than one chunk byte for byte', () => {
		const big = new Uint8Array(3 * (1 << 20));
		for (let index = 0; index < big.length; index += 1) big[index] = (index * 7 + (index >> 10)) & 0xff;
		const large = archive(dir, 'large.zip', { 'addon/blob.bin': big, 'addon/addon.json': '{}' });
		const destination = join(dir, 'large-unpacked');
		expect(extractZip(large, { root: 'addon/', destination }).files).toBe(2);
		expect(Buffer.from(readFileSync(join(destination, 'blob.bin'))).equals(Buffer.from(big))).toBe(true);
	});

	it('takes the whole archive when the root is empty', () => {
		const destination = join(dir, 'whole');
		expect(extractZip(path, { root: '', destination }).files).toBe(4);
		expect(existsSync(join(destination, 'README.md'))).toBe(true);
		expect(existsSync(join(destination, 'addon', 'main.js'))).toBe(true);
	});

	it('unpacks an entry with a data descriptor whose compressed bytes carry the signature of one', () => {
		// The form of a per-target archive (finding of 2026-11-02): every entry
		// with flag bit 3, and an executable whose compressed bytes hold PK\x07\x08.
		const tool = bytesWithDescriptorSignatures(300_000);
		const manifest = strToU8('{ "name": "acme.pack" }\n');
		const file = join(dir, 'descriptor.zip');
		writeFileSync(
			file,
			handZip([
				{ name: 'addon/bin/tool', data: tool, descriptor: true },
				{ name: 'addon/package.json', data: manifest, descriptor: true }
			])
		);
		const destination = join(dir, 'descriptor-unpacked');
		expect(extractZip(file, { root: 'addon/', destination })).toEqual({
			sha256: sha256Of(file),
			bytes: readFileSync(file).byteLength,
			files: 2
		});
		expect(Buffer.from(readFileSync(join(destination, 'bin', 'tool'))).equals(Buffer.from(tool))).toBe(true);
		expect(readFileSync(join(destination, 'package.json'), 'utf8')).toBe('{ "name": "acme.pack" }\n');
		const read = readZipEntry(file, 'addon/package.json');
		expect(read === null ? null : Buffer.from(read).toString('utf8')).toBe('{ "name": "acme.pack" }\n');
	});

	it('reads the sizes and offsets of an archive in the ZIP64 form', () => {
		const file = join(dir, 'zip64.zip');
		writeFileSync(
			file,
			handZip(
				[
					{ name: 'addon/stored.txt', data: strToU8('stored\n'), method: 0 },
					{ name: 'addon/deflated.txt', data: strToU8('deflated\n') }
				],
				{ zip64: true }
			)
		);
		const destination = join(dir, 'zip64-unpacked');
		expect(extractZip(file, { root: 'addon/', destination }).files).toBe(2);
		expect(readFileSync(join(destination, 'stored.txt'), 'utf8')).toBe('stored\n');
		expect(readFileSync(join(destination, 'deflated.txt'), 'utf8')).toBe('deflated\n');
	});
});

describe('the names an archive may not carry', () => {
	it('are refused by the path check', () => {
		expect(zipEntryPathProblem('addon/main.js')).toBeNull();
		expect(zipEntryPathProblem('addon/sub/')).toBeNull();
		expect(zipEntryPathProblem('')).toBe('is empty');
		expect(zipEntryPathProblem('../escape.js')).toBe('has an empty, dot or dot-dot segment');
		expect(zipEntryPathProblem('addon/./main.js')).toBe('has an empty, dot or dot-dot segment');
		expect(zipEntryPathProblem('addon//main.js')).toBe('has an empty, dot or dot-dot segment');
		expect(zipEntryPathProblem('/etc/passwd')).toBe('is absolute');
		expect(zipEntryPathProblem('C:/x.js')).toBe('is absolute');
		expect(zipEntryPathProblem('addon\\main.js')).toBe('contains a backslash');
		expect(zipEntryPathProblem('addon/.git/config')).toBe('has a .git segment');
		expect(zipEntryPathProblem('addon/.GIT')).toBe('has a .git segment');
		expect(zipEntryPathProblem('addon/a\u0000b')).toBe('contains a control character');
	});

	it('refuse the whole archive at extraction, outside the root as much as inside it', () => {
		const dir = makeTempRoot('zip-refuse');
		for (const [name, entry] of [
			['traversal.zip', '../escape.js'],
			['absolute.zip', '/etc/passwd'],
			['git.zip', 'addon/.git/config'],
			['backslash.zip', 'addon\\main.js']
		] as const) {
			const path = archive(dir, name, { 'addon/addon.json': '{}', [entry]: 'x' });
			expect(() => extractZip(path, { root: 'addon/', destination: join(dir, `${name}-out`) })).toThrow(/the archive entry/u);
		}
	});

	it('refuse a link, an entry that is not a regular file, one that occurs twice, and one the reader cannot inflate', () => {
		const dir = makeTempRoot('zip-refuse-kind');
		const data = strToU8('x');
		for (const [name, entries, expected] of [
			['link.zip', [{ name: 'addon/link', data, unixMode: 0o120777 }], /"addon\/link" is a symbolic link/u],
			['fifo.zip', [{ name: 'addon/fifo', data, unixMode: 0o010644 }], /"addon\/fifo" is not a regular file/u],
			[
				'twice.zip',
				[
					{ name: 'addon/a.js', data },
					{ name: 'addon/a.js', data }
				],
				/"addon\/a\.js" occurs more than once/u
			],
			['encrypted.zip', [{ name: 'addon/secret.js', data, flags: 0x1 }], /"addon\/secret\.js" is encrypted/u],
			['bzip2.zip', [{ name: 'addon/packed.js', data, method: 12 }], /"addon\/packed\.js" is compressed with method 12/u],
			['crc.zip', [{ name: 'addon/broken.js', data, crc: 1 }], /"addon\/broken\.js" fails its CRC-32 check/u]
		] as const) {
			const path = join(dir, name);
			writeFileSync(path, handZip(entries));
			expect(() => extractZip(path, { root: 'addon/', destination: join(dir, `${name}-out`) })).toThrow(expected);
		}
	});
});
