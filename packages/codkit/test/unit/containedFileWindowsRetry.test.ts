/** @scope spec://codkit/modules/codkit/PROP-002#CONTAINED-WINDOWS-REPLACE-RETRY */
// The Windows retry of an atomic replacement, driven through its seams: the
// rename, the platform and the clock are injected, so every case runs on any
// OS and never sleeps. What is pinned is the whole schedule - which waits are
// taken, and where the budget stops them - and that the refusal at the end is
// the one a failed rename has always been.

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeRegularFileAtomic } from '../../src/lib/containedFile.ts';
import type { AtomicWriteOptions } from '../../src/lib/containedPath.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { heldRename } from '../support/heldRename.ts';
import type { HeldRename } from '../support/heldRename.ts';

let root: string | undefined;

afterEach(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

/** A fresh root holding `state.json` with the bytes `old`; returns the file's path. */
function stateFile(): string {
	root = mkdtempSync(join(tmpdir(), 'ck-windows-rename-'));
	const path = join(root, 'state.json');
	writeFileSync(path, 'old', 'utf8');
	return path;
}

/** Replace `state.json` with `new` on Windows through the seams, recording every wait taken in `waits`. */
function replace(
	path: string,
	hold: HeldRename,
	waits: number[],
	options: Pick<AtomicWriteOptions, 'windowsReplaceBudgetMs' | 'renamePlatform'> = {}
): void {
	writeRegularFileAtomic(path, {
		what: 'state.json',
		bytes: Buffer.from('new'),
		renamePlatform: 'win32',
		waitForRenameRetry: (milliseconds) => waits.push(milliseconds),
		applyRename: hold.rename,
		...options
	});
}

/** The refusal `action` ends with; anything but a codkit refusal fails the case. */
function refusalOf(action: () => void): { readonly code: string; readonly message: string; readonly hint: string | undefined } {
	try {
		action();
	} catch (error) {
		if (isCkError(error)) return { code: error.code, message: error.message, hint: error.hint };
		throw error;
	}
	throw new Error('expected a refusal');
}

it('retries a transient Windows replacement without deleting the destination', () => {
	const path = stateFile();
	const hold = heldRename(2);
	const waits: number[] = [];
	replace(path, hold, waits);
	expect(waits).toEqual([10, 20]);
	expect(hold.attempts()).toBe(3);
	expect(readFileSync(path, 'utf8')).toBe('new');
	expect(readdirSync(root ?? '')).toEqual(['state.json']);
});

it('gives the default budget waits of 10, 20, 40, 80 and 160 ms: a sixth attempt still lands', () => {
	const path = stateFile();
	const hold = heldRename(5);
	const waits: number[] = [];
	replace(path, hold, waits);
	expect(waits).toEqual([10, 20, 40, 80, 160]);
	expect(hold.attempts()).toBe(6);
	expect(readFileSync(path, 'utf8')).toBe('new');
});

it('refuses once the default budget is spent, with the refusal of a failed rename and the destination kept', () => {
	const path = stateFile();
	const hold = heldRename(Number.POSITIVE_INFINITY);
	const waits: number[] = [];
	const refusal = refusalOf(() => replace(path, hold, waits));
	expect(waits).toEqual([10, 20, 40, 80, 160]);
	expect(hold.attempts()).toBe(6);
	expect(refusal).toEqual({
		code: 'CONFIG',
		message: `state.json: cannot atomically replace ${path}: EPERM: operation not permitted, rename`,
		hint: 'check the permissions of the parent directory'
	});
	expect(readFileSync(path, 'utf8')).toBe('old');
	expect(readdirSync(root ?? '')).toEqual(['state.json']);
});

it('keeps waiting past the default budget when the write names a longer one, in waits capped at 250 ms', () => {
	const path = stateFile();
	const hold = heldRename(7);
	const waits: number[] = [];
	replace(path, hold, waits, { windowsReplaceBudgetMs: 1_000 });
	expect(waits).toEqual([10, 20, 40, 80, 160, 250, 250]);
	expect(hold.attempts()).toBe(8);
	expect(readFileSync(path, 'utf8')).toBe('new');
});

it('takes no wait that would carry the sum past the budget, and then refuses', () => {
	const path = stateFile();
	const hold = heldRename(Number.POSITIVE_INFINITY);
	const waits: number[] = [];
	const refusal = refusalOf(() => replace(path, hold, waits, { windowsReplaceBudgetMs: 1_000 }));
	// 810 ms waited; one more wait of 250 ms would make 1060.
	expect(waits).toEqual([10, 20, 40, 80, 160, 250, 250]);
	expect(hold.attempts()).toBe(8);
	expect(refusal.code).toBe('CONFIG');
	expect(refusal.message).toMatch(/cannot atomically replace .*: EPERM/);
	expect(readFileSync(path, 'utf8')).toBe('old');
	expect(readdirSync(root ?? '')).toEqual(['state.json']);
});

it.each(['EACCES', 'EBUSY', 'ENOTEMPTY'])('treats %s from a Windows rename as a held target too', (code) => {
	const path = stateFile();
	const hold = heldRename(1, code);
	const waits: number[] = [];
	replace(path, hold, waits);
	expect(waits).toEqual([10]);
	expect(readFileSync(path, 'utf8')).toBe('new');
});

it('refuses at the first failure for an errno a held target does not produce', () => {
	const path = stateFile();
	const hold = heldRename(Number.POSITIVE_INFINITY, 'EXDEV');
	const waits: number[] = [];
	const refusal = refusalOf(() => replace(path, hold, waits, { windowsReplaceBudgetMs: 60_000 }));
	expect(waits).toEqual([]);
	expect(hold.attempts()).toBe(1);
	expect(refusal.message).toMatch(/cannot atomically replace .*: EXDEV/);
	expect(readdirSync(root ?? '')).toEqual(['state.json']);
});

it.each(['linux', 'darwin'] as const)('refuses at the first failure on %s, where a held target does not refuse a rename', (platform) => {
	const path = stateFile();
	const hold = heldRename(Number.POSITIVE_INFINITY);
	const waits: number[] = [];
	const refusal = refusalOf(() => replace(path, hold, waits, { windowsReplaceBudgetMs: 60_000, renamePlatform: platform }));
	expect(waits).toEqual([]);
	expect(hold.attempts()).toBe(1);
	expect(refusal.code).toBe('CONFIG');
	expect(readFileSync(path, 'utf8')).toBe('old');
});
