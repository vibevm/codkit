/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	CYCLE_MATERIALIZE_RECORD_PATH,
	executeProvisionalMove,
	prepareProvisionalMove,
	type CycleMaterializeMoveCheckpoint,
	type ProvisionalMoveOptions
} from '../../src/lib/cycleMaterializeMove.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

type MoveFixture = {
	readonly tree: string;
	readonly patchset: string;
	readonly source: string;
	readonly target: string;
	readonly changedPaths: readonly string[];
};

afterAll(cleanupTempRoots);

describe('portable cycle materialize movement', () => {
	it('uses an exact isolated target index when an external writer changes the live index', () => {
		const current = simpleFixture();
		runMove(current, (checkpoint) => {
			if (checkpoint !== 'index-reset') return;
			write(current.tree, 'evil.tmp', 'external index bytes\n');
			const evil = fixtureGit(current.tree, ['hash-object', '-w', '--', 'evil.tmp']).stdout.trim();
			fixtureGit(current.tree, ['update-index', '--cacheinfo', `100644,${evil},file.txt`]);
			rmSync(join(current.tree, 'evil.tmp'));
		});
		expect(readFileSync(join(current.tree, 'file.txt'), 'utf8')).toBe('target bytes\n');
		expect(fixtureGit(current.tree, ['show', ':file.txt']).stdout).toBe('external index bytes\n');
		expect(existsSync(recordPath(current))).toBe(false);
	});

	it('finishes while an external live index lock is held after the durable reset', () => {
		const current = simpleFixture();
		const lock = join(current.tree, '.git/index.lock');
		expect(() => runMove(current, crashAt('index-reset'))).toThrow('loss at index-reset');
		try {
			writeFileSync(lock, 'external optional refresh\n', { flag: 'wx' });
			runMove(current);
			expect(readFileSync(join(current.tree, 'file.txt'), 'utf8')).toBe('target bytes\n');
			expect(existsSync(recordPath(current))).toBe(false);
		} finally {
			rmSync(lock, { force: true });
		}
	});

	it('does not rewrite the live index stat cache during resume preflight', () => {
		const current = simpleFixture();
		expect(() => runMove(current, crashAt('index-reset'))).toThrow('loss at index-reset');
		const index = join(current.tree, '.git/index');
		const before = hash(readFileSync(index));
		const now = new Date(Date.now() + 10_000);
		utimesSync(join(current.tree, 'stable.txt'), now, now);
		prepareProvisionalMove(moveOptions(current));
		expect(hash(readFileSync(index))).toBe(before);
		runMove(current);
	});

	it('migrates and resumes a canonical v1 receipt at index-reset', () => {
		const current = simpleFixture();
		expect(() => runMove(current, crashAt('index-reset'))).toThrow('loss at index-reset');
		const receipt = JSON.parse(readFileSync(recordPath(current), 'utf8')) as Record<string, unknown>;
		delete receipt['entries'];
		receipt['codkitCycleMaterialize'] = 1;
		writeFileSync(recordPath(current), `${JSON.stringify(receipt, null, 2)}\n`);
		runMove(current);
		expect(readFileSync(join(current.tree, 'file.txt'), 'utf8')).toBe('target bytes\n');
		expect(existsSync(recordPath(current))).toBe(false);
	});

	it('keeps the durable receipt when exact post-checkout proof observes changed bytes', () => {
		const current = simpleFixture();
		expect(
			codeOf(() =>
				runMove(current, (checkpoint) => {
					if (checkpoint === 'checkout-batch:1') write(current.tree, 'file.txt', 'changed after checkout\n');
				})
			)
		).toBe('CONFIG');
		expect(existsSync(recordPath(current))).toBe(true);
		write(current.tree, 'file.txt', 'target bytes\n');
		runMove(current);
		expect(existsSync(recordPath(current))).toBe(false);
	});

	it('bounds isolated checkout-index work into deterministic path batches', () => {
		const current = fixture(
			'cycle-portable-batches',
			(tree) => write(tree, 'stable.txt', 'stable\n'),
			(tree) => {
				for (let index = 0; index < 129; index += 1) write(tree, `many/${index.toString().padStart(3, '0')}.txt`, `${index}\n`);
			}
		);
		const batches: string[] = [];
		runMove(current, (checkpoint) => {
			if (checkpoint.startsWith('checkout-batch:')) batches.push(checkpoint);
		});
		expect(batches).toEqual(['checkout-batch:1', 'checkout-batch:2']);
	});

	it.each([
		['file-to-directory', true],
		['directory-to-file', false]
	] as const)('materializes and resumes the %s D/F transition', (_label, fileToDirectory) => {
		const current = dfFixture(fileToDirectory);
		const interruption = fileToDirectory ? 'path-deleted:a' : 'checkout-batch:1';
		expect(() => runMove(current, crashAt(interruption))).toThrow(`loss at ${interruption}`);
		runMove(current);
		if (fileToDirectory) {
			expect(readFileSync(join(current.tree, 'a/b'), 'utf8')).toBe('target child\n');
			expect(lstatSync(join(current.tree, 'a')).isDirectory()).toBe(true);
		} else {
			expect(readFileSync(join(current.tree, 'a'), 'utf8')).toBe('target file\n');
			expect(lstatSync(join(current.tree, 'a')).isFile()).toBe(true);
		}
	});

	it('resumes filtered worktree bytes after index-reset instead of comparing canonical blobs', () => {
		const current = lfsFixture();
		expect(() => runMove(current, crashAt('index-reset'))).toThrow('loss at index-reset');
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).toBe('old lfs payload\n');
		runMove(current);
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).toBe('new lfs payload\n');
		expect(fixtureGit(current.tree, ['show', `${current.target}:asset.bin`]).stdout).toContain('git-lfs.github.com/spec');
	});

	it('fails closed before receipt, ref, or worktree mutation when an LFS object is missing', () => {
		const current = lfsFixture();
		const pointer = fixtureGit(current.tree, ['show', `${current.target}:asset.bin`]).stdout;
		const oid = /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
		if (oid === undefined) throw new Error('fixture pointer missing');
		rmSync(join(current.tree, '.git/lfs/objects', oid.slice(0, 2), oid.slice(2, 4), oid));
		expect(codeOf(() => prepareProvisionalMove(moveOptions(current)))).toBe('DIRTY-TREE');
		expect(readFileSync(join(current.tree, 'asset.bin'), 'utf8')).toBe('old lfs payload\n');
		expect(existsSync(recordPath(current))).toBe(false);
		expect(runGit({ args: ['show-ref', '--verify', '--quiet', 'refs/heads/codkit/cycle/test'], cwd: current.tree }).status).toBe(1);
	});

	it('honors placeholder symlink and ignored-filemode semantics', () => {
		const current = portableModeFixture();
		runMove(current);
		expect(lstatSync(join(current.tree, 'link')).isFile()).toBe(true);
		expect(readFileSync(join(current.tree, 'link'), 'utf8')).toBe('../../outside-target');
		expect(lstatSync(join(current.tree, 'script.sh')).mode & 0o111).toBe(0);
	});
});

function simpleFixture(): MoveFixture {
	return fixture(
		'cycle-portable-simple',
		(tree) => {
			write(tree, 'file.txt', 'source bytes\n');
			write(tree, 'stable.txt', 'stable\n');
		},
		(tree) => write(tree, 'file.txt', 'target bytes\n')
	);
}

function dfFixture(fileToDirectory: boolean): MoveFixture {
	return fixture(
		`cycle-portable-df-${fileToDirectory}`,
		(tree) => (fileToDirectory ? write(tree, 'a', 'source file\n') : write(tree, 'a/b', 'source child\n')),
		(tree) => {
			rmSync(join(tree, 'a'), { recursive: true, force: true });
			write(tree, fileToDirectory ? 'a/b' : 'a', fileToDirectory ? 'target child\n' : 'target file\n');
		}
	);
}

function lfsFixture(): MoveFixture {
	const tree = makeTempRoot('cycle-portable-lfs-tree');
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.clean', 'git-lfs clean -- %f']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.smudge', 'git-lfs smudge -- %f']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.process', 'git-lfs filter-process']);
	fixtureGit(tree, ['config', '--local', 'filter.lfs.required', 'true']);
	write(tree, '.gitattributes', 'asset.bin filter=lfs diff=lfs merge=lfs -text\n');
	write(tree, 'asset.bin', 'old lfs payload\n');
	const source = fixtureCommit(tree, 'fixture: source LFS', '2026-08-31T01:00:00Z');
	write(tree, 'asset.bin', 'new lfs payload\n');
	const target = fixtureCommit(tree, 'fixture: target LFS', '2026-08-31T01:01:00Z');
	fixtureGit(tree, ['checkout', '--quiet', '--detach', source]);
	return finishFixture(tree, source, target);
}

function portableModeFixture(): MoveFixture {
	const tree = makeTempRoot('cycle-portable-modes-tree');
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	write(tree, 'script.sh', '#!/bin/sh\nexit 0\n');
	symlinkSync('old-target', join(tree, 'link'));
	const source = fixtureCommit(tree, 'fixture: source modes', '2026-08-31T02:00:00Z');
	chmodSync(join(tree, 'script.sh'), 0o755);
	unlinkSync(join(tree, 'link'));
	symlinkSync('../../outside-target', join(tree, 'link'));
	const target = fixtureCommit(tree, 'fixture: target modes', '2026-08-31T02:01:00Z');
	fixtureGit(tree, ['config', 'core.symlinks', 'false']);
	fixtureGit(tree, ['config', 'core.filemode', 'false']);
	fixtureGit(tree, ['checkout', '--quiet', '--force', '--detach', source]);
	return finishFixture(tree, source, target);
}

function fixture(label: string, sourceFiles: (tree: string) => void, targetFiles: (tree: string) => void): MoveFixture {
	const tree = makeTempRoot(`${label}-tree`);
	fixtureGit(tree, ['init', '--quiet', '--initial-branch=main', '.']);
	sourceFiles(tree);
	const source = fixtureCommit(tree, 'fixture: source move', '2026-08-31T00:00:00Z');
	targetFiles(tree);
	const target = fixtureCommit(tree, 'fixture: target move', '2026-08-31T00:01:00Z');
	fixtureGit(tree, ['checkout', '--quiet', '--detach', source]);
	return finishFixture(tree, source, target);
}

function finishFixture(tree: string, source: string, target: string): MoveFixture {
	const patchset = makeTempRoot('cycle-portable-patchset');
	const changedPaths = fixtureGit(tree, ['diff', '--name-only', '-z', source, target]).stdout.split('\0').filter(Boolean);
	return { tree, patchset, source, target, changedPaths };
}

function write(root: string, path: string, contents: string): void {
	const target = join(root, ...path.split('/'));
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, contents);
}

function moveOptions(current: MoveFixture, checkpoint?: (checkpoint: CycleMaterializeMoveCheckpoint) => void): ProvisionalMoveOptions {
	const gitDir = fixtureGit(current.tree, ['rev-parse', '--absolute-git-dir']).stdout.trim();
	return {
		patchesDir: current.patchset,
		tree: current.tree,
		branch: 'codkit/cycle/test',
		targetPin: current.target,
		tip: current.target,
		changedPaths: current.changedPaths,
		prospectiveGitDir: gitDir,
		conflicts: [],
		allowedOwnPaths: [],
		...(checkpoint === undefined ? {} : { checkpoint })
	};
}

function runMove(current: MoveFixture, checkpoint?: (checkpoint: CycleMaterializeMoveCheckpoint) => void): void {
	const options = moveOptions(current, checkpoint);
	const preflight = prepareProvisionalMove(options);
	executeProvisionalMove(options, preflight);
}

function crashAt(expected: string): (checkpoint: CycleMaterializeMoveCheckpoint) => void {
	return (checkpoint) => {
		if (checkpoint === expected) throw new Error(`loss at ${checkpoint}`);
	};
}

function recordPath(current: MoveFixture): string {
	return join(current.patchset, ...CYCLE_MATERIALIZE_RECORD_PATH.split('/'));
}

function hash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
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
