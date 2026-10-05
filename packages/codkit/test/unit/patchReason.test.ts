/** @scope spec://codkit/modules/codkit/PROP-007#CMD-MARKER-REASON */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authorPatchReason } from '../../src/lib/patchReason.ts';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import { resolveProjectType } from '../../src/types/registry.ts';

const conventions = loadConventions(await resolveProjectType('vscode'));
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'codkit-patch-reason-'));
	roots.push(root);
	mkdirSync(join(root, 'delta/patches'), { recursive: true });
	writeFileSync(join(root, 'delta/owners.json'), JSON.stringify({ owners: { 'product-core': {} } }));
	const path = join(root, 'delta/patches/src__item.ts.ckpatch');
	const body = '--- a/src/item.ts\n+++ b/src/item.ts\n@@ -1,1 +1,2 @@\n first\n+second\n';
	const bytes = Buffer.from(
		'# codkit-patch: 2\n# id: CK-workbench-997\n# layer: patch\n# type: modify\n# category: follow\n# owner: product-core\n# reason: old --- reason\n# link: none\n# cause: none\n# pin: 1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5\n# contract-tests: none\n' +
			body
	);
	writeFileSync(path, bytes);
	return {
		root,
		path,
		bytes,
		body,
		request: {
			target: 'src/item.ts',
			expectedId: 'CK-workbench-997',
			expectedHash: hash(bytes),
			reason: 'not own: new --- reason',
			dryRun: false
		}
	};
}
describe('scoped patch reason authoring', () => {
	it('dry-runs exact preview and updates only reason while preserving explicit layer and body', () => {
		const f = fixture();
		const preview = authorPatchReason(f.root, { ...f.request, dryRun: true }, conventions);
		expect(readFileSync(f.path)).toEqual(f.bytes);
		expect(preview.status).toBe('dry-run');
		const result = authorPatchReason(f.root, f.request, conventions);
		const after = readFileSync(f.path);
		expect(after.toString()).toBe(f.bytes.toString().replace('# reason: old --- reason', '# reason: not own: new --- reason'));
		expect(result.bodyHash).toBe(hash(Buffer.from(f.body)));
		expect(result.status).toBe('updated');
		expect(authorPatchReason(f.root, { ...f.request, expectedHash: hash(after) }, conventions).status).toBe('unchanged');
	});
	it('rejects hash/id/malformed reason and scope changes without writing', () => {
		const f = fixture();
		for (const change of [
			{ expectedHash: '0'.repeat(64) },
			{ expectedId: 'CK-workbench-996' },
			{ reason: 'bad\nreason' },
			{ target: '../src/item.ts' },
			{ target: 'C:/src/item.ts' },
			{ target: 'src/missing.ts' }
		]) {
			expect(() => authorPatchReason(f.root, { ...f.request, ...change }, conventions)).toThrow();
			expect(readFileSync(f.path)).toEqual(f.bytes);
		}
	});
	it('retains concurrent bytes after the pre-replace CAS and cleans its temporary', () => {
		const f = fixture();
		const concurrent = Buffer.from(f.bytes.toString().replace('old --- reason', 'concurrent reason'));
		expect(() => authorPatchReason(f.root, f.request, conventions, () => writeFileSync(f.path, concurrent))).toThrow(
			/changed before replacement/
		);
		expect(readFileSync(f.path)).toEqual(concurrent);
		expect(readdirSync(join(f.root, 'delta/patches'))).toEqual(['src__item.ts.ckpatch']);
	});
	it('rejects malformed current bytes, undeclared owner and generated rule metadata without repair', () => {
		for (const mutate of [
			(bytes: Buffer) => Buffer.from(bytes.toString().replace('# owner: product-core', '# owner: nobody')),
			(bytes: Buffer) => Buffer.from(bytes.toString().replace('# layer: patch', '# layer: rewrite-rule')),
			(bytes: Buffer) => Buffer.from(bytes.toString().replace('@@ -1,1 +1,2 @@', 'malformed hunk'))
		]) {
			const f = fixture();
			const changed = mutate(f.bytes);
			writeFileSync(f.path, changed);
			expect(() => authorPatchReason(f.root, { ...f.request, expectedHash: hash(changed) }, conventions)).toThrow();
			expect(readFileSync(f.path)).toEqual(changed);
		}
	});
	it('refuses symlink parent redirection and preserves the outside artifact', () => {
		const f = fixture();
		const outside = mkdtempSync(join(tmpdir(), 'codkit-reason-outside-'));
		roots.push(outside);
		writeFileSync(join(outside, 'src__item.ts.ckpatch'), f.bytes);
		rmSync(join(f.root, 'delta/patches'), { recursive: true });
		symlinkSync(outside, join(f.root, 'delta/patches'), process.platform === 'win32' ? 'junction' : 'dir');
		expect(() => authorPatchReason(f.root, f.request, conventions)).toThrow(/symlink/);
		expect(readFileSync(join(outside, 'src__item.ts.ckpatch'))).toEqual(f.bytes);
	});
});
