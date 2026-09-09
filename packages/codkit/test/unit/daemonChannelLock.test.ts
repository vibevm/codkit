/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-CHANNEL-LOCK */
// The per-channel operation lock: exclusive publication, honest absent/valid/
// invalid reading, single-winner stale recovery, and the channel namespace it
// derives its key from. Every interleaving here is a barrier, never a sleep.

import { createHash } from 'node:crypto';
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	acquireDaemonChannelLock,
	assertDaemonChannelLock,
	daemonChannelKey,
	daemonChannelLockPath,
	readDaemonChannelLock
} from '../../src/lib/daemonChannelLock.ts';
import type { DaemonChannelLock } from '../../src/lib/daemonChannelLock.ts';
import { asciiFoldChannel, validateChannelName, validateChannelSet } from '../../src/lib/buildChannel.ts';
import { loadBuildWatch } from '../../src/lib/buildWrap.ts';
import { removeContainedFile, writeContainedFileExclusive } from '../../src/lib/containedFile.ts';
import { linkContainedFileExclusive, removeContainedHardlinkGeneration } from '../../src/lib/containedGeneration.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

afterAll(cleanupDiskRoots);

const CHANNEL = 'transpile';

function lockBytes(root: string): Buffer {
	return readFileSync(daemonChannelLockPath(root, CHANNEL));
}

function plantLock(root: string, bytes: string): string {
	const path = daemonChannelLockPath(root, CHANNEL);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, bytes, 'utf8');
	return path;
}

describe('the daemon channel key', () => {
	it('is the full SHA-256 of the ASCII-case-folded channel', () => {
		expect(daemonChannelKey(CHANNEL)).toBe(createHash('sha256').update(CHANNEL, 'utf8').digest('hex'));
		expect(daemonChannelKey(CHANNEL)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('folds case so two spellings can never hold two locks over one runtime file', () => {
		expect(asciiFoldChannel('TypeCheck')).toBe('typecheck');
		expect(daemonChannelKey('TypeCheck')).toBe(daemonChannelKey('typecheck'));
	});
});

describe('exclusive acquisition', () => {
	it('publishes complete nonce-bearing bytes and refuses a live second owner', () => {
		const root = makeDiskRoot('lock-exclusive');
		const held = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile');
		try {
			const observed = readDaemonChannelLock(root, CHANNEL);
			expect(observed).toMatchObject({
				state: 'valid',
				record: { channel: CHANNEL, key: daemonChannelKey(CHANNEL), pid: process.pid, command: 'build up transpile', nonce: held.nonce }
			});
			expect(JSON.parse(lockBytes(root).toString('utf8'))).toMatchObject({ nonce: held.nonce });
			expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build down transpile')).toThrow(/still possibly alive/);
			expect(lockBytes(root).toString('utf8')).toContain(held.nonce);
		} finally {
			held.release();
		}
		expect(readDaemonChannelLock(root, CHANNEL)).toEqual({ state: 'absent' });
	});

	it('binds the capability to one patch set and one channel, and dies on release', () => {
		const root = makeDiskRoot('lock-capability');
		const other = makeDiskRoot('lock-capability-other');
		const held = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile');
		expect(() => assertDaemonChannelLock(held, root, CHANNEL)).not.toThrow();
		expect(() => assertDaemonChannelLock(held, other, CHANNEL)).toThrow(/live channel-bound/);
		expect(() => assertDaemonChannelLock(held, root, 'typecheck')).toThrow(/live channel-bound/);
		const forged: DaemonChannelLock = { ...held, release: () => undefined };
		expect(() => assertDaemonChannelLock(forged, root, CHANNEL)).toThrow(/live channel-bound/);
		held.release();
		expect(() => assertDaemonChannelLock(held, root, CHANNEL)).toThrow(/live channel-bound/);
	});

	it('is idempotent on release and leaves no generation behind', () => {
		const root = makeDiskRoot('lock-release-twice');
		const held = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile');
		held.release();
		held.release();
		expect(existsSync(daemonChannelLockPath(root, CHANNEL))).toBe(false);
		const again = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile');
		expect(again.nonce).not.toBe(held.nonce);
		again.release();
	});
});

describe('stale recovery', () => {
	it('elects exactly one of two interleaved contenders, and a successor public name is never unlinked', () => {
		const root = makeDiskRoot('lock-stale-recovery');
		const abandoned = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_242 });
		const stale = JSON.parse(lockBytes(root).toString('utf8'));
		const publicRelative = `.codkit/locks/daemon-${daemonChannelKey(CHANNEL)}.lock`;
		const publicPath = join(root, ...publicRelative.split('/'));

		// Phase 1 - the election, interleaved through the seam the remover
		// exposes: the second contender runs to completion inside the first one's
		// post-proof window, exactly where a preempted process would pause. Two
		// sequential calls never produce this; they only ever see the aftermath.
		let secondOutcome: string | null = null;
		const first = removeContainedHardlinkGeneration(root, publicRelative, `${publicRelative}.${stale.nonce as string}.owner`, {
			what: publicRelative,
			afterOpen: () => {
				secondOutcome = removeContainedHardlinkGeneration(root, publicRelative, `${publicRelative}.${stale.nonce as string}.owner`, {
					what: publicRelative
				});
			}
		});
		// The loser reports a lost election - its private link was already unlinked
		// by the winner - and touches nothing else.
		expect(first).toBe('lost');
		expect(secondOutcome).toBe('removed');
		expect(existsSync(publicPath)).toBe(false);

		const recovered = acquireDaemonChannelLock(root, CHANNEL, 'build down transpile');
		expect(recovered.nonce).not.toBe(abandoned.nonce);
		recovered.release();

		// Phase 2 - the successor re-check that follows the winner's election. A
		// contender is paused after its proofs while a winner publishes a fresh
		// generation under the public name (every step a real acquisition takes:
		// an exclusive private link, the old publication unlinked, the new one
		// linked). The paused contender may still unlink ITS private link, but it
		// must lose before the public name - deleting the re-check would unlink
		// the live winner's publication here.
		const secondAbandoned = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_243 });
		const staleTwo = JSON.parse(lockBytes(root).toString('utf8'));
		const staleOwnerRelative = `${publicRelative}.${staleTwo.nonce as string}.owner`;
		const successorNonce = 'b7c8d9e0-fa1b-4c2d-8e3f-334455667788';
		const successorOwnerRelative = `${publicRelative}.${successorNonce}.owner`;
		const successorBytes = `${JSON.stringify({ ...staleTwo, pid: 424_244, nonce: successorNonce }, null, 2)}\n`;
		const contender = removeContainedHardlinkGeneration(root, publicRelative, staleOwnerRelative, {
			what: publicRelative,
			afterOpen: () => {
				expect(
					writeContainedFileExclusive(root, successorOwnerRelative, { bytes: Buffer.from(successorBytes), what: successorOwnerRelative })
				).toBe(true);
				removeContainedFile(root, publicRelative, { what: publicRelative });
				expect(linkContainedFileExclusive(root, successorOwnerRelative, publicRelative, { what: publicRelative })).toBe(true);
			}
		});

		expect(contender).toBe('lost');
		// The live winner's publication survives, byte for byte, and both the
		// winner's private link and the contender's own are what remain.
		expect(JSON.parse(readFileSync(publicPath, 'utf8'))).toMatchObject({ nonce: successorNonce });
		expect(readFileSync(publicPath, 'utf8')).toBe(successorBytes);
		expect(existsSync(join(root, ...successorOwnerRelative.split('/')))).toBe(true);
		expect(existsSync(join(root, ...staleOwnerRelative.split('/')))).toBe(false);
		// The displaced holder's release must not throw over the winner and must
		// not touch the winner's publication either.
		expect(secondAbandoned.nonce).toBe(staleTwo.nonce);
		secondAbandoned.release();
		expect(readFileSync(publicPath, 'utf8')).toBe(successorBytes);
	});

	it('recovers a proven-dead owner through acquisition and mints a fresh nonce', () => {
		const root = makeDiskRoot('lock-stale-acquire');
		const abandoned = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_242 });
		const taken = acquireDaemonChannelLock(root, CHANNEL, 'build down transpile', { ownerAlive: () => false });
		try {
			expect(taken.nonce).not.toBe(abandoned.nonce);
			expect(readDaemonChannelLock(root, CHANNEL)).toMatchObject({ state: 'valid', record: { nonce: taken.nonce } });
		} finally {
			taken.release();
		}
	});

	it('acquires over the debris of a recoverer killed mid-recovery, and never over a live one', () => {
		// The wedge two independent audits reproduced against a green panel: a
		// recoverer SIGKILLed between publishing its claim and unlinking the
		// public name left debris no successor could attribute, and every later
		// `up` and `down` on the channel refused `stayed contended` forever.
		const root = makeDiskRoot('lock-crashed-recoverer');
		acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_242 });
		const publicRelative = `.codkit/locks/daemon-${daemonChannelKey(CHANNEL)}.lock`;
		const publicPath = join(root, ...publicRelative.split('/'));
		const stale = JSON.parse(lockBytes(root).toString('utf8'));
		// The holder died between its two unlinks: the private owner link is gone
		// and the publication is an orphan.
		unlinkSync(join(root, ...`${publicRelative}.${stale.nonce as string}.owner`.split('/')));

		// A recoverer then died inside its own window, leaving a claim. A claim is
		// an ordinary file whose bytes name its publisher and its publication.
		const shape = statSync(publicPath);
		const debris = `${publicPath}.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`;
		writeFileSync(
			debris,
			`${JSON.stringify({ codkitOrphanClaim: 1, dev: shape.dev, ino: shape.ino, pid: 424_243, nonce: 'c1d2e3f4-a5b6-4c7d-8e9f-001122334455' }, null, 2)}\n`,
			'utf8'
		);
		expect(statSync(publicPath).nlink).toBe(1);

		// A claim whose publisher may still be running is never stolen. The holder
		// is proven gone, so recovery is reached; only the claim's own publisher
		// answers alive, so the recovery loses its election every attempt and the
		// channel refuses instead of letting two contenders recover one lock.
		// (`ownerAlive` must discriminate the two pids: a blanket `() => true`
		// would refuse at the holder check and never reach this path at all.)
		expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { ownerAlive: (pid) => pid === 424_243 })).toThrow(
			/stayed contended after 3 attempts; inspect .*daemon-.*\.lock and its siblings/
		);
		expect(existsSync(debris)).toBe(true);
		expect(existsSync(publicPath)).toBe(true);
		expect(JSON.parse(readFileSync(publicPath, 'utf8')).nonce).toBe(stale.nonce);

		// With both the holder and the crashed recoverer proven gone, the very
		// first acquisition recovers instead of exhausting its attempts.
		const taken = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { ownerAlive: () => false });
		try {
			expect(taken.nonce).not.toBe(stale.nonce);
			expect(existsSync(debris)).toBe(false);
		} finally {
			taken.release();
		}
		expect(existsSync(publicPath)).toBe(false);
	});

	it('names unattributable damage at the claim name instead of reporting contention', () => {
		// The acquisition-level half of the wedge: bytes that do not parse as a
		// claim occupy the fixed claim name beside an orphaned publication. The
		// refusal must name the damage for the operator on the first attempt,
		// not report `stayed contended after 3 attempts` for a state no
		// contention produced - and must remove nothing.
		const root = makeDiskRoot('lock-damaged-claim-name');
		acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_242 });
		const publicRelative = `.codkit/locks/daemon-${daemonChannelKey(CHANNEL)}.lock`;
		const publicPath = join(root, ...publicRelative.split('/'));
		const stale = JSON.parse(readFileSync(publicPath, 'utf8'));
		unlinkSync(join(root, ...`${publicRelative}.${stale.nonce as string}.owner`.split('/')));
		const shape = statSync(publicPath);
		const damaged = `${publicPath}.orphan-${shape.dev.toString(16)}-${shape.ino.toString(16)}.owner`;
		writeFileSync(damaged, 'not json\n', 'utf8');
		expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build down transpile', { ownerAlive: () => false })).toThrow(
			/the claim name .* is occupied by a file that does not parse as a claim/
		);
		expect(readFileSync(damaged, 'utf8')).toBe('not json\n');
		expect(existsSync(publicPath)).toBe(true);
	});

	it('refuses by name when the orphaned generation cannot be proven', () => {
		// The `invalid` branch of the acquisition: an orphan whose publication
		// still carries an extra hard link is a live owner holding it, and the
		// refusal must say what was left untouched rather than the generic
		// exhaustion wording three attempts later.
		const root = makeDiskRoot('lock-orphan-invalid');
		acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_242 });
		const publicRelative = `.codkit/locks/daemon-${daemonChannelKey(CHANNEL)}.lock`;
		const publicPath = join(root, ...publicRelative.split('/'));
		const stale = JSON.parse(lockBytes(root).toString('utf8'));
		unlinkSync(join(root, ...`${publicRelative}.${stale.nonce as string}.owner`.split('/')));
		// An extra hard link on the orphaned publication: nlink > 1 with no owner
		// link is a live owner by the protocol's own rule.
		linkSync(publicPath, `${publicPath}.stranger`);

		expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build down transpile', { ownerAlive: () => false })).toThrow(
			/the orphaned operation-lock generation is still claimed and was left untouched/
		);
		expect(existsSync(publicPath)).toBe(true);
		expect(existsSync(`${publicPath}.stranger`)).toBe(true);
	});

	it('treats a possibly-alive or reused owner pid as held and changes nothing', () => {
		const root = makeDiskRoot('lock-live-owner');
		const abandoned = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { pid: 424_242 });
		const before = lockBytes(root);
		const beforeMtime = statSync(daemonChannelLockPath(root, CHANNEL)).mtimeMs;
		expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build down transpile', { ownerAlive: () => true })).toThrow(
			/still possibly alive/
		);
		expect(lockBytes(root)).toEqual(before);
		expect(statSync(daemonChannelLockPath(root, CHANNEL)).mtimeMs).toBe(beforeMtime);
		expect(abandoned.nonce).toBe(JSON.parse(before.toString('utf8')).nonce);
	});
});

describe('a release that could not retire its own generation is not silent', () => {
	it('reports the outcome and recreates no administrative directory', () => {
		// REPAIR-010 ordered the release to stop discarding its return value. The
		// value was retained on the handle - and then read by nobody, so the one
		// state it exists to surface stayed invisible in production.
		const root = makeDiskRoot('lock-release-warn');
		const warnings: string[] = [];
		const held = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { onWarn: (text) => warnings.push(text) });
		const locks = dirname(daemonChannelLockPath(root, CHANNEL));
		// The lock directory is removed underneath the holder: the retirement can
		// prove nothing and must not recreate what somebody else deleted.
		rmSync(locks, { recursive: true, force: true });

		held.release();

		expect(held.outcome()).toBe('lost');
		expect(warnings).toEqual([
			expect.stringMatching(/transpile: the operation lock could not retire its own generation \(lost\); inspect .*daemon-.*\.lock/)
		]);
		expect(existsSync(locks)).toBe(false);
	});

	it('says nothing when the generation retired cleanly', () => {
		const root = makeDiskRoot('lock-release-quiet');
		const warnings: string[] = [];
		const held = acquireDaemonChannelLock(root, CHANNEL, 'build up transpile', { onWarn: (text) => warnings.push(text) });
		held.release();
		expect(held.outcome()).toBe('removed');
		expect(warnings).toEqual([]);
	});
});

describe('invalid locks are refusals, never repairs', () => {
	it.each([
		['empty', ''],
		['truncated', '{"codkitDaemonChannelLock":'],
		['malformed', '{ nope'],
		['schema-invalid', '{}\n'],
		['extra-field', `${JSON.stringify({ codkitDaemonChannelLock: 1, extra: true })}\n`],
		[
			'noncanonical-date',
			`${JSON.stringify({
				codkitDaemonChannelLock: 1,
				key: 'a'.repeat(64),
				channel: CHANNEL,
				pid: 7,
				startedAt: '2026-09-04',
				command: 'build up transpile',
				nonce: '11111111-1111-4111-8111-111111111111'
			})}\n`
		],
		[
			'foreign-key',
			`${JSON.stringify({
				codkitDaemonChannelLock: 1,
				key: 'a'.repeat(64),
				channel: CHANNEL,
				pid: 7,
				startedAt: '2026-09-04T00:00:00.000Z',
				command: 'build up transpile',
				nonce: '11111111-1111-4111-8111-111111111111'
			})}\n`
		]
	])('refuses acquisition over a %s lock and preserves its exact bytes', (_label, bytes) => {
		const root = makeDiskRoot(`lock-invalid-${_label}`);
		const path = plantLock(root, bytes);
		const beforeMtime = statSync(path).mtimeMs;
		expect(readDaemonChannelLock(root, CHANNEL).state).toBe('invalid');
		expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build up transpile')).toThrow(/operation lock is invalid/);
		expect(readFileSync(path, 'utf8')).toBe(bytes);
		expect(statSync(path).mtimeMs).toBe(beforeMtime);
	});

	it('refuses an unreadable lock without deleting it', () => {
		const root = makeDiskRoot('lock-unreadable');
		const path = plantLock(root, '{}\n');
		chmodSync(path, 0o000);
		try {
			expect(readDaemonChannelLock(root, CHANNEL).state).toBe('invalid');
			expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build up transpile')).toThrow(/operation lock is invalid/);
			expect(existsSync(path)).toBe(true);
		} finally {
			chmodSync(path, 0o600);
		}
	});

	it('refuses a symlinked lock leaf without reading or replacing the target', () => {
		const root = makeDiskRoot('lock-symlink');
		const outside = makeDiskRoot('lock-symlink-outside');
		const sentinel = join(outside, 'sentinel.lock');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		const path = daemonChannelLockPath(root, CHANNEL);
		mkdirSync(dirname(path), { recursive: true });
		symlinkSync(sentinel, path);
		expect(readDaemonChannelLock(root, CHANNEL).state).toBe('invalid');
		expect(() => acquireDaemonChannelLock(root, CHANNEL, 'build up transpile')).toThrow();
		expect(readFileSync(sentinel, 'utf8')).toBe('outside\n');
	});
});

describe('the build channel namespace', () => {
	it.each(['all', 'ALL', 'All', 'deps-hash', 'DEPS-HASH', 'Deps-Hash'])('rejects the reserved runtime name %j', (channel) => {
		expect(() => validateChannelName(channel)).toThrow(/reserved build runtime name/);
	});

	it('rejects a name whose candidate/temp filename exceeds the portable component limit', () => {
		// 255 portable bytes minus the ".json" / ".<uuid>.candidate" suffixes the
		// runtime derives from the key leaves 202 bytes for the name itself.
		expect(() => validateChannelName('a'.repeat(203))).toThrow(/portable component limit/);
		expect(() => validateChannelName('a'.repeat(202))).not.toThrow();
	});

	it('rejects overlong multi-byte names as unportable basenames before any length arithmetic', () => {
		expect(() => validateChannelName('ä'.repeat(120))).toThrow(/portable directory basename/);
		expect(() => validateChannelName('日本語')).toThrow(/portable directory basename/);
	});

	it('rejects an ASCII-case-fold duplicate anywhere in the configured set and names both originals', () => {
		expect(() => validateChannelSet(['transpile', 'typecheck'])).not.toThrow();
		expect(() => validateChannelSet(['Foo', 'bar', 'foo'])).toThrow(/"Foo" and "foo" collide after ASCII case folding/);
	});

	it('refuses every hostile name before any key is derived', () => {
		for (const channel of [
			'',
			'.',
			'..',
			'../x',
			'a/b',
			'a\\b',
			'/abs',
			'C:\\drive',
			'CON',
			'nul.txt',
			'name.',
			'name ',
			'a\u0001b',
			'all'
		]) {
			expect(() => daemonChannelKey(channel)).toThrow(/unsafe build channel name/);
		}
	});

	it('validates the configured channel set before the watch cache is populated', () => {
		// The real ordering around the channel namespace: a profile whose channel
		// set is invalid (an ASCII-case-fold collision) is refused, and the refusal
		// happens BEFORE the parsed profile is cached - so repairing the profile
		// and loading again returns the repaired channels. A load that cached
		// first would keep serving the invalid set on every later call.
		const root = makeDiskRoot('lock-watch-cache-order');
		const profile = join(root, 'config', 'watch.json');
		mkdirSync(dirname(profile), { recursive: true });
		writeFileSync(
			join(root, 'codkit.json'),
			`${JSON.stringify(
				{
					codkitConfig: 2,
					pin: { tag: '1.135.0', sha: '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5', date: '2026-08-25' },
					upstreamAnchorCommit: '0000000000000000000000000000000000000000',
					type: 'vscode',
					typeConfig: { ownRoot: 'src/vs/patchset' },
					generatedBranchPrefix: 'codkit/applied/',
					cycleBranchPrefix: 'codkit/cycle/',
					releaseRefPrefix: 'codkit/release/',
					publishRemoteUrl: null,
					buildWatchFile: 'config/watch.json'
				},
				null,
				2
			)}\n`,
			'utf8'
		);
		const channel = (name: string) => ({
			script: `watch-${name}`,
			passStart: ['^start$'],
			passEnd: ['^end$'],
			errorLine: [`^${name}: (.+)$`]
		});
		writeFileSync(profile, `${JSON.stringify({ codkitBuildWatch: 1, channels: { Foo: channel('foo'), foo: channel('foo') } })}\n`, 'utf8');
		expect(() => loadBuildWatch(vscodeType, root)).toThrow(/"Foo" and "foo" collide after ASCII case folding/);

		// Nothing was cached by the refused load: the next call reads the repaired
		// profile instead of replaying the invalid one.
		writeFileSync(profile, `${JSON.stringify({ codkitBuildWatch: 1, channels: { transpile: channel('transpile') } })}\n`, 'utf8');
		expect(loadBuildWatch(vscodeType, root).channels.map((entry) => entry.name)).toEqual(['transpile']);
	});
});
