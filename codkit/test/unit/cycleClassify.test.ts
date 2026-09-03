/** @scope spec://codkit/modules/codkit/PROP-009#state */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { applyCycleClassification, classifyCycleApply } from '../../src/lib/cycleClassify.ts';
import { makeCycleClassifyRecovery, writeCycleClassifyRecovery } from '../../src/lib/cycleClassifyRecovery.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { formatPatchHeader, encodePatchName } from '../../src/lib/patchFormat.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const EMPTY_ARTIFACTS: CycleState['artifacts'] = {
	clean: [],
	shifted: [],
	merged: [],
	conflict: [],
	'target-deleted': [],
	'target-renamed': [],
	'rule-broken': [],
	'contract-failed': []
};

type Fixture = {
	readonly tree: string;
	readonly root: string;
	readonly oldPin: string;
	readonly newPin: string;
	readonly targetCommit: string;
	readonly state: CycleState;
	readonly config: CodkitConfig;
};

describe('cycle apply classification adapter', () => {
	afterAll(() => cleanupTempRoots());

	it('loads the complete patch/rule/overlay inventory and returns every real-git outcome in canonical order', () => {
		const tree = makeTempRoot('cycle-classify-full-tree');
		init(tree);
		for (const path of ['src/clean.ts', 'src/shifted.ts', 'src/merged.ts', 'src/conflict.ts']) write(tree, path, 'a\nbase\nz\n');
		write(tree, 'src/deleted.ts', 'a\nbase\nz\n');
		write(tree, 'src/rule-clean.ts', 'anchor\nstable\n');
		write(tree, 'src/rule-broken.ts', 'old-anchor\n');
		write(tree, 'config/product.json', '{"name":"old","stable":true}\n');
		const oldPin = fixtureCommit(tree, 'old pin', '2026-05-01T00:00:00Z');

		write(tree, 'src/shifted.ts', 'a\nbase\nz\nupstream-tail\n');
		write(tree, 'src/merged.ts', 'prefix\na\nbase\nz\n');
		write(tree, 'src/conflict.ts', 'a\nupstream\nz\n');
		rmSync(join(tree, 'src/deleted.ts'));
		write(tree, 'src/rule-broken.ts', 'new-anchor\n');
		write(tree, 'config/product.json', '{"name":"new","stable":true}\n');
		const newPin = fixtureCommit(tree, 'target changes', '2026-05-02T00:00:00Z');

		const current = cycleFixture(tree, oldPin, newPin);
		for (const [index, target] of ['src/clean.ts', 'src/shifted.ts', 'src/merged.ts', 'src/conflict.ts', 'src/deleted.ts'].entries()) {
			writePatch(current.root, target, `CK-workbench-30${index}`, oldPin, target === 'src/deleted.ts' ? 'base' : 'base', 'codkit');
		}
		writeRule(current.root, 'src/rule-clean.ts', 'CK-rule-clean', oldPin, 'anchor');
		writeRule(current.root, 'src/rule-broken.ts', 'CK-rule-broken', oldPin, 'old-anchor');
		writeOverlay(current.root, 'config/product.json', 'CK-overlay', oldPin, 'old');

		const result = classifyCycleApply(options(current));
		expect(result.renames).toEqual([]);
		expect(result.renameBatch.plans).toEqual([]);
		expect(result.reviewRequired).toBe(false);
		expect(result.classifications.map((item) => item.artifactPath)).toEqual(
			[...result.classifications.map((item) => item.artifactPath)].sort(byteCompare)
		);
		expect(result.classifications).toHaveLength(8);
		expect(outcomeFor(result, patchPath('src/clean.ts'))).toBe('clean');
		expect(outcomeFor(result, patchPath('src/shifted.ts'))).toBe('shifted');
		expect(outcomeFor(result, patchPath('src/merged.ts'))).toBe('merged');
		expect(outcomeFor(result, patchPath('src/conflict.ts'))).toBe('conflict');
		expect(outcomeFor(result, patchPath('src/deleted.ts'))).toBe('target-deleted');
		expect(outcomeFor(result, 'delta/rules/CK-rule-clean.ckrule.json')).toBe('clean');
		expect(outcomeFor(result, 'delta/rules/CK-rule-broken.ckrule.json')).toBe('rule-broken');
		expect(outcomeFor(result, 'delta/overlays/CK-overlay.overlay.json')).toBe('conflict');
		expect(result.causes.map((entry) => entry.artifactPath)).toEqual(
			result.classifications.filter((item) => item.outcome !== 'clean').map((item) => item.artifactPath)
		);
		expect(result.causes.find((entry) => entry.outcome === 'target-deleted')).toMatchObject({
			cause: { sha: newPin, approx: false }
		});
		expect(Object.values(result.buckets).flat()).toHaveLength(result.classifications.length);
	});

	it('plans an R100 rename without writes, then applies, reloads and classifies through the old/new path map', () => {
		const tree = makeTempRoot('cycle-classify-r100-tree');
		init(tree);
		const oldTarget = 'src/old/client.ts';
		const newTarget = 'src/new/client.ts';
		write(tree, oldTarget, 'a\nbase\nz\n');
		const oldPin = fixtureCommit(tree, 'old pin', '2026-05-03T00:00:00Z');
		mkdirSync(join(tree, 'src/new'), { recursive: true });
		fixtureGit(tree, ['mv', oldTarget, newTarget]);
		const newPin = fixtureCommit(tree, 'exact rename', '2026-05-04T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		writePatch(current.root, oldTarget, 'CK-workbench-401', oldPin, 'base', 'codkit');

		const preview = classifyCycleApply(options(current));
		expect(preview.renames).toEqual([{ from: oldTarget, to: newTarget, similarity: 100 }]);
		expect(preview.reviewRequired).toBe(false);
		expect(preview.classifications[0]).toMatchObject({ artifactPath: patchPath(oldTarget), targetPath: newTarget, outcome: 'clean' });
		expect(preview.buckets['target-renamed']).toEqual([patchPath(oldTarget)]);
		expect(existsSync(join(current.root, patchPath(oldTarget)))).toBe(true);
		expect(existsSync(join(current.root, patchPath(newTarget)))).toBe(false);

		const applied = withCycleLocks(current, (locks) => applyCycleClassification({ ...options(current), locks }));
		expect(applied.classifications[0]).toMatchObject({ artifactPath: patchPath(newTarget), targetPath: newTarget, outcome: 'clean' });
		expect(applied.buckets['target-renamed']).toEqual([patchPath(newTarget)]);
		expect(applied.causes).toEqual([
			expect.objectContaining({ artifactPath: patchPath(newTarget), outcome: 'target-renamed', cause: { sha: newPin, approx: false } })
		]);
		expect(readFileSync(join(current.root, patchPath(newTarget)), 'utf8')).toContain(`+++ b/${newTarget}`);
	});

	it('makes an R<100 rename an explicit review stop before any filesystem change', () => {
		const tree = makeTempRoot('cycle-classify-r87-tree');
		init(tree);
		const oldTarget = 'src/old/many.ts';
		const newTarget = 'src/new/many.ts';
		write(tree, oldTarget, numbered('old'));
		const oldPin = fixtureCommit(tree, 'old pin', '2026-05-05T00:00:00Z');
		mkdirSync(join(tree, 'src/new'), { recursive: true });
		fixtureGit(tree, ['mv', oldTarget, newTarget]);
		write(tree, newTarget, numbered('changed'));
		const newPin = fixtureCommit(tree, 'inexact rename', '2026-05-06T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		writePatch(current.root, oldTarget, 'CK-workbench-402', oldPin, 'line-10-old', 'line-10-codkit', 10, 20);

		const preview = classifyCycleApply(options(current));
		expect(preview.renames).toHaveLength(1);
		expect(preview.renames[0]?.similarity).toBeLessThan(100);
		expect(preview.reviewRequired).toBe(true);
		expect(() => withCycleLocks(current, (locks) => applyCycleClassification({ ...options(current), locks }))).toThrow(/explicit review/);
		expect(existsSync(join(current.root, patchPath(oldTarget)))).toBe(true);
		expect(existsSync(join(current.root, patchPath(newTarget)))).toBe(false);
	});

	it('fails before rename planning when config or artifact pin metadata is stale', () => {
		const tree = makeTempRoot('cycle-classify-stale-tree');
		init(tree);
		write(tree, 'src/a.ts', 'a\nbase\nz\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-07T00:00:00Z');
		write(tree, 'src/a.ts', 'a\nnext\nz\n');
		const newPin = fixtureCommit(tree, 'new', '2026-05-08T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		writePatch(current.root, 'src/a.ts', 'CK-workbench-403', oldPin, 'base', 'codkit');

		expect(() =>
			classifyCycleApply({
				...options(current),
				config: { ...current.config, pin: { ...current.config.pin, tag: 'wrong' } }
			})
		).toThrow(/does not exactly match/);
		const artifact = join(current.root, patchPath('src/a.ts'));
		writeFileSync(artifact, readFileSync(artifact, 'utf8').replace(`t1@${oldPin}`, `stale@${'f'.repeat(40)}`));
		expect(() => classifyCycleApply(options(current))).toThrow(/metadata pin .* does not match cycle source/);
	});

	it('fails closed on malformed inventory I/O and never treats it as an empty layer', () => {
		const tree = makeTempRoot('cycle-classify-io-tree');
		init(tree);
		write(tree, 'src/a.ts', 'a\nbase\nz\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-09T00:00:00Z');
		write(tree, 'target-marker.txt', 'target\n');
		const newPin = fixtureCommit(tree, 'new', '2026-05-10T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		write(current.root, 'delta/rules', 'not a directory\n');
		expect(() => classifyCycleApply(options(current))).toThrow(/delta\/rules is not a real directory/);

		rmSync(join(current.root, 'delta/rules'));
		mkdirSync(join(current.root, 'delta/rules'), { recursive: true });
		const outside = makeTempRoot('cycle-classify-io-outside');
		write(outside, 'bad.ckrule.json', '{}\n');
		symlinkSync(join(outside, 'bad.ckrule.json'), join(current.root, 'delta/rules/bad.ckrule.json'));
		expect(() => classifyCycleApply(options(current))).toThrow(/is not a real file/);
	});

	it('does not write classification recovery through a symlinked runtime ancestor', () => {
		const root = makeTempRoot('cycle-classify-recovery-symlink');
		const outside = makeTempRoot('cycle-classify-recovery-outside');
		const sentinel = join(outside, 'sentinel.txt');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		symlinkSync(outside, join(root, '.codkit'), 'dir');
		const record = makeCycleClassifyRecovery({
			sourcePin: { tag: 't1', sha: '1'.repeat(40), date: '2026-08-01' },
			targetPin: { tag: 't2', sha: '2'.repeat(40), date: '2026-08-08' },
			branch: 'codkit/cycle/t2',
			similarity: 50,
			detectedRenames: [],
			batch: { plans: [], bindings: [], modes: [], candidates: [], needsReview: false }
		});
		expect(() => writeCycleClassifyRecovery(root, record)).toThrow(/unsafe recovery path|symlink/);
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
		expect(existsSync(join(outside, 'cycle-classify.json'))).toBe(false);
	});

	it('rejects non-apply state and stale recorded rename evidence', () => {
		const tree = makeTempRoot('cycle-classify-state-tree');
		init(tree);
		write(tree, 'src/a.ts', 'a\nbase\nz\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-11T00:00:00Z');
		write(tree, 'target-marker.txt', 'target\n');
		const newPin = fixtureCommit(tree, 'new', '2026-05-12T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		expect(() => classifyCycleApply({ ...options(current), state: { ...current.state, phase: 'resolve' } })).toThrow(
			/cycle phase must be apply/
		);
		expect(() => classifyCycleApply({ ...options(current), state: { ...current.state, branch: 'codkit/cycle/wrong' } })).toThrow(
			/cycle branch must be exactly/
		);
		expect(() =>
			classifyCycleApply({
				...options(current),
				state: { ...current.state, transaction: { kind: 'restart', baseCommit: oldPin, bumpCommit: newPin } }
			})
		).toThrow(/requires transaction null/);
		const wrongDate = { ...current.state.targetPin, date: '1999-01-01' };
		expect(() =>
			classifyCycleApply({
				...options(current),
				config: { ...current.config, pin: wrongDate },
				state: { ...current.state, targetPin: wrongDate }
			})
		).toThrow(/targetPin date does not match/);
		const reversedSource = { ...current.state.sourcePin, sha: newPin, date: commitDate(tree, newPin) };
		const reversedTarget = { ...current.state.targetPin, sha: oldPin, date: commitDate(tree, oldPin) };
		expect(() =>
			classifyCycleApply({
				...options(current),
				config: { ...current.config, pin: reversedTarget },
				state: { ...current.state, sourcePin: reversedSource, targetPin: reversedTarget }
			})
		).toThrow(/sourcePin is not an ancestor/);
		expect(() =>
			classifyCycleApply({
				...options(current),
				state: {
					...current.state,
					renames: [{ from: 'src/old.ts', to: 'src/new.ts', similarity: 100 }]
				}
			})
		).toThrow(/state rename .* is stale/);
		fixtureGit(current.root, ['symbolic-ref', 'HEAD', 'refs/heads/wrong']);
		expect(() => classifyCycleApply(options(current))).toThrow(/patchset checkout must be on cycle branch/);
	});

	it('accepts resource-only and own-only inventories without patch conventions', () => {
		const tree = makeTempRoot('cycle-classify-single-layer-tree');
		init(tree);
		write(tree, 'resources/stable.bin', 'stable\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-12T00:01:00Z');
		write(tree, 'target-marker.txt', 'target\n');
		const newPin = fixtureCommit(tree, 'new', '2026-05-12T00:02:00Z');
		const good = `t1@${oldPin}`;

		const resourceOnly = cycleFixture(tree, oldPin, newPin);
		rmSync(join(resourceOnly.root, 'codkit'), { recursive: true, force: true });
		write(resourceOnly.root, 'delta/resources/files/stable.bin', 'replacement\n');
		writeJson(resourceOnly.root, 'delta/resources/map.json', {
			codkitResourceMap: 2,
			entries: [resourceEntry('CK-resource-only', 'resources/stable.bin', 'stable.bin', good)]
		});
		expect(classifyCycleApply(options(resourceOnly))).toMatchObject({
			classifications: [expect.objectContaining({ kind: 'resource', outcome: 'clean' })],
			validated: []
		});

		const ownOnly = cycleFixture(tree, oldPin, newPin);
		rmSync(join(ownOnly.root, 'codkit'), { recursive: true, force: true });
		write(ownOnly.root, 'delta/own/unit.ts', 'export const unit = true;\n');
		writeJson(ownOnly.root, 'delta/own/patchset.delta.json', {
			codkitOwnManifest: 2,
			units: [
				{
					id: 'CK-own-only',
					layer: 'own',
					type: 'module',
					category: 'own',
					owner: 'workbench-core',
					reason: 'own only fixture',
					link: 'none',
					cause: 'none',
					pin: good,
					contractTests: [],
					roots: ['unit.ts']
				}
			],
			serviceOverrides: []
		});
		expect(classifyCycleApply(options(ownOnly))).toMatchObject({
			classifications: [],
			validated: [expect.objectContaining({ kind: 'own', artifactId: 'CK-own-only' })]
		});
	});

	it('classifies resource lifecycle and validates resource, own, service-override and removed pins without patches', () => {
		const tree = makeTempRoot('cycle-classify-layers-tree');
		init(tree);
		write(tree, 'resources/stable.bin', 'stable\n');
		write(tree, 'resources/deleted.bin', 'deleted\n');
		write(tree, 'resources/old.bin', 'renamed\n');
		const oldPin = fixtureCommit(tree, 'old resources', '2026-05-13T00:00:00Z');
		rmSync(join(tree, 'resources/deleted.bin'));
		fixtureGit(tree, ['mv', 'resources/old.bin', 'resources/new.bin']);
		const newPin = fixtureCommit(tree, 'resource lifecycle', '2026-05-14T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		writeLayerMetadata(current.root, oldPin);

		const result = classifyCycleApply(options(current));
		expect(result.classifications.map((entry) => [entry.kind, entry.artifactPath, entry.outcome])).toEqual([
			['resource', 'delta/resources/files/deleted.bin', 'target-deleted'],
			['resource', 'delta/resources/files/renamed.bin', 'target-renamed'],
			['resource', 'delta/resources/files/stable.bin', 'clean']
		]);
		expect(result.buckets['target-deleted']).toEqual(['delta/resources/files/deleted.bin']);
		expect(result.buckets['target-renamed']).toEqual(['delta/resources/files/renamed.bin']);
		expect(result.reviewRequired).toBe(true);
		expect(result.renames).toContainEqual({ from: 'resources/old.bin', to: 'resources/new.bin', similarity: 100 });
		expect(result.causes).toEqual([
			expect.objectContaining({ outcome: 'target-deleted', cause: { sha: newPin, approx: false } }),
			expect.objectContaining({ outcome: 'target-renamed', cause: { sha: newPin, approx: false } })
		]);
		expect(result.validated.map((entry) => entry.kind)).toEqual(['own', 'service-override', 'removed']);
	});

	it('accepts a resource target changed to an exact detected rename destination', () => {
		const tree = makeTempRoot('cycle-classify-resource-confirmed-rename-tree');
		init(tree);
		write(tree, 'resources/old.bin', 'resource\n');
		const oldPin = fixtureCommit(tree, 'old resource target', '2026-05-14T00:01:00Z');
		fixtureGit(tree, ['mv', 'resources/old.bin', 'resources/new.bin']);
		const newPin = fixtureCommit(tree, 'rename resource target', '2026-05-14T00:02:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		write(current.root, 'delta/resources/files/resource.bin', 'replacement\n');
		writeJson(current.root, 'delta/resources/map.json', {
			codkitResourceMap: 2,
			entries: [resourceEntry('CK-resource-confirmed-rename', 'resources/new.bin', 'resource.bin', `t1@${oldPin}`)]
		});

		const result = classifyCycleApply(options(current));
		expect(result.classifications).toEqual([
			expect.objectContaining({
				kind: 'resource',
				targetPath: 'resources/new.bin',
				outcome: 'clean'
			})
		]);
		expect(result.renames).toContainEqual({ from: 'resources/old.bin', to: 'resources/new.bin', similarity: 100 });
		expect(result.reviewRequired).toBe(false);
	});

	it('rejects a resource target introduced at the new pin without a detected rename', () => {
		const tree = makeTempRoot('cycle-classify-resource-new-only-tree');
		init(tree);
		write(tree, 'source-marker.txt', 'source\n');
		const oldPin = fixtureCommit(tree, 'source without resource target', '2026-05-14T00:03:00Z');
		write(tree, 'resources/new-only.bin', 'introduced\n');
		const newPin = fixtureCommit(tree, 'introduce resource target', '2026-05-14T00:04:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		write(current.root, 'delta/resources/files/resource.bin', 'replacement\n');
		writeJson(current.root, 'delta/resources/map.json', {
			codkitResourceMap: 2,
			entries: [resourceEntry('CK-resource-new-only', 'resources/new-only.bin', 'resource.bin', `t1@${oldPin}`)]
		});

		expect(() => classifyCycleApply(options(current))).toThrow(/resource target resources\/new-only\.bin is absent at metadata pin/);
	});

	it('rejects stale pin metadata in resource, own, service-override and removed records', () => {
		const tree = makeTempRoot('cycle-classify-layer-pin-tree');
		init(tree);
		write(tree, 'resources/stable.bin', 'stable\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-15T00:00:00Z');
		write(tree, 'target-marker.txt', 'target\n');
		const newPin = fixtureCommit(tree, 'new', '2026-05-16T00:00:00Z');
		for (const stale of ['resource', 'own', 'service-override', 'removed'] as const) {
			const current = cycleFixture(tree, oldPin, newPin);
			writeLayerMetadata(current.root, oldPin, stale);
			expect(() => classifyCycleApply(options(current))).toThrow(/metadata pin .* does not match cycle source/);
		}
	});

	it('resumes a durable rename under live locks before parsing the interrupted patch', () => {
		const tree = makeTempRoot('cycle-classify-resume-tree');
		init(tree);
		const oldTarget = 'src/old/resume.ts';
		const newTarget = 'src/new/resume.ts';
		write(tree, oldTarget, 'a\nbase\nz\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-17T00:00:00Z');
		mkdirSync(join(tree, 'src/new'), { recursive: true });
		fixtureGit(tree, ['mv', oldTarget, newTarget]);
		const newPin = fixtureCommit(tree, 'rename', '2026-05-18T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		writePatch(current.root, oldTarget, 'CK-workbench-404', oldPin, 'base', 'codkit');
		classifyCycleApply(options(current));

		withCycleLocks(current, (locks) => {
			expect(() =>
				applyCycleClassification({
					...options(current),
					locks,
					runtime: {
						rename: {
							afterOperation: (completed) => {
								if (completed === 1) throw new Error('interrupt');
							}
						}
					}
				})
			).toThrow('interrupt');
		});
		expect(existsSync(join(current.root, '.codkit/cycle-classify.json'))).toBe(true);
		expect(() => classifyCycleApply(options(current))).toThrow(/pending durable rename requires locked apply recovery/);
		const resumed = runFreshApply(current);
		expect(resumed).toEqual([expect.objectContaining({ artifactPath: patchPath(newTarget), targetPath: newTarget })]);
		expect(existsSync(join(current.root, '.codkit/cycle-classify.json'))).toBe(false);
	});

	it('rejects a recomputed-digest recovery batch tamper before the transaction exists', () => {
		const current = renameFixture('cycle-classify-tamper-pristine', 'before');
		withCycleLocks(current, (locks) => {
			expect(() =>
				applyCycleClassification({
					...options(current),
					locks,
					runtime: {
						afterRecoveryWrite: () => {
							throw new Error('crash');
						}
					}
				})
			).toThrow('crash');
		});
		tamperRecovery(current.root, (record) => {
			const plan = firstPlan(record);
			plan.toTarget = 'src/evil.ts';
		});
		expect(() => withCycleLocks(current, (locks) => applyCycleClassification({ ...options(current), locks }))).toThrow(
			/does not match the pristine inventory/
		);
		expect(existsSync(join(current.root, patchPath('src/old/before.ts')))).toBe(true);
	});

	it('rejects recomputed-digest operation/destination tamper against an existing transaction before resuming', () => {
		const current = renameFixture('cycle-classify-tamper-transaction', 'during');
		withCycleLocks(current, (locks) => {
			expect(() =>
				applyCycleClassification({
					...options(current),
					locks,
					runtime: {
						rename: {
							afterOperation: (done) => {
								if (done === 1) throw new Error('crash');
							}
						}
					}
				})
			).toThrow('crash');
		});
		const artifact = join(current.root, patchPath('src/old/during.ts'));
		const before = readFileSync(artifact);
		tamperRecovery(current.root, (record) => {
			const plan = firstPlan(record);
			const move = plan.operations.find((operation) => operation.kind === 'move');
			if (move === undefined) throw new Error('missing move');
			move.to = 'delta/patches/evil.ckpatch';
		});
		expect(() => withCycleLocks(current, (locks) => applyCycleClassification({ ...options(current), locks }))).toThrow(
			/recovery plan operations are not canonical|expected rename batch/
		);
		expect(readFileSync(artifact)).toEqual(before);
	});

	it('rejects released, wrong and raced lock capabilities before rename mutation', () => {
		const tree = makeTempRoot('cycle-classify-lock-tree');
		init(tree);
		const oldTarget = 'src/old/lock.ts';
		const newTarget = 'src/new/lock.ts';
		write(tree, oldTarget, 'a\nbase\nz\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-19T00:00:00Z');
		mkdirSync(join(tree, 'src/new'), { recursive: true });
		fixtureGit(tree, ['mv', oldTarget, newTarget]);
		const newPin = fixtureCommit(tree, 'rename', '2026-05-20T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		writePatch(current.root, oldTarget, 'CK-workbench-405', oldPin, 'base', 'codkit');
		const cycle = acquireLock(current.root, 'cycle-global', 'cycle continue');
		const wrong = acquireLock(current.root, 'wrong-tree', 'cycle continue');
		try {
			expect(() => applyCycleClassification({ ...options(current), locks: { cycle, tree: wrong } })).toThrow(/tree lock capability/);
		} finally {
			wrong.release();
		}
		const treeLock = acquireLock(current.root, treeId(current.tree), 'cycle continue');
		try {
			const clonedCycle = { ...cycle, info: { ...cycle.info } };
			expect(() => applyCycleClassification({ ...options(current), locks: { cycle: clonedCycle, tree: treeLock } })).toThrow(
				/requires a live lock handle owned by this process/
			);
			expect(() =>
				applyCycleClassification({
					...options(current),
					locks: { cycle, tree: treeLock },
					runtime: { beforeRenameMutation: () => treeLock.release() }
				})
			).toThrow(/requires a live lock handle owned by this process/);
			expect(existsSync(join(current.root, patchPath(oldTarget)))).toBe(true);
		} finally {
			treeLock.release();
			cycle.release();
		}
	});

	it('makes deletion of an opened optional layer loud instead of accepting an empty replacement', () => {
		const tree = makeTempRoot('cycle-classify-layer-race-tree');
		init(tree);
		write(tree, 'resources/stable.bin', 'stable\n');
		const oldPin = fixtureCommit(tree, 'old', '2026-05-21T00:00:00Z');
		write(tree, 'target-marker.txt', 'target\n');
		const newPin = fixtureCommit(tree, 'new', '2026-05-22T00:00:00Z');
		const current = cycleFixture(tree, oldPin, newPin);
		write(current.root, 'delta/resources/files/stable.bin', 'replacement\n');
		writeJson(current.root, 'delta/resources/map.json', {
			codkitResourceMap: 2,
			entries: [resourceEntry('CK-resource-race', 'resources/stable.bin', 'stable.bin', `t1@${oldPin}`)]
		});
		expect(() =>
			classifyCycleApply({
				...options(current),
				layerRuntime: {
					afterOptionalOpen(path) {
						if (path === 'delta/resources/map.json') rmSync(join(current.root, path));
					}
				}
			})
		).toThrow(/map\.json disappeared while its mandatory bytes were being read/);
	});
});

function cycleFixture(tree: string, oldPin: string, newPin: string): Fixture {
	const root = makeTempRoot('cycle-classify-patchset');
	const destination = join(root, 'codkit/config/conventions.json');
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(join(process.cwd(), 'codkit/config/conventions.json'), destination);
	fixtureGit(root, ['init', '--quiet', '--initial-branch=codkit/cycle/t2', '.']);
	const sourcePin = { tag: 't1', sha: oldPin, date: commitDate(tree, oldPin) };
	const targetPin = { tag: 't2', sha: newPin, date: commitDate(tree, newPin) };
	const state: CycleState = {
		codkitCycleState: 2,
		sourcePin,
		targetPin,
		branch: 'codkit/cycle/t2',
		startedAt: '2026-05-02T00:00:00+00:00',
		updatedAt: '2026-05-02T00:00:00+00:00',
		phase: 'apply',
		nextAction: 'classify the complete delta',
		transaction: null,
		artifacts: EMPTY_ARTIFACTS,
		resolved: [],
		renames: []
	};
	const config: CodkitConfig = {
		codkitConfig: 1,
		pin: targetPin,
		upstreamAnchorCommit: oldPin,
		ownDirName: 'patchset',
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
	return { tree, root, oldPin, newPin, targetCommit: newPin, state, config };
}

function options(current: Fixture) {
	return { patchesDir: current.root, treeDir: current.tree, config: current.config, state: current.state };
}

function renameFixture(label: string, stem: string): Fixture {
	const tree = makeTempRoot(`${label}-tree`);
	init(tree);
	const oldTarget = `src/old/${stem}.ts`;
	const newTarget = `src/new/${stem}.ts`;
	write(tree, oldTarget, 'a\nbase\nz\n');
	const oldPin = fixtureCommit(tree, 'old', '2026-06-01T00:00:00Z');
	mkdirSync(join(tree, 'src/new'), { recursive: true });
	fixtureGit(tree, ['mv', oldTarget, newTarget]);
	const newPin = fixtureCommit(tree, 'rename', '2026-06-02T00:00:00Z');
	const current = cycleFixture(tree, oldPin, newPin);
	writePatch(current.root, oldTarget, 'CK-workbench-406', oldPin, 'base', 'codkit');
	return current;
}

type MutableRecovery = {
	digest: string;
	batch: { plans: Array<{ toTarget: string; operations: Array<{ kind: string; to?: string }> }> };
	[key: string]: unknown;
};

function firstPlan(record: MutableRecovery): MutableRecovery['batch']['plans'][number] {
	const plan = record.batch.plans[0];
	if (plan === undefined) throw new Error('missing recovery plan');
	return plan;
}

function tamperRecovery(root: string, mutate: (record: MutableRecovery) => void): void {
	const path = join(root, '.codkit/cycle-classify.json');
	const record = JSON.parse(readFileSync(path, 'utf8')) as MutableRecovery;
	mutate(record);
	const { digest: _oldDigest, ...body } = record;
	record.digest = createHash('sha256').update(JSON.stringify(body)).digest('hex');
	writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
}

function runFreshApply(current: Fixture): readonly { artifactPath: string; targetPath: string }[] {
	const script = join(makeTempRoot('cycle-classify-child'), 'resume.mjs');
	const classifyUrl = pathToFileURL(join(process.cwd(), 'codkit/src/lib/cycleClassify.ts')).href;
	const lockUrl = pathToFileURL(join(process.cwd(), 'codkit/src/lib/lock.ts')).href;
	const fingerprintUrl = pathToFileURL(join(process.cwd(), 'codkit/src/lib/fingerprint.ts')).href;
	writeFileSync(
		script,
		[
			`const { applyCycleClassification } = await import(${JSON.stringify(classifyUrl)});`,
			`const { acquireLock } = await import(${JSON.stringify(lockUrl)});`,
			`const { treeId } = await import(${JSON.stringify(fingerprintUrl)});`,
			'const options = JSON.parse(process.argv[2]);',
			"const cycle = acquireLock(options.patchesDir, 'cycle-global', 'fresh resume');",
			'let tree;',
			'try {',
			"  tree = acquireLock(options.patchesDir, treeId(options.treeDir), 'fresh resume');",
			'  const result = applyCycleClassification({ ...options, locks: { cycle, tree } });',
			'  process.stdout.write(JSON.stringify(result.classifications.map(({ artifactPath, targetPath }) => ({ artifactPath, targetPath }))));',
			'} finally { tree?.release(); cycle.release(); }'
		].join('\n')
	);
	const stdout = execFileSync(process.execPath, ['--experimental-strip-types', script, JSON.stringify(options(current))], {
		encoding: 'utf8'
	});
	return JSON.parse(stdout) as readonly { artifactPath: string; targetPath: string }[];
}

function withCycleLocks<T>(
	current: Fixture,
	body: (locks: { cycle: ReturnType<typeof acquireLock>; tree: ReturnType<typeof acquireLock> }) => T
): T {
	const cycle = acquireLock(current.root, 'cycle-global', 'cycle continue');
	try {
		const tree = acquireLock(current.root, treeId(current.tree), 'cycle continue');
		try {
			return body({ cycle, tree });
		} finally {
			tree.release();
		}
	} finally {
		cycle.release();
	}
}

function commitDate(tree: string, sha: string): string {
	return fixtureGit(tree, ['show', '-s', '--format=%cs', sha]).stdout.trim();
}

function init(tree: string): void {
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
}

function writePatch(root: string, target: string, id: string, oldPin: string, before: string, after: string, start = 1, count = 3): void {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'cycle classifier fixture',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
		contractTests: []
	});
	const lines =
		count === 3
			? [' a', `-${before}`, `+${after}`, ' z']
			: Array.from({ length: count }, (_, index) => {
					const line = index + 1;
					return line === start ? `-${before}\n+${after}` : ` line-${String(line).padStart(2, '0')}-old`;
				}).flatMap((line) => line.split('\n'));
	const body = [`--- a/${target}`, `+++ b/${target}`, `@@ -1,${count} +1,${count} @@`, ...lines].join('\n');
	write(root, patchPath(target), `${header}${body}\n`);
}

function writeRule(root: string, target: string, id: string, oldPin: string, match: string): void {
	writeJson(root, `delta/rules/${id}.ckrule.json`, {
		codkitRule: 2,
		id,
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'cycle classifier fixture',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
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

function writeOverlay(root: string, target: string, id: string, oldPin: string, expected: string): void {
	writeJson(root, `delta/overlays/${id}.overlay.json`, {
		codkitOverlay: 2,
		id,
		target,
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'cycle classifier fixture',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
		contractTests: ['fixture.overlay'],
		operations: [{ op: 'set', path: ['name'], value: 'codkit', expectUpstream: expected }]
	});
}

function writeLayerMetadata(root: string, oldPin: string, stale?: 'resource' | 'own' | 'service-override' | 'removed'): void {
	const good = `t1@${oldPin}`;
	const bad = `stale@${'f'.repeat(40)}`;
	for (const name of ['stable.bin', 'deleted.bin', 'renamed.bin']) write(root, `delta/resources/files/${name}`, `${name}\n`);
	writeJson(root, 'delta/resources/map.json', {
		codkitResourceMap: 2,
		entries: [
			resourceEntry('CK-resource-deleted', 'resources/deleted.bin', 'deleted.bin', stale === 'resource' ? bad : good),
			resourceEntry('CK-resource-renamed', 'resources/old.bin', 'renamed.bin', good),
			resourceEntry('CK-resource-stable', 'resources/stable.bin', 'stable.bin', good)
		]
	});
	write(root, 'delta/own/unit.ts', 'export const unit = true;\n');
	writeJson(root, 'delta/own/patchset.delta.json', {
		codkitOwnManifest: 2,
		units: [
			{
				id: 'CK-own',
				layer: 'own',
				type: 'module',
				category: 'own',
				owner: 'workbench-core',
				reason: 'fixture own unit',
				link: 'none',
				cause: 'none',
				pin: stale === 'own' ? bad : good,
				contractTests: [],
				roots: ['unit.ts']
			}
		],
		serviceOverrides: [
			{
				id: 'CK-service',
				serviceId: 'IExampleService',
				module: 'unit.ts',
				owner: 'workbench-core',
				reason: 'fixture override',
				link: 'none',
				cause: 'none',
				pin: stale === 'service-override' ? bad : good,
				contractTests: []
			}
		]
	});
	writeJson(root, 'delta/removed.json', {
		codkitRemoved: 1,
		entries: [
			{
				id: 'CK-removed',
				kind: 'setting',
				target: 'fixture.setting',
				how: 'config overlay',
				owner: 'product',
				reason: 'fixture removal',
				link: 'none',
				pin: stale === 'removed' ? bad : good,
				contractTests: ['fixture.removed']
			}
		]
	});
}

function resourceEntry(id: string, target: string, sourceName: string, pin: string) {
	return {
		id,
		target,
		source: `delta/resources/files/${sourceName}`,
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'fixture resource',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.resource']
	};
}

function patchPath(target: string): string {
	return `delta/patches/${encodePatchName(target)}`;
}

function outcomeFor(result: ReturnType<typeof classifyCycleApply>, artifactPath: string): string | undefined {
	return result.classifications.find((item) => item.artifactPath === artifactPath)?.outcome;
}

function numbered(replacement: 'old' | 'changed'): string {
	return (
		Array.from({ length: 20 }, (_, index) => {
			const number = index + 1;
			return number === 10 ? `line-10-${replacement}` : `line-${String(number).padStart(2, '0')}-old`;
		}).join('\n') + '\n'
	);
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function writeJson(root: string, path: string, value: unknown): void {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function byteCompare(left: string, right: string): number {
	return Buffer.from(left).compare(Buffer.from(right));
}
