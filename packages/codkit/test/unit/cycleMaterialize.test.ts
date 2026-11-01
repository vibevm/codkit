// unit: a real target-pin repository exercises provisional cycle materialization.

import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { classifyArtifacts } from '../../src/lib/classifyEngine.ts';
import type { ArtifactClassification, ClassificationArtifact } from '../../src/lib/classifyEngine.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { materializeCycleApply } from '../../src/lib/cycleMaterialize.ts';
import type { CycleMaterializeOptions } from '../../src/lib/cycleMaterialize.ts';
import { CYCLE_MATERIALIZE_RECORD_PATH } from '../../src/lib/cycleMaterializeMove.ts';
import type { CycleMaterializeMoveCheckpoint } from '../../src/lib/cycleMaterializeMove.ts';
import { runGit, runGitBytes } from '../../src/lib/gitx.ts';
import { writeInputStore } from '../../src/lib/inputsStore.ts';
import type { InputConfig } from '../../src/lib/configFile.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { parseOverlay } from '../../src/lib/layers/overlay.ts';
import { parseRule } from '../../src/lib/layers/rule.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { formatPatchHeader, parseCkpatch } from '../../src/lib/patchFormat.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import { fixtureCommit, fixtureGit, writeFingerprintFiles } from '../fixtures/makeUpstream.ts';
import { conventions } from '../support/conventions.ts';
import { writeOwnManifestFixture } from '../support/ownManifestFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const CLEAN = 'src/clean.ts';
const MERGED = 'src/merged.ts';
const CONFLICT = 'src/conflict.ts';
const CONFLICT_TWO = 'src/conflict-two.ts';
const DELETED = 'src/deleted.ts';
const RULE_CLEAN = 'src/rule-clean.ts';
const RULE_BROKEN = 'src/rule-broken.ts';
const OVERLAY_CLEAN = 'config/clean.json';
const OVERLAY_BROKEN = 'config/broken.json';
const RESOURCE = 'resources/icon.bin';
const MODE_ONLY = 'scripts/mode-only.sh';

type Fixture = {
	readonly patchesDir: string;
	readonly tree: string;
	readonly oldPin: string;
	readonly targetPin: string;
	readonly config: CodkitConfig;
	readonly sourcePin: CodkitConfig['pin'];
	readonly resolution: ForkDirResolution;
	readonly classifications: readonly ArtifactClassification[];
	readonly output: Output;
};

function fixture(): Fixture {
	const tree = makeTempRoot('cycle-materialize-tree');
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	writeFingerprintFiles(tree);
	write(tree, CLEAN, 'a\nbase\nz\n');
	write(tree, MERGED, 'a\nbase\nz\n');
	write(tree, CONFLICT, 'a\nbase\nz\n');
	write(tree, CONFLICT_TWO, 'a\nbase\nz\n');
	write(tree, DELETED, 'obsolete\nbase\n');
	write(tree, RULE_CLEAN, 'anchor\nstable\n');
	write(tree, RULE_BROKEN, 'old-anchor\nstable\n');
	write(tree, OVERLAY_CLEAN, '{"name":"old","keep":true}\n');
	write(tree, OVERLAY_BROKEN, '{"name":"old","keep":true}\n');
	writeBytes(tree, RESOURCE, new Uint8Array([0x01, 0x02, 0x03]));
	write(tree, MODE_ONLY, '#!/bin/sh\necho stable\n');
	chmodSync(join(tree, RESOURCE), 0o755);
	fixtureGit(tree, ['add', '--', RESOURCE]);
	fixtureGit(tree, ['update-index', '--chmod=+x', '--', RESOURCE]);
	const oldPin = fixtureCommit(tree, 'fixture: old cycle pin', '2026-03-01T00:00:00Z');

	write(tree, MERGED, 'prefix\na\nbase\nz\n');
	write(tree, CONFLICT, 'a\nupstream\nz\n');
	write(tree, CONFLICT_TWO, 'a\nsecond-upstream\nz\n');
	write(tree, RULE_BROKEN, 'new-anchor\nstable\n');
	write(tree, OVERLAY_BROKEN, '{"name":"new","keep":true}\n');
	rmSync(join(tree, DELETED));
	chmodSync(join(tree, MODE_ONLY), 0o755);
	fixtureGit(tree, ['add', '--', MODE_ONLY]);
	fixtureGit(tree, ['update-index', '--chmod=+x', '--', MODE_ONLY]);
	const targetPin = fixtureCommit(tree, 'fixture: target cycle pin', '2026-03-01T00:01:00Z');
	fixtureGit(tree, ['switch', '--quiet', '--detach', oldPin]);

	const patchesDir = makeTempRoot('cycle-materialize-patchset');
	copyConventions(patchesDir);
	const patchArtifacts = [
		patch(patchesDir, CLEAN, 'CK-shell-201', oldPin, 'base', 'codkit'),
		patch(patchesDir, MERGED, 'CK-shell-202', oldPin, 'base', 'codkit'),
		patch(patchesDir, CONFLICT, 'CK-shell-203', oldPin, 'base', 'codkit'),
		patch(patchesDir, CONFLICT_TWO, 'CK-shell-207', oldPin, 'base', 'second-codkit'),
		patch(patchesDir, DELETED, 'CK-shell-204', oldPin, 'base', 'codkit')
	];
	const cleanRule = rule(patchesDir, RULE_CLEAN, 'CK-shell-205', oldPin, 'anchor');
	const brokenRule = rule(patchesDir, RULE_BROKEN, 'CK-shell-206', oldPin, 'old-anchor');
	const cleanOverlay = overlay(patchesDir, OVERLAY_CLEAN, 'CK-product-201', oldPin, 'old');
	const brokenOverlay = overlay(patchesDir, OVERLAY_BROKEN, 'CK-product-202', oldPin, 'old');
	writeResourceAndOwn(patchesDir, oldPin);
	fixtureGit(patchesDir, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureCommit(patchesDir, 'fixture: complete cycle delta', '2026-03-02T00:00:00Z');

	const artifacts: ClassificationArtifact[] = [
		...patchArtifacts.map((artifact) => ({ kind: 'patch' as const, ...artifact })),
		{ kind: 'rule', rule: cleanRule },
		{ kind: 'rule', rule: brokenRule },
		{ kind: 'overlay', overlay: cleanOverlay },
		{ kind: 'overlay', overlay: brokenOverlay }
	];
	const classifications = classifyArtifacts({ type: stubProjectType, treeDir: tree, artifacts, oldPin, newRef: targetPin });
	const config: CodkitConfig = {
		codkitConfig: 2,
		pin: { tag: 't2', sha: targetPin, date: '2026-03-01' },
		upstreamAnchorCommit: oldPin,
		type: 'stub',
		typeConfig: { ownRoot: 'source/own' },
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	};
	return {
		patchesDir,
		tree,
		oldPin,
		targetPin,
		config,
		sourcePin: { tag: 't1', sha: oldPin, date: '2026-03-01' },
		resolution: { path: tree, source: 'flag', exists: true, warning: null },
		classifications,
		output: new Output({ command: 'cycle continue', version: '0.0.0', jsonMode: false, streams: { writeOut() {}, writeErr() {} } })
	};
}

function patch(patchesDir: string, target: string, id: string, oldPin: string, before: string, after: string) {
	const header = formatPatchHeader({
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'exercise provisional cycle materialization',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
		contractTests: []
	});
	const artifactPath = `delta/patches/${id}.ckpatch`;
	const body = [`--- a/${target}`, `+++ b/${target}`, '@@ -1,3 +1,3 @@', ' a', `-${before}`, `+${after}`, ' z'].join('\n');
	const bytes = encodeUtf8(`${header}${body}\n`);
	writeBytes(patchesDir, artifactPath, bytes);
	return { artifactPath, patch: parseCkpatch(bytes, conventions(), artifactPath) };
}

function rule(patchesDir: string, target: string, id: string, oldPin: string, match: string) {
	const artifactPath = `delta/rules/${id}.ckrule.json`;
	const raw = {
		codkitRule: 2,
		id,
		type: 'hook',
		category: 'follow',
		owner: 'shell-core',
		reason: 'guard a generated patch',
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
	};
	writeJson(patchesDir, artifactPath, raw);
	return parseRule(raw, artifactPath);
}

function overlay(patchesDir: string, target: string, id: string, oldPin: string, expected: string) {
	const artifactPath = `delta/overlays/${id}.overlay.json`;
	const raw = {
		codkitOverlay: 2,
		id,
		target,
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'exercise provisional overlay materialization',
		link: 'none',
		cause: 'none',
		pin: `t1@${oldPin}`,
		contractTests: ['fixture.overlay'],
		operations: [{ op: 'set', path: ['name'], value: 'patchset', expectUpstream: expected }]
	};
	writeJson(patchesDir, artifactPath, raw);
	return parseOverlay(raw, artifactPath);
}

function writeResourceAndOwn(patchesDir: string, oldPin: string): void {
	writeBytes(patchesDir, 'delta/resources/files/icon.bin', new Uint8Array([0x00, 0xff, 0x0a, 0x7f]));
	writeJson(patchesDir, 'delta/resources/map.json', {
		codkitResourceMap: 2,
		entries: [
			{
				id: 'CK-product-203',
				target: RESOURCE,
				source: 'delta/resources/files/icon.bin',
				type: 'modify',
				category: 'own',
				owner: 'product',
				reason: 'binary resource fixture',
				link: 'none',
				cause: 'none',
				pin: `t1@${oldPin}`,
				contractTests: ['fixture.resource']
			}
		]
	});
	write(patchesDir, 'delta/own/hello.ts', 'export const hello = true;\n');
	writeOwnManifestFixture(patchesDir, `t1@${oldPin}`, ['hello.ts']);
}

function copyConventions(patchesDir: string): void {
	const destination = join(patchesDir, 'codkit/config/conventions.json');
	mkdirSync(dirname(destination), { recursive: true });
	copyFileSync(fileURLToPath(new URL('../../config/conventions.json', import.meta.url)), destination);
}

function write(root: string, path: string, contents: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function writeBytes(root: string, path: string, contents: Uint8Array): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, contents);
}

function writeJson(root: string, path: string, value: unknown): void {
	write(root, path, `${JSON.stringify(value, null, 2)}\n`);
}

function blob(tree: string, ref: string, path: string): Uint8Array {
	const result = runGitBytes({ args: ['show', `${ref}:${path}`], cwd: tree });
	if (result.status !== 0) throw new Error(`missing fixture blob ${path}`);
	return result.stdout;
}

function codeOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) return error.code;
		throw error;
	}
	throw new Error('expected a codkit error');
}

function materialize(current: Fixture, overrides: Partial<Pick<CycleMaterializeOptions, 'classifications' | 'checkpoint'>> = {}) {
	return materializeCycleApply({
		patchesDir: current.patchesDir,
		resolution: current.resolution,
		config: current.config,
		type: stubProjectType,
		sourcePin: current.sourcePin,
		classifications: overrides.classifications ?? current.classifications,
		out: current.output,
		...(overrides.checkpoint === undefined ? {} : { checkpoint: overrides.checkpoint })
	});
}

function provisionalRef(current: Fixture): string {
	return runGit({ args: ['show-ref', '--verify', '--hash', 'refs/heads/codkit/cycle/t2-provisional'], cwd: current.tree }).stdout.trim();
}

function looseObjectCount(current: Fixture): string {
	return (
		runGit({ args: ['count-objects', '-v'], cwd: current.tree })
			.stdout.split('\n')
			.find((line) => line.startsWith('count: ')) ?? ''
	);
}

function collidingResourceMap(current: Fixture): void {
	writeJson(current.patchesDir, 'delta/resources/map.json', {
		codkitResourceMap: 2,
		entries: [
			{
				id: 'CK-product-203',
				target: CLEAN,
				source: 'delta/resources/files/icon.bin',
				type: 'modify',
				category: 'own',
				owner: 'product',
				reason: 'collision fixture',
				link: 'none',
				cause: 'none',
				pin: `t1@${current.oldPin}`,
				contractTests: ['fixture.resource']
			}
		]
	});
}

describe('materializeCycleApply', () => {
	afterAll(cleanupTempRoots);
	it('excludes delivered own code in the provisional checkout', () => {
		const current = fixture();
		materializeCycleApply({
			patchesDir: current.patchesDir,
			resolution: current.resolution,
			config: current.config,
			type: stubProjectType,
			sourcePin: current.sourcePin,
			classifications: current.classifications,
			out: current.output
		});
		expect(readFileSync(join(current.tree, 'source/own/hello.ts'), 'utf8')).toContain('hello');
		expect(runGit({ args: ['check-ignore', 'source/own/hello.ts'], cwd: current.tree }).status).toBe(0);
		expect(runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: current.tree }).stdout).not.toContain('source/own/');
	}, 90_000);

	it('hides the directories of the inputs as load does and accepts their exact deliveries (##INPUTS-LOAD)', () => {
		const current = fixture();
		const delivered = 'delivered by load\n';
		write(current.tree, 'documentation/doc.md', delivered);
		const blob = runGit({ args: ['hash-object', '--stdin'], cwd: current.tree, input: delivered }).stdout.trim();
		writeInputStore(current.tree, [
			{ name: 'docs', to: 'documentation', mode: 'working', commit: null, stamp: '0'.repeat(64), files: { 'doc.md': blob } }
		]);
		const config: CodkitConfig = { ...current.config, inputs: [{ name: 'docs', to: 'documentation' } as InputConfig] };
		materializeCycleApply({
			patchesDir: current.patchesDir,
			resolution: current.resolution,
			config,
			type: stubProjectType,
			sourcePin: current.sourcePin,
			classifications: current.classifications,
			out: current.output
		});
		expect(readFileSync(join(current.tree, 'documentation/doc.md'), 'utf8')).toBe(delivered);
		expect(runGit({ args: ['check-ignore', 'documentation/doc.md'], cwd: current.tree }).status).toBe(0);
		expect(runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: current.tree }).stdout).not.toContain('documentation/');
	}, 90_000);

	it('preflights without mutation, builds the complete provisional tip, and retries byte-identically', () => {
		const current = fixture();
		fixtureGit(current.tree, ['branch', 'codkit/applied/t2', current.oldPin]);
		write(current.tree, 'unknown.txt', 'do not overwrite\n');
		const beforeHead = runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim();
		expect(
			codeOf(() =>
				materializeCycleApply({
					patchesDir: current.patchesDir,
					resolution: current.resolution,
					config: current.config,
					type: stubProjectType,
					sourcePin: current.sourcePin,
					classifications: current.classifications,
					out: current.output
				})
			)
		).toBe('DIRTY-TREE');
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim()).toBe(beforeHead);
		expect(runGit({ args: ['show-ref', '--verify', '--quiet', 'refs/heads/codkit/cycle/t2-provisional'], cwd: current.tree }).status).toBe(
			1
		);
		expect(readFileSync(join(current.tree, 'unknown.txt'), 'utf8')).toBe('do not overwrite\n');
		rmSync(join(current.tree, 'unknown.txt'));

		const first = materializeCycleApply({
			patchesDir: current.patchesDir,
			resolution: current.resolution,
			config: current.config,
			type: stubProjectType,
			sourcePin: current.sourcePin,
			classifications: current.classifications,
			out: current.output
		});
		expect(first.branch).toBe('codkit/cycle/t2-provisional');
		expect(runGit({ args: ['check-ignore', 'source/own/owned.ts'], cwd: current.tree }).status).toBe(0);
		expect(first.provisionalTip).toMatch(/^[0-9a-f]{40}$/);
		expect(runGit({ args: ['branch', '--show-current'], cwd: current.tree }).stdout.trim()).toBe(first.branch);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim()).toBe(first.provisionalTip);
		expect(
			runGit({ args: ['rev-list', '--count', `${current.targetPin}..${first.provisionalTip}`], cwd: current.tree }).stdout.trim()
		).toBe('6');
		expect(first.blockers.map((entry) => [entry.outcome, entry.artifactId])).toEqual([
			['conflict', 'CK-product-202'],
			['conflict', 'CK-shell-203'],
			['target-deleted', 'CK-shell-204'],
			['conflict', 'CK-shell-207'],
			['rule-broken', 'CK-shell-206']
		]);

		const conflict = readFileSync(join(current.tree, CONFLICT), 'utf8');
		expect(conflict).toContain('<<<<<<< ours\n');
		expect(conflict).toContain('||||||| base\n');
		expect(conflict).toContain('>>>>>>> theirs\n');
		expect(readFileSync(join(current.tree, CONFLICT_TWO), 'utf8')).toContain('<<<<<<< ours\n');
		expect(Buffer.from(blob(current.tree, first.provisionalTip, CONFLICT)).toString()).toBe('a\nupstream\nz\n');
		expect(Buffer.from(blob(current.tree, first.provisionalTip, CLEAN)).toString()).toBe('a\ncodkit\nz\n');
		expect(Buffer.from(blob(current.tree, first.provisionalTip, MERGED)).toString()).toBe('prefix\na\ncodkit\nz\n');
		expect(Buffer.from(blob(current.tree, first.provisionalTip, OVERLAY_CLEAN)).toString()).toContain('"name": "patchset"');
		expect(Buffer.from(blob(current.tree, first.provisionalTip, OVERLAY_BROKEN)).toString()).toContain('"name":"new"');
		expect(Array.from(blob(current.tree, first.provisionalTip, RESOURCE))).toEqual([0x00, 0xff, 0x0a, 0x7f]);
		expect(runGit({ args: ['ls-tree', first.provisionalTip, RESOURCE], cwd: current.tree }).stdout).toMatch(/^100755 /);
		expect(statSync(join(current.tree, MODE_ONLY)).mode & 0o111).not.toBe(0);
		expect(runGit({ args: ['cat-file', '-e', `${first.provisionalTip}:${DELETED}`], cwd: current.tree }).status).not.toBe(0);
		expect(readFileSync(join(current.tree, 'source/own/hello.ts'), 'utf8')).toBe('export const hello = true;\n');
		expect(runGit({ args: ['rev-parse', 'refs/heads/codkit/applied/t2'], cwd: current.tree }).stdout.trim()).toBe(current.oldPin);

		const second = materializeCycleApply({
			patchesDir: current.patchesDir,
			resolution: current.resolution,
			config: current.config,
			type: stubProjectType,
			sourcePin: current.sourcePin,
			classifications: current.classifications,
			out: current.output
		});
		expect(second.provisionalTip).toBe(first.provisionalTip);
		expect(second.changedPaths).toEqual([]);
		expect(readFileSync(join(current.tree, CONFLICT), 'utf8')).toBe(conflict);

		write(current.tree, 'unexpected-after-run.txt', 'mine\n');
		expect(
			codeOf(() =>
				materializeCycleApply({
					patchesDir: current.patchesDir,
					resolution: current.resolution,
					config: current.config,
					type: stubProjectType,
					sourcePin: current.sourcePin,
					classifications: current.classifications,
					out: current.output
				})
			)
		).toBe('DIRTY-TREE');
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim()).toBe(first.provisionalTip);
	});

	it('rejects stale or tampered classifications before claiming the provisional ref', () => {
		const current = fixture();
		const tampered = current.classifications.map((item) => {
			if (item.kind !== 'patch' || item.artifactId !== 'CK-shell-201' || item.bytes === null) return item;
			return { ...item, bytes: encodeUtf8('tampered\n') };
		});
		expect(codeOf(() => materialize(current, { classifications: tampered }))).toBe('ARTIFACT-BROKEN');
		expect(provisionalRef(current)).toBe('');
	});

	it('canonicalizes classification order to the same exact commit id', () => {
		const ordered = fixture();
		const shuffled = fixture();
		const first = materialize(ordered);
		const second = materialize(shuffled, { classifications: [...shuffled.classifications].reverse() });
		expect(second.provisionalTip).toBe(first.provisionalTip);
		expect(first.provisionalTip).toMatch(/^[0-9a-f]{40}$/);
	});

	it('rejects target ownership collisions and divergent provisional refs', () => {
		const targetCollision = fixture();
		collidingResourceMap(targetCollision);
		expect(codeOf(() => materialize(targetCollision))).toBe('ARTIFACT-BROKEN');
		expect(provisionalRef(targetCollision)).toBe('');

		const refCollision = fixture();
		fixtureGit(refCollision.tree, ['branch', 'codkit/cycle/t2-provisional', refCollision.oldPin]);
		const objectsBefore = looseObjectCount(refCollision);
		expect(codeOf(() => materialize(refCollision))).toBe('CONFIG');
		expect(provisionalRef(refCollision)).toBe(refCollision.oldPin);
		expect(looseObjectCount(refCollision)).toBe(objectsBefore);
	});

	it('refuses staged work and an ignored path that a prospective checkout would overwrite', () => {
		const staged = fixture();
		write(staged.tree, 'staged.txt', 'mine\n');
		fixtureGit(staged.tree, ['add', 'staged.txt']);
		const objectsBefore = looseObjectCount(staged);
		expect(codeOf(() => materialize(staged))).toBe('DIRTY-TREE');
		expect(provisionalRef(staged)).toBe('');
		expect(looseObjectCount(staged)).toBe(objectsBefore);

		const ignored = fixture();
		fixtureGit(ignored.tree, ['switch', '--quiet', '--detach', ignored.targetPin]);
		write(ignored.tree, 'hazard/generated.txt', 'upstream\n');
		fixtureGit(ignored.tree, ['add', '--force', 'hazard/generated.txt']);
		const laterPin = fixtureCommit(ignored.tree, 'fixture: add ignored hazard target', '2026-03-01T00:02:00Z');
		fixtureGit(ignored.tree, ['switch', '--quiet', '--detach', ignored.oldPin]);
		write(ignored.tree, '.git/info/exclude', 'hazard/\n');
		write(ignored.tree, 'hazard/generated.txt', 'local ignored bytes\n');
		const laterConfig = { ...ignored.config, pin: { ...ignored.config.pin, sha: laterPin } };
		expect(
			codeOf(() =>
				materializeCycleApply({
					patchesDir: ignored.patchesDir,
					resolution: ignored.resolution,
					config: laterConfig,
					type: stubProjectType,
					sourcePin: ignored.sourcePin,
					classifications: ignored.classifications,
					out: ignored.output
				})
			)
		).toBe('DIRTY-TREE');
	});

	it('preserves executable resources and materializes symlink-mode prospective paths', () => {
		const executable = fixture();
		const result = materialize(executable);
		expect(runGit({ args: ['ls-tree', result.provisionalTip, RESOURCE], cwd: executable.tree }).stdout).toMatch(/^100755 /);

		const linked = fixture();
		fixtureGit(linked.tree, ['switch', '--quiet', '--detach', linked.targetPin]);
		write(linked.tree, 'link-source.txt', 'source\n');
		symlinkSync('link-source.txt', join(linked.tree, 'linked.txt'));
		fixtureGit(linked.tree, ['add', 'link-source.txt', 'linked.txt']);
		const linkedPin = fixtureCommit(linked.tree, 'fixture: add symlink', '2026-03-01T00:02:00Z');
		fixtureGit(linked.tree, ['switch', '--quiet', '--detach', linked.oldPin]);
		const linkedConfig = { ...linked.config, pin: { ...linked.config.pin, sha: linkedPin } };
		const linkedResult = materializeCycleApply({
			patchesDir: linked.patchesDir,
			resolution: linked.resolution,
			config: linkedConfig,
			type: stubProjectType,
			sourcePin: linked.sourcePin,
			classifications: linked.classifications,
			out: linked.output
		});
		expect(provisionalRef(linked)).toBe(linkedResult.provisionalTip);
		expect(readFileSync(join(linked.tree, 'linked.txt'), 'utf8')).toBe('source\n');
	});

	it('runs the write-capability gate before building or claiming a ref', () => {
		const current = fixture();
		const scratch = join(current.tree, '.git/codkit');
		mkdirSync(scratch, { recursive: true });
		chmodSync(scratch, 0o555);
		try {
			expect(codeOf(() => materialize(current))).toBe('TREE-READONLY');
			expect(provisionalRef(current)).toBe('');
		} finally {
			chmodSync(scratch, 0o755);
		}
	});

	it('fails loudly when a layer directory exists but is unreadable', () => {
		const current = fixture();
		const rules = join(current.patchesDir, 'delta/rules');
		chmodSync(rules, 0o000);
		try {
			expect(codeOf(() => materialize(current))).toBe('ARTIFACT-BROKEN');
			expect(provisionalRef(current)).toBe('');
		} finally {
			chmodSync(rules, 0o755);
		}
	});

	it.each(['both', 'tree-only'] as const)('refuses %s own-code data loss before object or ref mutation', (kind) => {
		const current = fixture();
		const applied = materialize(current);
		const ownRoot = join(current.tree, 'source/own');
		if (kind === 'both') write(current.tree, 'source/own/hello.ts', 'tree edit\n');
		else writeFileSync(join(ownRoot, 'tree-only.ts'), 'tree-only\n');
		const objectsBefore = looseObjectCount(current);
		expect(codeOf(() => materialize(current))).toBe('DIRTY-TREE');
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim()).toBe(applied.provisionalTip);
		expect(looseObjectCount(current)).toBe(objectsBefore);
	});

	it.each(['symlink', 'unreadable'] as const)('strictly rejects an own %s before scratch import', (kind) => {
		const current = fixture();
		const ownRoot = join(current.patchesDir, 'delta/own');
		if (kind === 'symlink') {
			rmSync(join(ownRoot, 'hello.ts'));
			symlinkSync(join(current.patchesDir, 'codkit/config/conventions.json'), join(ownRoot, 'hello.ts'));
		} else {
			chmodSync(ownRoot, 0o000);
		}
		const objectsBefore = looseObjectCount(current);
		try {
			expect(codeOf(() => materialize(current))).toBe('ARTIFACT-BROKEN');
			expect(provisionalRef(current)).toBe('');
			expect(looseObjectCount(current)).toBe(objectsBefore);
		} finally {
			if (kind === 'unreadable') chmodSync(ownRoot, 0o755);
		}
	});

	it('fails loudly on a missing target blob without moving refs or files', () => {
		const current = fixture();
		const object = runGit({ args: ['rev-parse', `${current.targetPin}:${RESOURCE}`], cwd: current.tree }).stdout.trim();
		rmSync(join(current.tree, '.git/objects', object.slice(0, 2), object.slice(2)));
		expect(codeOf(() => materialize(current))).toBe('ARTIFACT-BROKEN');
		expect(provisionalRef(current)).toBe('');
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim()).toBe(current.oldPin);
	});

	it.each(['prepared', 'ref-updated', 'head-selected', 'index-reset', 'checkout-complete', 'conflicts-written', 'record-removed'] as const)(
		'resumes after process loss at %s',
		(interruptedAt) => {
			const current = fixture();
			const checkpoint = (observed: CycleMaterializeMoveCheckpoint): void => {
				if (observed === interruptedAt) throw new Error(`process loss after ${observed}`);
			};
			expect(() => materialize(current, { checkpoint })).toThrow(`process loss after ${interruptedAt}`);
			const resumed = materialize(current);
			expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: current.tree }).stdout.trim()).toBe(resumed.provisionalTip);
			expect(readFileSync(join(current.tree, CONFLICT), 'utf8')).toContain('<<<<<<< ours\n');
			expect(existsSync(join(current.patchesDir, ...CYCLE_MATERIALIZE_RECORD_PATH.split('/')))).toBe(false);
		}
	);

	it('recovers a deterministic temp after the first of two patch conflicts was renamed', () => {
		const current = fixture();
		const interruptedAt = `conflict-temp-written:${CONFLICT}` as const;
		expect(() =>
			materialize(current, {
				checkpoint(observed) {
					if (observed === interruptedAt) throw new Error(`process loss after ${observed}`);
				}
			})
		).toThrow(`process loss after ${interruptedAt}`);
		expect(readFileSync(join(current.tree, CONFLICT_TWO), 'utf8')).toContain('<<<<<<< ours\n');
		expect(readFileSync(join(current.tree, CONFLICT), 'utf8')).toBe('a\nupstream\nz\n');
		expect(readdirSync(join(current.tree, 'src')).filter((name) => name.startsWith('.codkit-cycle-'))).toHaveLength(1);
		materialize(current);
		expect(readFileSync(join(current.tree, CONFLICT), 'utf8')).toContain('<<<<<<< ours\n');
		expect(readdirSync(join(current.tree, 'src')).filter((name) => name.startsWith('.codkit-cycle-'))).toHaveLength(0);
	});
});
