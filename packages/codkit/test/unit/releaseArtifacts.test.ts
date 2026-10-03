import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureReleaseArtifacts } from '../../src/lib/releaseArtifacts.ts';

const roots: string[] = [];
function root() {
	const value = mkdtempSync(join(tmpdir(), 'codkit-release-artifacts-'));
	roots.push(value);
	return value;
}
afterEach(() => {
	for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

it('captures file bytes, normalizes duplicate output declarations and sorts identities deterministically', () => {
	const dir = root();
	writeFileSync(join(dir, 'z.bin'), Buffer.from([0, 255, 1]));
	writeFileSync(join(dir, 'a space__file'), 'text');
	const found = captureReleaseArtifacts(dir, ['z.bin', 'a space__file', 'z.bin']);
	expect(found).toMatchObject({
		ok: true,
		value: [
			{ kind: 'file', path: 'a space__file', bytes: 4 },
			{
				kind: 'file',
				path: 'z.bin',
				bytes: 3,
				sha256: createHash('sha256')
					.update(Buffer.from([0, 255, 1]))
					.digest('hex')
			}
		]
	});
});
it('binds directory layout, empty directories and file contents to a versioned tree stream', () => {
	const dir = root();
	mkdirSync(join(dir, 'bundle/empty'), { recursive: true });
	writeFileSync(join(dir, 'bundle/a.txt'), 'hello');
	const first = captureReleaseArtifacts(dir, ['bundle/']);
	expect(first).toMatchObject({ ok: true, value: [{ kind: 'directory', path: 'bundle', bytes: 5 }] });
	expect(captureReleaseArtifacts(dir, ['bundle'])).toEqual(first);
	writeFileSync(join(dir, 'bundle/a.txt'), 'jello');
	expect(captureReleaseArtifacts(dir, ['bundle'])).not.toEqual(first);
	writeFileSync(join(dir, 'bundle/a.txt'), 'hello');
	rmSync(join(dir, 'bundle/empty'), { recursive: true });
	expect(captureReleaseArtifacts(dir, ['bundle'])).not.toEqual(first);
});
it('refuses missing outputs, traversal and a substituted symlink parent without reading foreign bytes', () => {
	const dir = root();
	const outside = root();
	writeFileSync(join(outside, 'secret'), 'foreign sentinel');
	symlinkSync(outside, join(dir, 'link'), 'junction');
	for (const path of ['missing', '../foreign', 'link/secret'])
		expect(captureReleaseArtifacts(dir, [path])).toMatchObject({ ok: false, problem: { kind: 'storage' } });
	expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('foreign sentinel');
});
it('refuses an escaping output link instead of following or pretending to hash its target', () => {
	const dir = root();
	const outside = root();
	symlinkSync(outside, join(dir, 'escape'), 'junction');
	expect(captureReleaseArtifacts(dir, ['escape'])).toMatchObject({ ok: false, problem: { kind: 'storage' } });
});
it('represents a contained link as link text rather than target file contents', () => {
	const dir = root();
	mkdirSync(join(dir, 'target'));
	symlinkSync(join(dir, 'target'), join(dir, 'inside'), 'junction');
	expect(captureReleaseArtifacts(dir, ['inside'])).toMatchObject({ ok: true, value: [{ kind: 'symlink', path: 'inside' }] });
});
