import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TypePackageApproval } from '../../src/types/installation.ts';

const probe = vi.hoisted((): { approval: TypePackageApproval | null } => ({ approval: null }));
vi.mock('../../src/lib/containedFile.ts', async (original) => {
	const actual = await original<typeof import('../../src/lib/containedFile.ts')>();
	return {
		...actual,
		readContainedFile: (root: string, path: string, options: { what: string }) =>
			path === 'config/type-registry.json' && probe.approval !== null
				? { state: 'present', bytes: Buffer.from(JSON.stringify({ codkitTypeRegistry: 1, entries: [probe.approval] })) }
				: actual.readContainedFile(root, path, options)
	};
});
import { resolveProjectType } from '../../src/types/registry.ts';

const packageParent = resolve(import.meta.dirname, '../../../../node_modules/@codkit');
const roots: string[] = [];
afterEach(() => {
	probe.approval = null;
	for (const root of roots.splice(0)) {
		if (!root.startsWith(`${packageParent}\\`) && !root.startsWith(`${packageParent}/`))
			throw new Error('fixture cleanup escaped its package parent');
		rmSync(root, { recursive: true, force: true });
	}
});

function fixture() {
	const id = `integrity-probe-${randomUUID()}`;
	const packageName = `@codkit/${id}`;
	const root = join(packageParent, id);
	mkdirSync(root);
	roots.push(root);
	mkdirSync(join(root, 'dist'));
	const sentinel = join(root, 'executed');
	const adapter = join(root, 'dist', 'index.js');
	writeFileSync(
		adapter,
		`import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed'); throw new Error('adapter evaluated');`
	);
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({
			name: packageName,
			version: '1.0.0',
			type: 'module',
			exports: { '.': './dist/index.js', './package.json': './package.json', './type-manifest.json': './type-manifest.json' }
		})
	);
	const manifest = {
		typeManifestVersion: 1,
		contractVersion: 1,
		id,
		package: packageName,
		version: '1.0.0',
		engineRange: { min: '1.0.0', maxExclusive: '2.0.0' },
		capabilities: [],
		configurableCapabilities: []
	};
	writeFileSync(join(root, 'type-manifest.json'), JSON.stringify(manifest));
	const paths = ['dist/index.js', 'package.json', 'type-manifest.json'];
	const digest = (path: string) =>
		createHash('sha256')
			.update(readFileSync(join(root, path)))
			.digest('hex');
	probe.approval = {
		id,
		package: packageName,
		version: '1.0.0',
		contractVersion: 1,
		manifestSha256: digest('type-manifest.json'),
		integrityRoots: ['dist', 'package.json', 'type-manifest.json'],
		files: paths.map((path) => ({ path, sha256: digest(path) }))
	};
	return { id, root, adapter, sentinel };
}

describe('integrity refusal on the real import path', () => {
	it('refuses changed code before its first statement executes', async () => {
		const sample = fixture();
		writeFileSync(sample.adapter, `${readFileSync(sample.adapter, 'utf8')}\n// changed\n`);
		await expect(resolveProjectType(sample.id)).rejects.toThrow(/integrity mismatch.*dist\/index.js/);
		expect(existsSync(sample.sentinel)).toBe(false);
	});
	it('refuses declaration tampering before evaluation', async () => {
		const sample = fixture();
		writeFileSync(join(sample.root, 'type-manifest.json'), `${readFileSync(join(sample.root, 'type-manifest.json'), 'utf8')}\n`);
		await expect(resolveProjectType(sample.id)).rejects.toThrow(/manifest integrity mismatch/);
		expect(existsSync(sample.sentinel)).toBe(false);
	});
	it('refuses an extra runtime file before evaluation', async () => {
		const sample = fixture();
		writeFileSync(join(sample.root, 'dist', 'extra.js'), 'throw new Error("extra");');
		await expect(resolveProjectType(sample.id)).rejects.toThrow(/unapproved file/);
		expect(existsSync(sample.sentinel)).toBe(false);
	});
	it('evaluates approved code only after receipts match', async () => {
		const sample = fixture();
		await expect(resolveProjectType(sample.id)).rejects.toThrow(/adapter evaluated/);
		expect(existsSync(sample.sentinel)).toBe(true);
	});
});
