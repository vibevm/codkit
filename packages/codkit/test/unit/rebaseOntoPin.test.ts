/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { rebaseOntoPinCommand } from '../../src/commands/rebaseOntoPin.ts';
import type { CommandContext } from '../../src/lib/command.ts';
import { loadConfig, serializeBaseConfig, type CodkitConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { encodePatchName, formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import { rebaseOntoPin } from '../../src/lib/rebaseOntoPin.ts';
import { REBASE_MOVE_PATH } from '../../src/lib/rebaseOntoPinMove.ts';
import { readRebasePending } from '../../src/lib/rebaseOntoPinPending.ts';
import { runSave } from '../../src/lib/saveEngine.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';
// prettier-ignore
const TARGETS = { clean: 'src/clean.ts', shifted: 'src/shifted.ts', merged: 'src/merged.ts', conflict: 'src/conflict.ts', deleted: 'src/deleted.ts', rename: 'src/rename-old.ts' } as const;
const RENAMED = 'src/rename-new.ts';
const TARGET_ONLY = 'src/target-only.ts';
const OWN_TARGET = 'src/vs/patchset/targetOwn.ts';
const OVERLAY_TARGET = 'config/product.json';
const RESOURCE_TARGET = 'resources/logo.bin';
// prettier-ignore
const IDS = { clean: 'CK-workbench-711', shifted: 'CK-workbench-712', merged: 'CK-workbench-713', conflict: 'CK-workbench-714', deleted: 'CK-workbench-715', rename: 'CK-workbench-716' } as const;
// prettier-ignore
type FixtureOptions = { readonly blockers?: boolean; readonly nonpatch?: boolean; readonly collision?: boolean; readonly noMerge?: boolean; readonly redundant?: boolean; readonly deletedOwn?: boolean };
// prettier-ignore
type Fixture = { readonly root: string; readonly tree: string; readonly t1: string; readonly t2: string; readonly mergeBase: string; readonly featureParent: string; readonly targetParent: string; readonly config: CodkitConfig; readonly resolution: ForkDirResolution };
function makeFixture(label: string, options: FixtureOptions = {}): Fixture {
	const tree = makeTempRoot(`${label}-tree`);
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	write(tree, '.gitignore', 'product.overrides.json\nsrc/vs/patchset/\n');
	for (const target of [...Object.values(TARGETS), TARGET_ONLY]) write(tree, target, baseText());
	write(tree, OVERLAY_TARGET, '{"name":"upstream","stable":true}\n');
	write(tree, RESOURCE_TARGET, 'upstream resource\n');
	write(tree, TARGETS.deleted, `${baseText()}// deleted identity\n`);
	write(tree, TARGETS.rename, `${baseText()}// rename identity\n`);
	const t1 = fixtureCommit(tree, 'fixture: old upstream pin', '2026-08-10T00:00:00Z');
	write(tree, TARGETS.shifted, `${baseText()}upstream-tail\n`);
	write(tree, TARGETS.merged, `prefix\n${baseText()}`);
	write(tree, TARGETS.conflict, baseText('// upstream-anchor'));
	if (options.redundant === true) write(tree, TARGETS.clean, resolvedText(IDS.clean));
	fixtureGit(tree, ['mv', TARGETS.rename, RENAMED]);
	if (options.blockers !== false) rmSync(join(tree, TARGETS.deleted));
	const t2 = fixtureCommit(tree, 'fixture: new upstream pin', '2026-08-11T00:00:00Z');
	write(tree, 'product.overrides.json', '{"stale":true}\n');
	if (options.deletedOwn !== true) write(tree, OWN_TARGET, 'export const targetOwn = true;\n');
	const root = makeTempRoot(`${label}-patchset`);
	fixtureGit(root, ['init', '--quiet', '--initial-branch=feature', '.']);
	const conventionsPath = join(root, 'codkit/config/conventions.json');
	mkdirSync(dirname(conventionsPath), { recursive: true });
	copyFileSync(fileURLToPath(new URL('../../config/conventions.json', import.meta.url)), conventionsPath);
	write(root, 'codkit.json', serializeBaseConfig(configOf(tree, t1, 't1', t1)));
	writeSourceOwn(root, t1);
	const mergeBase = fixtureCommit(root, 'fixture: shared patchset base', '2026-08-12T00:00:00Z');
	for (const key of Object.keys(IDS) as readonly (keyof typeof IDS)[]) {
		if (options.blockers === false && (key === 'conflict' || key === 'deleted')) continue;
		writePatch(root, TARGETS[key], IDS[key], t1, key === 'clean' ? t1 : 'none');
	}
	if (options.nonpatch === true) writeRule(root, t1);
	const featureParent = fixtureCommit(root, 'fixture: feature patches', '2026-08-13T00:00:00Z');
	if (options.noMerge === true) {
		const source = loadConfig(root);
		if (source === null) throw new Error('fixture source config missing');
		return { root, tree, t1, t2, mergeBase, featureParent, targetParent: '', config: source, resolution: resolution(tree) };
	}
	fixtureGit(root, ['checkout', '--quiet', '-b', 'target', mergeBase]);
	write(root, 'codkit.json', serializeBaseConfig(configOf(tree, t2, 't2', t1)));
	writePatch(root, TARGET_ONLY, 'CK-platform-719', t2, 'none', 't2');
	writeTargetLayers(root, t2);
	if (options.collision === true) writePatch(root, TARGETS.clean, IDS.clean, t2, 'none', 't2');
	const targetParent = fixtureCommit(root, 'fixture: target pin branch', '2026-08-14T00:00:00Z');
	fixtureGit(root, ['checkout', '--quiet', 'feature']);
	const merge = runGit({
		args: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'merge', '--no-ff', '--no-commit', 'target'],
		cwd: root
	});
	if (merge.status !== 0 && options.collision !== true) throw new Error(`fixture merge failed: ${merge.stderr}`);
	write(root, 'codkit.json', serializeBaseConfig(configOf(tree, t2, 't2', t1)));
	if (options.collision === true) writePatch(root, TARGETS.clean, IDS.clean, t1, t1);
	fixtureCommit(root, 'fixture: merge target into feature', '2026-08-15T00:00:00Z');
	const config = loadConfig(root);
	if (config === null) throw new Error('fixture target config missing');
	return { root, tree, t1, t2, mergeBase, featureParent, targetParent, config, resolution: resolution(tree) };
}
function baseText(anchor = '// anchor'): string {
	return `export const before = true;\n${anchor}\nexport const after = true;\n`;
}
function resolvedText(id: string, anchor = '// anchor'): string {
	return `export const before = true;\n${anchor}\n// codkit:begin ${id}\nexport const feature = true;\n// codkit:end ${id}\nexport const after = true;\n`;
}
function writePatch(root: string, target: string, id: string, pin: string, cause: string, tag = 't1'): void {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'rebase fixture patch',
		link: 'none',
		cause,
		pin: `${tag}@${pin}`,
		contractTests: []
	});
	const body = [
		`--- a/${target}`,
		`+++ b/${target}`,
		'@@ -1,3 +1,6 @@',
		' export const before = true;',
		' // anchor',
		`+// codkit:begin ${id}`,
		'+export const feature = true;',
		`+// codkit:end ${id}`,
		' export const after = true;'
	].join('\n');
	write(root, patchPath(target), `${header}${body}\n`);
}
function writeRule(root: string, pin: string): void {
	writeJson(root, 'delta/rules/feature.ckrule.json', {
		codkitRule: 2,
		id: 'CK-build-718',
		type: 'hook',
		category: 'follow',
		owner: 'build',
		reason: 'stale feature rule',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: [],
		target: TARGET_ONLY,
		engine: 'line-ops',
		expectedMatches: 1,
		ops: [{ match: '// anchor', action: 'append-after', text: '// codkit:begin CK-build-718' }]
	});
}
function writeTargetLayers(root: string, pin: string): void {
	write(root, 'delta/own/targetOwn.ts', 'export const targetOwn = true;\n');
	writeJson(root, 'delta/own/patchset.delta.json', {
		codkitOwnManifest: 2,
		units: [
			{
				id: 'CK-platform-720',
				layer: 'own',
				type: 'module',
				category: 'own',
				owner: 'platform',
				reason: 'target-only own code',
				link: 'none',
				cause: 'none',
				pin: `t2@${pin}`,
				contractTests: [],
				roots: ['targetOwn.ts']
			}
		],
		serviceOverrides: []
	});
	writeJson(root, 'delta/overlays/product.overlay.json', {
		codkitOverlay: 2,
		id: 'CK-product-720',
		target: OVERLAY_TARGET,
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'target-only overlay',
		link: 'none',
		cause: 'none',
		pin: `t2@${pin}`,
		contractTests: ['target.overlay'],
		operations: [{ op: 'set', path: ['name'], value: 'patchset', expectUpstream: 'upstream' }]
	});
	write(root, 'delta/resources/files/logo.bin', 'patchset resource\n');
	writeJson(root, 'delta/resources/map.json', {
		codkitResourceMap: 2,
		entries: [
			{
				id: 'CK-product-721',
				target: RESOURCE_TARGET,
				source: 'delta/resources/files/logo.bin',
				type: 'modify',
				category: 'own',
				owner: 'product',
				reason: 'target-only resource',
				link: 'none',
				cause: 'none',
				pin: `t2@${pin}`,
				contractTests: ['target.resource']
			}
		]
	});
}
function writeSourceOwn(root: string, pin: string): void {
	write(root, 'delta/own/targetOwn.ts', 'export const targetOwn = true;\n');
	writeJson(root, 'delta/own/patchset.delta.json', {
		codkitOwnManifest: 2,
		units: [
			{
				id: 'CK-platform-720',
				layer: 'own',
				type: 'module',
				category: 'own',
				owner: 'platform',
				reason: 'source own code',
				link: 'none',
				cause: 'none',
				pin: `t1@${pin}`,
				contractTests: [],
				roots: ['targetOwn.ts']
			}
		],
		serviceOverrides: []
	});
}
function configOf(tree: string, sha: string, tag: string, anchor: string): CodkitConfig {
	// prettier-ignore
	return { codkitConfig: 2, pin: { tag, sha, date: fixtureGit(tree, ['show', '-s', '--format=%cs', sha]).stdout.trim() }, upstreamAnchorCommit: anchor, type: 'vscode', typeConfig: { ownRoot: 'src/vs/patchset' }, generatedBranchPrefix: 'codkit/applied/', cycleBranchPrefix: 'codkit/cycle/', releaseRefPrefix: 'codkit/release/', publishRemoteUrl: null, buildWatchFile: null, conventionsExtensionFile: null };
}
function resolution(tree: string): ForkDirResolution {
	return { path: tree, source: 'settings', exists: true, warning: null };
}
function patchPath(target: string): string {
	return `delta/patches/${encodePatchName(target)}`;
}
function write(root: string, path: string, contents: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}
function writeJson(root: string, path: string, value: unknown): void {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}
function output(): Output {
	return new Output({ command: 'rebase-onto-pin', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
}
function commandContext(fixture: Fixture): CommandContext {
	return {
		type: vscodeType,
		toolRoot: fixture.root,
		locations: {
			patchesDir: { path: fixture.root, source: 'flag', exists: true, warning: null },
			forkDir: fixture.resolution
		},
		patchesDir: fixture.root,
		args: [],
		flags: { forkDir: null, patchesDir: null, json: true, ci: false, verbose: false },
		commandFlags: new Map(),
		env: {},
		config: fixture.config,
		out: output()
	};
}
function run(fixture: Fixture) {
	return rebaseOntoPin({ patchesDir: fixture.root, resolution: fixture.resolution, config: fixture.config, out: output() });
}
function commitAndSync(fixture: Fixture, date: string) {
	fixtureCommit(fixture.root, 'fixture: commit rebased patches', date);
	return runSync({
		patchesDir: fixture.root,
		resolution: fixture.resolution,
		config: fixture.config,
		out: output(),
		fresh: false,
		dryRun: false,
		verbose: false
	});
}
function parsedPatch(fixture: Fixture, target: string) {
	const artifact = patchPath(target);
	return parseCkpatch(readFileSync(join(fixture.root, artifact)), conventions(), artifact);
}
function worktreeSnapshot(root: string): readonly (readonly [string, string])[] {
	const files: Array<readonly [string, string]> = [];
	const visit = (relative: string): void => {
		const absolute = relative === '' ? root : join(root, relative);
		for (const entry of readdirSync(absolute, { withFileTypes: true })) {
			if (relative === '' && entry.name === '.git') continue;
			const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push([path, readFileSync(join(root, path)).toString('base64')]);
		}
	};
	visit('');
	return files.sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)));
}
afterAll(() => cleanupTempRoots());
describe('rebaseOntoPin', () => {
	it('refuses a second live tree-lock holder before any rebase write', async () => {
		const fixture = makeFixture('rebase-command-lock');
		const rootBefore = worktreeSnapshot(fixture.root);
		const treeBefore = worktreeSnapshot(fixture.tree);
		const held = acquireLock(fixture.root, treeId(fixture.tree), 'competing command');
		try {
			await expect(rebaseOntoPinCommand.run(commandContext(fixture))).rejects.toThrow(/another codkit command|lock/);
		} finally {
			held.release();
		}
		expect(worktreeSnapshot(fixture.root).filter(([path]) => !path.startsWith('.codkit/'))).toEqual(rootBefore);
		expect(worktreeSnapshot(fixture.tree)).toEqual(treeBefore);
	});
	it('builds the target baseline, auto-saves clean/shifted/merged/rename, and lists every blocker', () => {
		const fixture = makeFixture('rebase-full');
		const result = run(fixture);
		const byId = new Map(result.patches.map((entry) => [entry.artifactId, entry]));
		expect(result.exitCode).toBe(1);
		expect(byId.get(IDS.clean)).toMatchObject({ outcome: 'clean', cause: { sha: fixture.t1, approx: false } });
		expect(byId.get(IDS.shifted)).toMatchObject({ outcome: 'shifted', cause: { sha: fixture.t2, approx: false } });
		expect(byId.get(IDS.merged)).toMatchObject({ outcome: 'merged', cause: { sha: fixture.t2, approx: false } });
		expect(byId.get(IDS.rename)).toMatchObject({
			outcome: 'target-renamed',
			targetPath: RENAMED,
			cause: { sha: fixture.t2, approx: false }
		});
		expect(result.blockers.map((entry) => entry.outcome).sort()).toEqual(['conflict', 'target-deleted']);
		expect(parsedPatch(fixture, TARGETS.clean).header).toMatchObject({ pin: `t2@${fixture.t2}`, cause: fixture.t1 });
		expect(parsedPatch(fixture, TARGETS.shifted).header).toMatchObject({ pin: `t2@${fixture.t2}`, cause: fixture.t2 });
		expect(parsedPatch(fixture, RENAMED).header.pin).toBe(`t2@${fixture.t2}`);
		expect(parsedPatch(fixture, TARGET_ONLY).header.pin).toBe(`t2@${fixture.t2}`);
		expect(readFileSync(join(fixture.tree, TARGET_ONLY), 'utf8')).toBe(resolvedText('CK-platform-719'));
		expect(readFileSync(join(fixture.tree, OWN_TARGET), 'utf8')).toBe('export const targetOwn = true;\n');
		expect(JSON.parse(readFileSync(join(fixture.tree, OVERLAY_TARGET), 'utf8'))).toMatchObject({ name: 'patchset', stable: true });
		expect(readFileSync(join(fixture.tree, RESOURCE_TARGET), 'utf8')).toBe('patchset resource\n');
		expect(existsSync(join(fixture.tree, 'product.overrides.json'))).toBe(false);
		expect(readFileSync(join(fixture.tree, TARGETS.conflict), 'utf8')).toContain('<<<<<<< ours');
		expect(parsedPatch(fixture, TARGETS.conflict).header.pin).toBe(`t1@${fixture.t1}`);
		expect(readRebasePending(fixture.root, TARGETS.conflict)).toMatchObject({
			artifactId: IDS.conflict,
			cause: fixture.t2,
			pin: { tag: 't2', sha: fixture.t2 }
		});
	});
	it.each([
		null,
		'artifact-written',
		'receipt-updated',
		'before-pending-remove',
		'remove-artifact-written',
		'remove-receipt-updated',
		'remove-before-pending-remove'
	] as const)('ordinary later save consumes conflict metadata across %s interruption', (stage) => {
		const fixture = makeFixture(`rebase-pending-save-${stage ?? 'none'}`);
		run(fixture);
		const removing = stage?.startsWith('remove-') === true;
		const checkpointStage = removing ? stage?.slice('remove-'.length) : stage;
		write(fixture.tree, TARGETS.conflict, removing ? baseText('// upstream-anchor') : resolvedText(IDS.conflict, '// upstream-anchor'));
		let injected = false;
		const save = () =>
			runSave({
				patchesDir: fixture.root,
				resolution: fixture.resolution,
				config: fixture.config,
				out: output(),
				paths: [TARGETS.conflict],
				allowNewFile: [],
				commit: false,
				message: null,
				verbose: false,
				...(stage === null
					? {}
					: {
							rebasePendingCheckpoint(at) {
								if (!injected && at === checkpointStage) {
									injected = true;
									throw new Error(`injected ${stage}`);
								}
							}
						})
			});
		if (stage !== null) expect(save).toThrow(`injected ${stage}`);
		const saved = save();
		expect(saved.exitCode).toBe(0);
		expect(readRebasePending(fixture.root, TARGETS.conflict)).toBeNull();
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		if (removing) expect(existsSync(join(fixture.root, patchPath(TARGETS.conflict)))).toBe(false);
		else expect(parsedPatch(fixture, TARGETS.conflict).header).toMatchObject({ pin: `t2@${fixture.t2}`, cause: fixture.t2 });
		if (stage === null) {
			rmSync(join(fixture.root, patchPath(TARGETS.deleted)));
			expect(commitAndSync(fixture, '2026-08-16T00:00:00Z').exitCode).toBe(0);
			expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(false);
		}
	});
	it('ordinary conflict save fails closed on a valid-looking original-header tamper', () => {
		const fixture = makeFixture('rebase-pending-tamper');
		run(fixture);
		const artifact = join(fixture.root, patchPath(TARGETS.conflict));
		writeFileSync(artifact, readFileSync(artifact, 'utf8').replace('# reason: rebase fixture patch', '# reason: tampered header'));
		write(fixture.tree, TARGETS.conflict, resolvedText(IDS.conflict, '// upstream-anchor'));
		const saved = runSave({
			patchesDir: fixture.root,
			resolution: fixture.resolution,
			config: fixture.config,
			out: output(),
			paths: [TARGETS.conflict],
			allowNewFile: [],
			commit: false,
			message: null,
			verbose: false
		});
		expect(saved).toMatchObject({ exitCode: 1, status: 'blocked' });
		expect(readRebasePending(fixture.root, TARGETS.conflict)).not.toBeNull();
		expect(readFileSync(artifact, 'utf8')).toContain('# reason: tampered header');
	});
	it('returns zero when every feature patch auto-saves', () => {
		const fixture = makeFixture('rebase-clean-only', { blockers: false });
		const result = run(fixture);
		expect(result.exitCode).toBe(0);
		expect(result.blockers).toEqual([]);
		expect(result.save).toMatchObject({ exitCode: 0 });
		expect(result.patches.map((entry) => entry.outcome)).toEqual(['clean', 'merged', 'target-renamed', 'shifted']);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		expect(commitAndSync(fixture, '2026-08-17T00:00:00Z').exitCode).toBe(0);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(false);
		expect(runGit({ args: ['status', '--porcelain=v1'], cwd: fixture.tree }).stdout).toBe('');
	});
	it('sanctioned load rejects changed committed delta or unrelated fork dirt and retains authority', () => {
		const changed = makeFixture('rebase-sync-changed-delta', { blockers: false });
		run(changed);
		write(changed.root, 'delta/own/unexpected.ts', 'export const unexpected = true;\n');
		fixtureCommit(changed.root, 'fixture: changed committed delta', '2026-08-18T00:00:00Z');
		const treeBefore = worktreeSnapshot(changed.tree);
		expect(() =>
			runSync({
				patchesDir: changed.root,
				resolution: changed.resolution,
				config: changed.config,
				out: output(),
				fresh: false,
				dryRun: false,
				verbose: false
			})
		).toThrow(/completed receipt|load tree/);
		expect(worktreeSnapshot(changed.tree)).toEqual(treeBefore);
		expect(existsSync(join(changed.root, REBASE_MOVE_PATH))).toBe(true);
		const dirty = makeFixture('rebase-sync-dirty-fork', { blockers: false });
		run(dirty);
		fixtureCommit(dirty.root, 'fixture: committed exact delta', '2026-08-19T00:00:00Z');
		write(dirty.tree, 'unrelated-after-rebase.txt', 'unrelated\n');
		expect(() =>
			runSync({
				patchesDir: dirty.root,
				resolution: dirty.resolution,
				config: dirty.config,
				out: output(),
				fresh: false,
				dryRun: false,
				verbose: false
			})
		).toThrow(/unrelated fork dirt/);
		expect(existsSync(join(dirty.root, REBASE_MOVE_PATH))).toBe(true);
		expect(readFileSync(join(dirty.tree, 'unrelated-after-rebase.txt'), 'utf8')).toBe('unrelated\n');
	});
	it('rejects wrong graph, dirty patchset, non-patch feature metadata, and target collisions', async () => {
		const wrong = makeFixture('rebase-wrong-graph', { noMerge: true });
		expect(() => run(wrong)).toThrow(/exactly two parents/);
		const dirty = makeFixture('rebase-dirty');
		write(dirty.root, 'dirty.txt', 'dirty\n');
		expect(await rebaseOntoPinCommand.run(commandContext(dirty))).toBe(1);
		const nonpatch = makeFixture('rebase-nonpatch', { nonpatch: true });
		expect(await rebaseOntoPinCommand.run(commandContext(nonpatch))).toBe(1);
		const collision = makeFixture('rebase-collision', { collision: true });
		expect(await rebaseOntoPinCommand.run(commandContext(collision))).toBe(1);
		const deletedOwn = makeFixture('rebase-deleted-own', { deletedOwn: true });
		expect(await rebaseOntoPinCommand.run(commandContext(deletedOwn))).toBe(1);
	});
	it('never moves either repository ref or index', () => {
		const fixture = makeFixture('rebase-zero-ref-index');
		const before = {
			rootRefs: runGit({ args: ['show-ref'], cwd: fixture.root }).stdout,
			rootIndex: readFileSync(join(fixture.root, '.git/index')),
			treeRefs: runGit({ args: ['show-ref'], cwd: fixture.tree }).stdout,
			treeIndex: readFileSync(join(fixture.tree, '.git/index')),
			rootHead: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.root }).stdout,
			treeHead: runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.tree }).stdout
		};
		run(fixture);
		expect(runGit({ args: ['show-ref'], cwd: fixture.root }).stdout).toBe(before.rootRefs);
		expect(readFileSync(join(fixture.root, '.git/index'))).toEqual(before.rootIndex);
		expect(runGit({ args: ['show-ref'], cwd: fixture.tree }).stdout).toBe(before.treeRefs);
		expect(readFileSync(join(fixture.tree, '.git/index'))).toEqual(before.treeIndex);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.root }).stdout).toBe(before.rootHead);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.tree }).stdout).toBe(before.treeHead);
	});
	it('refuses unrelated dirty fork bytes before changing a managed path', () => {
		const fixture = makeFixture('rebase-dirty-fork');
		write(fixture.tree, 'unrelated-local.txt', 'do not overwrite\n');
		const rootBefore = worktreeSnapshot(fixture.root);
		const treeBefore = worktreeSnapshot(fixture.tree);
		expect(() => run(fixture)).toThrow(/fork has unrelated or unextracted dirty paths/);
		expect(worktreeSnapshot(fixture.root)).toEqual(rootBefore);
		expect(worktreeSnapshot(fixture.tree)).toEqual(treeBefore);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(false);
	});
	it('resumes an injected mid-move interruption from the exact durable plan', () => {
		const fixture = makeFixture('rebase-move-resume', { blockers: false });
		expect(() =>
			rebaseOntoPin({
				patchesDir: fixture.root,
				resolution: fixture.resolution,
				config: fixture.config,
				out: output(),
				moveTempCheckpoint(path) {
					if (path === TARGET_ONLY) throw new Error('injected rebase move interruption');
				}
			})
		).toThrow('injected rebase move interruption');
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		const resumed = run(fixture);
		expect(resumed.exitCode).toBe(0);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		expect(readFileSync(join(fixture.tree, TARGET_ONLY), 'utf8')).toBe(resolvedText('CK-platform-719'));
		expect(readFileSync(join(fixture.tree, OWN_TARGET), 'utf8')).toBe('export const targetOwn = true;\n');
	});
	it.each(['after-move', 'before-save', 'after-save', 'artifact-temp'] as const)(
		'fresh retry completes after an injected %s interruption',
		(stage) => {
			const fixture = makeFixture(`rebase-resume-${stage}`, { blockers: false });
			expect(() =>
				rebaseOntoPin({
					patchesDir: fixture.root,
					resolution: fixture.resolution,
					config: fixture.config,
					out: output(),
					...(stage === 'artifact-temp'
						? {
								artifactRenameTempCheckpoint() {
									throw new Error(`injected ${stage}`);
								}
							}
						: {
								checkpoint(at) {
									if (at === stage) throw new Error(`injected ${stage}`);
								}
							})
				})
			).toThrow(`injected ${stage}`);
			expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
			const resumed = run(fixture);
			expect(resumed.exitCode).toBe(0);
			expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
			expect(readFileSync(join(fixture.tree, TARGET_ONLY), 'utf8')).toBe(resolvedText('CK-platform-719'));
		}
	);
	it('fresh retry completes pending creation interrupted between conflict records and save', () => {
		const fixture = makeFixture('rebase-resume-pending');
		expect(() =>
			rebaseOntoPin({
				patchesDir: fixture.root,
				resolution: fixture.resolution,
				config: fixture.config,
				out: output(),
				checkpoint(stage) {
					if (stage === 'during-pending') throw new Error('injected pending interruption');
				}
			})
		).toThrow('injected pending interruption');
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		expect(readRebasePending(fixture.root, TARGETS.conflict)).not.toBeNull();
		const resumed = run(fixture);
		expect(resumed.exitCode).toBe(1);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		expect(readRebasePending(fixture.root, TARGETS.conflict)).not.toBeNull();
	});
	it('fails closed when a saved artifact is staged or tampered before retained-transaction retry', async () => {
		const fixture = makeFixture('rebase-resume-tampered', { blockers: false });
		expect(() =>
			rebaseOntoPin({
				patchesDir: fixture.root,
				resolution: fixture.resolution,
				config: fixture.config,
				out: output(),
				checkpoint(stage) {
					if (stage === 'after-save') throw new Error('injected after-save tamper window');
				}
			})
		).toThrow('injected after-save tamper window');
		fixtureGit(fixture.root, ['add', '--', patchPath(TARGETS.shifted)]);
		expect(await rebaseOntoPinCommand.run(commandContext(fixture))).toBe(1);
		fixtureGit(fixture.root, ['reset', '--quiet', '--', patchPath(TARGETS.shifted)]);
		write(fixture.root, patchPath(TARGETS.shifted), '{}\n');
		expect(() => run(fixture)).toThrow(/pending rebase|patch|header|valid/i);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
	});
	it('retry accepts a patch legitimately removed because upstream adopted its exact body', () => {
		const fixture = makeFixture('rebase-resume-redundant', { blockers: false, redundant: true });
		expect(() =>
			rebaseOntoPin({
				patchesDir: fixture.root,
				resolution: fixture.resolution,
				config: fixture.config,
				out: output(),
				checkpoint(stage) {
					if (stage === 'after-save') throw new Error('injected after redundant removal');
				}
			})
		).toThrow('injected after redundant removal');
		expect(existsSync(join(fixture.root, patchPath(TARGETS.clean)))).toBe(false);
		const resumed = run(fixture);
		expect(resumed.exitCode).toBe(0);
		expect(existsSync(join(fixture.root, REBASE_MOVE_PATH))).toBe(true);
		expect(existsSync(join(fixture.root, patchPath(TARGETS.clean)))).toBe(false);
	});
});
