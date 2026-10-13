import { deepStrictEqual, equal, match, throws } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mirrorRepository, pushArgs, readTargets } from '../lib/mirror.mjs';

function git(root, ...args) {
	const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
	if (result.status !== 0) throw new Error(result.stderr || result.stdout);
	return result.stdout.trim();
}

function write(root, name, text) {
	const parts = name.split('/');
	if (parts.length > 1) mkdirSync(join(root, ...parts.slice(0, -1)), { recursive: true });
	writeFileSync(join(root, name), text);
}

function identity(root) {
	git(root, 'config', 'user.name', 'Mirror Test');
	git(root, 'config', 'user.email', 'mirror@example.invalid');
	git(root, 'config', 'core.autocrlf', 'false');
}

function fixture(body) {
	const folder = mkdtempSync(join(tmpdir(), 'codkit-mirror-'));
	try {
		const root = join(folder, 'codkit');
		mkdirSync(root);
		git(root, 'init', '--quiet', '--initial-branch=main');
		identity(root);
		write(root, 'package.json', '{"name":"codkit-workspace"}\n');
		write(root, 'packages/codkit/package.json', '{"name":"codkit"}\n');
		const targets = ['github', 'gitverse'].map((name) => {
			const url = join(folder, name + '.git');
			git(folder, 'init', '--bare', '--quiet', '--initial-branch=main', url);
			return { name, url, refs: ['main', 'tags'] };
		});
		write(root, 'mirrors.json', JSON.stringify({ schema: 1, targets }));
		git(root, 'add', '.');
		git(root, 'commit', '--quiet', '-m', 'fixture: initial Codkit');
		return body({ root, targets, folder });
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
}

function ref(root, name = 'refs/heads/main') {
	return git(root, 'rev-parse', '--verify', name);
}

test('fans only declared Codkit refs to both repositories and preserves annotated tags', () =>
	fixture(({ root, targets }) => {
		git(root, 'tag', '-a', 'v1.0.0', '-m', 'release');
		git(root, 'branch', 'feature/nimbus');
		git(root, 'update-ref', 'refs/private/do-not-publish', ref(root));
		git(root, 'remote', 'add', 'github', targets[0].url);
		git(root, 'config', 'push.followTags', 'true');
		const messages = [];
		equal(mirrorRepository(root, { log: (line) => messages.push(line) }).exitCode, 0);
		for (const { url } of targets) {
			equal(ref(url), ref(root));
			equal(ref(url, 'refs/tags/v1.0.0'), ref(root, 'refs/tags/v1.0.0'));
			deepStrictEqual(git(url, 'for-each-ref', '--format=%(refname)').split('\n'), ['refs/heads/main', 'refs/tags/v1.0.0']);
		}
		equal(ref(root, 'refs/remotes/github/main'), ref(root));
		equal(mirrorRepository(root, { check: true }).inSync, true);
		match(messages.join('\n'), /all targets in sync/);
	}));

test('check reports empty and behind refs honestly without updating remote refs', () =>
	fixture(({ root, targets }) => {
		const empty = mirrorRepository(root, { check: true });
		equal(empty.exitCode, 1);
		equal(git(targets[0].url, 'for-each-ref'), '');
		equal(mirrorRepository(root).exitCode, 0);
		const old = ref(root);
		write(root, 'new.txt', 'new');
		git(root, 'add', '.');
		git(root, 'commit', '--quiet', '-m', 'fixture: new integrated change');
		const behind = mirrorRepository(root, { check: true });
		equal(behind.exitCode, 0);
		equal(behind.inSync, false);
		for (const { url } of targets) equal(ref(url), old);
		equal(mirrorRepository(root).exitCode, 0);
		for (const { url } of targets) equal(ref(url), ref(root));
	}));

test('a diverged target remains untouched while the other target receives main', () =>
	fixture(({ root, targets, folder }) => {
		equal(mirrorRepository(root).exitCode, 0);
		const other = join(folder, 'web');
		git(folder, 'clone', '--quiet', targets[0].url, other);
		identity(other);
		write(other, 'web.txt', 'accepted elsewhere');
		git(other, 'add', '.');
		git(other, 'commit', '--quiet', '-m', 'fixture: remote change');
		git(other, 'push', '--quiet', 'origin', 'main');
		const remote = ref(other);
		write(root, 'local.txt', 'integrated locally');
		git(root, 'add', '.');
		git(root, 'commit', '--quiet', '-m', 'fixture: local change');
		const result = mirrorRepository(root);
		equal(result.exitCode, 1);
		equal(result.results[0].state, 'DRIFT');
		equal(ref(targets[0].url), remote);
		equal(ref(targets[1].url), ref(root));
		throws(() => mirrorRepository(root, { from: 'github' }), /fast-forward/i);
		equal(ref(targets[0].url), remote);
	}));

test('an accepted web merge comes home through ff-only and is then fanned out', () =>
	fixture(({ root, targets, folder }) => {
		equal(mirrorRepository(root).exitCode, 0);
		const other = join(folder, 'web');
		git(folder, 'clone', '--quiet', targets[0].url, other);
		identity(other);
		write(other, 'web.txt', 'accepted PR');
		git(other, 'add', '.');
		git(other, 'commit', '--quiet', '-m', 'fixture: accepted PR');
		git(other, 'push', '--quiet', 'origin', 'main');
		equal(mirrorRepository(root, { from: 'github' }).exitCode, 0);
		for (const { url } of targets) equal(ref(url), ref(other));
		equal(ref(root), ref(other));
	}));

test('deletions do not propagate and a changed remote tag blocks its target', () =>
	fixture(({ root, targets }) => {
		git(root, 'tag', 'v1.0.0');
		equal(mirrorRepository(root).exitCode, 0);
		const original = ref(root);
		git(root, 'tag', '-d', 'v1.0.0');
		equal(mirrorRepository(root).exitCode, 0);
		for (const { url } of targets) equal(ref(url, 'refs/tags/v1.0.0'), original);
		write(root, 'new.txt', 'new');
		git(root, 'add', '.');
		git(root, 'commit', '--quiet', '-m', 'fixture: newer release');
		git(root, 'tag', 'v1.0.0');
		equal(mirrorRepository(root).exitCode, 1);
		for (const { url } of targets) {
			equal(ref(url), original);
			equal(ref(url, 'refs/tags/v1.0.0'), original);
		}
	}));

test('a web merge changing repository identity cannot fan Nimbus out to another host', () =>
	fixture(({ root, targets, folder }) => {
		equal(mirrorRepository(root).exitCode, 0);
		const old = ref(root);
		const other = join(folder, 'web');
		git(folder, 'clone', '--quiet', targets[0].url, other);
		identity(other);
		write(other, 'package.json', '{"name":"nimbus"}');
		git(other, 'add', '.');
		git(other, 'commit', '--quiet', '-m', 'fixture: incompatible repository');
		git(other, 'push', '--quiet', 'origin', 'main');
		throws(() => mirrorRepository(root, { from: 'github' }), /other than Codkit/);
		equal(ref(targets[1].url), old);
	}));

test('the manifest brought home in a web merge supplies the target set for that fan-out', () =>
	fixture(({ root, targets, folder }) => {
		equal(mirrorRepository(root).exitCode, 0);
		const other = join(folder, 'web');
		git(folder, 'clone', '--quiet', targets[0].url, other);
		identity(other);
		const url = join(folder, 'new-host.git');
		git(folder, 'init', '--bare', '--quiet', '--initial-branch=main', url);
		const doc = JSON.parse(readFileSync(join(other, 'mirrors.json'), 'utf8'));
		doc.targets.push({ name: 'new-host', url, refs: ['main'] });
		write(other, 'mirrors.json', JSON.stringify(doc));
		git(other, 'add', '.');
		git(other, 'commit', '--quiet', '-m', 'fixture: onboard new host');
		git(other, 'push', '--quiet', 'origin', 'main');
		equal(mirrorRepository(root, { from: 'github' }).exitCode, 0);
		equal(ref(url), ref(other));
	}));

test('transport failure is reported separately and does not stop the reachable target', () =>
	fixture(({ root, targets, folder }) => {
		const doc = JSON.parse(readFileSync(join(root, 'mirrors.json'), 'utf8'));
		doc.targets[0].url = join(folder, 'absent.git');
		write(root, 'mirrors.json', JSON.stringify(doc));
		const result = mirrorRepository(root);
		equal(result.exitCode, 1);
		equal(result.results[0].state, 'FAILED');
		equal(result.results[1].state, 'SYNC');
		equal(ref(targets[1].url), ref(root));
	}));

test('manifest validation and repository identity refuse unsafe scope before publication', () =>
	fixture(({ root, targets }) => {
		const original = JSON.parse(readFileSync(join(root, 'mirrors.json'), 'utf8'));
		for (const edit of [
			(doc) => {
				doc.schema = 2;
			},
			(doc) => {
				doc.targets[0].refs = ['main:other'];
			},
			(doc) => {
				doc.targets[0].refs = ['main', 'main'];
			},
			(doc) => {
				doc.targets[1].name = doc.targets[0].name;
			},
			(doc) => {
				doc.targets[0].url = 'https://user:password@example.invalid/repo';
			}
		]) {
			const doc = structuredClone(original);
			edit(doc);
			write(root, 'mirrors.json', JSON.stringify(doc));
			throws(() => readTargets(root));
		}
		write(root, 'mirrors.json', JSON.stringify(original));
		write(root, 'package.json', '{"name":"nimbus"}');
		throws(() => mirrorRepository(root), /other than Codkit/);
		for (const { url } of targets) equal(git(url, 'for-each-ref'), '');
	}));

test('push argv has one pinned non-force ref and suppresses implicit followTags', () => {
	const oid = 'a'.repeat(40);
	deepStrictEqual(pushArgs('https://github.com/vibevm/codkit.git', { oid, name: 'refs/heads/main' }), [
		'-c',
		'push.followTags=false',
		'push',
		'--',
		'https://github.com/vibevm/codkit.git',
		`${oid}:refs/heads/main`
	]);
	for (const name of ['+refs/heads/main', 'refs/heads/main:other', 'refs/heads/*', ':refs/heads/main']) {
		throws(() => pushArgs('https://github.com/vibevm/codkit.git', { oid, name }));
	}
});
