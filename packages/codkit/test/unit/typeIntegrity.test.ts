import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { typeIntegrityProblems } from '../../src/types/integrity.ts';
import type { TypePackageApproval } from '../../src/types/installation.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'codkit-type-integrity-'));
	roots.push(root);
	mkdirSync(join(root, 'dist'));
	writeFileSync(join(root, 'dist', 'index.js'), 'export const projectType = {};\n');
	const approval: TypePackageApproval = {
		id: 'sample',
		package: '@codkit/type-sample',
		version: '1.0.0',
		contractVersion: 1,
		manifestSha256: 'a'.repeat(64),
		integrityRoots: ['dist'],
		files: [
			{
				path: 'dist/index.js',
				sha256: createHash('sha256')
					.update(readFileSync(join(root, 'dist', 'index.js')))
					.digest('hex')
			}
		]
	};
	return { root, approval };
}

describe('installation byte receipts', () => {
	it('accepts exactly approved execution bytes', () => {
		const { root, approval } = fixture();
		expect(typeIntegrityProblems(root, approval)).toEqual([]);
	});
	it('refuses a modified adapter without evaluating it', () => {
		const { root, approval } = fixture();
		const sentinel = join(root, 'executed');
		writeFileSync(
			join(root, 'dist', 'index.js'),
			`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'bad');`
		);
		expect(typeIntegrityProblems(root, approval).join()).toContain('dist/index.js');
		expect(existsSync(sentinel)).toBe(false);
	});
	it('refuses an unapproved addition under a publication root', () => {
		const { root, approval } = fixture();
		writeFileSync(join(root, 'dist', 'foreign.js'), 'throw new Error("not approved");');
		expect(typeIntegrityProblems(root, approval).join()).toContain('unapproved file');
	});
	it('refuses missing approved bytes', () => {
		const { root, approval } = fixture();
		rmSync(join(root, 'dist', 'index.js'));
		expect(typeIntegrityProblems(root, approval).join()).toContain('integrity mismatch');
	});
	it('refuses traversal in a forged receipt', () => {
		const { root, approval } = fixture();
		expect(typeIntegrityProblems(root, { ...approval, files: [{ path: '../foreign.js', sha256: 'a'.repeat(64) }] }).length).toBeGreaterThan(
			0
		);
	});
});
