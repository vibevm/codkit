/** @scope spec://codkit/modules/codkit/PROP-007#CMD-REBASE-ONTO-PIN */
// Read-only validation and extraction of the two-parent patchset merge contract.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesEqual } from './bytes.ts';
import { loadConfig } from './configFile.ts';
import type { CodkitConfig } from './configFile.ts';
import { gitOk, runGit, runGitBytes } from './gitx.ts';
import { ckError } from './messages.ts';
import { encodePatchName, parseCkpatch, PATCH_FILE_SUFFIX } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import { loadConventions } from './conventionsFile.ts';
import { PATCHES_DIR } from './syncEngine.ts';
import { porcelainZEntries } from './driftGuard.ts';
import { rebaseMovePending, retireHistoricalCompletedRebaseMove } from './rebaseOntoPinMove.ts';
import { hasRebasePendingRecords } from './rebaseOntoPinPending.ts';
import { detectRenames } from './renames.ts';
import type { ProjectType } from '@codkit/type-api';

const CONFIG = 'codkit.json';
const PIN_BEARING_NONPATCH = [
	/^delta\/rules\/.*\.ckrule\.json$/,
	/^delta\/overlays\/.*\.overlay\.json$/,
	/^delta\/resources\/map\.json$/,
	/^delta\/own\/patchset\.delta\.json$/,
	/^delta\/removed\.json$/
];

export type RebaseFeaturePatch = {
	readonly sourceArtifactPath: string;
	readonly artifactPath: string;
	readonly patch: ParsedPatch;
	readonly bytes: Uint8Array;
	readonly mergedBytes: Uint8Array;
};

export type RebaseGraph = {
	readonly head: string;
	readonly featureParent: string;
	readonly targetParent: string;
	readonly mergeBase: string;
	readonly sourceConfig: CodkitConfig;
	readonly targetConfig: CodkitConfig;
	readonly featurePatches: readonly RebaseFeaturePatch[];
	readonly sourcePatchesDir: string;
	readonly targetPatchesDir: string;
	readonly release: () => void;
};

export function prepareRebaseGraph(patchesDir: string, type: ProjectType, treeDir: string, mergedConfig: CodkitConfig): RebaseGraph {
	const dirtyPaths = assertCleanMerge(patchesDir);
	const { head, featureParent, targetParent } = twoParents(patchesDir);
	if (dirtyPaths.length === 0 && !hasRebasePendingRecords(patchesDir)) retireHistoricalCompletedRebaseMove(patchesDir, treeDir, head);
	const mergedBytes = objectBytes(patchesDir, head, CONFIG, false);
	const targetBytes = objectBytes(patchesDir, targetParent, CONFIG, false);
	if (!bytesEqual(mergedBytes, targetBytes)) throw contract('merged codkit.json is not byte-identical to HEAD^2');

	const featureCheckout = checkoutCommit(patchesDir, featureParent);
	const targetCheckout = checkoutCommit(patchesDir, targetParent);
	try {
		const sourceConfig = requiredConfig(featureCheckout.dir, 'HEAD^1');
		const targetConfig = requiredConfig(targetCheckout.dir, 'HEAD^2');
		if (!samePin(mergedConfig, targetConfig)) throw contract('loaded merged config pin does not match HEAD^2');
		assertPinPair(treeDir, sourceConfig, targetConfig);
		const mergeBase = uniqueMergeBase(patchesDir, featureParent, targetParent);
		assertNoFeatureNonpatch(patchesDir, mergeBase, featureParent);
		const featurePaths = featurePatchPaths(patchesDir, mergeBase, featureParent);
		const source = loadPatchesFromCommit(patchesDir, type, featureParent, featurePaths, featureCheckout.dir);
		const merged = loadAllPatches(patchesDir, type, head, patchesDir);
		const target = loadAllPatches(patchesDir, type, targetParent, targetCheckout.dir);
		const featurePatches = bindMergedFeaturePatches(source, merged, target);
		const upstreamRenames = detectRenames({
			cwd: treeDir,
			oldPin: sourceConfig.pin.sha,
			newPin: targetConfig.pin.sha,
			fromTargets: featurePatches.map((entry) => entry.patch.targetPath)
		});
		assertAuthorizedRebaseDirt(dirtyPaths, featurePatches, new Map(upstreamRenames.map((entry) => [entry.from, entry.to])));
		return {
			head,
			featureParent,
			targetParent,
			mergeBase,
			sourceConfig,
			targetConfig,
			featurePatches,
			sourcePatchesDir: featureCheckout.dir,
			targetPatchesDir: targetCheckout.dir,
			release() {
				featureCheckout.release();
				targetCheckout.release();
			}
		};
	} catch (error) {
		featureCheckout.release();
		targetCheckout.release();
		throw error;
	}
}

function assertCleanMerge(patchesDir: string): readonly string[] {
	const status = runGit({
		args: ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', ':(exclude).codkit'],
		cwd: patchesDir
	});
	if (status.status !== 0) throw contract('patchset root is not a readable Git work tree');
	const dirty = porcelainZEntries(status.stdout);
	if (dirty.some((entry) => entry.status !== '??' && entry.status[0] !== ' ')) {
		throw dirtyTree('pending rebase cannot carry staged patchset changes');
	}
	const dirtyPaths = dirty.map((entry) => entry.path).sort(compareText);
	if (dirtyPaths.length > 0 && !rebaseMovePending(patchesDir)) throw dirtyTree('patchset work tree and index must be clean');
	if (runGit({ args: ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], cwd: patchesDir }).status === 0) {
		throw contract('merge is still in progress');
	}
	return dirtyPaths;
}

function assertAuthorizedRebaseDirt(
	dirtyPaths: readonly string[],
	featurePatches: readonly RebaseFeaturePatch[],
	renames: ReadonlyMap<string, string>
): void {
	const allowed = new Set(
		featurePatches.flatMap((entry) => [
			entry.artifactPath,
			`${PATCHES_DIR}/${encodePatchName(renames.get(entry.patch.targetPath) ?? entry.patch.targetPath)}`,
			`${PATCHES_DIR}/${encodePatchName(renames.get(entry.patch.targetPath) ?? entry.patch.targetPath)}.codkit-rebase-rename.tmp`
		])
	);
	const unauthorized = dirtyPaths.filter((path) => !allowed.has(path));
	if (unauthorized.length > 0) throw dirtyTree(`pending rebase has unrelated patchset changes: ${unauthorized.join(', ')}`);
}

function twoParents(patchesDir: string): { readonly head: string; readonly featureParent: string; readonly targetParent: string } {
	const row = must(patchesDir, ['rev-list', '--parents', '-n', '1', 'HEAD'], 'read HEAD parents').split(' ');
	if (row.length !== 3) throw contract(`HEAD must have exactly two parents, got ${Math.max(0, row.length - 1)}`);
	const [head, featureParent, targetParent] = row;
	if (head === undefined || featureParent === undefined || targetParent === undefined) throw contract('HEAD parent row is malformed');
	return { head, featureParent, targetParent };
}

function assertPinPair(treeDir: string, source: CodkitConfig, target: CodkitConfig): void {
	if (source.pin.sha === target.pin.sha) throw contract('HEAD^1 and HEAD^2 configs name the same pin');
	for (const [label, sha] of [
		['HEAD^1 pin', source.pin.sha],
		['HEAD^2 pin', target.pin.sha]
	] as const) {
		const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], cwd: treeDir });
		if (resolved.status !== 0 || resolved.stdout.trim() !== sha) throw contract(`${label} ${sha} is not reachable in the fork tree`);
	}
	for (const [label, pin] of [
		['HEAD^1 pin', source.pin],
		['HEAD^2 pin', target.pin]
	] as const) {
		const date = runGit({ args: ['show', '-s', '--format=%cs', pin.sha], cwd: treeDir });
		if (date.status !== 0 || date.stdout.trim() !== pin.date) throw contract(`${label} date does not match ${pin.sha}`);
	}
	if (runGit({ args: ['merge-base', '--is-ancestor', source.pin.sha, target.pin.sha], cwd: treeDir }).status !== 0) {
		throw contract('HEAD^1 pin is not an ancestor of HEAD^2 pin; merge parents may be reversed');
	}
}

function uniqueMergeBase(patchesDir: string, feature: string, target: string): string {
	const bases = must(patchesDir, ['merge-base', '--all', feature, target], 'derive the merge base').split('\n').filter(Boolean);
	if (bases.length !== 1) throw contract(`HEAD parents have ${bases.length} merge bases instead of one`);
	return bases[0] ?? '';
}

function assertNoFeatureNonpatch(patchesDir: string, mergeBase: string, feature: string): void {
	const changed = nameOnly(patchesDir, mergeBase, feature);
	const stale = changed.filter((path) => PIN_BEARING_NONPATCH.some((pattern) => pattern.test(path)));
	if (stale.length > 0) throw broken(`feature changes non-patch pin-bearing records: ${stale.join(', ')}`);
}

function featurePatchPaths(patchesDir: string, mergeBase: string, feature: string): readonly string[] {
	return nameStatusPaths(patchesDir, mergeBase, feature)
		.filter((path) => path.startsWith(`${PATCHES_DIR}/`) && path.endsWith(PATCH_FILE_SUFFIX))
		.filter((path) => objectExists(patchesDir, feature, path))
		.sort(compareText);
}

function nameStatusPaths(patchesDir: string, from: string, to: string): readonly string[] {
	const result = runGit({ args: ['diff', '--name-status', '-z', from, to, '--', PATCHES_DIR], cwd: patchesDir });
	if (result.status !== 0 || (result.stdout !== '' && !result.stdout.endsWith('\0')))
		throw contract(`cannot inspect patch changes ${from}..${to}`);
	const fields = result.stdout.split('\0');
	fields.pop();
	const paths: string[] = [];
	for (let index = 0; index < fields.length;) {
		const status = fields[index] ?? '';
		index += 1;
		const count = /^[RC][0-9]{3}$/.test(status) ? 2 : /^[ADMRTUXB]$/.test(status) ? 1 : 0;
		if (count === 0 || index + count > fields.length) throw contract(`malformed patch name-status record ${JSON.stringify(status)}`);
		for (let offset = 0; offset < count; offset += 1) paths.push(fields[index + offset] ?? '');
		index += count;
	}
	return paths.sort(compareText);
}

function nameOnly(patchesDir: string, from: string, to: string): readonly string[] {
	const result = runGit({ args: ['diff', '--name-only', '-z', from, to, '--'], cwd: patchesDir });
	if (result.status !== 0 || (result.stdout !== '' && !result.stdout.endsWith('\0')))
		throw contract(`cannot inspect feature changes ${from}..${to}`);
	return result.stdout.split('\0').filter(Boolean).sort(compareText);
}

function loadPatchesFromCommit(
	patchesDir: string,
	type: ProjectType,
	commit: string,
	paths: readonly string[],
	conventionsRoot: string
): readonly RebaseFeaturePatch[] {
	const conventions = loadConventions(type, conventionsRoot);
	return paths.map((artifactPath) => {
		const bytes = objectBytes(patchesDir, commit, artifactPath, false);
		const patch = parseCkpatch(bytes, conventions, artifactPath);
		if (artifactPath !== `${PATCHES_DIR}/${encodePatchName(patch.targetPath)}`) throw broken(`${artifactPath}: name does not match target`);
		return { sourceArtifactPath: artifactPath, artifactPath, patch, bytes, mergedBytes: bytes };
	});
}

function loadAllPatches(patchesDir: string, type: ProjectType, commit: string, conventionsRoot: string): readonly RebaseFeaturePatch[] {
	const listed = runGit({ args: ['ls-tree', '-r', '--name-only', '-z', commit, '--', PATCHES_DIR], cwd: patchesDir });
	if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0'))) throw contract(`cannot list patches at ${commit}`);
	const paths = listed.stdout
		.split('\0')
		.filter((path) => path.endsWith(PATCH_FILE_SUFFIX))
		.sort(compareText);
	return loadPatchesFromCommit(patchesDir, type, commit, paths, conventionsRoot);
}

function bindMergedFeaturePatches(
	source: readonly RebaseFeaturePatch[],
	merged: readonly RebaseFeaturePatch[],
	target: readonly RebaseFeaturePatch[]
): readonly RebaseFeaturePatch[] {
	const targetIds = new Set(target.map((entry) => entry.patch.header.id));
	const targetPaths = new Set(target.map((entry) => entry.artifactPath));
	const mergedById = new Map<string, RebaseFeaturePatch[]>();
	for (const entry of merged) {
		const rows = mergedById.get(entry.patch.header.id) ?? [];
		rows.push(entry);
		mergedById.set(entry.patch.header.id, rows);
	}
	return source.flatMap((entry): readonly RebaseFeaturePatch[] => {
		if (targetIds.has(entry.patch.header.id) || targetPaths.has(entry.sourceArtifactPath)) {
			throw broken(`${entry.sourceArtifactPath}: collides with a HEAD^2 patch identity or path`);
		}
		const destinations = mergedById.get(entry.patch.header.id) ?? [];
		if (destinations.length === 0) return [];
		if (destinations.length !== 1) throw broken(`${entry.patch.header.id}: merged HEAD carries duplicate patch identities`);
		const destination = destinations[0];
		if (destination === undefined) return [];
		if (targetPaths.has(destination.artifactPath)) throw broken(`${destination.artifactPath}: collides with a HEAD^2 patch path`);
		if (JSON.stringify(destination.patch.header) !== JSON.stringify(entry.patch.header)) {
			throw broken(`${destination.artifactPath}: merged patch header differs from its strict HEAD^1 source`);
		}
		return [{ ...entry, artifactPath: destination.artifactPath, mergedBytes: destination.bytes }];
	});
}

type ScratchCheckout = { readonly dir: string; readonly release: () => void };

function checkoutCommit(patchesDir: string, commit: string): ScratchCheckout {
	const root = mkdtempSync(join(tmpdir(), 'codkit-rebase-patchset-'));
	const dir = join(root, 'files');
	const index = join(root, 'index');
	mkdirSync(dir);
	const release = (): void => rmSync(root, { recursive: true, force: true });
	try {
		gitOk(
			{ args: ['read-tree', commit], cwd: patchesDir, env: { GIT_INDEX_FILE: index } },
			{ code: 'CONFIG', message: `cannot read ${commit}` }
		);
		gitOk(
			{ args: ['checkout-index', '--all', `--prefix=${dir}/`], cwd: patchesDir, env: { GIT_INDEX_FILE: index } },
			{ code: 'CONFIG', message: `cannot export ${commit}` }
		);
		return { dir, release };
	} catch (error) {
		release();
		throw error;
	}
}

function requiredConfig(root: string, label: string): CodkitConfig {
	const config = loadConfig(root);
	if (config === null) throw contract(`${label} carries no ${CONFIG}`);
	return config;
}

function objectBytes(patchesDir: string, commit: string, path: string, allowAbsent: boolean): Uint8Array {
	const result = runGitBytes({ args: ['show', `${commit}:${path}`], cwd: patchesDir });
	if (result.status === 0) return result.stdout;
	if (allowAbsent) return new Uint8Array(0);
	throw contract(`${path} is absent or unreadable at ${commit}`);
}

function objectExists(patchesDir: string, commit: string, path: string): boolean {
	return runGit({ args: ['cat-file', '-e', `${commit}:${path}`], cwd: patchesDir }).status === 0;
}

function samePin(left: CodkitConfig, right: CodkitConfig): boolean {
	return left.pin.tag === right.pin.tag && left.pin.sha === right.pin.sha && left.pin.date === right.pin.date;
}

function must(cwd: string, args: readonly string[], action: string): string {
	const result = runGit({ args, cwd });
	if (result.status !== 0) throw contract(`cannot ${action}: ${result.stderr.trim() || `git exited ${result.status}`}`);
	return result.stdout.trim();
}

function compareText(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}

function contract(reason: string): Error {
	return ckError('CONFIG', `cannot rebase onto pin: ${reason}`, 'repeat git merge <target> on the clean feature branch, then retry');
}

function dirtyTree(reason: string): Error {
	return ckError('DIRTY-TREE', `cannot rebase onto pin: ${reason}`, 'extract or remove unrelated changes, then retry the exact merge');
}

function broken(reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `cannot rebase onto pin: ${reason}`, 'repair the feature artifact set before retrying');
}
