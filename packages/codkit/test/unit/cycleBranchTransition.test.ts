/** @scope spec://codkit/modules/codkit/PROP-009#CYCLE-BRANCH-TRANSITION */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, serializeBaseConfig } from '../../src/lib/configFile.ts';
import { startCycle } from '../../src/lib/cycleControl.ts';
import { cycleStateSchema, readCycleState } from '../../src/lib/cycleState.ts';
import { makeUpstream, fixtureCommit, fixtureGit, pinDate } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { projectType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

function fixture(label: string) {
	const upstream = makeUpstream(makeTempRoot(`${label}-upstream`));
	const patchesDir = makeTempRoot(`${label}-patchset`);
	makePatchSet(patchesDir, upstream);
	writeFileSync(join(patchesDir, '.git', 'info', 'exclude'), '.codkit/\n', 'utf8');
	const initial = loadConfig(patchesDir);
	if (initial === null) throw new Error('fixture config missing');
	const source = { ...initial, pin: { tag: 't2', sha: upstream.t2.sha, date: pinDate(upstream.t2.dateIso) } };
	writeFileSync(join(patchesDir, 'codkit.json'), serializeBaseConfig(source), 'utf8');
	fixtureCommit(patchesDir, 'fixture: bind source release', '2026-02-01T00:00:00Z');
	fixtureGit(upstream.dir, ['checkout', '-b', 'sibling-release', 't1']);
	writeFileSync(join(upstream.dir, 'release.txt'), 'sibling release\n', 'utf8');
	fixtureCommit(upstream.dir, 'fixture: sibling release', '2026-02-02T00:00:00Z');
	fixtureGit(upstream.dir, ['tag', 't3']);
	return { upstream, patchesDir, source };
}

function facts(root: string) {
	return {
		head: fixtureGit(root, ['rev-parse', 'HEAD']).stdout,
		refs: fixtureGit(root, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout,
		config: readFileSync(join(root, 'codkit.json'), 'utf8'),
		state: readCycleState(root)
	};
}

describe('explicit cycle branch transitions', () => {
	afterAll(cleanupTempRoots);
	it('refuses a sibling release by default without mutation', () => {
		const current = fixture('cycle-sibling-default');
		const before = facts(current.patchesDir);
		expect(() =>
			startCycle({ patchesDir: current.patchesDir, forkDir: current.upstream.dir, config: current.source, type: projectType, target: 't3' })
		).toThrow('does not descend');
		expect(facts(current.patchesDir)).toEqual(before);
	});
	it('persists the authorized anchor and recovers interrupted init without repeating the flag', () => {
		const current = fixture('cycle-sibling-recovery');
		expect(() =>
			startCycle({
				patchesDir: current.patchesDir,
				forkDir: current.upstream.dir,
				config: current.source,
				type: projectType,
				target: 't3',
				allowBranchTransition: true,
				dependencies: {
					checkpoint: (stage) => {
						if (stage === 'init-config-written') throw new Error('injected interruption');
					}
				}
			})
		).toThrow('injected interruption');
		const pending = readCycleState(current.patchesDir);
		expect(pending).toMatchObject({ codkitCycleState: 4, branchTransitionAnchor: current.upstream.anchorSha, phase: 'init' });
		const latest = loadConfig(current.patchesDir);
		if (latest === null) throw new Error('fixture config missing');
		const completed = startCycle({
			patchesDir: current.patchesDir,
			forkDir: current.upstream.dir,
			config: latest,
			type: projectType,
			target: 't3'
		});
		expect(completed).toMatchObject({ resumed: true, sourcePin: current.source.pin, phase: 'apply' });
		expect(readCycleState(current.patchesDir)).toMatchObject({
			codkitCycleState: 4,
			branchTransitionAnchor: current.upstream.anchorSha,
			phase: 'apply'
		});
		expect(cycleStateSchema.safeParse({ ...readCycleState(current.patchesDir), codkitCycleState: 3 }).success).toBe(false);
	});
	it('still refuses a target in another root before mutation', () => {
		const current = fixture('cycle-sibling-unrelated');
		fixtureGit(current.upstream.dir, ['config', 'user.name', 'Cycle Fixture']);
		fixtureGit(current.upstream.dir, ['config', 'user.email', 'cycle@example.invalid']);
		const tree = fixtureGit(current.upstream.dir, ['rev-parse', 'HEAD^{tree}']).stdout.trim();
		const target = fixtureGit(current.upstream.dir, ['commit-tree', tree, '-m', 'independent root']).stdout.trim();
		const before = facts(current.patchesDir);
		expect(() =>
			startCycle({
				patchesDir: current.patchesDir,
				forkDir: current.upstream.dir,
				config: current.source,
				type: projectType,
				target,
				allowBranchTransition: true
			})
		).toThrow();
		expect(facts(current.patchesDir)).toEqual(before);
	});
	it('still refuses an ancestral downgrade with authorization', () => {
		const current = fixture('cycle-sibling-downgrade');
		const before = facts(current.patchesDir);
		expect(() =>
			startCycle({
				patchesDir: current.patchesDir,
				forkDir: current.upstream.dir,
				config: current.source,
				type: projectType,
				target: 't1',
				allowBranchTransition: true
			})
		).toThrow('ancestor of the source');
		expect(facts(current.patchesDir)).toEqual(before);
	});
});
