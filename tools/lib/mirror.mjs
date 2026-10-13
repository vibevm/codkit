// spec://org.vibevm.world/source-mirrors/flows/source-mirrors/fanout-mechanics#root
// Replicate declared Codkit refs only. Never use Git's whole-repository mirror mode.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function git(root, args, required = true) {
	const result = spawnSync('git', args, {
		cwd: root,
		encoding: 'utf8',
		timeout: 120_000,
		maxBuffer: 8 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
	});
	if (result.error) throw new Error(`Git failed: ${result.error.message}`);
	if (required && result.status !== 0) throw new Error((result.stderr || result.stdout).trim() || `Git exited ${result.status}`);
	return result;
}

function object(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validUrl(value) {
	if (typeof value !== 'string' || value.length === 0 || /[\s\x00-\x1f]/.test(value)) return false;
	if (isAbsolute(value)) return true; // Local bare repositories for offline integration tests.
	if (/^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(value)) return true;
	try {
		const url = new URL(value);
		return (
			['https:', 'ssh:', 'file:'].includes(url.protocol) &&
			!url.password &&
			!url.search &&
			!url.hash &&
			(url.protocol === 'ssh:' ? url.username === 'git' : !url.username)
		);
	} catch {
		return false;
	}
}

export function readTargets(root) {
	const doc = JSON.parse(readFileSync(join(root, 'mirrors.json'), 'utf8'));
	if (
		!object(doc) ||
		doc.schema !== 1 ||
		!Array.isArray(doc.targets) ||
		doc.targets.length === 0 ||
		Object.keys(doc).some((key) => !['schema', 'targets'].includes(key))
	)
		throw new Error('Invalid mirrors.json schema');
	const names = new Set();
	for (const target of doc.targets) {
		if (
			!object(target) ||
			typeof target.name !== 'string' ||
			!/^[a-z][a-z0-9-]*$/.test(target.name) ||
			names.has(target.name) ||
			!validUrl(target.url) ||
			!Array.isArray(target.refs) ||
			target.refs.length === 0 ||
			Object.keys(target).some((key) => !['name', 'url', 'refs'].includes(key))
		)
			throw new Error('Invalid or duplicate mirror target');
		names.add(target.name);
		const refs = new Set();
		for (const ref of target.refs) {
			if (
				typeof ref !== 'string' ||
				refs.has(ref) ||
				(ref !== 'tags' && git(root, ['check-ref-format', `refs/heads/${ref}`], false).status !== 0)
			)
				throw new Error('Invalid mirror ref');
			refs.add(ref);
		}
	}
	return doc.targets;
}

function assertCodkitRoot(root) {
	const top = git(root, ['rev-parse', '--show-toplevel']).stdout.trim();
	if (realpathSync(top) !== realpathSync(root)) throw new Error('Mirror root must be the Git repository root');
	const workspace = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const cli = JSON.parse(readFileSync(join(root, 'packages/codkit/package.json'), 'utf8'));
	if (workspace.name !== 'codkit-workspace' || cli.name !== 'codkit') throw new Error('Refusing to publish a repository other than Codkit');
}

function snapshotRefs(root, target) {
	return target.refs.flatMap((ref) => {
		if (ref === 'tags') {
			return git(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/tags'])
				.stdout.trim()
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const [oid, name] = line.split(' ');
					return { oid, name };
				});
		}
		const name = `refs/heads/${ref}`;
		const oid = git(root, ['rev-parse', '--verify', `${name}^{commit}`]).stdout.trim();
		if (!OID.test(oid)) throw new Error(`Invalid local object for ${name}`);
		return [{ oid, name }];
	});
}

function probe(root, url, ref) {
	const lines = git(root, ['ls-remote', '--refs', '--', url, ref.name]).stdout.trim().split('\n').filter(Boolean);
	const record = lines.map((line) => line.split(/\s+/)).find(([, name]) => name === ref.name);
	if (record === undefined) return { ...ref, state: 'EMPTY' };
	const remoteOid = record[0];
	if (!OID.test(remoteOid)) throw new Error(`Invalid remote object for ${ref.name}`);
	if (remoteOid === ref.oid) return { ...ref, state: 'SYNC', remoteOid };
	if (ref.name.startsWith('refs/tags/')) return { ...ref, state: 'DRIFT', remoteOid };
	git(root, ['fetch', '--no-tags', '--no-write-fetch-head', '--', url, ref.name]);
	const ancestry = git(root, ['merge-base', '--is-ancestor', remoteOid, ref.oid], false);
	if (![0, 1].includes(ancestry.status)) throw new Error('Cannot inspect remote ancestry; retry the probe');
	return { ...ref, state: ancestry.status === 0 ? 'BEHIND' : 'DRIFT', remoteOid };
}

/** Push one exact snapshot without implicit branches, tags, deletions, or force refspecs. */
export function pushArgs(url, ref) {
	if (!validUrl(url) || !OID.test(ref.oid) || !/^refs\/(heads|tags)\//.test(ref.name) || /[\s:+*]/.test(ref.name)) {
		throw new Error('Invalid explicit push ref');
	}
	return ['-c', 'push.followTags=false', 'push', '--', url, `${ref.oid}:${ref.name}`];
}

function refreshTracking(root, url, ref) {
	if (!ref.name.startsWith('refs/heads/')) return;
	const normalize = (value) => value.replace(/\/$/, '').replace(/\.git$/, '');
	for (const name of git(root, ['remote']).stdout.trim().split('\n').filter(Boolean)) {
		const remote = git(root, ['remote', 'get-url', name]).stdout.trim();
		if (normalize(remote) === normalize(url)) git(root, ['update-ref', `refs/remotes/${name}/${ref.name.slice(11)}`, ref.oid]);
	}
}

function bringHome(root, targets, from) {
	const target = targets.find((item) => item.name === from);
	if (!target || !target.refs.includes('main')) throw new Error('--from must name a configured mainline target');
	if (git(root, ['status', '--porcelain']).stdout.trim()) throw new Error('--from requires a clean checkout');
	if (git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']).stdout.trim() !== 'main')
		throw new Error('--from requires main checked out');
	git(root, ['fetch', '--no-tags', '--', target.url, 'refs/heads/main']);
	git(root, ['merge', '--ff-only', 'FETCH_HEAD']);
}

export function mirrorRepository(root, { check = false, from, log = () => {} } = {}) {
	assertCodkitRoot(root);
	const targets = readTargets(root);
	if (check && from !== undefined) throw new Error('--check and --from cannot be combined');
	if (from !== undefined) bringHome(root, targets, from);
	const plans = targets.map((target) => ({ target, refs: snapshotRefs(root, target) }));
	const main = git(root, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).stdout.trim();
	log(`mirror${check ? ' --check' : ''}: Codkit main @ ${main}`);
	const results = [];
	for (const { target, refs } of plans) {
		try {
			const facts = refs.map((ref) => probe(root, target.url, ref));
			if (facts.some((ref) => ref.state === 'DRIFT')) {
				for (const ref of facts) log(`  ${ref.state} ${target.name} ${ref.name} ${ref.remoteOid ?? ''}`);
				results.push({ target: target.name, state: 'DRIFT', refs: facts });
				continue;
			}
			for (const ref of facts) {
				if (!check && ref.state !== 'SYNC') {
					git(root, pushArgs(target.url, ref));
					if (probe(root, target.url, ref).state !== 'SYNC') throw new Error(`Push did not leave ${ref.name} in sync`);
					ref.state = 'SYNC';
				}
				if (!check && ref.state === 'SYNC') refreshTracking(root, target.url, ref);
				log(`  ${ref.state} ${target.name} ${ref.name}`);
			}
			results.push({ target: target.name, state: facts.every((ref) => ref.state === 'SYNC') ? 'SYNC' : 'BEHIND', refs: facts });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const state = /non-fast-forward|\[rejected\]|fetch first/i.test(message) ? 'DRIFT' : 'FAILED';
			log(`  ${state} ${target.name}: ${message}`);
			results.push({ target: target.name, state, error: message });
		}
	}
	const inSync = results.every((result) => result.state === 'SYNC');
	const failed = results.some(
		(result) => ['DRIFT', 'FAILED'].includes(result.state) || (check && result.refs.some((ref) => ref.state === 'EMPTY'))
	);
	log(
		`mirror: ${inSync ? 'all targets in sync' : failed ? 'failed; inspect named targets and reconcile before retrying' : 'targets behind; fast-forward publication needed'}`
	);
	return { exitCode: failed ? 1 : 0, inSync, main, results };
}
