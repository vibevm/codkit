/** @scope spec://codkit/modules/codkit/PROP-008#classify */
// Generic forecast analysis over a complete frozen patch/rule/overlay/resource inventory.

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { encodePatchName, formatPatchHeader } from '../../src/lib/patchFormat.ts';
import { analyzeUpgrade } from '../../src/lib/upgradeAnalysis.ts';
import type { UpgradeAnalysisOptions } from '../../src/lib/upgradeAnalysis.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const PATCH_TARGETS = {
	clean: 'src/clean.ts',
	shifted: 'src/shifted.ts',
	merged: 'src/merged.ts',
	conflict: 'src/conflict.ts',
	deleted: 'src/deleted.ts',
	renamed: 'src/rename-old.ts'
} as const;
const RENAMED_PATCH_TARGET = 'src/rename-new.ts';

type Fixture = {
	readonly tree: string;
	readonly root: string;
	readonly t1: string;
	readonly t2: string;
	readonly config: CodkitConfig;
};

function makeFixture(label: string): Fixture {
	const tree = makeTempRoot(`${label}-tree`);
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	for (const target of Object.values(PATCH_TARGETS)) write(tree, target, 'a\nbase\nz\n');
	write(tree, PATCH_TARGETS.deleted, 'a\nbase\ndeleted-z\n');
	write(tree, PATCH_TARGETS.renamed, 'a\nbase\nrename-z\n');
	write(tree, 'src/rule-clean.ts', 'anchor\nstable\n');
	write(tree, 'src/rule-broken.ts', 'old-anchor\n');
	write(tree, 'config/manifest.json', '{"name":"old","stable":true}\n');
	write(tree, 'resources/stable.bin', 'stable\n');
	write(tree, 'resources/deleted.bin', 'deleted\n');
	write(tree, 'resources/old.bin', 'renamed\n');
	const t1 = fixtureCommit(tree, 'fixture: current pin', '2026-07-01T00:00:00Z');

	write(tree, PATCH_TARGETS.shifted, 'a\nbase\nz\nupstream-tail\n');
	write(tree, PATCH_TARGETS.merged, 'prefix\na\nbase\nz\n');
	write(tree, PATCH_TARGETS.conflict, 'a\nupstream\nz\n');
	rmSync(join(tree, PATCH_TARGETS.deleted));
	fixtureGit(tree, ['mv', PATCH_TARGETS.renamed, RENAMED_PATCH_TARGET]);
	write(tree, 'src/rule-broken.ts', 'new-anchor\n');
	write(tree, 'config/manifest.json', '{"name":"new","stable":true}\n');
	rmSync(join(tree, 'resources/deleted.bin'));
	fixtureGit(tree, ['mv', 'resources/old.bin', 'resources/new.bin']);
	const t2 = fixtureCommit(tree, 'fixture: forecast target', '2026-07-02T00:00:00Z');

	const root = makeTempRoot(`${label}-patchset`);
	fixtureGit(root, ['init', '--quiet', '--initial-branch=ordinary-main', '.']);
	const conventions = join(root, 'codkit/config/conventions.json');
	mkdirSync(dirname(conventions), { recursive: true });
	copyFileSync(fileURLToPath(new URL('../../config/conventions.json', import.meta.url)), conventions);
	for (const [index, target] of Object.values(PATCH_TARGETS).entries()) {
		writePatch(root, target, `CK-shell-80${index}`, t1);
	}
	writeRule(root, 'src/rule-clean.ts', 'CK-build-801', t1, 'anchor');
	writeRule(root, 'src/rule-broken.ts', 'CK-build-802', t1, 'old-anchor');
	writeOverlay(root, t1);
	writeResources(root, t1);
	fixtureCommit(root, 'fixture: frozen forecast inventory', '2026-07-03T00:00:00Z');

	const config: CodkitConfig = {
		codkitConfig: 2,
		pin: { tag: 't1', sha: t1, date: commitDate(tree, t1) },
		upstreamAnchorCommit: t1,
		type: 'stub',
		typeConfig: { ownRoot: 'source/own' },
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
	return { tree, root, t1, t2, config };
}

function options(fixture: Fixture, newRef = fixture.t2): UpgradeAnalysisOptions {
	return { patchesDir: fixture.root, treeDir: fixture.tree, config: fixture.config, type: stubProjectType, newRef };
}

function writePatch(root: string, target: string, id: string, pin: string): void {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'forecast fixture patch',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: []
	});
	const tail = target === PATCH_TARGETS.deleted ? 'deleted-z' : target === PATCH_TARGETS.renamed ? 'rename-z' : 'z';
	const body = [`--- a/${target}`, `+++ b/${target}`, '@@ -1,3 +1,3 @@', ' a', '-base', '+codkit', ` ${tail}`].join('\n');
	write(root, `delta/patches/${encodePatchName(target)}`, `${header}${body}\n`);
}

function writeRule(root: string, target: string, id: string, pin: string, match: string): void {
	writeJson(root, `delta/rules/${id}.ckrule.json`, {
		codkitRule: 2,
		id,
		type: 'hook',
		category: 'follow',
		owner: 'automation',
		reason: 'forecast fixture rule',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: [],
		target,
		engine: 'line-ops',
		expectedMatches: 1,
		ops: [
			{ match, action: 'append-after', text: `// codkit:begin ${id}` },
			{ match: `// codkit:begin ${id}`, action: 'append-after', text: `// codkit:end ${id}` }
		]
	});
}

function writeOverlay(root: string, pin: string): void {
	writeJson(root, 'delta/overlays/product.overlay.json', {
		codkitOverlay: 2,
		id: 'CK-product-801',
		target: 'config/manifest.json',
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'forecast fixture overlay',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: ['fixture.overlay'],
		operations: [{ op: 'set', path: ['name'], value: 'patchset', expectUpstream: 'old' }]
	});
}

function writeResources(root: string, pin: string): void {
	for (const name of ['stable.bin', 'deleted.bin', 'renamed.bin']) write(root, `delta/resources/files/${name}`, `${name}\n`);
	writeJson(root, 'delta/resources/map.json', {
		codkitResourceMap: 2,
		entries: [
			resource('CK-product-802', 'resources/deleted.bin', 'deleted.bin', pin),
			resource('CK-product-803', 'resources/old.bin', 'renamed.bin', pin),
			resource('CK-product-804', 'resources/stable.bin', 'stable.bin', pin)
		]
	});
}

function resource(id: string, target: string, source: string, pin: string) {
	return {
		id,
		target,
		source: `delta/resources/files/${source}`,
		type: 'modify',
		category: 'own',
		owner: 'assets',
		reason: 'forecast fixture resource',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: ['fixture.resource']
	};
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function writeJson(root: string, path: string, value: unknown): void {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function commitDate(tree: string, sha: string): string {
	return fixtureGit(tree, ['show', '-s', '--format=%cs', sha]).stdout.trim();
}

function byteSorted(values: readonly string[]): readonly string[] {
	return [...values].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function failure(run: () => unknown): { readonly code: string; readonly message: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) return { code: error.code, message: error.message };
		throw error;
	}
	throw new Error('expected analysis to fail');
}

afterAll(() => cleanupTempRoots());

describe('analyzeUpgrade', () => {
	it('returns the complete t2 forecast with causes, owners, renames, and resources', () => {
		const fixture = makeFixture('upgrade-analysis-t2');
		const result = analyzeUpgrade(options(fixture));

		expect(result.artifacts).toHaveLength(12);
		expect(result.artifacts.map((item) => item.artifactPath)).toEqual(byteSorted(result.artifacts.map((item) => item.artifactPath)));
		expect(result.counts).toEqual({
			total: 12,
			nonClean: 9,
			byOutcome: {
				clean: 3,
				shifted: 1,
				merged: 1,
				conflict: 2,
				'target-deleted': 2,
				'target-renamed': 2,
				'rule-broken': 1,
				'contract-failed': 0
			}
		});
		expect(result.renames).toEqual([
			{ from: 'resources/old.bin', to: 'resources/new.bin', similarity: 100 },
			{ from: PATCH_TARGETS.renamed, to: RENAMED_PATCH_TARGET, similarity: 100 }
		]);
		expect(result.owners.map((group) => [group.owner, group.counts.total, group.counts.nonClean])).toEqual([
			['assets', 3, 2],
			['automation', 2, 1],
			['product', 1, 1],
			['shell-core', 6, 5]
		]);
		expect(result.artifacts.filter((item) => item.cause !== null)).toHaveLength(9);
		expect(result.artifacts.filter((item) => item.cause !== null).every((item) => item.cause?.sha === fixture.t2)).toBe(true);
		expect(result.artifacts.filter((item) => item.kind === 'resource').map((item) => item.outcome)).toEqual([
			'target-deleted',
			'target-renamed',
			'clean'
		]);
		expect(result.artifacts.find((item) => item.targetPath === RENAMED_PATCH_TARGET)?.outcome).toBe('target-renamed');
	});

	it('reports the current pin as clean without requiring a cycle branch or state', () => {
		const fixture = makeFixture('upgrade-analysis-current');
		const result = analyzeUpgrade(options(fixture, fixture.t1));

		expect(runGit({ args: ['branch', '--show-current'], cwd: fixture.root }).stdout.trim()).toBe('ordinary-main');
		expect(result.counts).toMatchObject({ total: 12, nonClean: 0 });
		expect(result.outcomes.clean).toHaveLength(12);
		expect(result.renames).toEqual([]);
		expect(result.artifacts.every((item) => item.outcome === 'clean' && item.cause === null)).toBe(true);
	});

	it('rejects an unreachable or non-descendant immutable ref', () => {
		const fixture = makeFixture('upgrade-analysis-ancestry');
		const missing = failure(() => analyzeUpgrade(options(fixture, 'f'.repeat(40))));
		const treeId = fixtureGit(fixture.tree, ['rev-parse', `${fixture.t1}^{tree}`]).stdout.trim();
		const identity = {
			GIT_AUTHOR_NAME: 'fixture',
			GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
			GIT_AUTHOR_DATE: '2026-07-04T00:00:00Z',
			GIT_COMMITTER_NAME: 'fixture',
			GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
			GIT_COMMITTER_DATE: '2026-07-04T00:00:00Z'
		};
		const orphan = fixtureGit(fixture.tree, ['commit-tree', treeId, '-m', 'fixture: unrelated root'], identity).stdout.trim();
		const unrelated = failure(() => analyzeUpgrade(options(fixture, orphan)));

		expect(missing.code).toBe('PIN-UNREACHABLE');
		expect(unrelated.code).toBe('PIN-UNREACHABLE');
		expect(unrelated.message).toContain('not a descendant');
	});

	it('rejects a resource target introduced only after its metadata pin', () => {
		const fixture = makeFixture('upgrade-analysis-resource-source');
		write(fixture.tree, 'resources/introduced.bin', 'introduced later\n');
		const t3 = fixtureCommit(fixture.tree, 'fixture: introduce resource after source pin', '2026-07-04T00:00:00Z');
		write(fixture.root, 'delta/resources/files/introduced.bin', 'replacement\n');
		const mapPath = join(fixture.root, 'delta/resources/map.json');
		const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { entries: unknown[] };
		map.entries.push(resource('CK-product-805', 'resources/introduced.bin', 'introduced.bin', fixture.t1));
		map.entries.sort((left, right) =>
			Buffer.from((left as { target: string }).target).compare(Buffer.from((right as { target: string }).target))
		);
		writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');

		const found = failure(() => analyzeUpgrade(options(fixture, t3)));
		expect(found.code).toBe('ARTIFACT-BROKEN');
		expect(found.message).toContain('absent at metadata pin');
	});

	it('fails loudly on a malformed frozen layer before classifying a partial list', () => {
		const fixture = makeFixture('upgrade-analysis-malformed');
		writeJson(fixture.root, 'delta/rules/broken.ckrule.json', { codkitRule: 999 });
		let mergeCalled = false;

		const result = failure(() =>
			analyzeUpgrade({
				...options(fixture),
				mergeFile: () => {
					mergeCalled = true;
					return { bytes: new Uint8Array(0), hasConflicts: false };
				}
			})
		);

		expect(result.code).toBe('ARTIFACT-BROKEN');
		expect(mergeCalled).toBe(false);
	});

	it('does not mutate refs, indexes, work trees, cycle state, .codkit, or out', () => {
		const fixture = makeFixture('upgrade-analysis-immutable');
		write(fixture.root, 'dirty-sentinel.txt', 'patchset dirty\n');
		write(fixture.tree, 'tree-sentinel.txt', 'tree dirty\n');
		const before = {
			rootHead: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.root }).stdout,
			rootRefs: runGit({ args: ['show-ref'], cwd: fixture.root }).stdout,
			rootStatus: runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.root }).stdout,
			rootIndex: readFileSync(join(fixture.root, '.git/index')),
			treeHead: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.tree }).stdout,
			treeRefs: runGit({ args: ['show-ref'], cwd: fixture.tree }).stdout,
			treeStatus: runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.tree }).stdout,
			treeIndex: readFileSync(join(fixture.tree, '.git/index')),
			rootSentinel: readFileSync(join(fixture.root, 'dirty-sentinel.txt')),
			treeSentinel: readFileSync(join(fixture.tree, 'tree-sentinel.txt'))
		};

		const result = analyzeUpgrade(options(fixture));

		expect(result.artifacts).toHaveLength(12);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.root }).stdout).toBe(before.rootHead);
		expect(runGit({ args: ['show-ref'], cwd: fixture.root }).stdout).toBe(before.rootRefs);
		expect(runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.root }).stdout).toBe(before.rootStatus);
		expect(readFileSync(join(fixture.root, '.git/index'))).toEqual(before.rootIndex);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.tree }).stdout).toBe(before.treeHead);
		expect(runGit({ args: ['show-ref'], cwd: fixture.tree }).stdout).toBe(before.treeRefs);
		expect(runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.tree }).stdout).toBe(before.treeStatus);
		expect(readFileSync(join(fixture.tree, '.git/index'))).toEqual(before.treeIndex);
		expect(readFileSync(join(fixture.root, 'dirty-sentinel.txt'))).toEqual(before.rootSentinel);
		expect(readFileSync(join(fixture.tree, 'tree-sentinel.txt'))).toEqual(before.treeSentinel);
		for (const path of ['cycle/state.json', 'cycle/log', '.codkit', 'out']) expect(existsSync(join(fixture.root, path))).toBe(false);
		for (const path of ['.codkit', 'out']) expect(existsSync(join(fixture.tree, path))).toBe(false);
	});
});
