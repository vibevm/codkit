// e2e: codkit gc - one command for state that is genuinely spent, never a
// recovery record (PROP-007 sec. 20 ##CMD-GC, classes: PROP-006 sec. 1
// ##GC-CLASSES; campaign TREE-COMMITS-SAVE Phase 9, decision D22).
//
// S28 builds the whole catalogue in one fixture: three saves with tree commits
// leave three consumed refs, a hard process loss during buildBranch leaves tmp
// scratch and a dead lock, a second tree that was loaded and then deleted
// leaves a cache that describes nothing, a crashed sync leaves its transaction
// file, and an unfinished marker new leaves a pending draft. The dry run must
// name every candidate with its class - the kept ones as kept, which is the
// observable form of the phase's deepest rule: a gc that never looked at
// transactions would still pass a mere "the file survived" check, so the test
// pins the keep decision to the plan itself. The real run then removes exactly
// what the dry run listed (R14: one to one), --keep-consumed spends the refs,
// and the transaction and the pending draft are proven byte-identical by hash
// after every gc run, not asserted intact.
//
// A lock whose owner is still alive is the counter-proof of the lock class:
// the same run that removes a dead owner's lock keeps a live one and says why.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/configFile.ts';
import { treeId } from '../../src/lib/fingerprint.ts';
import { gitLocal, runGit } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';
import { acquireLock, isAlive, lockPath, readLock } from '../../src/lib/lock.ts';
import type { LockHandle } from '../../src/lib/lock.ts';
import { pendingFileName } from '../../src/lib/pendingHeader.ts';
import { SYNC_TEST_CRASH_ENV, SYNC_TEST_CRASH_EXIT_CODE, SYNC_TRANSACTION_RELATIVE_PATH } from '../../src/lib/syncTransaction.ts';
import { CONSUMED_REF_PREFIX } from '../../src/lib/treeCommits.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { CODKIT_E2E_TEST_BUILD, makeCliFixture, runCli } from '../support/cliFixture.ts';
import type { CliFixture, Envelope, Run } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

/** F: the file whose patch artifact the patchset side moves (the sync conflict). */
const EXAMPLE_PATCH = 'delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch';
/** The tree file of the three saves. */
const UTIL_PATH = 'src/vs/base/common/util.ts';
/** The tree file of the pending draft marker new leaves behind. */
const LIFECYCLE_PATH = 'src/vs/base/common/lifecycle.ts';

const F_BLOCK_ID = 'CK-workbench-901';
const UTIL_BLOCK_ID = 'CK-base-905';
const LIFECYCLE_BLOCK_ID = 'CK-base-906';

const IDENTITY: GitEnv = {
	GIT_AUTHOR_NAME: 'human',
	GIT_AUTHOR_EMAIL: 'human@example.invalid',
	GIT_AUTHOR_DATE: '2026-09-06T12:00:00Z',
	GIT_COMMITTER_NAME: 'human',
	GIT_COMMITTER_EMAIL: 'human@example.invalid',
	GIT_COMMITTER_DATE: '2026-09-06T12:00:00Z'
};

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const launcher = join(repoRoot, 'codkit', 'bin', 'codkit.mjs');

/** A plan row of the --json envelope. */
type PlanRow = { action: string; class: string; path: string; reason: string };

afterAll(() => {
	cleanupTempRoots();
});

/** Put a line inside the marker block `id` of `text`. */
function fillBlock(text: string, id: string, line: string): string {
	const at = text.indexOf(`// codkit:begin ${id}`);
	if (at === -1) {
		throw new Error(`the block ${id} is not in the file`);
	}
	const endOfBegin = text.indexOf('\n', at) + 1;
	return `${text.slice(0, endOfBegin)}${line}\n${text.slice(endOfBegin)}`;
}

/** Scaffold a marker block and leave one line inside it, uncommitted. */
function dirtyBlock(fixture: CliFixture, path: string, id: string, line: string): void {
	const outcome = fixture.json([
		'marker',
		'new',
		path,
		'--id',
		id,
		'--type',
		'hook',
		'--owner',
		'workbench-core',
		'--reason',
		'gc fixture scaffold'
	]);
	expect(outcome.run.status, outcome.run.stderr).toBe(0);
	const target = fixture.treePath(path);
	writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), id, `\t\t${line}`), 'utf8');
}

/** Scaffold an empty marker block and its pending draft, with nothing else touched. */
function scaffoldDraft(fixture: CliFixture, path: string, id: string): void {
	const outcome = fixture.json([
		'marker',
		'new',
		path,
		'--id',
		id,
		'--type',
		'hook',
		'--owner',
		'workbench-core',
		'--reason',
		'gc fixture pending draft'
	]);
	expect(outcome.run.status, outcome.run.stderr).toBe(0);
}

/** Edit one file of the tree inside its block and commit everything, bypassing the hook (F12). */
function commitInTree(fixture: CliFixture, path: string, id: string, line: string, message: string): string {
	const target = fixture.treePath(path);
	writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), id, `\t\t${line}`), 'utf8');
	return commitAll(fixture, message);
}

function commitAll(fixture: CliFixture, message: string): string {
	const result = gitLocal({
		args: ['commit', '--quiet', '--all', '--message', message, '--no-verify'],
		cwd: fixture.treeDir,
		env: IDENTITY
	});
	expect(result.status, result.stderr).toBe(0);
	return fixture.git(['rev-parse', 'HEAD']).stdout.trim();
}

/**
 * Move a patch artifact on the patchset side: one added line inside the patch's
 * marker block, with the hunk count corrected, so the shifted artifact remains
 * a valid patch that applies to the pin.
 */
function shiftPatchsetArtifact(fixture: CliFixture, artifact: string, line: string): void {
	const path = fixture.patchesPath(artifact);
	const lines = readFileSync(path, 'utf8').split('\n');
	const out: string[] = [];
	let hunkHeader = -1;
	let inserted = false;
	for (const current of lines) {
		if (current.startsWith('@@ ')) {
			hunkHeader = out.length;
			out.push(current);
			continue;
		}
		out.push(current);
		if (!inserted && hunkHeader !== -1 && current.startsWith('+') && current.includes('codkit:begin')) {
			out.push(`+${line}`);
			inserted = true;
		}
	}
	expect(inserted, `the fixture artifact ${artifact} has no marker block to extend`).toBe(true);
	const header = out[hunkHeader] ?? '';
	const fixed = header.replace(
		/^(@@ -\d+(?:,\d+)? \+\d+)(?:,(\d+))? @@(.*)$/,
		(_all, prefix: string, count: string | undefined, rest: string) => {
			const was = count === undefined ? 1 : Number(count);
			return `${prefix},${was + 1} @@${rest}`;
		}
	);
	expect(fixed, `could not fix the hunk count of ${artifact}: "${header}"`).not.toBe(header);
	out[hunkHeader] = fixed;
	writeFileSync(path, out.join('\n'), 'utf8');
}

function consumedRefs(fixture: CliFixture): readonly { ref: string; sha: string }[] {
	return fixture
		.git(['for-each-ref', '--format=%(refname) %(objectname)', CONSUMED_REF_PREFIX])
		.stdout.trim()
		.split('\n')
		.filter((line) => line !== '')
		.map((line) => {
			const [ref = '', sha = ''] = line.split(' ');
			return { ref, sha };
		});
}

/**
 * The one crashed buildBranch of S28: a real `load --fresh` subprocess killed
 * the moment its scratch appears under `.codkit/tmp`, so the `finally` that
 * cleans the scratch and the lock release never run - the exact debris the
 * class exists for. The launcher re-execs the real CLI as its own child, so
 * the kill goes to the whole process group (detached leader), not just the
 * launcher; killing only the launcher would let the real run finish cleanly
 * and take its debris with it.
 */
async function crashDuringBranchBuild(fixture: CliFixture, key: string): Promise<void> {
	const scratch = fixture.patchesPath('.codkit/tmp');
	rmSync(scratch, { recursive: true, force: true });
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && name !== 'CODKIT_FORK_DIR' && name !== 'CODKIT_PATCHES_DIR') {
			env[name] = value;
		}
	}
	const child = spawn(process.execPath, [launcher, '--patches-dir', fixture.patchesDir, '--fork-dir', fixture.treeDir, 'load', '--fresh'], {
		cwd: fixture.patchesDir,
		env,
		stdio: 'ignore',
		detached: true
	});
	const exited = new Promise<number | null>((resolve) => {
		child.on('exit', (code) => {
			resolve(code);
		});
	});
	const killGroup = (): void => {
		const pid = child.pid;
		if (pid === undefined) {
			return;
		}
		try {
			process.kill(-pid, 'SIGKILL');
		} catch {
			child.kill('SIGKILL');
		}
	};
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (existsSync(scratch) && readdirSync(scratch).some((name) => name === `${key}.index` || name === `${key}.blob`)) {
			killGroup();
			break;
		}
		if (Date.now() > deadline) {
			killGroup();
			throw new Error('the branch build never exposed its scratch; the crash window was missed');
		}
		blockFor(2);
	}
	expect(await exited).not.toBe(0);
	// A missed window must fail here, loudly, at its source: later assertions
	// describe debris that is supposed to exist from this moment on.
	const debris = existsSync(scratch) ? readdirSync(scratch).filter((name) => name === `${key}.index` || name === `${key}.blob`) : [];
	expect(debris, 'the killed branch build left no scratch under .codkit/tmp').not.toHaveLength(0);
}

/** Synchronous sleep: the poller must not yield while it waits for the scratch. */
function blockFor(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** A pid that is provably gone: a child that already exited. */
function deadPid(): number {
	const child = spawnSync(process.execPath, ['-e', '']);
	expect(child.status).toBe(0);
	const pid = child.pid;
	if (pid === undefined) {
		throw new Error('the short-lived child has no pid');
	}
	expect(isAlive(pid)).toBe(false);
	return pid;
}

/** Recreate the lock a crashed run leaves at this tree's lock path (a dead owner, legacy form). */
function plantStaleLock(fixture: CliFixture, key: string): void {
	const path = lockPath(fixture.patchesDir, key);
	rmSync(path, { force: true });
	writeFileSync(path, `${JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString(), command: 'load' }, null, 2)}\n`, 'utf8');
}

/** Clone a second tree against the same patchset, load it, delete it: its cache outlives it. */
function loadThenDeleteSecondTree(fixture: CliFixture): void {
	const config = loadConfig(fixture.patchesDir);
	if (config === null) {
		throw new Error('missing fixture config');
	}
	const root = makeTempRoot('gc-s28-second-tree');
	const tree = join(root, 'fork-tree');
	runGit({ args: ['clone', '--quiet', '--no-checkout', fixture.upstream.dir, tree], cwd: root, netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', config.pin.sha], cwd: tree });
	const applied = runCli(fixture.patchesDir, ['--patches-dir', fixture.patchesDir, '--fork-dir', tree, 'load']);
	expect(applied.status, applied.stderr).toBe(0);
	rmSync(root, { recursive: true, force: true });
}

function hashOf(absolute: string): string {
	return createHash('sha256').update(readFileSync(absolute)).digest('hex');
}

function transactionPath(fixture: CliFixture): string {
	return join(fixture.patchesDir, ...SYNC_TRANSACTION_RELATIVE_PATH.split('/'));
}

function pendingPath(fixture: CliFixture): string {
	return fixture.patchesPath(`.codkit/pending/${pendingFileName(LIFECYCLE_PATH)}`);
}

function planRows(envelope: Envelope): readonly PlanRow[] {
	return envelope.data['plan'] as PlanRow[];
}

function removedPaths(envelope: Envelope): readonly string[] {
	return envelope.data['removed'] as string[];
}

function messageText(envelope: Envelope): string {
	return envelope.messages.map((message) => message.text).join('\n');
}

// ---------------------------------------------------------------------------
// S28
// ---------------------------------------------------------------------------

describe('S28: gc removes spent state and never a transaction', () => {
	let fixture: CliFixture;
	let key: string;
	let aliveLock: LockHandle;
	let aliveKey: string;
	let transactionHash: string;
	let pendingHash: string;
	let dryRun: { run: Run; envelope: Envelope };
	let applied: { run: Run; envelope: Envelope };
	/** Disk facts captured between the dry run and the real run: the later tests describe the dry-run world. */
	let tmpAfterDryRun: readonly string[];

	beforeAll(async () => {
		fixture = makeCliFixture('gc-s28');
		expect(fixture.run(['load']).status).toBe(0);

		// Three saves with tree commits: three consumed refs (D6).
		dirtyBlock(fixture, UTIL_PATH, UTIL_BLOCK_ID, '// the first tree commit');
		commitAll(fixture, 'work: tree commit 1');
		expect(fixture.run(['save']).status).toBe(0);
		commitInTree(fixture, UTIL_PATH, UTIL_BLOCK_ID, '// the second tree commit', 'work: tree commit 2');
		expect(fixture.run(['save']).status).toBe(0);
		commitInTree(fixture, UTIL_PATH, UTIL_BLOCK_ID, '// the third tree commit', 'work: tree commit 3');
		expect(fixture.run(['save']).status).toBe(0);
		expect(consumedRefs(fixture).length).toBe(3);

		// Generated output for the out class.
		expect(fixture.run(['inventory']).status).toBe(0);

		// A cache entry whose tree no longer exists.
		loadThenDeleteSecondTree(fixture);

		// The one crashed buildBranch: tmp scratch plus a dead tree lock.
		key = treeId(fixture.treeDir);
		await crashDuringBranchBuild(fixture, key);
		expect(readLock(lockPath(fixture.patchesDir, key))).not.toBeNull();

		// A pending draft an unfinished marker new leaves behind (D22 keeps it).
		scaffoldDraft(fixture, LIFECYCLE_PATH, LIFECYCLE_BLOCK_ID);

		// A stopped sync: its transaction file is the state gc must never spend.
		shiftPatchsetArtifact(fixture, EXAMPLE_PATCH, '\t\t// the patchset side of F');
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), F_BLOCK_ID, '\t\t// the tree side of F'), 'utf8');
		const crashed = fixture.run(['sync'], { [CODKIT_E2E_TEST_BUILD]: '1', [SYNC_TEST_CRASH_ENV]: 'transaction-written' });
		expect(crashed.status, crashed.stderr).toBe(SYNC_TEST_CRASH_EXIT_CODE);
		expect(existsSync(transactionPath(fixture))).toBe(true);
		const stale = readLock(lockPath(fixture.patchesDir, key));
		expect(stale).not.toBeNull();
		expect(isAlive(stale?.pid ?? -1)).toBe(false);

		// A live lock of another tree, held by this very test process.
		aliveKey = treeId('/gone/gc-s28-alive-lock-tree');
		aliveLock = acquireLock(fixture.patchesDir, aliveKey, 'test-holder');

		transactionHash = hashOf(transactionPath(fixture));
		pendingHash = hashOf(pendingPath(fixture));

		dryRun = fixture.json(['gc', '--dry-run']);
		tmpAfterDryRun = readdirSync(fixture.patchesPath('.codkit/tmp'));
		// The dry run's lock acquisition spent the stale lock (##LOCK-MECHANISM
		// removes it on every acquisition); recreate it so the real run removes
		// exactly the plan the dry run printed, one to one (R14).
		plantStaleLock(fixture, key);
		applied = fixture.json(['gc']);
	});

	it('lists every candidate with its class, the kept ones named as kept', () => {
		expect(dryRun.run.status, dryRun.run.stderr).toBe(0);
		const rows = planRows(dryRun.envelope);
		const byClass = (name: string): readonly PlanRow[] => rows.filter((row) => row.class === name);

		// Consumed refs: three, all inside the default window, all kept.
		expect(byClass('consumed-ref')).toHaveLength(3);
		expect(byClass('consumed-ref').every((row) => row.action === 'keep')).toBe(true);

		// tmp: the killed branch build's scratch, to remove.
		expect(
			byClass('tmp')
				.map((row) => row.path)
				.join('\n')
		).toContain(`${key}.index`);
		expect(byClass('tmp').every((row) => row.action === 'remove')).toBe(true);

		// The stale own-tree lock, removed by the acquisition and named as a removal.
		const removedLocks = rows.filter((row) => row.class === 'lock' && row.action === 'remove');
		expect(removedLocks.map((row) => row.path).join('\n')).toContain(`.codkit/locks/${key}.lock`);

		// The live lock of the other tree: kept, and the plan says why.
		const aliveRows = rows.filter((row) => row.path === `.codkit/locks/${aliveKey}.lock`);
		expect(aliveRows).toHaveLength(1);
		expect(aliveRows[0]?.action).toBe('keep');
		expect(aliveRows[0]?.reason).toContain('is still running');
		expect(aliveRows[0]?.reason).toContain('test-holder');

		// The cache of the deleted tree goes; the cache of this tree stays.
		const cacheRows = byClass('tree-cache');
		expect(cacheRows.filter((row) => row.action === 'remove')).toHaveLength(1);
		expect(
			cacheRows
				.filter((row) => row.action === 'keep')
				.map((row) => row.path)
				.join('\n')
		).toContain(key);

		// Generated output goes.
		expect(
			byClass('out')
				.map((row) => row.path)
				.join('\n')
		).toContain('.codkit/out/inventory.json');

		// The kept classes, named as kept - the dry run is where the operator
		// sees them, so a gc that swept transactions could not pass this line.
		const keptTransaction = rows.filter((row) => row.class === 'transaction');
		expect(keptTransaction).toHaveLength(1);
		expect(keptTransaction[0]?.action).toBe('keep');
		expect(keptTransaction[0]?.path).toBe(SYNC_TRANSACTION_RELATIVE_PATH);
		expect(messageText(dryRun.envelope)).toMatch(/keep\s+transaction\s+\.codkit\/sync-transaction\.json/);
		const keptPending = rows.filter((row) => row.class === 'pending');
		expect(keptPending).toHaveLength(1);
		expect(keptPending[0]?.action).toBe('keep');
		expect(messageText(dryRun.envelope)).toMatch(/keep\s+pending\s+\.codkit\/pending\//);
	});

	it('removes nothing in a dry run, except the lock the acquisition itself takes over', () => {
		expect(tmpAfterDryRun).toContain(`${key}.index`);
		expect(existsSync(transactionPath(fixture))).toBe(true);
		expect(removedPaths(dryRun.envelope)).toEqual([]);
	});

	it('removes exactly what the dry run listed (R14: one to one)', () => {
		expect(applied.run.status, applied.run.stderr).toBe(0);
		const planned = planRows(dryRun.envelope)
			.filter((row) => row.action === 'remove')
			.map((row) => row.path)
			.sort();
		expect([...removedPaths(applied.envelope)].sort()).toEqual(planned);
	});

	it('deletes only the safe classes', () => {
		expect(readdirSync(fixture.patchesPath('.codkit/tmp'))).toEqual([]);
		expect(existsSync(fixture.patchesPath('.codkit/out/inventory.json'))).toBe(false);
		expect(readdirSync(fixture.patchesPath('.codkit/trees'))).toEqual([`${key}.json`]);
		expect(existsSync(lockPath(fixture.patchesDir, key))).toBe(false);
		expect(consumedRefs(fixture).length).toBe(3);
	});

	it('keeps the live lock of a live owner and the kept classes byte-identical', () => {
		expect(existsSync(lockPath(fixture.patchesDir, aliveKey))).toBe(true);
		expect(readLock(lockPath(fixture.patchesDir, aliveKey))?.command).toBe('test-holder');

		expect(hashOf(transactionPath(fixture)), 'the sync transaction must be byte-identical after gc').toBe(transactionHash);
		expect(hashOf(pendingPath(fixture)), 'the pending draft must be byte-identical after gc').toBe(pendingHash);
	});

	it('--keep-consumed 1 leaves exactly one ref and still no transaction damage', () => {
		const pruned = fixture.json(['gc', '--keep-consumed', '1', '--older-than', '0']);
		expect(pruned.run.status, pruned.run.stderr).toBe(0);
		expect(consumedRefs(fixture)).toHaveLength(1);
		expect(hashOf(transactionPath(fixture))).toBe(transactionHash);
		expect(removedPaths(pruned.envelope).every((path) => path.startsWith('refs/codkit/consumed/'))).toBe(true);
	});

	it('refuses a non-numeric window before taking any lock', () => {
		const refused = fixture.run(['gc', '--keep-consumed', 'soon']);
		expect(refused.status).toBe(2);
		expect(refused.stderr).toContain('CK-E-CONFIG');
	});

	afterAll(() => {
		aliveLock?.release();
	});
});
