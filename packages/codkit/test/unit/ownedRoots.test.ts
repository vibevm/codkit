// Several owned directories, and the build outputs inside them
// (PROP-016 ##TYPE-AREA-LAYOUT, ##DECISION-OWNED-DIRECTORIES-AND-BUILD-OUTPUTS,
// PROP-005 ##OWN-ROOTS-IN-THE-DELTA).
//
// The two facts these cases are about were measured on a real clone of the
// second family: a package that compiles in place writes its output next to its
// sources inside the owned directory, and a product's application is a second
// directory the delta owns. Everything here is the engine's half of that - what
// the mirror copies, what the classifier calls changed own code, and where the
// delta keeps the second directory.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareAllOwn, mirrorAllOwnBack, syncAllOwnCode } from '../../src/lib/ownCopy.ts';
import { classifyAllOwn, ownMarkState } from '../../src/lib/ownSides.ts';
import { deltaDirOfRole, isBuildOutput, ownedRootOf, ownedRootsOf, ownedTreePrefixes } from '../../src/lib/ownedRoots.ts';
import type { OwnedRoot } from '../../src/lib/ownedRoots.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { ownedRoot } from '../support/ownedRoots.ts';
import { stubType } from '../support/stubType.ts';

const OWN_DIR = 'packages/product-own';
const APPLICATION_DIR = 'applications/product';

/** The own root compiles in place; the application directory generates as well. */
const ROOTS: readonly OwnedRoot[] = [
	ownedRoot(OWN_DIR, 'own', ['lib/**', '*.tsbuildinfo']),
	ownedRoot(APPLICATION_DIR, 'application', ['lib/**', 'src-gen/**'])
];

afterAll(() => {
	cleanupTempRoots();
});

type Sides = { readonly patchesDir: string; readonly treeDir: string };

function makeSides(label: string, delta: Record<string, string>, tree: Record<string, string>): Sides {
	const patchesDir = makeTempRoot(`owned-${label}-patchset`);
	const treeDir = makeTempRoot(`owned-${label}-tree`);
	for (const [relative, content] of Object.entries(delta)) write(join(patchesDir, ...relative.split('/')), content);
	for (const [relative, content] of Object.entries(tree)) write(join(treeDir, ...relative.split('/')), content);
	return { patchesDir, treeDir };
}

function write(absolute: string, content: string): void {
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

describe('the owned directories a type answers with', () => {
	it('keeps the own root in delta/own and addresses every other one by its role', () => {
		expect(deltaDirOfRole('own')).toBe('delta/own');
		expect(deltaDirOfRole('application')).toBe('delta/own-roots/application');
	});

	it('is the own root alone when the type owns one directory', () => {
		const roots = ownedRootsOf(stubType(), { ownRoot: 'own/here' });
		expect(roots).toEqual([{ path: 'own/here', role: 'own', buildOutputs: [], deltaDir: 'delta/own', upstreamPaths: new Set() }]);
		expect(ownedTreePrefixes(roots)).toEqual(['own/here/']);
	});

	it('refuses an answer whose first directory is not the configured own root', () => {
		const type = stubType({
			layout: {
				ownRootProblem: () => null,
				ownRoots: () => [{ path: 'somewhere/else', role: 'own', buildOutputs: [] }],
				ownExtensionPath: () => null,
				cleanupWhitelist: [],
				forbiddenPatchTargets: []
			}
		});
		expect(() => ownedRootsOf(type, { ownRoot: 'own/here' })).toThrow(/first owned directory must be typeConfig\.ownRoot/);
	});

	it('refuses an owned directory that sits inside another', () => {
		const type = stubType({
			layout: {
				ownRootProblem: () => null,
				ownRoots: (config) => [
					{ path: config.ownRoot, role: 'own', buildOutputs: [] },
					{ path: `${config.ownRoot}/app`, role: 'application', buildOutputs: [] }
				],
				ownExtensionPath: () => null,
				cleanupWhitelist: [],
				forbiddenPatchTargets: []
			}
		});
		expect(() => ownedRootsOf(type, { ownRoot: 'own/here' })).toThrow(/sits inside the owned directory/);
	});

	it('answers which owned directory a tree path belongs to', () => {
		expect(ownedRootOf(ROOTS, `${APPLICATION_DIR}/package.json`)?.role).toBe('application');
		expect(ownedRootOf(ROOTS, 'src/upstream.ts')).toBeNull();
	});

	it('reads the build outputs with the gitignore-style matcher of the whitelist', () => {
		const own = ROOTS[0] as OwnedRoot;
		expect(isBuildOutput(own, 'lib/')).toBe(true);
		expect(isBuildOutput(own, 'lib/feature.js')).toBe(true);
		expect(isBuildOutput(own, 'tsconfig.tsbuildinfo')).toBe(true);
		expect(isBuildOutput(own, 'src/feature.ts')).toBe(false);
	});
});

describe('the mirror over several owned directories', () => {
	it('materializes each of them from its own delta directory', () => {
		const sides = makeSides(
			'materialize',
			{
				'delta/own/src/feature.ts': 'export const feature = 1;\n',
				'delta/own-roots/application/package.json': '{ "name": "product" }\n'
			},
			{}
		);
		const report = syncAllOwnCode(sides.patchesDir, sides.treeDir, ROOTS);
		expect(report.copied).toBe(2);
		expect(report.total).toBe(2);
		expect(readFileSync(join(sides.treeDir, OWN_DIR, 'src', 'feature.ts'), 'utf8')).toContain('feature = 1');
		expect(readFileSync(join(sides.treeDir, APPLICATION_DIR, 'package.json'), 'utf8')).toContain('product');
	});

	it('leaves a build output inside an owned directory alone, and never carries it into the delta', () => {
		const sides = makeSides(
			'build-output',
			{ 'delta/own/src/feature.ts': 'export const feature = 1;\n' },
			{
				[`${OWN_DIR}/src/feature.ts`]: 'export const feature = 1;\n',
				[`${OWN_DIR}/lib/feature.js`]: 'exports.feature = 1;\n',
				[`${OWN_DIR}/tsconfig.tsbuildinfo`]: '{"version":"1"}\n'
			}
		);
		// A compiled tree is not a changed tree: nothing diverges, nothing is
		// classified as work at risk, and the load leaves the output in place.
		expect(compareAllOwn(sides.patchesDir, sides.treeDir, ROOTS)).toEqual([]);
		const classes = classifyAllOwn(sides.patchesDir, sides.treeDir, ROOTS, () => null).filter((entry) => entry.kind !== 'same');
		expect(classes).toEqual([]);
		const report = syncAllOwnCode(sides.patchesDir, sides.treeDir, ROOTS);
		expect(report.removed).toBe(0);
		expect(existsSync(join(sides.treeDir, OWN_DIR, 'lib', 'feature.js'))).toBe(true);
		// And `save` extracts none of it.
		const mirrored = mirrorAllOwnBack(sides.patchesDir, sides.treeDir, ROOTS, classes);
		expect(mirrored.copied).toBe(0);
		expect(existsSync(join(sides.patchesDir, 'delta', 'own', 'lib'))).toBe(false);
	});

	it('extracts an edit of the application directory back into its own delta directory', () => {
		const sides = makeSides(
			'extract',
			{ 'delta/own-roots/application/package.json': '{ "name": "product" }\n' },
			{
				[`${APPLICATION_DIR}/package.json`]: '{ "name": "product", "version": "2" }\n',
				[`${APPLICATION_DIR}/lib/bundle.js`]: '// built\n'
			}
		);
		const mark = { 'package.json': shaOfDelta(sides.patchesDir, 'delta/own-roots/application/package.json') };
		const classes = classifyAllOwn(sides.patchesDir, sides.treeDir, ROOTS, (owned) => (owned.role === 'application' ? mark : null)).filter(
			(entry) => entry.kind !== 'same'
		);
		expect(classes.map((entry) => [entry.owned.role, entry.relative, entry.kind])).toEqual([
			['application', 'package.json', 'tree-edited']
		]);
		mirrorAllOwnBack(sides.patchesDir, sides.treeDir, ROOTS, classes);
		expect(readFileSync(join(sides.patchesDir, 'delta', 'own-roots', 'application', 'package.json'), 'utf8')).toContain('"version": "2"');
		expect(existsSync(join(sides.patchesDir, 'delta', 'own-roots', 'application', 'lib'))).toBe(false);
	});

	it('records one map per owned directory in the mark, and the own root keeps the historical field', () => {
		const sides = makeSides(
			'mark',
			{
				'delta/own/src/feature.ts': 'export const feature = 1;\n',
				'delta/own-roots/application/package.json': '{ "name": "product" }\n'
			},
			{}
		);
		const state = ownMarkState(sides.patchesDir, ROOTS);
		expect(Object.keys(state.ownFiles)).toEqual(['src/feature.ts']);
		expect(Object.keys(state.ownRootFiles ?? {})).toEqual(['application']);
		expect(Object.keys(state.ownRootFiles?.['application'] ?? {})).toEqual(['package.json']);
		expect(ownMarkState(sides.patchesDir, [ROOTS[0] as OwnedRoot]).ownRootFiles).toBeUndefined();
	});
});

/** sha256 of one delta file: the digest the mark's per-file map records. */
function shaOfDelta(patchesDir: string, relative: string): string {
	return createHash('sha256')
		.update(readFileSync(join(patchesDir, ...relative.split('/'))))
		.digest('hex');
}
