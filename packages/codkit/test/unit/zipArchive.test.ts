// unit: the zip reader of the bundles (PROP-008 ##BUNDLES-LOAD): the hash of
// the whole archive, one entry read on its own, the regular files under one
// root unpacked into a directory, and the names the reader refuses before it
// keeps anything. The archives are made in the test with fflate itself, so the
// suite proves the reader and not a fixture file.

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
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
});
