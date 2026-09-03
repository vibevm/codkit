/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { concreteStabilizationWorldMatches } from '../../src/lib/cycleStabilize.ts';
import { captureCycleLiveSnapshot } from '../../src/lib/cycleStabilizeEvidence.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

type Side = 'patchset' | 'fork';
type Dirt = 'unstaged' | 'staged' | 'untracked';

describe('cycle stabilization live evidence', () => {
	afterAll(cleanupTempRoots);

	it.each([
		['patchset', 'unstaged'],
		['patchset', 'staged'],
		['patchset', 'untracked'],
		['fork', 'unstaged'],
		['fork', 'staged'],
		['fork', 'untracked']
	] as const)('binds %s %s dirt to bytes even when status names do not change', (side: Side, dirt: Dirt) => {
		const current = fixture();
		const root = side === 'patchset' ? current.patchset : current.fork;
		const path = dirt === 'untracked' ? 'new.bin' : 'tracked.bin';
		write(root, path, Buffer.from([0, 1, 2]));
		if (dirt === 'staged') fixtureGit(root, ['add', '--', path]);
		const first = captureCycleLiveSnapshot(current.patchset, current.fork, current.target)[side];
		write(root, path, Buffer.from([0, 1, 3]));
		if (dirt === 'staged') fixtureGit(root, ['add', '--', path]);
		const second = captureCycleLiveSnapshot(current.patchset, current.fork, current.target)[side];

		expect(second.statusDigest).toBe(first.statusDigest);
		expect(second.contentDigest).not.toBe(first.contentDigest);
	});

	it('excludes its durable report and private runtime records from dirt evidence', () => {
		const current = fixture();
		const before = captureCycleLiveSnapshot(current.patchset, current.fork, current.target).patchset;
		write(current.patchset, 'cycle/report/stabilize.json', '{"first":true}\n');
		write(current.patchset, '.codkit/locks/cycle-global.json', '{"heartbeat":1}\n');
		const after = captureCycleLiveSnapshot(current.patchset, current.fork, current.target).patchset;
		expect(after).toEqual(before);
	});

	it('rejects tracked content in the reserved runtime namespace', () => {
		const current = fixture();
		write(current.patchset, '.codkit/user-file.txt', 'tracked user data\n');
		fixtureGit(current.patchset, ['add', '--', '.codkit/user-file.txt']);
		fixtureCommit(current.patchset, 'snapshot tracked runtime collision', '2026-08-01T00:01:00Z');
		expect(() => captureCycleLiveSnapshot(current.patchset, current.fork, current.target)).toThrow(/tracked content|reserved runtime/);
	});

	it('binds a green concrete build to the exact reported branch tip', () => {
		const current = fixture();
		const live = captureCycleLiveSnapshot(current.patchset, current.fork, current.target);
		const expectedRef = live.fork.ref;
		if (expectedRef === null) throw new Error('fixture fork is detached');
		expect(concreteStabilizationWorldMatches(live, live, expectedRef, live.fork.head)).toBe(true);
		expect(concreteStabilizationWorldMatches(live, live, expectedRef, 'f'.repeat(40))).toBe(false);
	});

	it('requires exact fork preservation when a failed concrete run has no branch tip', () => {
		const current = fixture();
		const live = captureCycleLiveSnapshot(current.patchset, current.fork, current.target);
		const expectedRef = live.fork.ref;
		if (expectedRef === null) throw new Error('fixture fork is detached');
		expect(concreteStabilizationWorldMatches(live, live, expectedRef, null)).toBe(true);
		expect(concreteStabilizationWorldMatches(live, { ...live, fork: { ...live.fork, head: 'f'.repeat(40) } }, expectedRef, null)).toBe(
			false
		);
	});

	it.each(['symlink', 'fifo'] as const)('rejects an untracked %s instead of hashing a path label', (kind) => {
		const current = fixture();
		const path = join(current.patchset, kind);
		if (kind === 'symlink') symlinkSync('tracked.bin', path);
		else execFileSync('mkfifo', [path]);
		expect(() => captureCycleLiveSnapshot(current.patchset, current.fork, current.target)).toThrow(/untracked|regular file/);
	});

	it.each(['symlink', 'fifo'] as const)('does not follow or block when regular dirt becomes a %s just before open', (kind) => {
		const current = fixture();
		const path = 'race.bin';
		const absolute = join(current.patchset, path);
		const outside = join(makeTempRoot('snapshot-outside'), 'secret.bin');
		write(current.patchset, path, 'inside\n');
		writeFileSync(outside, 'outside-secret\n');
		let swapped = 0;
		const started = Date.now();
		expect(() =>
			captureCycleLiveSnapshot(current.patchset, current.fork, current.target, {
				beforeUntrackedOpen(root, candidate) {
					if (root !== current.patchset || candidate !== path) return;
					swapped += 1;
					rmSync(absolute);
					if (kind === 'symlink') symlinkSync(outside, absolute);
					else execFileSync('mkfifo', [absolute]);
				}
			})
		).toThrow(/safely read|regular file/);
		expect(swapped).toBe(1);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(readFileSync(outside, 'utf8')).toBe('outside-secret\n');
	});

	it('does not read an outside sentinel when an ancestor becomes a symlink just before open', () => {
		const current = fixture();
		const path = 'parent/race.bin';
		const parent = join(current.patchset, 'parent');
		const parked = join(current.patchset, 'parent-before-race');
		const outside = makeTempRoot('snapshot-outside-parent');
		const sentinel = join(outside, 'race.bin');
		write(current.patchset, path, 'inside\n');
		writeFileSync(sentinel, 'outside-sentinel\n');
		let swapped = 0;
		expect(() =>
			captureCycleLiveSnapshot(current.patchset, current.fork, current.target, {
				beforeUntrackedOpen(root, candidate) {
					if (root !== current.patchset || candidate !== path) return;
					swapped += 1;
					renameSync(parent, parked);
					symlinkSync(outside, parent, 'dir');
				}
			})
		).toThrow(/ancestor changed|safely read/);
		expect(swapped).toBe(1);
		expect(readFileSync(sentinel, 'utf8')).toBe('outside-sentinel\n');
	});
});

function fixture(): { readonly patchset: string; readonly fork: string; readonly target: string } {
	const patchset = repository('snapshot-patchset');
	const fork = repository('snapshot-fork');
	return { patchset, fork, target: fixtureGit(fork, ['rev-parse', 'HEAD']).stdout.trim() };
}

function repository(label: string): string {
	const root = makeTempRoot(label);
	fixtureGit(root, ['init', '--quiet', '--initial-branch=main', '.']);
	write(root, 'tracked.bin', Buffer.from([0, 1, 0]));
	fixtureCommit(root, 'snapshot base', '2026-08-01T00:00:00Z');
	return root;
}

function write(root: string, relative: string, contents: string | Uint8Array): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents);
}
