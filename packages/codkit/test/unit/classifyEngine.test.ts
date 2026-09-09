// unit: PROP-008 sec. 5 patch outcome matrix and PROP-013 ##UT-CLASSIFY.
// Classification reads git objects and uses merge-file scratch files; the
// fixture repository's work tree, index, and refs must remain untouched.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeUtf8Strict, encodeUtf8 } from '../../src/lib/bytes.ts';
import { classifyArtifacts, classifyPatchArtifact, classifyPatchArtifacts } from '../../src/lib/classifyEngine.ts';
import type { ClassificationArtifact, PatchClassification, PatchClassificationArtifact } from '../../src/lib/classifyEngine.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { parseOverlay } from '../../src/lib/layers/overlay.ts';
import type { Overlay } from '../../src/lib/layers/overlay.ts';
import { parseRule } from '../../src/lib/layers/rule.ts';
import type { Rule } from '../../src/lib/layers/rule.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const CLEAN = 'source/classify/clean.ts';
const SHIFTED = 'source/classify/shifted.ts';
const MERGED = 'source/classify/merged.ts';
const CONFLICT = 'source/classify/conflict.ts';
const DELETED = 'source/classify/deleted.ts';
const ADDED = 'source/classify/added.ts';
const BINARY_ADDED = 'source/classify/binary-added.ts';
const RULE_TARGET = 'source/classify/rule-target.ts';
const OVERLAY_TARGET = 'manifest.json';
const RENAMED_CLEAN_OLD = 'source/classify/renamed-clean-old.ts';
const RENAMED_CLEAN_NEW = 'source/classify/renamed-clean-new.ts';
const RENAMED_SHIFTED_OLD = 'source/classify/renamed-shifted-old.ts';
const RENAMED_SHIFTED_NEW = 'source/classify/renamed-shifted-new.ts';

type Fixture = {
	readonly dir: string;
	readonly oldPin: string;
	readonly newRef: string;
	readonly artifacts: Readonly<Record<string, PatchClassificationArtifact>>;
};

function makeFixture(): Fixture {
	const dir = makeTempRoot('classify-engine');
	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	for (const path of [CLEAN, SHIFTED, MERGED, CONFLICT, DELETED, RENAMED_CLEAN_OLD, RENAMED_SHIFTED_OLD]) {
		write(dir, path, 'a\nbase\nz\n');
	}
	write(dir, RULE_TARGET, 'anchor\nstable\n');
	write(dir, OVERLAY_TARGET, '{"name":"old","keep":true}\n');
	const oldPin = fixtureCommit(dir, 'fixture: old classification pin', '2026-01-01T01:00:00Z');

	write(dir, SHIFTED, 'a\nbase\nz\nupstream-tail\n');
	write(dir, MERGED, 'prefix\na\nbase\nz\n');
	write(dir, CONFLICT, 'a\nupstream\nz\n');
	write(dir, RULE_TARGET, 'upstream-anchor\nstable\n');
	write(dir, OVERLAY_TARGET, '{"name":"new","keep":true}\n');
	writeBytes(dir, BINARY_ADDED, new Uint8Array([0x00, 0xff, 0x0a]));
	fixtureGit(dir, ['mv', RENAMED_CLEAN_OLD, RENAMED_CLEAN_NEW]);
	fixtureGit(dir, ['mv', RENAMED_SHIFTED_OLD, RENAMED_SHIFTED_NEW]);
	write(dir, RENAMED_SHIFTED_NEW, 'a\nbase\nz\nupstream-tail\n');
	rmSync(join(dir, DELETED));
	const newRef = fixtureCommit(dir, 'fixture: new classification ref', '2026-01-01T01:01:00Z');

	return {
		dir,
		oldPin,
		newRef,
		artifacts: {
			clean: artifact(CLEAN, 'CK-shell-101', oldPin),
			shifted: artifact(SHIFTED, 'CK-shell-102', oldPin),
			merged: artifact(MERGED, 'CK-shell-103', oldPin),
			conflict: artifact(CONFLICT, 'CK-shell-104', oldPin),
			deleted: artifact(DELETED, 'CK-shell-105', oldPin),
			added: addFileArtifact(ADDED, 'CK-shell-106', oldPin),
			renamedClean: artifact(RENAMED_CLEAN_OLD, 'CK-shell-114', oldPin),
			renamedShifted: artifact(RENAMED_SHIFTED_OLD, 'CK-shell-115', oldPin)
		}
	};
}

function artifact(targetPath: string, id: string, oldPin: string): PatchClassificationArtifact {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'exercise one normative patch classification outcome',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
		contractTests: []
	});
	const artifactPath = `delta/patches/${targetPath.replaceAll('/', '__')}.ckpatch`;
	const body = [`--- a/${targetPath}`, `+++ b/${targetPath}`, '@@ -1,3 +1,3 @@', ' a', '-base', '+codkit', ' z'].join('\n');
	return {
		artifactPath,
		patch: parseCkpatch(encodeUtf8(`${header}${body}\n`), conventions(), artifactPath)
	};
}

function addFileArtifact(targetPath: string, id: string, oldPin: string): PatchClassificationArtifact {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'exercise an add-file patch across an upgrade',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
		contractTests: []
	});
	const artifactPath = `delta/patches/${targetPath.replaceAll('/', '__')}.ckpatch`;
	const body = ['--- /dev/null', `+++ b/${targetPath}`, '@@ -0,0 +1,2 @@', '+created', '+by-codkit'].join('\n');
	return {
		artifactPath,
		patch: parseCkpatch(encodeUtf8(`${header}${body}\n`), conventions(), artifactPath)
	};
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function writeBytes(root: string, path: string, contents: Uint8Array): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function ruleArtifact(targetPath: string, id: string, oldPin: string, match: string): Rule {
	return parseRule(
		{
			codkitRule: 2,
			id,
			type: 'hook',
			category: 'follow',
			owner: 'shell-core',
			reason: 'classify a real rewrite-rule match count at the new ref',
			link: 'none',
			cause: 'none',
			pin: `t1@${oldPin}`,
			contractTests: [],
			target: targetPath,
			engine: 'line-ops',
			expectedMatches: 1,
			ops: [
				{ match, action: 'append-after', text: `// codkit:begin ${id}` },
				{ match: `// codkit:begin ${id}`, action: 'append-after', text: `// codkit:end ${id}` }
			]
		},
		`delta/rules/${id}.ckrule.json`
	);
}

function overlayArtifact(id: string, oldPin: string, path: string, expectUpstream: unknown): Overlay {
	return parseOverlay(
		{
			codkitOverlay: 2,
			id,
			target: OVERLAY_TARGET,
			type: 'modify',
			category: 'own',
			owner: 'product',
			reason: 'classify config-overlay drift at the new ref',
			link: 'none',
			cause: 'none',
			pin: `t1@${oldPin}`,
			contractTests: ['fixture.guard.overlay'],
			operations: [{ op: 'set', path: [path], value: 'patchset', expectUpstream }]
		},
		`delta/overlays/${id}.overlay.json`
	);
}

function caught(run: () => unknown): { readonly code: string; readonly message: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return { code: error.code, message: error.message };
		}
		throw error;
	}
	throw new Error('expected classification to fail');
}

function classify(fixture: Fixture, key: string): PatchClassification {
	const selected = fixture.artifacts[key];
	if (selected === undefined) {
		throw new Error(`missing classification fixture ${key}`);
	}
	return classifyPatchArtifact({
		treeDir: fixture.dir,
		artifact: selected,
		oldPin: fixture.oldPin,
		newRef: fixture.newRef
	});
}

function text(bytes: Uint8Array | null): string | null {
	if (bytes === null) {
		return null;
	}
	const decoded = decodeUtf8Strict(bytes);
	if (decoded === null) {
		throw new Error('classifier returned non-UTF-8 fixture bytes');
	}
	return decoded;
}

describe('classifyPatchArtifact', () => {
	let fixture: Fixture;

	beforeAll(() => {
		fixture = makeFixture();
	});

	afterAll(() => {
		cleanupTempRoots();
	});

	it('classifies an unchanged upstream target as clean', () => {
		const result = classify(fixture, 'clean');

		expect(result.outcome).toBe('clean');
		expect(text(result.bytes)).toBe('a\ncodkit\nz\n');
		expect(result.materials === null ? null : text(result.materials.ours)).toBe('a\nbase\nz\n');
		expect(result.materials).toMatchObject({ baseExists: true, oursExists: true });
	});

	it('classifies an exact application after a non-overlapping upstream edit as shifted', () => {
		const result = classify(fixture, 'shifted');

		expect(result.outcome).toBe('shifted');
		expect(text(result.bytes)).toBe('a\ncodkit\nz\nupstream-tail\n');
	});

	it('reads a renamed patch base from its old path and reports the current path as clean', () => {
		const selected = fixture.artifacts['renamedClean'];
		if (selected === undefined) {
			throw new Error('missing clean rename fixture');
		}

		const result = classifyPatchArtifact({
			treeDir: fixture.dir,
			artifact: selected,
			oldPin: fixture.oldPin,
			newRef: fixture.newRef,
			baseTargetPath: RENAMED_CLEAN_OLD,
			newTargetPath: RENAMED_CLEAN_NEW
		});

		expect(result.outcome).toBe('clean');
		expect(result.targetPath).toBe(RENAMED_CLEAN_NEW);
		expect(text(result.bytes)).toBe('a\ncodkit\nz\n');
		expect(result.materials === null ? null : text(result.materials.base)).toBe('a\nbase\nz\n');
	});

	it('classifies a renamed target with a non-overlapping upstream edit as shifted', () => {
		const selected = fixture.artifacts['renamedShifted'];
		if (selected === undefined) {
			throw new Error('missing shifted rename fixture');
		}

		const result = classifyPatchArtifact({
			treeDir: fixture.dir,
			artifact: selected,
			oldPin: fixture.oldPin,
			newRef: fixture.newRef,
			baseTargetPath: RENAMED_SHIFTED_OLD,
			newTargetPath: RENAMED_SHIFTED_NEW
		});

		expect(result.outcome).toBe('shifted');
		expect(result.targetPath).toBe(RENAMED_SHIFTED_NEW);
		expect(text(result.bytes)).toBe('a\ncodkit\nz\nupstream-tail\n');
	});

	it('classifies a clean 3-way result that cannot apply exactly as merged', () => {
		const result = classify(fixture, 'merged');

		expect(result.outcome).toBe('merged');
		expect(text(result.bytes)).toBe('prefix\na\ncodkit\nz\n');
	});

	it('returns diff3 conflict bytes as a conflict outcome', () => {
		const result = classify(fixture, 'conflict');
		const bytes = text(result.bytes);

		expect(result.outcome).toBe('conflict');
		expect(bytes).toContain('<<<<<<< ours\n');
		expect(bytes).toContain('||||||| base\n');
		expect(bytes).toContain('>>>>>>> theirs\n');
		expect(bytes).toContain('upstream');
		expect(bytes).toContain('codkit');
	});

	it('classifies an absent new-ref target before attempting a merge', () => {
		const selected = fixture.artifacts['deleted'];
		if (selected === undefined) {
			throw new Error('missing deleted fixture');
		}
		const result = classifyPatchArtifact({
			treeDir: fixture.dir,
			artifact: selected,
			oldPin: fixture.oldPin,
			newRef: fixture.newRef,
			mergeFile: () => {
				throw new Error('target-deleted must not invoke merge-file');
			}
		});

		expect(result).toMatchObject({ outcome: 'target-deleted', bytes: null, materials: null, targetPath: DELETED });
	});

	it('treats a still-absent add-file target as a clean empty-base application', () => {
		const result = classify(fixture, 'added');

		expect(result.outcome).toBe('clean');
		expect(text(result.bytes)).toBe('created\nby-codkit\n');
		expect(result.materials === null ? null : text(result.materials.base)).toBe('');
		expect(result.materials === null ? null : text(result.materials.ours)).toBe('');
		expect(result.materials).toMatchObject({ baseExists: false, oursExists: false });
	});

	it('validates an edit target at the old pin before treating new-ref absence as deletion', () => {
		const missing = artifact('source/classify/missing-at-both-pins.ts', 'CK-shell-107', fixture.oldPin);

		const failure = caught(() =>
			classifyPatchArtifact({ treeDir: fixture.dir, artifact: missing, oldPin: fixture.oldPin, newRef: fixture.newRef })
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain(`does not exist at old pin ${fixture.oldPin}`);
	});

	it('rejects an unsafe rename mapping before reading either ref', () => {
		const selected = fixture.artifacts['renamedClean'];
		if (selected === undefined) {
			throw new Error('missing unsafe-mapping fixture');
		}

		const failure = caught(() =>
			classifyPatchArtifact({
				treeDir: fixture.dir,
				artifact: selected,
				oldPin: fixture.oldPin,
				newRef: fixture.newRef,
				baseTargetPath: '../outside.ts',
				newTargetPath: RENAMED_CLEAN_NEW
			})
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain('baseTargetPath');
		expect(failure.message).toContain('must not contain');
	});

	it('fails on a mapped old path that is absent even when the current path exists', () => {
		const selected = fixture.artifacts['renamedClean'];
		if (selected === undefined) {
			throw new Error('missing old-path mapping fixture');
		}
		const missingOld = 'source/classify/not-the-old-name.ts';

		const failure = caught(() =>
			classifyPatchArtifact({
				treeDir: fixture.dir,
				artifact: selected,
				oldPin: fixture.oldPin,
				newRef: fixture.newRef,
				baseTargetPath: missingOld,
				newTargetPath: RENAMED_CLEAN_NEW
			})
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain(`${missingOld} does not exist at old pin ${fixture.oldPin}`);
	});

	it('refuses an add-file patch whose target already exists at the old pin', () => {
		const invalid = addFileArtifact(CLEAN, 'CK-shell-108', fixture.oldPin);

		const failure = caught(() =>
			classifyPatchArtifact({ treeDir: fixture.dir, artifact: invalid, oldPin: fixture.oldPin, newRef: fixture.newRef })
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain(`already exists at old pin ${fixture.oldPin}`);
	});

	it('preserves raw blob bytes when upstream independently adds an add-file target', () => {
		const selected = addFileArtifact(BINARY_ADDED, 'CK-shell-109', fixture.oldPin);
		let seenOurs: Uint8Array | null = null;

		const result = classifyPatchArtifact({
			treeDir: fixture.dir,
			artifact: selected,
			oldPin: fixture.oldPin,
			newRef: fixture.newRef,
			mergeFile: (request) => {
				seenOurs = request.ours;
				return { bytes: request.ours, hasConflicts: true };
			}
		});

		expect(result.outcome).toBe('conflict');
		expect(Array.from(seenOurs ?? [])).toEqual([0x00, 0xff, 0x0a]);
		expect(Array.from(result.materials?.ours ?? [])).toEqual([0x00, 0xff, 0x0a]);
	});

	it('fails loudly when a listed blob cannot be read from the object database', () => {
		const damaged = makeFixture();
		const selected = damaged.artifacts['clean'];
		if (selected === undefined) {
			throw new Error('missing damaged-repository artifact');
		}
		const objectId = runGit({ args: ['rev-parse', `${damaged.oldPin}:${CLEAN}`], cwd: damaged.dir }).stdout.trim();
		rmSync(join(damaged.dir, '.git', 'objects', objectId.slice(0, 2), objectId.slice(2)));

		const failure = caught(() =>
			classifyPatchArtifact({ treeDir: damaged.dir, artifact: selected, oldPin: damaged.oldPin, newRef: damaged.newRef })
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain(`cannot read blob ${objectId}`);
		expect(failure.message).toContain(`at ${damaged.oldPin}`);
	});

	it('classifies the full list after an earlier conflict without mutating the repository', () => {
		const conflict = fixture.artifacts['conflict'];
		const clean = fixture.artifacts['clean'];
		if (conflict === undefined || clean === undefined) {
			throw new Error('missing batch fixture');
		}
		const headBefore = runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.dir }).stdout;
		const statusBefore = runGit({ args: ['status', '--porcelain'], cwd: fixture.dir }).stdout;

		const results = classifyPatchArtifacts({
			treeDir: fixture.dir,
			artifacts: [conflict, clean],
			oldPin: fixture.oldPin,
			newRef: fixture.newRef
		});

		expect(results.map((result) => result.outcome)).toEqual(['conflict', 'clean']);
		expect(results).toHaveLength(2);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixture.dir }).stdout).toBe(headBefore);
		expect(runGit({ args: ['status', '--porcelain'], cwd: fixture.dir }).stdout).toBe(statusBefore);
	});

	it('returns one full discriminated list for patch, rule, and overlay outcomes', () => {
		const conflict = fixture.artifacts['conflict'];
		const clean = fixture.artifacts['clean'];
		const renamed = fixture.artifacts['renamedClean'];
		if (conflict === undefined || clean === undefined || renamed === undefined) {
			throw new Error('missing aggregate patch fixtures');
		}
		const artifacts: ClassificationArtifact[] = [
			{ kind: 'patch', ...conflict },
			{ kind: 'rule', rule: ruleArtifact(RULE_TARGET, 'CK-shell-110', fixture.oldPin, 'anchor') },
			{ kind: 'overlay', overlay: overlayArtifact('CK-product-111', fixture.oldPin, 'name', 'old') },
			{ kind: 'rule', rule: ruleArtifact(RULE_TARGET, 'CK-shell-112', fixture.oldPin, 'stable') },
			{ kind: 'overlay', overlay: overlayArtifact('CK-product-113', fixture.oldPin, 'keep', true) },
			{ kind: 'patch', ...clean },
			{
				kind: 'patch',
				...renamed,
				baseTargetPath: RENAMED_CLEAN_OLD,
				newTargetPath: RENAMED_CLEAN_NEW
			}
		];

		const results = classifyArtifacts({
			type: stubProjectType,

			treeDir: fixture.dir,
			artifacts,
			oldPin: fixture.oldPin,
			newRef: fixture.newRef
		});

		expect(results.map((result) => [result.kind, result.layer, result.outcome])).toEqual([
			['patch', 'patch', 'conflict'],
			['rule', 'rewrite-rule', 'rule-broken'],
			['overlay', 'config-overlay', 'conflict'],
			['rule', 'rewrite-rule', 'clean'],
			['overlay', 'config-overlay', 'clean'],
			['patch', 'patch', 'clean'],
			['patch', 'patch', 'clean']
		]);
		const brokenRule = results[1];
		const driftedOverlay = results[2];
		const cleanPatch = results[5];
		const renamedPatch = results[6];
		if (
			brokenRule?.kind !== 'rule' ||
			driftedOverlay?.kind !== 'overlay' ||
			cleanPatch?.kind !== 'patch' ||
			renamedPatch?.kind !== 'patch'
		) {
			throw new Error('aggregate result discriminants are out of order');
		}
		expect(brokenRule.matches).toEqual({ perOp: [0, 0], total: 0 });
		expect(brokenRule.expectedMatches).toBe(1);
		expect(driftedOverlay.report?.drift).toHaveLength(1);
		expect(text(cleanPatch.bytes)).toBe('a\ncodkit\nz\n');
		expect(renamedPatch.targetPath).toBe(RENAMED_CLEAN_NEW);
		expect(text(renamedPatch.bytes)).toBe('a\ncodkit\nz\n');
		expect(results).toHaveLength(artifacts.length);
	});
});
