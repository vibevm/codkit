import { describe, expect, it } from 'vitest';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { applyOperations, parseOverlay, restrictedTargetViolations, validateNpmDependencyPairs } from '../../src/lib/layers/overlay.ts';
import type { JsonLike, OverlayVarContext } from '../../src/lib/layers/overlay.ts';
import { pruneNpmDependency } from '../../src/lib/layers/npmPrune.ts';

const context: OverlayVarContext = {
	pinTag: '1.135.0',
	pinSha: 'a'.repeat(40),
	pinDate: '2026-09-28',
	patchSetCommit: 'b'.repeat(40),
	buildDate: '2026-09-28'
};

const metadata = {
	codkitOverlay: 2,
	id: 'CK-build-901',
	type: 'modify',
	category: 'own',
	owner: 'build',
	reason: 'remove unused proprietary dependency',
	link: 'none',
	cause: 'none',
	pin: `1.135.0@${'a'.repeat(40)}`,
	contractTests: ['build.guard.dependencies']
};

function lock(): { [key: string]: JsonLike } {
	return {
		name: 'example',
		lockfileVersion: 3,
		packages: {
			'': { dependencies: { obsolete: '1.0.0', shared: '1.0.0', keeper: '1.0.0' } },
			'node_modules/obsolete': { version: '1.0.0', dependencies: { private: '1.0.0', shared: '1.0.0' } },
			'node_modules/private': { version: '1.0.0', dependencies: { leaf: '1.0.0' } },
			'node_modules/leaf': { version: '1.0.0' },
			'node_modules/shared': { version: '1.0.0' },
			'node_modules/keeper': { version: '1.0.0', dependencies: { shared: '1.0.0' } },
			'node_modules/old-orphan': { version: '1.0.0' }
		}
	};
}

describe('npm-prune overlay operation', () => {
	it('removes only newly orphaned package instances', () => {
		const document = lock();
		pruneNpmDependency(document, ['packages', '', 'dependencies', 'obsolete']);
		const packages = document['packages'];
		expect(packages).toEqual({
			'': { dependencies: { shared: '1.0.0', keeper: '1.0.0' } },
			'node_modules/shared': { version: '1.0.0' },
			'node_modules/keeper': { version: '1.0.0', dependencies: { shared: '1.0.0' } },
			'node_modules/old-orphan': { version: '1.0.0' }
		});
	});

	it('resolves nested node_modules before ancestors', () => {
		const document = lock();
		const packages = document['packages'];
		if (packages === null || typeof packages !== 'object' || Array.isArray(packages)) throw new Error('fixture');
		packages['node_modules/obsolete/node_modules/private'] = { version: '2.0.0' };
		pruneNpmDependency(document, ['packages', '', 'dependencies', 'obsolete']);
		expect(packages['node_modules/obsolete/node_modules/private']).toBeUndefined();
		expect(packages['node_modules/private']).toEqual({ version: '1.0.0', dependencies: { leaf: '1.0.0' } });
	});

	it('rejects lockfile versions it cannot safely transform', () => {
		const document = { ...lock(), lockfileVersion: 2 };
		expect(() => pruneNpmDependency(document, ['packages', '', 'dependencies', 'obsolete'])).toThrow('v3 only');
	});

	it('is an ordinary, non-mutating overlay render input', () => {
		const original = lock();
		const transformed = applyOperations(original, [{ op: 'npm-prune', path: ['packages', '', 'dependencies', 'obsolete'] }], context);
		expect(JSON.stringify(original)).toContain('node_modules/obsolete');
		expect(JSON.stringify(transformed)).not.toContain('node_modules/obsolete');
	});

	it('permits exact manifest and lockfile removals on declared VS Code targets only', () => {
		const manifest = parseOverlay(
			{
				...metadata,
				target: 'remote/package.json',
				operations: [{ op: 'remove', path: ['dependencies', '@github/copilot'], expectUpstream: '1.0.81-0' }]
			},
			'delta/overlays/remote__package.json.overlay.json'
		);
		const lockfile = parseOverlay(
			{
				...metadata,
				target: 'remote/package-lock.json',
				operations: [{ op: 'npm-prune', path: ['packages', '', 'dependencies', '@github/copilot'], expectUpstream: '1.0.81-0' }]
			},
			'delta/overlays/remote__package-lock.json.overlay.json'
		);
		expect(restrictedTargetViolations(vscodeType, manifest)).toEqual([]);
		expect(restrictedTargetViolations(vscodeType, lockfile)).toEqual([]);
		expect(() => validateNpmDependencyPairs([manifest, lockfile])).not.toThrow();
		expect(() => validateNpmDependencyPairs([manifest])).toThrow('no matching npm-prune');
		expect(() => validateNpmDependencyPairs([lockfile])).toThrow('no matching remove');
		expect(restrictedTargetViolations(vscodeType, { ...lockfile, target: 'product.json' })).toHaveLength(1);
		expect(
			restrictedTargetViolations(vscodeType, {
				...manifest,
				operations: [{ op: 'remove', path: ['dependencies', '@github/copilot'] }]
			})
		).toHaveLength(1);
	});

	it('updates a dependency-free direct package with matching pin guards', () => {
		const manifest = parseOverlay(
			{
				...metadata,
				target: 'package.json',
				operations: [{ op: 'set', path: ['dependencies', 'jschardet'], value: '4.0.0', expectUpstream: '3.1.4' }]
			},
			'delta/overlays/package.json.overlay.json'
		);
		const oldPackage = { version: '3.1.4', resolved: 'https://registry.example/old.tgz', integrity: 'sha512-old', license: 'LGPL-2.1+' };
		const newPackage = { version: '4.0.0', resolved: 'https://registry.example/new.tgz', integrity: 'sha512-new', license: '0BSD' };
		const lockfile = parseOverlay(
			{
				...metadata,
				target: 'package-lock.json',
				operations: [
					{ op: 'set', path: ['packages', '', 'dependencies', 'jschardet'], value: '4.0.0', expectUpstream: '3.1.4' },
					{ op: 'set', path: ['packages', 'node_modules/jschardet'], value: newPackage, expectUpstream: oldPackage }
				]
			},
			'delta/overlays/package-lock.json.overlay.json'
		);
		expect(restrictedTargetViolations(vscodeType, manifest)).toEqual([]);
		expect(restrictedTargetViolations(vscodeType, lockfile)).toEqual([]);
		expect(() => validateNpmDependencyPairs([manifest, lockfile])).not.toThrow();
		expect(() => validateNpmDependencyPairs([manifest])).toThrow('needs a matching dependency-free lockfile update');
		const [rootOperation, packageOperation] = lockfile.operations;
		if (rootOperation === undefined || packageOperation === undefined) throw new Error('fixture');
		expect(() =>
			validateNpmDependencyPairs([
				manifest,
				{
					...lockfile,
					operations: [rootOperation, { ...packageOperation, value: { ...newPackage, dependencies: { extra: '1.0.0' } } }]
				}
			])
		).toThrow('needs a matching dependency-free lockfile update');
	});
});
