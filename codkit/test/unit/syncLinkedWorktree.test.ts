// A real repository plus a real linked worktree, because the bug only exists
// there: `.git` is a file and the per-worktree admin directory that
// `--absolute-git-dir` returns is not where Git reads `info/exclude` or
// `hooks/pre-commit` from. In a multi-worktree repository the own-directory
// exclusion is worktree-local (a per-worktree file plus the per-worktree
// `core.excludesFile` key), never a managed block in the shared `info/exclude`
// (PROP-005 ##OWN-EXCLUDED-LOCALLY); the hook and the tree mark follow
// PROP-008 ##TREE-HOOK-STEP and PROP-006 ##TREE-MARK. The one deliberate
// exception is the hook under a custom `core.hooksPath`: that effective
// location can sit outside the repository, and the guard then stays in the
// repository's own admin dir instead (PROP-008 ##TREE-HOOK-STEP).

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import {
	EXCLUDE_BEGIN,
	EXCLUDE_END,
	OWN_EXCLUDE_RELATIVE_PATH,
	isLinkedGitLayout,
	writeExclude,
	writeTreeHook
} from '../../src/lib/syncEngine.ts';
import { gitDirOf, writeTreeMark } from '../../src/lib/treeCache.ts';
import type { TreeMark } from '../../src/lib/treeCache.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

/** A real repository with one commit: the shape of every normal fork tree. */
function makeNormalRepo(label: string): string {
	const repo = makeTempRoot(label);
	runGit({ args: ['init', '--quiet', '-b', 'main', '.'], cwd: repo });
	writeFileSync(join(repo, 'readme.txt'), 'upstream file\n', 'utf8');
	runGit({ args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'add', 'readme.txt'], cwd: repo });
	runGit({ args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--quiet', '-m', 'base'], cwd: repo });
	return repo;
}

/** A real repository with one commit, plus a real linked worktree of it. */
function makeLinkedWorktree(label: string): { readonly main: string; readonly worktree: string } {
	const main = makeNormalRepo(`${label}-main`);

	const worktree = join(makeTempRoot(`${label}-worktree`), 'fork-tree');
	mkdirSync(dirname(worktree), { recursive: true });
	runGit({ args: ['worktree', 'add', '--quiet', '-b', 'ck-wt', worktree], cwd: main });
	return { main, worktree };
}

/** The path Git itself consults for an administrative file of a repository. */
function gitPathOf(repo: string, relative: string): string {
	const result = runGit({ args: ['rev-parse', '--path-format=absolute', '--git-path', relative], cwd: repo, pathResolution: true });
	expect(result.status).toBe(0);
	return result.stdout.trim();
}

/** `--absolute-git-dir` of a worktree: the per-worktree admin directory. */
function perWorktreeDir(repo: string): string {
	return gitDirOf(repo);
}

function hookOutput(): Output {
	return new Output({ command: 'sync', version: 'test', jsonMode: false });
}

/** An Output that records every human-facing line, warnings included. */
function collectingOutput(): { readonly out: Output; readonly lines: readonly string[] } {
	const lines: string[] = [];
	const out = new Output({
		command: 'sync',
		version: 'test',
		jsonMode: false,
		streams: {
			writeOut: (chunk) => lines.push(chunk),
			writeErr: (chunk) => lines.push(chunk)
		}
	});
	return { out, lines };
}

/** A foreign hook with unmistakable bytes and mode, planted in the common dir. */
const SENTINEL_HOOK = '#!/bin/sh\necho sentinel-veto >&2\nexit 7\n';
const SENTINEL_MODE = 0o741;

function plantSentinel(path: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, SENTINEL_HOOK, 'utf8');
	chmodSync(path, SENTINEL_MODE);
}

function manualCommit(repo: string): { readonly status: number; readonly stderr: string } {
	const result = gitLocal({
		args: ['-c', 'user.email=codkit@invalid', '-c', 'user.name=codkit', 'commit', '--allow-empty', '-m', 'manual'],
		cwd: repo
	});
	return { status: result.status, stderr: result.stderr };
}

const MARK: TreeMark = {
	codkitTreeMark: 1,
	pinSha: '1111111111111111111111111111111111111111',
	deltaFingerprint: 'fingerprint',
	branchTip: '2222222222222222222222222222222222222222',
	ownFingerprint: 'own',
	ownFiles: { 'src/vs/patchset/a.ts': '3333333333333333333333333333333333333333' }
};

describe('a linked worktree fork tree', () => {
	it('canonicalizes Windows slash and case before classifying normal versus linked', () => {
		expect(isLinkedGitLayout('C:\\Repo\\.git', 'c:/repo/.git', 'win32')).toBe(false);
		expect(isLinkedGitLayout('C:\\Repo\\.git\\worktrees\\one', 'c:/repo/.git', 'win32')).toBe(true);
	});
	it('hides the own directory through a worktree-local exclude, never the shared one', () => {
		const { worktree } = makeLinkedWorktree('exclude-effective');
		const commonExclude = gitPathOf(worktree, 'info/exclude');
		expect(commonExclude).not.toBe(join(perWorktreeDir(worktree), 'info', 'exclude'));
		const commonBefore = readFileSync(commonExclude, 'utf8');

		writeExclude(worktree, 'patchset');

		// The shared exclude of the repository is untouched: no managed block
		// may hide this tree's own paths in its sibling worktrees.
		expect(readFileSync(commonExclude, 'utf8')).toBe(commonBefore);

		// The exclusion is the per-worktree file Git is pointed at by the
		// per-worktree core.excludesFile key.
		const own = join(perWorktreeDir(worktree), ...OWN_EXCLUDE_RELATIVE_PATH.split('/'));
		expect(readFileSync(own, 'utf8')).toBe(`${EXCLUDE_BEGIN}\n/src/vs/patchset/\n${EXCLUDE_END}\n`);
		const pointing = runGit({ args: ['config', '--worktree', '--get', 'core.excludesFile'], cwd: worktree });
		expect(pointing.status).toBe(0);
		expect(pointing.stdout.trim()).toBe(own);
		const extension = runGit({ args: ['config', '--local', '--get', 'extensions.worktreeConfig'], cwd: worktree });
		expect(extension.stdout.trim()).toBe('true');

		// The own files are invisible to the tree's git, and a loose file is not.
		mkdirSync(join(worktree, 'src', 'vs', 'patchset'), { recursive: true });
		writeFileSync(join(worktree, 'src', 'vs', 'patchset', 'a.ts'), 'own code\n', 'utf8');
		writeFileSync(join(worktree, 'loose.txt'), 'user file\n', 'utf8');
		const status = runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: worktree });
		expect(status.status).toBe(0);
		expect(status.stdout).not.toContain('src/vs/patchset/');
		expect(status.stdout).toContain('?? loose.txt');
	});

	it("keeps two linked worktrees with different own directories from changing each other's git status", () => {
		const main = makeNormalRepo('exclude-sibling-main');
		const first = join(makeTempRoot('exclude-sibling-first'), 'wt-one');
		const second = join(makeTempRoot('exclude-sibling-second'), 'wt-two');
		mkdirSync(dirname(first), { recursive: true });
		runGit({ args: ['worktree', 'add', '--quiet', '-b', 'ck-one', first], cwd: main });
		mkdirSync(dirname(second), { recursive: true });
		runGit({ args: ['worktree', 'add', '--quiet', '-b', 'ck-two', second], cwd: main });
		const commonExclude = gitPathOf(first, 'info/exclude');
		writeFileSync(commonExclude, '# user rules\n*.secret\n', 'utf8');

		writeExclude(first, 'alpha');
		writeExclude(second, 'beta');

		// Each worktree hides exactly its own directory...
		for (const [tree, own, other] of [
			[first, 'alpha', 'beta'],
			[second, 'beta', 'alpha']
		] as const) {
			mkdirSync(join(tree, 'src', 'vs', own), { recursive: true });
			writeFileSync(join(tree, 'src', 'vs', own, 'a.ts'), 'own code\n', 'utf8');
			mkdirSync(join(tree, 'src', 'vs', other), { recursive: true });
			writeFileSync(join(tree, 'src', 'vs', other, 'b.ts'), 'foreign own code\n', 'utf8');
			const status = runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: tree });
			expect(status.status).toBe(0);
			expect(status.stdout).not.toContain(`src/vs/${own}/`);
			expect(status.stdout).toContain(`?? src/vs/${other}/`);
		}

		// ...the shared exclude keeps the user's rules byte for byte and never
		// carries a codkit managed block, and each worktree's own exclusion is
		// its own file.
		expect(readFileSync(commonExclude, 'utf8')).toBe('# user rules\n*.secret\n');
		expect(readFileSync(join(perWorktreeDir(first), ...OWN_EXCLUDE_RELATIVE_PATH.split('/')), 'utf8')).toBe(
			`${EXCLUDE_BEGIN}\n/src/vs/alpha/\n${EXCLUDE_END}\n`
		);
		expect(readFileSync(join(perWorktreeDir(second), ...OWN_EXCLUDE_RELATIVE_PATH.split('/')), 'utf8')).toBe(
			`${EXCLUDE_BEGIN}\n/src/vs/beta/\n${EXCLUDE_END}\n`
		);
	});

	it("retires codkit's stale managed block from the shared exclude, foreign lines intact", () => {
		const { worktree } = makeLinkedWorktree('exclude-legacy-block');
		const commonExclude = gitPathOf(worktree, 'info/exclude');
		writeFileSync(commonExclude, `# user rules\n${EXCLUDE_BEGIN}\n/src/vs/oldown/\n${EXCLUDE_END}\n*.local\n`, 'utf8');

		writeExclude(worktree, 'patchset');

		// Our own block is removed; the user's lines stay byte for byte.
		expect(readFileSync(commonExclude, 'utf8')).toBe('# user rules\n*.local\n');
		const own = join(perWorktreeDir(worktree), ...OWN_EXCLUDE_RELATIVE_PATH.split('/'));
		expect(readFileSync(own, 'utf8')).toBe(`${EXCLUDE_BEGIN}\n/src/vs/patchset/\n${EXCLUDE_END}\n`);
	});

	it('refuses a foreign per-worktree excludesFile instead of overwriting it', () => {
		const { main, worktree } = makeLinkedWorktree('exclude-foreign-key');
		// A user who already uses per-worktree excludes for their own purposes.
		runGit({ args: ['config', '--local', 'extensions.worktreeConfig', 'true'], cwd: main });
		const foreign = join(makeTempRoot('exclude-foreign-key-dir'), 'exclude');
		mkdirSync(dirname(foreign), { recursive: true });
		writeFileSync(foreign, '/user-own/\n', 'utf8');
		runGit({ args: ['config', '--worktree', 'core.excludesFile', foreign], cwd: worktree });

		expect(() => writeExclude(worktree, 'patchset')).toThrow(/core\.excludesFile/);
		const kept = runGit({ args: ['config', '--worktree', '--get', 'core.excludesFile'], cwd: worktree });
		expect(kept.stdout.trim()).toBe(foreign);
		expect(readFileSync(foreign, 'utf8')).toBe('/user-own/\n');
		expect(existsSync(join(perWorktreeDir(worktree), ...OWN_EXCLUDE_RELATIVE_PATH.split('/')))).toBe(false);
	});

	it('rechecks dormant worktree config under the lock before enabling the extension', () => {
		const { worktree } = makeLinkedWorktree('exclude-dormant-race');
		const config = join(perWorktreeDir(worktree), 'config.worktree');
		const foreign = join(makeTempRoot('exclude-dormant-race-foreign'), 'exclude');
		writeFileSync(foreign, '/foreign/\n', 'utf8');
		const planted = `[core]\n\texcludesFile = ${foreign}\n`;

		expect(() =>
			writeExclude(worktree, 'patchset', {
				afterPlan: () => writeFileSync(config, planted, 'utf8')
			})
		).toThrow(/dormant config\.worktree/);
		// The foreign file and config remain exact, and the shared extension was
		// not enabled before the refusal.
		expect(readFileSync(config, 'utf8')).toBe(planted);
		expect(readFileSync(foreign, 'utf8')).toBe('/foreign/\n');
		expect(runGit({ args: ['config', '--local', '--get', 'extensions.worktreeConfig'], cwd: worktree }).status).not.toBe(0);
		expect(existsSync(join(perWorktreeDir(worktree), ...OWN_EXCLUDE_RELATIVE_PATH.split('/')))).toBe(false);
	});

	it.each(['afterOwnedWrite', 'afterExtensionEnable', 'afterCoreSet'] as const)(
		'rolls back worktree-local exclude activation after %s failure',
		(checkpoint) => {
			const { main, worktree } = makeLinkedWorktree(`exclude-atomic-${checkpoint}`);
			const commonConfig = join(gitDirOf(main), 'config');
			const worktreeConfig = join(perWorktreeDir(worktree), 'config.worktree');
			const own = join(perWorktreeDir(worktree), ...OWN_EXCLUDE_RELATIVE_PATH.split('/'));
			const commonBefore = readFileSync(commonConfig);
			const indexBefore = runGit({ args: ['write-tree'], cwd: worktree }).stdout.trim();
			const statusBefore = runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: worktree }).stdout;

			expect(() =>
				writeExclude(worktree, 'patchset', {
					[checkpoint]: () => {
						throw new Error(`injected ${checkpoint}`);
					}
				})
			).toThrow(`injected ${checkpoint}`);
			expect(readFileSync(commonConfig)).toEqual(commonBefore);
			expect(existsSync(worktreeConfig)).toBe(false);
			expect(existsSync(own)).toBe(false);
			expect(runGit({ args: ['write-tree'], cwd: worktree }).stdout.trim()).toBe(indexBefore);
			expect(runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: worktree }).stdout).toBe(statusBefore);
		}
	);

	it('refuses a foreign value of extensions.worktreeConfig', () => {
		const { main, worktree } = makeLinkedWorktree('exclude-foreign-extension');
		// Git itself only accepts true here, but the shared extension slot is
		// read before any write: an unexpected value is a human decision.
		runGit({ args: ['config', '--local', 'extensions.worktreeConfig', 'false'], cwd: main });
		expect(() => writeExclude(worktree, 'patchset')).toThrow(/extensions\.worktreeConfig/);
	});

	it('refuses foreign content in the codkit-owned exclude file', () => {
		const { worktree } = makeLinkedWorktree('exclude-foreign-own-file');
		const own = join(perWorktreeDir(worktree), ...OWN_EXCLUDE_RELATIVE_PATH.split('/'));
		mkdirSync(dirname(own), { recursive: true });
		writeFileSync(own, '/somebody-else/\n', 'utf8');
		expect(() => writeExclude(worktree, 'patchset')).toThrow(/foreign content/);
		expect(readFileSync(own, 'utf8')).toBe('/somebody-else/\n');
	});

	it('ignores an exclude file planted at the per-worktree location Git never reads', () => {
		const { worktree } = makeLinkedWorktree('exclude-negative');
		writeExclude(worktree, 'patchset');
		writeFileSync(join(worktree, 'loose.txt'), 'user file\n', 'utf8');

		// The old appended location with an exclude-everything pattern: if Git
		// consulted it, the loose file would vanish from status. It must not.
		const ignored = join(perWorktreeDir(worktree), 'info', 'exclude');
		mkdirSync(dirname(ignored), { recursive: true });
		writeFileSync(ignored, '*\n', 'utf8');
		const status = runGit({ args: ['status', '--porcelain', '--untracked-files=all'], cwd: worktree });
		expect(status.status).toBe(0);
		expect(status.stdout).toContain('?? loose.txt');
	});

	it('still installs the executable blocking hook in a normal repository checkout', () => {
		const { main } = makeLinkedWorktree('hook-normal');
		const hook = gitPathOf(main, 'hooks/pre-commit');
		expect(hook).toBe(join(main, '.git', 'hooks', 'pre-commit'));

		expect(writeTreeHook(main, hookOutput())).toBe(true);
		expect(readFileSync(hook, 'utf8')).toContain('codkit save');
		expect((statSync(hook).mode & 0o111) !== 0).toBe(true);

		const refused = manualCommit(main);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('codkit save');
	});

	it('refuses to touch the shared hook of a linked worktree and warns that the guard is off', () => {
		const { main, worktree } = makeLinkedWorktree('hook-shared');
		const sentinel = gitPathOf(worktree, 'hooks/pre-commit');
		plantSentinel(sentinel);
		const bytes = readFileSync(sentinel, 'utf8');
		const mode = statSync(sentinel).mode;

		const warned = collectingOutput();
		expect(writeTreeHook(worktree, warned.out)).toBe(false);

		// The common hook is byte- and mode-identical, and nothing appears at
		// the old per-worktree appended location either.
		expect(readFileSync(sentinel, 'utf8')).toBe(bytes);
		expect(statSync(sentinel).mode).toBe(mode);
		expect(existsSync(join(perWorktreeDir(worktree), 'hooks', 'pre-commit'))).toBe(false);
		const text = warned.lines.join('\n').toLowerCase();
		expect(text).toContain('manual-commit guard is unavailable');
		expect(text).toContain('sibling worktree');

		// The main checkout stays governed by the sentinel alone: its veto is
		// the reason a commit fails there, and codkit's hint is nowhere.
		const mainCommit = manualCommit(main);
		expect(mainCommit.status).not.toBe(0);
		expect(mainCommit.stderr).toContain('sentinel-veto');
		expect(mainCommit.stderr).not.toContain('codkit save');
	});

	it('leaves a linked worktree without any codkit hook, so manual commits simply go through', () => {
		const { worktree } = makeLinkedWorktree('hook-unguarded');
		const warned = collectingOutput();
		expect(writeTreeHook(worktree, warned.out)).toBe(false);

		expect(manualCommit(worktree).status).toBe(0);
		expect(existsSync(join(perWorktreeDir(worktree), 'hooks', 'pre-commit'))).toBe(false);
	});

	it('keeps the tree mark in the per-worktree admin directory, not the common one', () => {
		const { worktree } = makeLinkedWorktree('mark-per-worktree');
		expect(writeTreeMark(worktree, MARK, () => {})).toBe(true);

		const perWorktree = perWorktreeDir(worktree);
		const markPath = join(perWorktree, 'codkit', 'applied.json');
		expect(existsSync(markPath)).toBe(true);
		expect(gitPathOf(worktree, 'codkit/applied.json')).toBe(markPath);
		const common = runGit({ args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: worktree });
		expect(common.status).toBe(0);
		const shared = join(common.stdout.trim(), 'codkit', 'applied.json');
		expect(markPath).not.toBe(shared);
		expect(existsSync(shared)).toBe(false);
	});
});

describe('a normal repository with a custom core.hooksPath', () => {
	/**
	 * A repository whose git takes hooks from an external directory: the setup a
	 * user (or a site-wide hooks collection) has, and the one place codkit must
	 * never write to, even though `--git-path hooks/pre-commit` names it.
	 */
	function makeCustomHooksRepo(label: string): { readonly repo: string; readonly sentinel: string } {
		const repo = makeNormalRepo(`${label}-repo`);
		const sentinel = join(makeTempRoot(`${label}-external`), 'pre-commit');
		plantSentinel(sentinel);
		runGit({ args: ['config', 'core.hooksPath', dirname(sentinel)], cwd: repo });
		return { repo, sentinel };
	}

	it('writes only its own admin hook and reports the guard as unavailable', () => {
		const { repo, sentinel } = makeCustomHooksRepo('hook-custom');
		// The premise of the scenario: while the config stands, git really
		// resolves the hook to the external directory, not the repo's own.
		expect(gitPathOf(repo, 'hooks/pre-commit')).toBe(sentinel);
		const bytes = readFileSync(sentinel, 'utf8');
		const mode = statSync(sentinel).mode;

		const warned = collectingOutput();
		expect(writeTreeHook(repo, warned.out)).toBe(false);

		// The external hook is byte- and mode-identical: codkit never follows
		// core.hooksPath out of the repository's administrative directory.
		expect(readFileSync(sentinel, 'utf8')).toBe(bytes);
		expect(statSync(sentinel).mode).toBe(mode);

		// The repository's own administrative hook is installed and executable.
		const adminHook = join(repo, '.git', 'hooks', 'pre-commit');
		expect(readFileSync(adminHook, 'utf8')).toContain('codkit save');
		expect((statSync(adminHook).mode & 0o111) !== 0).toBe(true);

		const text = warned.lines.join('\n').toLowerCase();
		expect(text).toContain('core.hookspath');
		expect(text).toContain('manual-commit guard is unavailable');

		// The honest effect: git keeps executing the configured custom hook, so
		// the veto a manual commit meets is the sentinel's and codkit's hint is
		// nowhere - the guard is unavailable while that config remains.
		const refused = manualCommit(repo);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('sentinel-veto');
		expect(refused.stderr).not.toContain('codkit save');
	});

	it('has the admin hook become the live guard once the custom hooksPath is gone', () => {
		const { repo } = makeCustomHooksRepo('hook-custom-restored');
		const warned = collectingOutput();
		expect(writeTreeHook(repo, warned.out)).toBe(false);

		runGit({ args: ['config', '--unset', 'core.hooksPath'], cwd: repo });
		const refused = manualCommit(repo);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('codkit save');
	});
});

describe('the commit guard across every git config scope', () => {
	/** A temporary machine-level git config naming an external hooks directory. */
	function makeGlobalHooksConfig(label: string): { readonly path: string; readonly sentinel: string } {
		const external = makeTempRoot(`${label}-external`);
		const sentinel = join(external, 'pre-commit');
		plantSentinel(sentinel);
		const config = join(makeTempRoot(`${label}-config`), 'gitconfig');
		writeFileSync(config, `[core]\n\thooksPath = ${external}\n`, 'utf8');
		return { path: config, sentinel };
	}

	it("reports the guard unavailable while a global core.hooksPath redirects the user's git", () => {
		const repo = makeNormalRepo('hook-global-hookspath');
		const global = makeGlobalHooksConfig('hook-global-hookspath');
		const previous = process.env['GIT_CONFIG_GLOBAL'];
		process.env['GIT_CONFIG_GLOBAL'] = global.path;
		try {
			const warned = collectingOutput();
			expect(writeTreeHook(repo, warned.out)).toBe(false);
			const text = warned.lines.join('\n').toLowerCase();
			expect(text).toContain('core.hookspath');
			expect(text).toContain('manual-commit guard is unavailable');

			// The honest effect: the user's git runs the machine-level sentinel,
			// not the codkit hook that sits in the repository's admin dir.
			const refused = manualCommit(repo);
			expect(refused.status).not.toBe(0);
			expect(refused.stderr).toContain('sentinel-veto');
			expect(refused.stderr).not.toContain('codkit save');
		} finally {
			if (previous === undefined) {
				delete process.env['GIT_CONFIG_GLOBAL'];
			} else {
				process.env['GIT_CONFIG_GLOBAL'] = previous;
			}
		}
	});

	it('never treats a failing path resolution as proof of an active guard (core.hooksPath=/dev/null)', () => {
		const repo = makeNormalRepo('hook-devnull');
		runGit({ args: ['config', 'core.hooksPath', '/dev/null'], cwd: repo });

		const warned = collectingOutput();
		expect(writeTreeHook(repo, warned.out)).toBe(false);
		const text = warned.lines.join('\n').toLowerCase();
		expect(text).toContain('cannot prove');
		expect(text).toContain('manual-commit guard');

		// The honest effect: with hooks at /dev/null nothing refuses a manual
		// commit, and codkit did not claim otherwise.
		expect(manualCommit(repo).status).toBe(0);
		// The repository's own copy is still installed, and becomes the guard
		// once the broken config is gone.
		const adminHook = join(repo, '.git', 'hooks', 'pre-commit');
		expect(readFileSync(adminHook, 'utf8')).toContain('codkit save');
		runGit({ args: ['config', '--unset', 'core.hooksPath'], cwd: repo });
		const refused = manualCommit(repo);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('codkit save');
	});
});

describe('a foreign pre-commit hook in a normal repository', () => {
	it('is never overwritten: byte- and mode-identical, guard reported unavailable', () => {
		const repo = makeNormalRepo('hook-foreign');
		const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
		plantSentinel(hookPath);
		const bytes = readFileSync(hookPath, 'utf8');
		const mode = statSync(hookPath).mode;

		const warned = collectingOutput();
		expect(writeTreeHook(repo, warned.out)).toBe(false);
		expect(readFileSync(hookPath, 'utf8')).toBe(bytes);
		expect(statSync(hookPath).mode).toBe(mode);
		const text = warned.lines.join('\n').toLowerCase();
		expect(text).toContain('foreign');
		expect(text).toContain('manual-commit guard');

		// The foreign hook keeps governing the repository on its own terms.
		const refused = manualCommit(repo);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('sentinel-veto');
	});

	it('renews a hook an older codkit wrote without the ownership marker', () => {
		const repo = makeNormalRepo('hook-legacy-ours');
		const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
		mkdirSync(dirname(hookPath), { recursive: true });
		writeFileSync(
			hookPath,
			[
				'#!/bin/sh',
				'# Installed by codkit. Commits in this fork tree are made by codkit only.',
				'if [ "$CODKIT_INTERNAL_COMMIT" != "1" ]; then',
				'\techo "codkit: manual commits in the fork tree are forbidden;" >&2',
				'\techo "codkit: save your work with: codkit save (from the patchset repo)." >&2',
				'\techo "codkit: This tree is managed by codkit." >&2',
				'\texit 1',
				'fi',
				'exit 0',
				''
			].join('\n'),
			'utf8'
		);
		chmodSync(hookPath, 0o755);

		const warned = collectingOutput();
		expect(writeTreeHook(repo, warned.out)).toBe(true);
		const renewed = readFileSync(hookPath, 'utf8');
		expect(renewed).toContain('# codkit-hook v1');
		expect(renewed).toContain('codkit save');
		const refused = manualCommit(repo);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('codkit save');
	});
});

describe('a tree git cannot resolve', () => {
	it('keeps the isolated non-repository fallback for managed-block byte tests', () => {
		const tree = makeTempRoot('exclude-unresolvable');
		mkdirSync(join(tree, '.git', 'info'), { recursive: true });
		writeFileSync(join(tree, '.git', 'info', 'exclude'), '# user\n', 'utf8');

		writeExclude(tree, 'patchset');
		expect(readFileSync(join(tree, '.git', 'info', 'exclude'), 'utf8')).toBe(
			`# user\n\n${EXCLUDE_BEGIN}\n/src/vs/patchset/\n${EXCLUDE_END}\n`
		);
	});
});
