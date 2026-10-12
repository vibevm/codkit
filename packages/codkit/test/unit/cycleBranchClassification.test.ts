/** @scope spec://codkit/modules/codkit/PROP-009#CYCLE-BRANCH-TRANSITION */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { classifyCycleApply } from '../../src/lib/cycleClassify.ts';
import { startCycle } from '../../src/lib/cycleControl.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { renameReferencePaths } from '../../src/lib/cycleEngineIo.ts';
import { ownedRootsOf } from '../../src/lib/ownedRoots.ts';
import { readCycleState } from '../../src/lib/cycleState.ts';
import { makeCycleApplyRecord, readCycleApplyRecord, writeCycleApplyRecord } from '../../src/lib/cycleEngineRecord.ts';
import { makeUpstream, fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { projectType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

describe('classification across explicitly authorized release branches', () => {
	afterAll(cleanupTempRoots);
	it('classifies actual artifacts and excludes binary fixtures from rename reference discovery', () => {
		const upstream = makeUpstream(makeTempRoot('branch-classification-upstream'));
		const patchesDir = makeTempRoot('branch-classification-patches');
		makePatchSet(patchesDir, upstream);
		writeFileSync(join(patchesDir, '.git', 'info', 'exclude'), '.codkit/\n', 'utf8');
		fixtureGit(upstream.dir, ['checkout', '--detach', upstream.anchorSha]);
		fixtureGit(upstream.dir, ['read-tree', '--reset', '-u', 't1']);
		writeFileSync(join(upstream.dir, 'sibling-release.txt'), 'release\n', 'utf8');
		fixtureCommit(upstream.dir, 'fixture: sibling release with the same source tree', '2026-02-02T00:00:00Z');
		fixtureGit(upstream.dir, ['tag', 't3']);
		const source = loadConfig(patchesDir);
		if (source === null) throw new Error('fixture config missing');
		startCycle({ patchesDir, forkDir: upstream.dir, config: source, type: projectType, target: 't3', allowBranchTransition: true });
		const config = loadConfig(patchesDir);
		const state = readCycleState(patchesDir);
		if (config === null || state === null) throw new Error('cycle init missing');
		writeFileSync(join(patchesDir, 'delta/own/binary.vsix'), new Uint8Array([80, 75, 0, 255]));
		const refs = renameReferencePaths(patchesDir, ownedRootsOf(projectType, config.typeConfig));
		expect([...refs.own, ...refs.contractTests]).not.toContain('delta/own/binary.vsix');
		expect(refs.own.length + refs.contractTests.length).toBeGreaterThan(0);
		const input = {
			patchesDir,
			treeDir: upstream.dir,
			config,
			state,
			type: projectType,
			ownPaths: refs.own,
			contractTestPaths: refs.contractTests
		};
		const result = classifyCycleApply(input);
		expect(result.classifications.length).toBeGreaterThan(0);
		expect(result.buckets.conflict).toEqual([]);
		const overlay = result.classifications.find((item) => item.kind === 'overlay');
		if (overlay === undefined || overlay.kind !== 'overlay' || overlay.report === null) throw new Error('fixture overlay missing');
		const diagnostic = {
			...overlay,
			outcome: 'conflict' as const,
			report: {
				...overlay.report,
				drift: [
					{
						overlayId: overlay.artifactId,
						artifactPath: overlay.artifactPath,
						target: overlay.targetPath,
						operationIndex: 0,
						path: ['removed-key'],
						expected: true,
						expectedAbsent: false,
						actual: undefined
					}
				]
			}
		};
		const record = makeCycleApplyRecord({
			sourcePin: state.sourcePin,
			targetPin: state.targetPin,
			branch: state.branch,
			createdAt: state.updatedAt,
			classifications: result.classifications.map((item) => (item.artifactPath === overlay.artifactPath ? diagnostic : item)),
			causes: [
				...result.causes.filter((item) => item.artifactPath !== overlay.artifactPath),
				{
					artifactPath: overlay.artifactPath,
					artifactId: overlay.artifactId,
					targetPath: overlay.targetPath,
					outcome: 'conflict',
					cause: { sha: state.targetPin.sha, approx: true }
				}
			],
			buckets: {
				...result.buckets,
				clean: result.buckets.clean.filter((path) => path !== overlay.artifactPath),
				conflict: [overlay.artifactPath]
			},
			renames: result.renames,
			renamePaths: [],
			regenerationPaths: [],
			reviewToken: null,
			reviewStop: null,
			checkpoint: 'preview',
			renameParent: fixtureGit(patchesDir, ['rev-parse', 'HEAD']).stdout.trim(),
			renameCommit: null,
			regenerationParent: null,
			regenerationCommit: null
		});
		writeCycleApplyRecord(patchesDir, record);
		const restored = readCycleApplyRecord(patchesDir)?.classifications.find((item) => item.kind === 'overlay');
		if (restored === undefined || restored.kind !== 'overlay' || restored.report === null) throw new Error('stored overlay missing');
		expect(restored.report.drift[0]?.actual).toBeUndefined();
		expect(restored.report.drift[0]?.expected).toBe(true);
		expect(readFileSync(join(patchesDir, '.codkit/cycle-apply.json'), 'utf8')).not.toContain('"actual": null');
		expect(() => classifyCycleApply({ ...input, state: { ...state, codkitCycleState: 3 } })).toThrow('authorization does not match');
		expect(() => classifyCycleApply({ ...input, config: { ...config, upstreamAnchorCommit: '1'.repeat(40) } })).toThrow(
			'authorization does not match'
		);
	});
});
