/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CycleApplyClassification, CycleClassificationCause } from '../../src/lib/cycleClassify.ts';
import {
	CYCLE_REGENERATE_RECOVERY_PATH,
	applyCycleRegenerationPlan,
	planCycleRegeneration,
	regenerateCycle
} from '../../src/lib/cycleRegenerate.ts';
import type { CycleRegenerationOptions, CycleRegenerationPlan } from '../../src/lib/cycleRegenerate.ts';
import type { CycleState } from '../../src/lib/cycleState.ts';
import { formatPatchHeader } from '../../src/lib/patchFormat.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

const SOURCE_SHA = '1'.repeat(40);
const TARGET_SHA = '2'.repeat(40);
const CAUSE_SHA = '3'.repeat(40);
const SOURCE_PIN = `1.0.0@${SOURCE_SHA}`;
const TARGET_PIN = `2.0.0@${TARGET_SHA}`;

describe('cycle regeneration transaction', () => {
	afterAll(() => cleanupTempRoots());

	it('regenerates every safe patch outcome, preserves blockers, deletes an empty diff, and repeats as a noop', () => {
		const root = makeTempRoot('cycle-regenerate-patches');
		const clean = patchItem(root, 'src/clean.ts', 'CK-workbench-901', 'clean', 'base\n', 'base\n', 'fork\n');
		const shifted = patchItem(root, 'src/shifted.ts', 'CK-workbench-902', 'shifted', 'base\n', 'upstream\n', 'merged\n');
		const merged = patchItem(root, 'src/merged.ts', 'CK-workbench-903', 'merged', 'base\n', 'upstream\n', 'combined\n');
		const empty = patchItem(root, 'src/empty.ts', 'CK-workbench-904', 'merged', 'base\n', 'upstream\n', 'upstream\n');
		const conflict = patchItem(root, 'src/conflict.ts', 'CK-workbench-905', 'conflict', 'base\n', 'upstream\n', 'markers\n');
		const deleted = deletedPatchItem(root, 'src/deleted.ts', 'CK-workbench-906');
		const classifications = [clean, conflict, deleted, empty, merged, shifted].sort(byArtifact);
		const causes = [cause(merged, true), cause(shifted, false)].sort(byArtifact);
		const options = input(root, classifications, causes);
		write(root, clean.artifactPath, text(root, clean.artifactPath).replace('# type:', '# layer: patch\n# type:'));
		const conflictBefore = bytes(root, conflict.artifactPath);
		const deletedBefore = bytes(root, deleted.artifactPath);

		const result = regenerateCycle(options);
		expect(result.changedPaths).toEqual([clean.artifactPath, empty.artifactPath, merged.artifactPath, shifted.artifactPath].sort());
		expect(existsSync(join(root, empty.artifactPath))).toBe(false);
		expect(bytes(root, conflict.artifactPath)).toEqual(conflictBefore);
		expect(bytes(root, deleted.artifactPath)).toEqual(deletedBefore);
		expect(text(root, clean.artifactPath)).toContain(`# pin: ${TARGET_PIN}`);
		expect(text(root, clean.artifactPath)).toContain('# layer: patch');
		expect(text(root, clean.artifactPath)).toContain('# cause: none');
		expect(text(root, merged.artifactPath)).toContain(`# cause: ${CAUSE_SHA}`);
		expect(result.actions.find((item) => item.artifactPath === merged.artifactPath)?.cause).toEqual({
			sha: CAUSE_SHA,
			approx: true
		});

		const repeat = regenerateCycle(options);
		expect(repeat.changedPaths).toEqual([]);
		expect(repeat.actions.filter((item) => item.action !== 'noop' && item.action !== 'untouched')).toEqual([]);
	});

	it('distinguishes existing empty targets from independently added empty upstream files', () => {
		const root = makeTempRoot('cycle-regenerate-empty-presence');
		const edit = patchItem(root, 'src/existing-empty.ts', 'CK-workbench-907', 'merged', '', '', 'fork\n');
		const add = addPatchItem(root, 'src/independent-empty.ts', 'CK-workbench-908');
		regenerateCycle(input(root, [edit, add].sort(byArtifact), []));
		for (const item of [edit, add]) {
			expect(text(root, item.artifactPath)).toContain(`--- a/${item.targetPath}`);
			expect(text(root, item.artifactPath)).not.toContain('--- /dev/null');
		}
	});

	it('updates clean rule, overlay, resource, own, service and removed metadata with canonical LF JSON', () => {
		const root = makeTempRoot('cycle-regenerate-layers');
		const rulePath = 'delta/rules/r.ckrule.json';
		const overlayPath = 'delta/overlays/o.overlay.json';
		const resourceSource = 'delta/resources/files/logo.bin';
		writeJson(root, rulePath, rule('CK-workbench-911'));
		writeJson(root, overlayPath, overlay('CK-product-912'));
		write(root, resourceSource, 'binary-ish\n');
		writeJson(root, 'delta/resources/map.json', {
			codkitResourceMap: 2,
			entries: [resource('CK-product-913', resourceSource)]
		});
		write(root, 'delta/own/main.ts', 'export {};\n');
		writeJson(root, 'delta/own/patchset.delta.json', {
			codkitOwnManifest: 2,
			units: [own('CK-workbench-914')],
			serviceOverrides: [service('CK-platform-915')]
		});
		writeJson(root, 'delta/removed.json', {
			codkitRemoved: 1,
			entries: [removed('CK-build-916')]
		});
		const classifications = (
			[
				{
					kind: 'overlay',
					layer: 'config-overlay',
					artifactPath: overlayPath,
					artifactId: 'CK-product-912',
					targetPath: 'product.json',
					outcome: 'clean',
					targetBytes: new TextEncoder().encode('{}\n'),
					report: null
				},
				{
					kind: 'resource',
					layer: 'resource-file',
					artifactPath: resourceSource,
					artifactId: 'CK-product-913',
					targetPath: 'resources/logo.bin',
					outcome: 'clean'
				},
				{
					kind: 'rule',
					layer: 'rewrite-rule',
					artifactPath: rulePath,
					artifactId: 'CK-workbench-911',
					targetPath: 'src/rule.ts',
					outcome: 'clean',
					targetBytes: new TextEncoder().encode('anchor\n'),
					matches: { perOp: [1, 0], total: 1 },
					expectedMatches: 1
				}
			] satisfies CycleApplyClassification[]
		).sort(byArtifact);
		const causes = [cause(classifications[0]!, true)].sort(byArtifact);

		const result = regenerateCycle(input(root, classifications, causes));
		expect(result.changedPaths).toEqual([
			'delta/overlays/o.overlay.json',
			'delta/own/patchset.delta.json',
			'delta/removed.json',
			'delta/resources/map.json',
			'delta/rules/r.ckrule.json'
		]);
		for (const path of result.changedPaths) {
			expect(text(root, path).endsWith('\n')).toBe(true);
			expect(text(root, path)).not.toContain('\r');
		}
		expect(JSON.parse(text(root, rulePath)).pin).toBe(TARGET_PIN);
		expect(JSON.parse(text(root, overlayPath)).pin).toBe(TARGET_PIN);
		expect(JSON.parse(text(root, 'delta/resources/map.json')).entries[0].pin).toBe(TARGET_PIN);
		expect(JSON.parse(text(root, 'delta/own/patchset.delta.json')).units[0].pin).toBe(TARGET_PIN);
		expect(JSON.parse(text(root, 'delta/removed.json')).entries[0].pin).toBe(TARGET_PIN);
	});

	it('rejects semantically valid noncanonical metadata before deriving cycle writes', () => {
		const root = makeTempRoot('cycle-regenerate-noncanonical-source');
		const overlayPath = 'delta/overlays/o.overlay.json';
		write(root, overlayPath, `${JSON.stringify(overlay('CK-product-917'))}\n`);
		const classification = {
			kind: 'overlay',
			layer: 'config-overlay',
			artifactPath: overlayPath,
			artifactId: 'CK-product-917',
			targetPath: 'product.json',
			outcome: 'clean',
			targetBytes: new TextEncoder().encode('{}\n'),
			report: null
		} satisfies CycleApplyClassification;

		expect(() => planCycleRegeneration(input(root, [classification], []))).toThrow(/metadata bytes are not canonical JSON/);
	});

	it('rejects source metadata mismatch and symlink containment before writes', () => {
		const root = makeTempRoot('cycle-regenerate-invalid');
		const rulePath = 'delta/rules/r.ckrule.json';
		writeJson(root, rulePath, { ...rule('CK-workbench-921'), pin: `stale@${'f'.repeat(40)}` });
		const classification = ruleClassification(rulePath, 'CK-workbench-921');
		expect(() => planCycleRegeneration(input(root, [classification], []))).toThrow(/matches neither cycle source nor target/);

		const linked = makeTempRoot('cycle-regenerate-link-target');
		writeJson(linked, 'r.ckrule.json', rule('CK-workbench-922'));
		const root2 = makeTempRoot('cycle-regenerate-link-root');
		mkdirSync(join(root2, 'delta'), { recursive: true });
		symlinkSync(linked, join(root2, 'delta/rules'));
		expect(() => planCycleRegeneration(input(root2, [], []))).toThrow(/symlink|unsafe/);
	});

	it('detects a stale-byte race and resumes an interrupted multi-file transaction exactly', () => {
		const root = makeTempRoot('cycle-regenerate-recovery');
		const aPath = 'delta/rules/a.ckrule.json';
		const bPath = 'delta/rules/b.ckrule.json';
		writeJson(root, aPath, rule('CK-workbench-931'));
		writeJson(root, bPath, rule('CK-workbench-932'));
		const options = input(root, [ruleClassification(aPath, 'CK-workbench-931'), ruleClassification(bPath, 'CK-workbench-932')], []);
		expect(() =>
			regenerateCycle(options, {
				beforeMutation(path) {
					if (path === aPath) write(root, path, `${text(root, path)} `);
				}
			})
		).toThrow(/stale byte race/);
		expect(existsSync(join(root, CYCLE_REGENERATE_RECOVERY_PATH))).toBe(true);

		// Restore the exact basis, then let one operation complete and simulate a crash.
		writeJson(root, aPath, rule('CK-workbench-931'));
		let checkpoints = 0;
		expect(() =>
			regenerateCycle(options, {
				checkpoint() {
					checkpoints += 1;
					if (checkpoints === 1) throw new Error('power loss');
				}
			})
		).toThrow(/power loss/);
		const resumed = regenerateCycle(options);
		expect(resumed.resumed).toBe(true);
		expect(JSON.parse(text(root, aPath)).pin).toBe(TARGET_PIN);
		expect(JSON.parse(text(root, bPath)).pin).toBe(TARGET_PIN);
		expect(existsSync(join(root, CYCLE_REGENERATE_RECOVERY_PATH))).toBe(false);
	});

	it('rejects a re-signed arbitrary operation and a chmod race, then preserves the original mode', () => {
		const root = makeTempRoot('cycle-regenerate-plan-trust');
		const path = 'delta/rules/a.ckrule.json';
		writeJson(root, path, rule('CK-workbench-941'));
		const options = input(root, [ruleClassification(path, 'CK-workbench-941')], []);
		const plan = planCycleRegeneration(options);
		const before = Buffer.from('owned\n').toString('base64');
		const injected = resign({
			...plan,
			basis: [
				...plan.basis,
				{ path: 'outside.txt', before, hash: createHash('sha256').update('owned\n').digest('hex'), mode: '100644' as const }
			].sort(byPath),
			operations: [
				...plan.operations,
				{
					path: 'outside.txt',
					action: 'write' as const,
					before,
					beforeMode: '100644' as const,
					after: Buffer.from('changed\n').toString('base64'),
					afterMode: '100644' as const
				}
			].sort(byPath)
		});
		writeJson(root, CYCLE_REGENERATE_RECOVERY_PATH, injected);
		expect(() => regenerateCycle(options)).toThrow(/exact plan derived/);
		expect(existsSync(join(root, 'outside.txt'))).toBe(false);
		unlinkSync(join(root, CYCLE_REGENERATE_RECOVERY_PATH));

		chmodSync(join(root, path), 0o755);
		expect(() => applyCycleRegenerationPlan(options, plan)).toThrow(/mode changed/);
		chmodSync(join(root, path), 0o644);
		regenerateCycle(options);
		expect(statSync(join(root, path)).mode & 0o111).toBe(0);
	});
});

function input(
	root: string,
	classifications: readonly CycleApplyClassification[],
	causes: readonly CycleClassificationCause[]
): CycleRegenerationOptions {
	return { patchesDir: root, type: vscodeType, state: state(), classifications, causes };
}

function state(): CycleState {
	return {
		codkitCycleState: 2,
		sourcePin: { tag: '1.0.0', sha: SOURCE_SHA, date: '2026-01-01' },
		targetPin: { tag: '2.0.0', sha: TARGET_SHA, date: '2026-01-02' },
		branch: 'codkit/cycle/2.0.0',
		startedAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
		phase: 'apply',
		nextAction: 'regenerate',
		transaction: null,
		artifacts: {
			clean: [],
			shifted: [],
			merged: [],
			conflict: [],
			'target-deleted': [],
			'target-renamed': [],
			'rule-broken': [],
			'contract-failed': []
		},
		resolved: [],
		renames: []
	};
}

function patchItem(
	root: string,
	target: string,
	id: string,
	outcome: 'clean' | 'shifted' | 'merged' | 'conflict',
	base: string,
	ours: string,
	result: string
): Extract<CycleApplyClassification, { kind: 'patch' }> {
	const path = `delta/patches/${target.replaceAll('/', '__')}.ckpatch`;
	write(root, path, oldPatch(target, id));
	return {
		kind: 'patch',
		layer: 'patch',
		artifactPath: path,
		artifactId: id,
		targetPath: target,
		outcome,
		bytes: new TextEncoder().encode(result),
		materials: {
			base: new TextEncoder().encode(base),
			baseExists: true,
			ours: new TextEncoder().encode(ours),
			oursExists: true,
			theirs: new TextEncoder().encode('fork\n')
		}
	};
}

function deletedPatchItem(root: string, target: string, id: string): Extract<CycleApplyClassification, { kind: 'patch' }> {
	const path = `delta/patches/${target.replaceAll('/', '__')}.ckpatch`;
	write(root, path, oldPatch(target, id));
	return {
		kind: 'patch',
		layer: 'patch',
		artifactPath: path,
		artifactId: id,
		targetPath: target,
		outcome: 'target-deleted',
		bytes: null,
		materials: null
	};
}

function addPatchItem(root: string, target: string, id: string): Extract<CycleApplyClassification, { kind: 'patch' }> {
	const path = `delta/patches/${target.replaceAll('/', '__')}.ckpatch`;
	write(root, path, `${patchHeader(id)}--- /dev/null\n+++ b/${target}\n@@ -0,0 +1 @@\n+fork\n`);
	return {
		kind: 'patch',
		layer: 'patch',
		artifactPath: path,
		artifactId: id,
		targetPath: target,
		outcome: 'merged',
		bytes: new TextEncoder().encode('fork\n'),
		materials: {
			base: new Uint8Array(0),
			baseExists: false,
			ours: new Uint8Array(0),
			oursExists: true,
			theirs: new TextEncoder().encode('fork\n')
		}
	};
}

function oldPatch(target: string, id: string): string {
	return `${patchHeader(id)}--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-base\n+fork\n`;
}

function patchHeader(id: string): string {
	return formatPatchHeader({
		id,
		type: 'modify',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'fixture patch',
		link: 'none',
		cause: 'none',
		pin: SOURCE_PIN,
		contractTests: []
	});
}

function ruleClassification(path: string, id: string): Extract<CycleApplyClassification, { kind: 'rule' }> {
	return {
		kind: 'rule',
		layer: 'rewrite-rule',
		artifactPath: path,
		artifactId: id,
		targetPath: 'src/rule.ts',
		outcome: 'clean',
		targetBytes: new TextEncoder().encode('anchor\n'),
		matches: { perOp: [1, 0], total: 1 },
		expectedMatches: 1
	};
}

function cause(item: CycleApplyClassification, approx: boolean): CycleClassificationCause {
	return {
		artifactPath: item.artifactPath,
		artifactId: item.artifactId,
		targetPath: item.targetPath,
		outcome: item.outcome,
		cause: { sha: CAUSE_SHA, approx }
	};
}

function rule(id: string): Record<string, unknown> {
	return {
		codkitRule: 2,
		id,
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'fixture rule',
		link: 'none',
		cause: 'none',
		pin: SOURCE_PIN,
		contractTests: [],
		target: 'src/rule.ts',
		engine: 'line-ops',
		expectedMatches: 1,
		ops: [
			{ match: 'anchor', action: 'append-after', text: `// codkit:begin ${id}` },
			{ match: 'never', action: 'append-after', text: `// codkit:end ${id}` }
		]
	};
}

function overlay(id: string): unknown {
	return {
		codkitOverlay: 2,
		id,
		target: 'product.json',
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'fixture overlay',
		link: 'none',
		cause: 'none',
		pin: SOURCE_PIN,
		contractTests: ['overlay.guard'],
		operations: [{ op: 'set', path: ['nameShort'], value: 'PatchSet', expectUpstream: 'Code - OSS' }]
	};
}

function resource(id: string, source: string): unknown {
	return {
		id,
		target: 'resources/logo.bin',
		source,
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'fixture resource',
		link: 'none',
		cause: 'none',
		pin: SOURCE_PIN,
		contractTests: ['resource.guard']
	};
}

function own(id: string): unknown {
	return {
		id,
		layer: 'own',
		type: 'extend',
		category: 'own',
		owner: 'workbench-core',
		reason: 'fixture own',
		link: 'none',
		cause: 'none',
		pin: SOURCE_PIN,
		contractTests: [],
		roots: ['main.ts']
	};
}

function service(id: string): unknown {
	return {
		id,
		serviceId: 'ITestService',
		module: 'main.ts',
		owner: 'platform',
		reason: 'fixture service override',
		link: 'none',
		cause: 'none',
		pin: SOURCE_PIN,
		contractTests: ['service.guard']
	};
}

function removed(id: string): unknown {
	return {
		id,
		kind: 'dependency',
		target: 'unused',
		how: 'rule',
		owner: 'build',
		reason: 'fixture removed',
		link: 'none',
		pin: SOURCE_PIN,
		contractTests: ['removed.guard']
	};
}

function writeJson(root: string, path: string, value: unknown): void {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}
function write(root: string, path: string, value: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, value);
}
function text(root: string, path: string): string {
	return readFileSync(join(root, ...path.split('/')), 'utf8');
}
function bytes(root: string, path: string): Buffer {
	return readFileSync(join(root, ...path.split('/')));
}
function byArtifact(left: { artifactPath: string }, right: { artifactPath: string }): number {
	return Buffer.from(left.artifactPath).compare(Buffer.from(right.artifactPath));
}

function byPath(left: { path: string }, right: { path: string }): number {
	return Buffer.from(left.path).compare(Buffer.from(right.path));
}

function resign(plan: CycleRegenerationPlan): CycleRegenerationPlan {
	const { digest: _old, ...body } = plan;
	return { ...plan, digest: createHash('sha256').update(JSON.stringify(body)).digest('hex') };
}
