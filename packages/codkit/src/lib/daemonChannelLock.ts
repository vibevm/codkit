/** @scope spec://codkit/modules/codkit/PROP-010#DAEMON-CHANNEL-LOCK */
// Linearization lock for one build channel. No command ever holds two.

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { encodeUtf8 } from './bytes.ts';
import { readContainedFile, removeContainedFile, writeContainedFileExclusive } from './containedFile.ts';
import { linkContainedFileExclusive, removeContainedHardlinkGeneration, removeContainedOrphanGeneration } from './containedGeneration.ts';
import { isAlive } from './lock.ts';
import { ckError } from './messages.ts';
import { asciiFoldChannel, validateChannelName } from './buildChannel.ts';

const LOCK_SCHEMA = 1;
const LOCK_ROOT = '.codkit/locks';

type ChannelLockRecord = {
	readonly codkitDaemonChannelLock: 1;
	readonly key: string;
	readonly channel: string;
	readonly pid: number;
	readonly startedAt: string;
	readonly command: string;
	readonly nonce: string;
};

const lockSchema = z
	.object({
		codkitDaemonChannelLock: z.literal(LOCK_SCHEMA),
		key: z.string().regex(/^[0-9a-f]{64}$/),
		channel: z.string().min(1),
		pid: z.number().int().positive(),
		startedAt: z.string().refine(canonicalIso, 'must be a canonical finite ISO timestamp'),
		command: z.string().min(1),
		nonce: z.string().uuid()
	})
	.strict();

export type DaemonChannelLockState =
	| { readonly state: 'absent' }
	| { readonly state: 'invalid'; readonly detail: string }
	| { readonly state: 'valid'; readonly record: ChannelLockRecord };

export type DaemonChannelLock = {
	readonly patchesDir: string;
	readonly channel: string;
	readonly key: string;
	readonly nonce: string;
	/** Never throws: a release inside a `finally` must not replace a real result. */
	release: () => void;
	/** What the last `release()` actually did; `pending` until it has run. */
	readonly outcome: () => 'pending' | 'removed' | 'lost' | 'invalid' | 'failed';
};

const liveCapabilities = new WeakSet<DaemonChannelLock>();

export type DaemonChannelLockOptions = {
	readonly pid?: number;
	readonly now?: () => Date;
	readonly ownerAlive?: (pid: number) => boolean;
	/** Where a release that could not retire its own generation is reported. */
	readonly onWarn?: (text: string) => void;
};

/** Contenders after the first are races, not failures; three bounds the retry. */
const ACQUIRE_ATTEMPTS = 3;

export function daemonChannelKey(channel: string): string {
	validateChannelName(channel);
	const folded = asciiFoldChannel(channel);
	return createHash('sha256').update(folded, 'utf8').digest('hex');
}

export function daemonChannelLockPath(patchesDir: string, channel: string): string {
	return `${patchesDir}/${publicRelative(daemonChannelKey(channel))}`;
}

export function readDaemonChannelLock(patchesDir: string, channel: string): DaemonChannelLockState {
	const key = daemonChannelKey(channel);
	let read;
	try {
		read = readContainedFile(patchesDir, publicRelative(key), { what: daemonChannelLockPath(patchesDir, channel) });
	} catch (error) {
		return { state: 'invalid', detail: error instanceof Error ? error.message : String(error) };
	}
	if (read.state === 'absent') return { state: 'absent' };
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
	} catch (error) {
		return { state: 'invalid', detail: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const parsed = lockSchema.safeParse(raw);
	if (!parsed.success) return { state: 'invalid', detail: `schema-invalid: ${parsed.error.issues[0]?.message ?? 'lock'}` };
	if (parsed.data.key !== key) return { state: 'invalid', detail: 'lock key does not match the channel' };
	return { state: 'valid', record: parsed.data };
}

export function acquireDaemonChannelLock(
	patchesDir: string,
	channel: string,
	command: string,
	options: DaemonChannelLockOptions = {}
): DaemonChannelLock {
	const key = daemonChannelKey(channel);
	const pid = options.pid ?? process.pid;
	const ownerAlive = options.ownerAlive ?? isAlive;
	for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
		const nonce = randomUUID();
		const record: ChannelLockRecord = {
			codkitDaemonChannelLock: LOCK_SCHEMA,
			key,
			channel,
			pid,
			startedAt: (options.now ?? (() => new Date()))().toISOString(),
			command,
			nonce
		};
		const owner = ownerRelative(key, nonce);
		if (!writeContainedFileExclusive(patchesDir, owner, { bytes: encodeUtf8(`${JSON.stringify(record, null, 2)}\n`), what: owner })) {
			throw ckError('LOCKED', `cannot reserve private daemon-channel lock generation for ${channel}`);
		}
		if (linkContainedFileExclusive(patchesDir, owner, publicRelative(key), { what: daemonChannelLockPath(patchesDir, channel) })) {
			return makeHandle(patchesDir, channel, key, nonce, options.onWarn);
		}
		removeContainedFile(patchesDir, owner, { what: owner });

		const current = readDaemonChannelLock(patchesDir, channel);
		if (current.state === 'invalid') throw locked(channel, `the operation lock is invalid: ${current.detail}`);
		if (current.state === 'absent') continue;
		if (ownerAlive(current.record.pid)) {
			throw locked(channel, `pid ${current.record.pid} is still possibly alive and owns ${current.record.command}`);
		}
		// The owner is proven absent. Retire exactly this generation: normally
		// through its private link, and - when the previous holder died between
		// its two unlinks - through the inode claim that recovers an orphan.
		// Losing either election means somebody else already retired it, which is
		// a reason to retry, not to refuse.
		const what = daemonChannelLockPath(patchesDir, channel);
		const retired = removeContainedHardlinkGeneration(patchesDir, publicRelative(key), ownerRelative(key, current.record.nonce), { what });
		if (retired === 'invalid') throw locked(channel, 'the stale operation-lock generation could not be proven and was left untouched');
		if (retired === 'owner-missing') {
			// The recovery publishes a claim of its own; its bytes carry this pid
			// and nonce so that a successor can bury it if this process dies
			// holding it, instead of reading anonymous debris as a live
			// competitor.
			const orphan = removeContainedOrphanGeneration(patchesDir, publicRelative(key), {
				what,
				claimant: { pid, nonce },
				claimantAlive: ownerAlive
			});
			if (orphan === 'invalid') throw locked(channel, 'the orphaned operation-lock generation is still claimed and was left untouched');
		}
	}
	// Contention, not debris: a recoverer's claim now names its publisher, so a
	// dead one is buried rather than waited on. Name the file anyway - the state
	// a human would inspect is a fact, not an inference from the word.
	throw locked(
		channel,
		`the operation lock stayed contended after ${ACQUIRE_ATTEMPTS} attempts; inspect ${daemonChannelLockPath(patchesDir, channel)} and its siblings`
	);
}

export function assertDaemonChannelLock(lock: DaemonChannelLock, patchesDir: string, channel: string): void {
	if (!liveCapabilities.has(lock) || lock.patchesDir !== patchesDir || lock.key !== daemonChannelKey(channel)) {
		throw locked(channel, 'a live channel-bound operation-lock capability is required');
	}
}

function makeHandle(patchesDir: string, channel: string, key: string, nonce: string, onWarn?: (text: string) => void): DaemonChannelLock {
	let released = false;
	let outcome: 'pending' | 'removed' | 'lost' | 'invalid' | 'failed' = 'pending';
	const path = daemonChannelLockPath(patchesDir, channel);
	const handle: DaemonChannelLock = {
		patchesDir,
		channel,
		key,
		nonce,
		release: () => {
			if (released) return;
			released = true;
			liveCapabilities.delete(handle);
			// A release runs inside a `finally`. It must not throw over the result
			// the caller was about to return, and it must not recreate an
			// administrative directory somebody removed underneath it.
			try {
				const result = removeContainedHardlinkGeneration(patchesDir, publicRelative(key), ownerRelative(key, nonce), { what: path });
				outcome = result === 'owner-missing' ? 'lost' : result;
			} catch {
				outcome = 'failed';
			}
			if (outcome !== 'removed') {
				onWarn?.(`${channel}: the operation lock could not retire its own generation (${outcome}); inspect ${path}`);
			}
		},
		outcome: () => outcome
	};
	liveCapabilities.add(handle);
	return handle;
}

function publicRelative(key: string): string {
	return `${LOCK_ROOT}/daemon-${key}.lock`;
}

function ownerRelative(key: string, nonce: string): string {
	return `${publicRelative(key)}.${nonce}.owner`;
}

function canonicalIso(value: string): boolean {
	const millis = Date.parse(value);
	return Number.isFinite(millis) && new Date(millis).toISOString() === value;
}

function locked(channel: string, detail: string): Error {
	return ckError(
		'LOCKED',
		`${channel}: ${detail}`,
		'wait for the owner or repair the named lock manually; invalid locks are never auto-deleted'
	);
}
