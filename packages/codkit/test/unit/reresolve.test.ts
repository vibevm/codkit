/** @scope spec://codkit/modules/codkit/PROP-007#cmd-reresolve */
// Unit coverage for source precedence and the one-file materialization boundary.

import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import type { GitBytesResult, GitResult } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { encodePatchName, formatPatchHeader } from '../../src/lib/patchFormat.ts';
import { runReresolve, selectPatchSource } from '../../src/lib/reresolve.ts';
import type { ReresolveDependencies } from '../../src/lib/reresolve.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

const TARGET = 'src/replay.ts';
const BASE = 'a\nbase\nz\n';
const PATCHED = 'a\ncodkit\nz\n';

type CoreFixture = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly patch: string;
	readonly target: string;
};

afterAll(() => cleanupTempRoots());

describe('reresolve source order', () => {
	it('selects explicit, .orig, in-progress HEAD, then completed HEAD^1 and never reads MERGE_HEAD as a blob', () => {
		const patchesDir = makeTempRoot('reresolve-source-order');
		const artifact = `delta/patches/${encodePatchName(TARGET)}`;
		const explicit = 'saved/old.ckpatch';
		write(patchesDir, explicit, 'explicit');
		write(patchesDir, `${artifact}.orig`, 'orig');
		const calls: string[] = [];
		const dependencies = sourceGit(
			calls,
			true,
			2,
			new Map([
				[`HEAD:${artifact}`, 'head'],
				[`HEAD^1:${artifact}`, 'parent']
			])
		);

		expect(text(selectPatchSource(patchesDir, artifact, explicit, dependencies).bytes)).toBe('explicit');
		unlinkSync(join(patchesDir, explicit));
		expect(text(selectPatchSource(patchesDir, artifact, explicit, dependencies).bytes)).toBe('orig');
		unlinkSync(join(patchesDir, `${artifact}.orig`));
		const head = selectPatchSource(patchesDir, artifact, explicit, dependencies);
		expect(head.kind).toBe('merge-head');
		expect(text(head.bytes)).toBe('head');

		const parent = selectPatchSource(patchesDir, artifact, null, sourceGit(calls, false, 2, new Map([[`HEAD^1:${artifact}`, 'parent']])));
		expect(parent.kind).toBe('merge-parent');
		expect(text(parent.bytes)).toBe('parent');
		expect(calls.some((call) => call.includes('show MERGE_HEAD:'))).toBe(false);
	});

	it('lists every checked source when no old patch exists', () => {
		const root = makeTempRoot('reresolve-source-missing');
		const artifact = `delta/patches/${encodePatchName(TARGET)}`;
		const error = caught(() => selectPatchSource(root, artifact, 'missing.ckpatch', sourceGit([], false, 1, new Map())));

		expect(error.code).toBe('ARTIFACT-BROKEN');
		expect(error.hint).toContain('--patch missing.ckpatch');
		expect(error.hint).toContain(`${artifact}.orig`);
		expect(error.hint).toContain(`HEAD:${artifact}`);
		expect(error.hint).toContain(`HEAD^1:${artifact}`);
	});

	it('does not treat HEAD^1 of an older merge as the completed source while a new merge is still in progress', () => {
		const root = makeTempRoot('reresolve-source-active-merge');
		const artifact = `delta/patches/${encodePatchName(TARGET)}`;
		const error = caught(() =>
			selectPatchSource(root, artifact, null, sourceGit([], true, 2, new Map([[`HEAD^1:${artifact}`, 'stale parent']])))
		);

		expect(error.code).toBe('ARTIFACT-BROKEN');
		expect(error.hint).toContain('merge is still in progress');
	});

	it('refuses outside and symlinked explicit sources before reading them', () => {
		const root = makeTempRoot('reresolve-source-safety');
		const outside = makeTempRoot('reresolve-source-outside');
		write(outside, 'old.ckpatch', 'secret');
		mkdirSync(join(root, 'saved'), { recursive: true });
		symlinkSync(join(outside, 'old.ckpatch'), join(root, 'saved/link.ckpatch'));
		const artifact = `delta/patches/${encodePatchName(TARGET)}`;

		expect(caught(() => selectPatchSource(root, artifact, '../outside.ckpatch')).code).toBe('CONFIG');
		expect(caught(() => selectPatchSource(root, artifact, 'saved/link.ckpatch')).code).toBe('CONFIG');
	});
});

describe('reresolve replay and materialization', () => {
	it('writes exact clean bytes atomically, preserves mode, and changes no ref, index, or patchset byte', () => {
		const current = makeCore('clean');
		chmodSync(current.target, 0o751);
		const head = git(current.treeDir, ['rev-parse', 'HEAD']);
		const refs = git(current.treeDir, ['show-ref']);
		const index = readFileSync(join(current.treeDir, '.git/index'));
		const patchBefore = readFileSync(current.patch);

		const result = execute(current);

		expect(result.outcome).toBe('clean');
		expect(readFileSync(current.target, 'utf8')).toBe(PATCHED);
		expect(statSync(current.target).mode & 0o777).toBe(0o751);
		expect(git(current.treeDir, ['rev-parse', 'HEAD'])).toBe(head);
		expect(git(current.treeDir, ['show-ref'])).toBe(refs);
		expect(readFileSync(join(current.treeDir, '.git/index'))).toEqual(index);
		expect(readFileSync(current.patch)).toEqual(patchBefore);
	});

	it('writes exact diff3 conflict bytes and reports the conflict count', () => {
		const current = makeCore('conflict');
		writeFileSync(current.target, 'a\nupstream\nz\n');

		const result = execute(current);
		const bytes = readFileSync(current.target, 'utf8');
		expect(result.outcome).toBe('conflict');
		expect(result.conflictCount).toBe(1);
		expect(bytes).toContain('<<<<<<< ours\n');
		expect(bytes).toContain('||||||| base\n');
		expect(bytes).toContain('>>>>>>> theirs\n');
	});

	it('returns target-deleted without creating the missing target', () => {
		const current = makeCore('deleted');
		unlinkSync(current.target);

		const result = execute(current);
		expect(result.outcome).toBe('target-deleted');
		expect(() => statSync(current.target)).toThrow();
	});

	it('refuses an exact target mismatch and a symlink target', () => {
		const mismatch = makeCore('target-mismatch', 'src/other.ts');
		expect(caught(() => execute(mismatch)).code).toBe('MARKER-ARTIFACT-MISMATCH');

		const linked = makeCore('target-symlink');
		const outside = makeTempRoot('reresolve-target-symlink-outside');
		write(outside, 'victim.ts', 'outside\n');
		unlinkSync(linked.target);
		symlinkSync(join(outside, 'victim.ts'), linked.target);
		expect(caught(() => execute(linked)).code).toBe('CONFIG');
		expect(readFileSync(join(outside, 'victim.ts'), 'utf8')).toBe('outside\n');
	});

	it('keeps the old target and removes its temporary file when atomic rename is interrupted', () => {
		const current = makeCore('atomic-failure');
		const before = readFileSync(current.target);
		const error = expectFailure(() =>
			execute(current, {
				beforeRename: () => {
					throw new Error('injected before rename');
				}
			})
		);

		expect(error.message).toBe('injected before rename');
		expect(readFileSync(current.target)).toEqual(before);
		expect(readdirSync(dirname(current.target)).some((name) => name.includes('.codkit-reresolve-'))).toBe(false);
	});

	it('refuses a concurrent same-size in-place edit without overwriting it or retaining the temporary file', () => {
		const current = makeCore('same-size-race');
		const concurrent = 'a\nedit\nz\n';
		expect(Buffer.byteLength(concurrent)).toBe(Buffer.byteLength(BASE));

		const failure = caught(() =>
			execute(current, {
				beforeRename: () => writeFileSync(current.target, concurrent)
			})
		);

		expect(failure.code).toBe('CONFIG');
		expect(readFileSync(current.target, 'utf8')).toBe(concurrent);
		expect(readdirSync(dirname(current.target)).some((name) => name.includes('.codkit-reresolve-'))).toBe(false);
	});
});

function makeCore(label: string, patchTarget = TARGET): CoreFixture {
	const treeDir = makeTempRoot(`reresolve-core-tree-${label}`);
	fixtureGit(treeDir, ['init', '--quiet', '--initial-branch=main', '.']);
	write(treeDir, TARGET, BASE);
	if (patchTarget !== TARGET) write(treeDir, patchTarget, BASE);
	const pin = fixtureCommit(treeDir, 'fixture: reresolve base', '2026-06-01T00:00:00Z');
	const patchesDir = makeTempRoot(`reresolve-core-patchset-${label}`);
	const patchRelative = 'saved/old.ckpatch';
	write(patchesDir, patchRelative, patchText(patchTarget, pin));
	return { patchesDir, treeDir, patch: join(patchesDir, patchRelative), target: join(treeDir, TARGET) };
}

function execute(current: CoreFixture, dependencies?: ReresolveDependencies) {
	return runReresolve({
		patchesDir: current.patchesDir,

		treeDir: current.treeDir,
		target: TARGET,
		explicitPatch: 'saved/old.ckpatch',
		conventions: loadConventions(vscodeType, current.patchesDir),
		...(dependencies === undefined ? {} : { dependencies })
	});
}

function patchText(target: string, pin: string): string {
	const header = formatPatchHeader({
		id: 'CK-workbench-731',
		type: 'hook',
		category: 'follow',
		owner: 'workbench-core',
		reason: 'unit reresolve patch',
		link: 'none',
		cause: 'none',
		pin: `t1@${pin}`,
		contractTests: []
	});
	return `${header}--- a/${target}\n+++ b/${target}\n@@ -1,3 +1,3 @@\n a\n-base\n+codkit\n z\n`;
}

function sourceGit(calls: string[], merge: boolean, parentCount: number, blobs: ReadonlyMap<string, string>): ReresolveDependencies {
	return {
		runGit: (options) => {
			const call = options.args.join(' ');
			calls.push(call);
			if (call === 'rev-parse --git-dir') return result(0, '.git\n');
			if (call === 'rev-parse --verify --quiet MERGE_HEAD') return result(merge ? 0 : 1);
			if (call === 'rev-list --parents -n 1 HEAD') {
				return result(0, ['head', ...Array.from({ length: parentCount }, (_, index) => `parent${index + 1}`)].join(' ') + '\n');
			}
			return result(1);
		},
		runGitBytes: (options) => {
			const object = options.args[1] ?? '';
			calls.push(options.args.join(' '));
			if (object.startsWith('MERGE_HEAD:')) throw new Error('MERGE_HEAD blob must never be read');
			const value = blobs.get(object);
			return bytesResult(value === undefined ? 1 : 0, value ?? '');
		}
	};
}

function result(status: number, stdout = ''): GitResult {
	return { status, stdout, stderr: '' };
}

function bytesResult(status: number, stdout: string): GitBytesResult {
	return { status, stdout: encodeUtf8(stdout), stderr: '' };
}

function git(root: string, args: readonly string[]): string {
	const outcome = runGit({ args, cwd: root });
	if (outcome.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${outcome.stderr}`);
	return outcome.stdout;
}

function write(root: string, path: string, content: string): void {
	const absolute = join(root, ...path.split('/'));
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

function text(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString('utf8');
}

function caught(run: () => unknown): { readonly code: string; readonly hint: string } {
	const error = expectFailure(run);
	if (!isCkError(error)) throw error;
	return { code: error.code, hint: error.hint ?? '' };
}

function expectFailure(run: () => unknown): Error {
	try {
		run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error('expected operation to fail');
}
