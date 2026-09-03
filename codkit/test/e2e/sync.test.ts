// e2e: `codkit sync` through the real launcher, on the fixture pair.
//
// Contracts under test: PROP-007 sec. 5 (##CMD-SYNC), PROP-008 sec. 3 (the
// pseudocode), PROP-006 sec. 1 (fast path, mark, cache), PROP-011 sec. 4
// (--fresh whitelist), PROP-012 sec. 5 (##FORK-TREE-PRECOMMIT-HOOK).
//
// The fork tree here is never the upstream fixture directory itself: it is a
// clone of a bare mirror, detached at the pin, the way a developer's tree is.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { treeId } from '../../src/lib/fingerprint.ts';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { EXAMPLE_PART_PATH, makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { PATCH_ID, makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launcher = join(repoRoot, 'codkit', 'bin', 'codkit.mjs');

const BRANCH = 'codkit/applied/t1';
const OWN_FILE = 'src/vs/patchset/hello.ts';
const RESOURCE_TARGET = 'resources/app-icon.bin';

type Run = { status: number; stdout: string; stderr: string };

type Envelope = {
	ok: boolean;
	exitCode: number;
	roots: { fork: { path: string; source: string; exists: boolean } | null };
	data: {
		status?: string;
		branch?: string;
		branchTip?: string | null;
		artifacts?: number;
		own?: { total: number; copied: number; removed: number };
		changedFiles?: number;
		cleaned?: number;
		dirtyFiles?: string[];
		brokenArtifacts?: string[];
		fastPathReason?: string;
	};
	messages: { level: string; code?: string; text: string }[];
	errors: { code: string; message: string; hint?: string }[];
};

let upstream: UpstreamFixture;
let patchsetFixture: string;
let bareMirror: string;

beforeAll(() => {
	upstream = makeUpstream(makeTempRoot('sync-upstream'));
	patchsetFixture = makeTempRoot('sync-patchset');
	makePatchSet(patchsetFixture, upstream);

	const mirrorRoot = makeTempRoot('sync-mirror');
	bareMirror = join(mirrorRoot, 'upstream.git');
	runGit({ args: ['clone', '--bare', '--quiet', upstream.dir, bareMirror], cwd: mirrorRoot, netAllowed: true });
});

afterAll(() => {
	cleanupTempRoots();
});

/** A fork tree as a developer has it: a clone, detached at the pin. */
function freshTree(at: string): string {
	rmSync(at, { recursive: true, force: true });
	mkdirSync(dirname(at), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', bareMirror, at], cwd: dirname(at), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', upstream.t1.sha], cwd: at });
	return at;
}

function treePath(label: string): string {
	return join(makeTempRoot(label), 'fork-tree');
}

function runCli(args: readonly string[], extraEnv: Record<string, string> = {}): Run {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	delete env['CODKIT_FORK_DIR'];
	env['CODKIT_PATCHES_DIR'] = patchsetFixture;
	Object.assign(env, extraEnv);
	const result = spawnSync(process.execPath, [launcher, ...args], { cwd: patchsetFixture, env, encoding: 'utf8' });
	return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sync(tree: string, extra: readonly string[] = []): { run: Run; envelope: Envelope } {
	const run = runCli(['sync', '--json', '--fork-dir', tree, ...extra]);
	return { run, envelope: JSON.parse(run.stdout) as Envelope };
}

function git(tree: string, args: readonly string[], env?: GitEnv): { status: number; stdout: string; stderr: string } {
	return runGit(env === undefined ? { args, cwd: tree } : { args, cwd: tree, env });
}

function gitOut(tree: string, args: readonly string[]): string {
	return git(tree, args).stdout.trim();
}

/** mtime of every file under a directory, keyed by relative path. */
function mtimes(root: string, relative = ''): Map<string, number> {
	const out = new Map<string, number>();
	const absolute = relative === '' ? root : join(root, relative);
	let entries: string[];
	try {
		entries = readdirSync(absolute);
	} catch {
		return out;
	}
	for (const name of entries) {
		const child = relative === '' ? name : `${relative}/${name}`;
		const stats = statSync(join(root, child));
		if (stats.isDirectory()) {
			for (const [key, value] of mtimes(root, child)) {
				out.set(key, value);
			}
			continue;
		}
		out.set(child, stats.mtimeMs);
	}
	return out;
}

describe('codkit sync: applying the delta (S01)', () => {
	let tree: string;
	let envelope: Envelope;

	beforeAll(() => {
		tree = freshTree(treePath('sync-s01'));
		const outcome = sync(tree);
		expect(outcome.run.status).toBe(0);
		envelope = outcome.envelope;
	});

	it('reports a successful apply', () => {
		expect(envelope.ok).toBe(true);
		expect(envelope.errors).toEqual([]);
		expect(envelope.data.status).toBe('applied');
		expect(envelope.data.branch).toBe(BRANCH);
		expect(envelope.data.artifacts).toBe(2);
	});

	it('puts HEAD on the generated branch and leaves the tree clean', () => {
		expect(gitOut(tree, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${BRANCH}`);
		expect(gitOut(tree, ['rev-parse', `refs/heads/${BRANCH}`])).toBe(envelope.data.branchTip);
		expect(gitOut(tree, ['status', '--porcelain'])).toBe('');
	});

	it('materializes own code without letting git see it', () => {
		expect(existsSync(join(tree, OWN_FILE))).toBe(true);
		expect(readFileSync(join(tree, OWN_FILE), 'utf8')).toContain('export function hello');
		// The exclude block is what keeps it invisible, not luck.
		const exclude = readFileSync(join(tree, '.git', 'info', 'exclude'), 'utf8');
		expect(exclude).toContain('# codkit:begin managed');
		expect(exclude).toContain('/src/vs/patchset/');
		expect(exclude).toContain('# codkit:end managed');
		expect(gitOut(tree, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
	});

	it('writes the dev channel of the config-overlay layer', () => {
		const overrides = JSON.parse(readFileSync(join(tree, 'product.overrides.json'), 'utf8')) as Record<string, unknown>;
		expect(overrides['nameShort']).toBe('Fixture PatchSet');
		// $var is substituted at materialization time.
		expect(overrides['patchsetUpstreamPin']).toBe('t1');
		// The upstream file itself is untouched by the dev channel.
		expect(JSON.parse(readFileSync(join(tree, 'product.json'), 'utf8'))['nameShort']).toBe('Fixture - OSS');
	});

	it('carries the marker block of the patch on HEAD', () => {
		const onHead = git(tree, ['show', `HEAD:${EXAMPLE_PART_PATH}`]).stdout;
		expect(onHead).toContain(`// codkit:begin ${PATCH_ID}`);
		expect(onHead).toContain(`// codkit:end ${PATCH_ID}`);
		expect(readFileSync(join(tree, EXAMPLE_PART_PATH), 'utf8')).toContain(`// codkit:begin ${PATCH_ID}`);
	});

	it('replaces the resource target with our bytes', () => {
		const inTree = readFileSync(join(tree, RESOURCE_TARGET));
		const inPatchSet = readFileSync(join(patchsetFixture, 'delta', 'resources', 'files', 'app-icon.bin'));
		expect(Buffer.from(inTree).equals(Buffer.from(inPatchSet))).toBe(true);
	});

	it('signs the generated commits with the codkit identity, the pin date and the trailers', () => {
		const log = gitOut(tree, ['log', '--format=%an <%ae>%n%cI%n%B---', `${upstream.t1.sha}..HEAD`]);
		const expectedDate = gitOut(tree, ['log', '-1', '--format=%cI', upstream.t1.sha]);
		expect(log).toContain('codkit <codkit@patchset.invalid>');
		expect(log.split('\n').filter((line) => line === expectedDate).length).toBe(2);
		expect(log).toContain(`Codkit-Artifact: ${PATCH_ID}`);
		expect(log).toContain(`Codkit-Upstream-Pin: t1@${upstream.t1.sha}`);
		expect(log).toContain('Codkit-Patchset-Commit: ');
		// The commit subject names the artifact and the path it touched.
		expect(log).toContain(`codkit: ${PATCH_ID} ${EXAMPLE_PART_PATH}`);
	});

	it('agrees with its own mark and cache', () => {
		const mark = JSON.parse(readFileSync(join(tree, '.git', 'codkit', 'applied.json'), 'utf8')) as Record<string, unknown>;
		const cachePath = join(patchsetFixture, '.codkit', 'trees', `${treeId(tree)}.json`);
		const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
		expect(mark['branchTip']).toBe(envelope.data.branchTip);
		expect(cache['branchTip']).toBe(envelope.data.branchTip);
		expect(mark['deltaFingerprint']).toBe(cache['deltaFingerprint']);
		expect(mark['pinSha']).toBe(upstream.t1.sha);
		expect(cache['treeRepoAnchor']).toBe(upstream.anchorSha);
	});

	it('installs the pre-commit hook that refuses manual commits', () => {
		const hook = join(tree, '.git', 'hooks', 'pre-commit');
		expect(existsSync(hook)).toBe(true);
		expect(readFileSync(hook, 'utf8')).toContain('codkit save');
		// Executable, or git would ignore it.
		expect((statSync(hook).mode & 0o111) !== 0).toBe(true);
	});

	it('is a no-op on the second run and does not touch mtimes (S03)', () => {
		const before = mtimes(join(tree, 'src', 'vs', 'workbench'));
		const outcome = sync(tree);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data.status).toBe('up-to-date');
		expect(outcome.envelope.messages.some((message) => message.text === 'up to date')).toBe(true);
		const after = mtimes(join(tree, 'src', 'vs', 'workbench'));
		expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
		for (const [path, when] of before) {
			expect(after.get(path)).toBe(when);
		}
	});

	it('re-applies from scratch when the tree is swapped underneath (S15)', () => {
		const tipBefore = envelope.data.branchTip;
		freshTree(tree);
		expect(git(tree, ['rev-parse', '--verify', `refs/heads/${BRANCH}`]).status).not.toBe(0);

		const outcome = sync(tree);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data.status).toBe('applied');
		expect(outcome.envelope.messages.some((message) => message.text === 'up to date')).toBe(false);
		// Deterministic: the same delta on the same pin yields the same tip.
		expect(outcome.envelope.data.branchTip).toBe(tipBefore);
		const mark = JSON.parse(readFileSync(join(tree, '.git', 'codkit', 'applied.json'), 'utf8')) as Record<string, unknown>;
		expect(mark['branchTip']).toBe(tipBefore);
	});
});

describe('codkit sync: determinism (S16)', () => {
	it('produces the same tip in two unrelated trees', () => {
		const first = sync(freshTree(treePath('sync-det-a')));
		const second = sync(freshTree(treePath('sync-det-b')));

		expect(first.run.status).toBe(0);
		expect(second.run.status).toBe(0);
		expect(first.envelope.data.branchTip).toBe(second.envelope.data.branchTip);
		expect(first.envelope.data.branchTip).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe('codkit sync: the drift guard', () => {
	it('refuses to run over an unextracted edit and leaves the tree alone', () => {
		const tree = freshTree(treePath('sync-guard'));
		const first = sync(tree);
		expect(first.run.status).toBe(0);
		const tipBefore = gitOut(tree, ['rev-parse', 'HEAD']);

		const target = join(tree, EXAMPLE_PART_PATH);
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}\n// an unmarked local edit\n`, 'utf8');

		const outcome = sync(tree);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.hint).toContain('codkit save');
		expect(outcome.envelope.data.dirtyFiles).toContain(EXAMPLE_PART_PATH);
		// Nothing was rebuilt and nothing was reverted.
		expect(gitOut(tree, ['rev-parse', 'HEAD'])).toBe(tipBefore);
		expect(readFileSync(target, 'utf8')).toContain('an unmarked local edit');
	});

	it('sees own code that git cannot see', () => {
		const tree = freshTree(treePath('sync-guard-own'));
		expect(sync(tree).run.status).toBe(0);

		writeFileSync(join(tree, OWN_FILE), '// edited in the tree, not in patchset\n', 'utf8');
		const outcome = sync(tree);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.data.dirtyFiles?.some((path) => path.startsWith(OWN_FILE))).toBe(true);
	});
});

describe('codkit sync: the unit manifest of own code', () => {
	const MANIFEST_IN_PATCHSET = 'patchset.delta.json';
	const MANIFEST_IN_TREE = 'src/vs/patchset/patchset.delta.json';

	it('delivers own code without the manifest that declares it', () => {
		const tree = freshTree(treePath('sync-manifest'));
		expect(sync(tree).run.status).toBe(0);

		expect(existsSync(join(tree, OWN_FILE))).toBe(true);
		// The manifest is a statement of patchset about own code, not a module of it:
		// in the tree it would be transpiled into out/ like any other file of src/.
		expect(existsSync(join(tree, MANIFEST_IN_TREE))).toBe(false);
		expect(existsSync(join(patchsetFixture, 'delta', 'own', MANIFEST_IN_PATCHSET))).toBe(true);
	});

	it('takes back one an earlier run materialized, and calls the tree clean afterwards', () => {
		const tree = freshTree(treePath('sync-manifest-stale'));
		expect(sync(tree).run.status).toBe(0);
		// The state a tree left by an older codkit is in.
		writeFileSync(join(tree, MANIFEST_IN_TREE), readFileSync(join(patchsetFixture, 'delta', 'own', MANIFEST_IN_PATCHSET), 'utf8'), 'utf8');

		const outcome = sync(tree);

		expect(outcome.run.status).toBe(0);
		expect(existsSync(join(tree, MANIFEST_IN_TREE))).toBe(false);
		expect(outcome.envelope.data.own?.removed).toBe(1);
		// And it was never unextracted work: `status` has nothing to say about it.
		const status = runCli(['status', '--json', '--fork-dir', tree]);
		expect(status.status).toBe(0);
		expect((JSON.parse(status.stdout) as { data: { own: { changed: number } } }).data.own.changed).toBe(0);
	});
});

describe('codkit sync --fresh', () => {
	it('removes untracked litter and keeps what the whitelist protects', () => {
		const tree = freshTree(treePath('sync-fresh'));
		expect(sync(tree).run.status).toBe(0);

		writeFileSync(join(tree, 'litter.txt'), 'left behind\n', 'utf8');
		mkdirSync(join(tree, 'scratch', 'deep'), { recursive: true });
		writeFileSync(join(tree, 'scratch', 'deep', 'note.md'), 'more litter\n', 'utf8');
		mkdirSync(join(tree, 'node_modules', 'pkg'), { recursive: true });
		writeFileSync(join(tree, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n', 'utf8');
		mkdirSync(join(tree, 'extensions', 'sample', 'out'), { recursive: true });
		writeFileSync(join(tree, 'extensions', 'sample', 'out', 'main.js'), 'built\n', 'utf8');
		mkdirSync(join(tree, '.build'), { recursive: true });
		writeFileSync(join(tree, '.build', 'stamp'), 'cache\n', 'utf8');

		const outcome = sync(tree, ['--fresh']);

		expect(outcome.run.status).toBe(0);
		expect(existsSync(join(tree, 'litter.txt'))).toBe(false);
		expect(existsSync(join(tree, 'scratch'))).toBe(false);
		expect(existsSync(join(tree, 'node_modules', 'pkg', 'index.js'))).toBe(true);
		expect(existsSync(join(tree, '.build', 'stamp'))).toBe(true);
		expect(existsSync(join(tree, 'extensions', 'sample', 'out', 'main.js'))).toBe(true);
		expect(existsSync(join(tree, OWN_FILE))).toBe(true);
		expect((outcome.envelope.data.cleaned ?? 0) >= 2).toBe(true);
	});
});

describe('codkit sync: the fork-tree hook', () => {
	it('refuses a manual commit and lets codkit through', () => {
		const tree = freshTree(treePath('sync-hook'));
		expect(sync(tree).run.status).toBe(0);
		const identity: GitEnv = {
			GIT_AUTHOR_NAME: 'human',
			GIT_AUTHOR_EMAIL: 'human@example.invalid',
			GIT_COMMITTER_NAME: 'human',
			GIT_COMMITTER_EMAIL: 'human@example.invalid'
		};

		const refused = gitLocal({ args: ['commit', '--allow-empty', '--message', 'by hand'], cwd: tree, env: identity });
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain('codkit save');

		const allowed = gitLocal({
			args: ['commit', '--allow-empty', '--quiet', '--message', 'by codkit'],
			cwd: tree,
			env: { ...identity, CODKIT_INTERNAL_COMMIT: '1' }
		});
		expect(allowed.status).toBe(0);

		// Put the branch back where sync left it, so nothing leaks into later runs.
		git(tree, ['reset', '--hard', 'HEAD~1']);
	});
});

describe('codkit sync --dry-run', () => {
	it('reports the plan without creating the branch', () => {
		const tree = freshTree(treePath('sync-dry'));

		const outcome = sync(tree, ['--dry-run']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data.status).toBe('dry-run');
		expect(outcome.envelope.data.artifacts).toBe(2);
		expect(outcome.envelope.messages.some((message) => message.text.includes('all applicable'))).toBe(true);
		expect(git(tree, ['rev-parse', '--verify', `refs/heads/${BRANCH}`]).status).not.toBe(0);
		expect(gitOut(tree, ['rev-parse', 'HEAD'])).toBe(upstream.t1.sha);
		expect(existsSync(join(tree, 'product.overrides.json'))).toBe(false);
	});

	it('does not run the guard and changes nothing on a dirty tree', () => {
		const tree = freshTree(treePath('sync-dry-dirty'));
		expect(sync(tree).run.status).toBe(0);
		const tipBefore = gitOut(tree, ['rev-parse', 'HEAD']);
		const target = join(tree, EXAMPLE_PART_PATH);
		writeFileSync(target, `${readFileSync(target, 'utf8')}\n// unextracted\n`, 'utf8');
		const before = mtimes(join(tree, 'src', 'vs', 'workbench'));

		const outcome = sync(tree, ['--dry-run']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		expect(gitOut(tree, ['rev-parse', 'HEAD'])).toBe(tipBefore);
		expect(readFileSync(target, 'utf8')).toContain('// unextracted');
		expect(mtimes(join(tree, 'src', 'vs', 'workbench'))).toEqual(before);
	});
});

describe('codkit sync: broken artifacts', () => {
	it('exits 1 and names the artifact when a patch does not apply at the pin', () => {
		const brokenPatchSet = makeTempRoot('sync-broken-patchset');
		makePatchSet(brokenPatchSet, upstream);
		const patches = join(brokenPatchSet, 'delta', 'patches');
		const [name] = readdirSync(patches);
		const patchPath = join(patches, name ?? '');
		// Break one context line: the patch no longer matches its own pin.
		const lines = readFileSync(patchPath, 'utf8').split('\n');
		const hunk = lines.findIndex((line) => line.startsWith('@@'));
		const context = lines.findIndex((line, index) => index > hunk && line.startsWith(' '));
		lines[context] = `${lines[context] ?? ''} // upstream moved`;
		writeFileSync(patchPath, lines.join('\n'), 'utf8');

		const tree = freshTree(treePath('sync-broken'));
		const run = runCli(['sync', '--json', '--fork-dir', tree], { CODKIT_PATCHES_DIR: brokenPatchSet });
		const envelope = JSON.parse(run.stdout) as Envelope;

		expect(run.status).toBe(1);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-ARTIFACT-BROKEN']);
		expect(envelope.errors[0]?.message).toContain('delta/patches/');
		expect(git(tree, ['rev-parse', '--verify', `refs/heads/${BRANCH}`]).status).not.toBe(0);
	});
});

describe('codkit sync --clone-if-missing', () => {
	it('is an environment failure when the tree is missing and the flag is absent', () => {
		const missing = treePath('sync-absent');
		const outcome = sync(missing);

		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-NOT-A-REPO']);
		expect(existsSync(missing)).toBe(false);
	});

	it('refuses in --ci before reaching the network', () => {
		const missing = treePath('sync-clone-ci');
		const run = runCli(['sync', '--json', '--ci', '--clone-if-missing', '--fork-dir', missing]);
		const envelope = JSON.parse(run.stdout) as Envelope;

		expect(run.status).toBe(2);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-NET-FORBIDDEN']);
		expect(existsSync(missing)).toBe(false);
	});

	it('asks for an explicit clone when there is no configured source', () => {
		const missing = treePath('sync-clone-nosource');
		const outcome = sync(missing, ['--clone-if-missing']);

		expect(outcome.run.status).toBe(2);
		const [error] = outcome.envelope.errors;
		expect(error?.code).toBe('CK-E-CONFIG');
		expect(error?.hint).toContain('codkit clone --from');
		expect(existsSync(missing)).toBe(false);
	});

	it('clones from the configured remote and applies the delta', () => {
		const missing = treePath('sync-clone-ok');
		const localConfig = join(patchsetFixture, 'codkit.local.json');
		writeFileSync(localConfig, `${JSON.stringify({ publishRemoteUrl: bareMirror }, null, 2)}\n`, 'utf8');
		try {
			const outcome = sync(missing, ['--clone-if-missing']);

			expect(outcome.run.status).toBe(0);
			expect(outcome.envelope.data.status).toBe('applied');
			expect(gitOut(missing, ['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${BRANCH}`);
			expect(gitOut(missing, ['status', '--porcelain'])).toBe('');
		} finally {
			rmSync(localConfig, { force: true });
		}
	});
});

describe('codkit sync: the lock', () => {
	it('refuses to start while another process holds the tree', () => {
		const tree = freshTree(treePath('sync-locked'));
		expect(sync(tree).run.status).toBe(0);

		const held = join(patchsetFixture, '.codkit', 'locks', `${treeId(tree)}.lock`);
		mkdirSync(dirname(held), { recursive: true });
		writeFileSync(held, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: 'save' }), 'utf8');
		try {
			const outcome = sync(tree);
			expect(outcome.run.status).toBe(2);
			expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-LOCKED']);
			expect(outcome.envelope.errors[0]?.hint).toContain(String(process.pid));
		} finally {
			rmSync(held, { force: true });
		}
	});
});
