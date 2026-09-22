import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { writeRegularFileAtomic } from '../../src/lib/containedFile.ts';

let root: string | undefined;

afterEach(() => {
	if (root !== undefined) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

it('retries a transient Windows replacement without deleting the destination', () => {
	root = mkdtempSync(join(tmpdir(), 'ck-windows-rename-'));
	const path = join(root, 'state.json');
	writeFileSync(path, 'old', 'utf8');
	let attempts = 0;
	const delays: number[] = [];
	writeRegularFileAtomic(path, {
		what: 'state.json',
		bytes: Buffer.from('new'),
		renamePlatform: 'win32',
		waitForRenameRetry: milliseconds => delays.push(milliseconds),
		applyRename: (temporary, destination) => {
			attempts += 1;
			if (attempts < 3) {
				throw Object.assign(new Error('transient Windows lock'), { code: 'EPERM' });
			}
			renameSync(temporary, destination);
		}
	});
	expect(attempts).toBe(3);
	expect(delays).toEqual([10, 20]);
	expect(readFileSync(path, 'utf8')).toBe('new');
	expect(readdirSync(root)).toEqual(['state.json']);
});
