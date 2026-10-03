import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { hashContainedFile, readContainedFile } from '../../src/lib/containedFile.ts';

const roots: string[] = [];
function root() {
	const path = mkdtempSync(join(tmpdir(), 'codkit-contained-hash-'));
	roots.push(path);
	return path;
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

it.each([0, 65535, 65536, 65537, 2 * 1024 * 1024 + 31])('matches a byte oracle across streaming boundaries: %i bytes', (size) => {
	const dir = root();
	const bytes = Buffer.alloc(size);
	for (let offset = 0; offset < size; offset += 1) bytes[offset] = offset % 251;
	writeFileSync(join(dir, 'artifact.bin'), bytes);
	expect(hashContainedFile(dir, 'artifact.bin', { what: 'artifact' })).toEqual({
		state: 'ok',
		bytes: size,
		sha256: createHash('sha256').update(bytes).digest('hex')
	});
	expect(readContainedFile(dir, 'artifact.bin', { what: 'artifact' })).toEqual({ state: 'ok', bytes: new Uint8Array(bytes) });
});
it('does not invent a digest for a missing artifact or a directory', () => {
	const dir = root();
	mkdirSync(join(dir, 'directory'));
	expect(hashContainedFile(dir, 'missing', { what: 'artifact' })).toEqual({ state: 'absent' });
	expect(() => hashContainedFile(dir, 'directory', { what: 'artifact' })).toThrow(/regular/);
});
it('uses the common containment proof before consuming a descriptor redirected outside the root', () => {
	const dir = root();
	const outside = root();
	mkdirSync(join(dir, 'out'));
	writeFileSync(join(dir, 'out/artifact.bin'), 'owned');
	writeFileSync(join(outside, 'artifact.bin'), 'foreign sentinel');
	expect(() =>
		hashContainedFile(dir, 'out/artifact.bin', {
			what: 'artifact',
			beforeOpen: () => {
				renameSync(join(dir, 'out'), join(dir, 'old-out'));
				symlinkSync(outside, join(dir, 'out'), 'junction');
			}
		})
	).toThrow(/outside/);
	expect(readFileSync(join(outside, 'artifact.bin'), 'utf8')).toBe('foreign sentinel');
});
