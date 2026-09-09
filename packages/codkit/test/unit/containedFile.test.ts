// The one contained-file implementation every administrative and repository
// read/write goes through (PROP-002 ##CONTAINED-FILE-IO). These tests pin its
// own contract: no leaf-symlink following, no symlinked parents, atomic
// replacement inside a verified parent, and honest refusal otherwise.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { closeSync, linkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openContainedFileAppend, readContainedFile, removeContainedFile, writeRegularFileAtomic } from '../../src/lib/containedFile.ts';
import { ensureAdminDirectory, sameEffectivePath } from '../../src/lib/containedPath.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';

afterAll(() => {
	cleanupDiskRoots();
});

function plantSentinel(root: string, name: string, bytes: string, mode = 0o644): string {
	mkdirSync(root, { recursive: true });
	const path = join(root, name);
	writeFileSync(path, bytes, 'utf8');
	chmodSync(path, mode);
	return path;
}

describe('the contained regular-file reader', () => {
	it('compares Windows effective hook paths across slash and case forms', () => {
		expect(sameEffectivePath('C:\\Repo\\.git\\hooks\\pre-commit', 'c:/repo/.git/hooks/pre-commit', 'win32')).toBe(true);
		expect(sameEffectivePath('C:\\Repo\\.git\\hooks\\pre-commit', 'c:/other/hooks/pre-commit', 'win32')).toBe(false);
	});
	it('reads a real file and reports an absent one', () => {
		const root = makeDiskRoot('contained-read-real');
		writeFileSync(join(root, 'file.json'), '{"ok":true}\n', 'utf8');
		const read = readContainedFile(root, 'file.json', { what: 'file.json' });
		expect(read.state).toBe('ok');
		if (read.state === 'ok') {
			expect(Buffer.from(read.bytes).toString('utf8')).toBe('{"ok":true}\n');
		}
		expect(readContainedFile(root, 'absent.json', { what: 'absent.json' }).state).toBe('absent');
	});

	it('refuses a symlinked leaf without reading the target', () => {
		const root = makeDiskRoot('contained-read-leaf-symlink');
		const outside = makeDiskRoot('contained-read-leaf-symlink-out');
		const sentinel = plantSentinel(outside, 'secrets.json', '{}\n');
		symlinkSync(sentinel, join(root, 'codkit.json'));
		expect(() => readContainedFile(root, 'codkit.json', { what: 'codkit.json' })).toThrow(/regular non-symlink/);
		expect(readFileSync(sentinel, 'utf8')).toBe('{}\n');
	});

	it('refuses a parent reached through a symlink', () => {
		const root = makeDiskRoot('contained-read-parent-symlink');
		const outside = makeDiskRoot('contained-read-parent-symlink-out');
		const nested = join(outside, 'nested');
		plantSentinel(nested, 'watch.json', '{}\n');
		symlinkSync(nested, join(root, 'profile'));
		expect(() => readContainedFile(root, 'profile/watch.json', { what: 'watch.json' })).toThrow(/symlink component/);
	});

	it('refuses when a verified parent is swapped to an outside symlink after open', () => {
		const root = makeDiskRoot('contained-read-parent-swap');
		const profile = join(root, 'profile');
		mkdirSync(profile);
		writeFileSync(join(profile, 'watch.json'), '{"inside":true}\n', 'utf8');
		const outside = makeDiskRoot('contained-read-parent-swap-out');
		const sentinel = plantSentinel(outside, 'watch.json', '{"outside":true}\n');

		expect(() =>
			readContainedFile(root, 'profile/watch.json', {
				what: 'watch.json',
				afterOpen: () => {
					renameSync(profile, join(root, 'held-profile'));
					symlinkSync(outside, profile);
				}
			})
		).toThrow(/resolves outside the root/);
		expect(readFileSync(sentinel, 'utf8')).toBe('{"outside":true}\n');
	});

	it('refuses a descriptor whose canonical path left the root, even onto the very same inode', () => {
		// The `isWithin` containment proof alone: the replacement carries a hard
		// link to the same leaf inode, so the descriptor-identity re-check beside
		// it passes and only the containment comparison can refuse. An
		// alternation spanning both guards would leave `isWithin` deletable.
		const root = makeDiskRoot('contained-read-iswithin');
		const profile = join(root, 'profile');
		mkdirSync(profile);
		writeFileSync(join(profile, 'watch.json'), '{"inside":true}\n', 'utf8');
		const outside = makeDiskRoot('contained-read-iswithin-out');
		linkSync(join(profile, 'watch.json'), join(outside, 'watch.json'));

		expect(() =>
			readContainedFile(root, 'profile/watch.json', {
				what: 'watch.json',
				afterOpen: () => {
					renameSync(profile, join(root, 'held-profile'));
					symlinkSync(outside, profile);
				}
			})
		).toThrow(/resolves outside the root/);
	});

	it('refuses a parent that is not a directory', () => {
		const root = makeDiskRoot('contained-read-parent-file');
		writeFileSync(join(root, 'profile'), 'a file\n', 'utf8');
		expect(() => readContainedFile(root, 'profile/watch.json', { what: 'watch.json' })).toThrow(/non-directory component/);
	});
});

describe('the atomic administrative writer', () => {
	it('replaces a regular file inside a verified parent, with mode', () => {
		const root = makeDiskRoot('contained-write-atomic');
		const parent = ensureAdminDirectory(root, ['admin'], { what: 'admin' });
		const path = join(parent, 'hook');
		writeRegularFileAtomic(path, { bytes: new Uint8Array([104, 105]), mode: 0o755, what: path });
		writeRegularFileAtomic(path, { bytes: new Uint8Array([104, 101, 121]), mode: 0o755, what: path });
		expect(readFileSync(path, 'utf8')).toBe('hey');
		expect(statSync(path).mode & 0o777).toBe(0o755);
		// No temporary litter is left beside the replaced file.
		expect(readdirSync(parent)).toEqual(['hook']);
	});

	it('refuses a leaf symlink instead of writing through it', () => {
		const root = makeDiskRoot('contained-write-leaf-symlink');
		const outside = makeDiskRoot('contained-write-leaf-symlink-out');
		const sentinel = plantSentinel(outside, 'target', 'sentinel\n', 0o741);
		symlinkSync(sentinel, join(root, 'leaf'));
		expect(() => writeRegularFileAtomic(join(root, 'leaf'), { bytes: new Uint8Array([1]), what: 'leaf' })).toThrow(
			/is a symlink; codkit never writes through one/
		);
		expect(readFileSync(sentinel, 'utf8')).toBe('sentinel\n');
	});

	it('refuses a symlinked administrative parent directory', () => {
		const root = makeDiskRoot('contained-admin-parent-symlink');
		const outside = makeDiskRoot('contained-admin-parent-symlink-out');
		mkdirSync(outside, { recursive: true });
		symlinkSync(outside, join(root, 'admin'));
		expect(() => ensureAdminDirectory(root, ['admin', 'nested'], { what: 'admin' })).toThrow(/symlink/);
		expect(existsSync(join(outside, 'nested'))).toBe(false);
	});

	it('refuses a direct atomic write whose immediate parent is a symlink', () => {
		const root = makeDiskRoot('contained-write-parent-symlink');
		const outside = makeDiskRoot('contained-write-parent-symlink-out');
		symlinkSync(outside, join(root, 'admin'));

		expect(() =>
			writeRegularFileAtomic(join(root, 'admin', 'hook'), {
				bytes: new Uint8Array([1, 2, 3]),
				what: 'hook'
			})
		).toThrow(/parent.*real directory/);
		expect(existsSync(join(outside, 'hook'))).toBe(false);
	});

	it('creates missing administrative directories as real directories', () => {
		const root = makeDiskRoot('contained-admin-create');
		const parent = ensureAdminDirectory(root, ['codkit', 'deeper'], { what: 'codkit' });
		expect(statSync(parent).isDirectory()).toBe(true);
		expect(statSync(parent).isSymbolicLink()).toBe(false);
		expect(parent).toBe(join(root, 'codkit', 'deeper'));
		rmSync(parent, { recursive: true });
	});

	it('refuses an administrative file name that is not a portable basename', () => {
		// The name check runs before any filesystem work: a trailing dot or a
		// reserved device name never becomes a file this tool administers.
		const root = makeDiskRoot('contained-write-unsafe-name');
		mkdirSync(root, { recursive: true });
		expect(() => writeRegularFileAtomic(join(root, 'hook.'), { bytes: new Uint8Array([1]), what: 'hook.' })).toThrow(
			/unsafe administrative file name/
		);
		expect(() => writeRegularFileAtomic(join(root, 'con'), { bytes: new Uint8Array([1]), what: 'con' })).toThrow(
			/unsafe administrative file name/
		);
		expect(readdirSync(root)).toEqual([]);
	});

	it('refuses a write whose parent path reaches the directory through a symlink', () => {
		// The final parent component is a real directory, so the shape check
		// passes and only the canonical-resolution comparison can refuse:
		// lstat resolves intermediate links, realpath exposes them.
		const root = makeDiskRoot('contained-write-parent-through-symlink');
		const real = makeDiskRoot('contained-write-parent-through-symlink-real');
		mkdirSync(join(real, 'nested'), { recursive: true });
		symlinkSync(real, join(root, 'link'));
		expect(() => writeRegularFileAtomic(join(root, 'link', 'nested', 'hook'), { bytes: new Uint8Array([1]), what: 'hook' })).toThrow(
			/resolves through a symlink/
		);
		expect(existsSync(join(real, 'nested', 'hook'))).toBe(false);
	});

	it('refuses an atomic replacement whose leaf vanished before the rename', () => {
		// The leaf half of the before-rename re-verification: the parent is
		// untouched, so the parent comparison passes and only the leaf
		// comparison can refuse. Renaming over an absent leaf is a write into a
		// state nobody proved.
		const root = makeDiskRoot('contained-write-leaf-vanished');
		const path = join(root, 'state.json');
		writeFileSync(path, '{"pid":1}\n', 'utf8');
		expect(() =>
			writeRegularFileAtomic(path, {
				what: 'state.json',
				bytes: new Uint8Array([2]),
				afterOpen: () => {
					unlinkSync(path);
				}
			})
		).toThrow(/the parent or target changed before atomic replacement/);
		expect(readdirSync(root)).toEqual([]);
	});

	it('reports a parent that still lstats to itself but no longer resolves to itself', () => {
		// The realpath conjunct of the post-rename proof, alone: after the
		// rename the directory still lstats as the same inode through the old
		// path - the intermediate component became a symlink to where the
		// directory now lives - so the shape, directory and dev/ino conjuncts
		// beside it all pass, and only the canonical-resolution comparison
		// notices the write now answers through a link.
		const root = makeDiskRoot('contained-write-parent-rerouted');
		mkdirSync(join(root, 'a', 'b'), { recursive: true });
		const path = join(root, 'a', 'b', 'hook');
		expect(() =>
			writeRegularFileAtomic(path, {
				what: 'hook',
				bytes: new Uint8Array([1]),
				afterReplace: () => {
					mkdirSync(join(root, 'a2'));
					renameSync(join(root, 'a', 'b'), join(root, 'a2', 'b'));
					rmSync(join(root, 'a'), { recursive: true });
					symlinkSync(join(root, 'a2'), join(root, 'a'));
				}
			})
		).toThrow(/the parent directory changed during the write/);
		expect(readFileSync(join(root, 'a2', 'b', 'hook'), 'utf8')).toBe(String.fromCharCode(1));
	});
});

describe('complete bytes or no publication', () => {
	it('loops a chunked descriptor write until every byte is on disk', () => {
		const root = makeDiskRoot('contained-short-write');
		const bytes = Buffer.from('a'.repeat(4096), 'utf8');
		const chunks: number[] = [];
		writeRegularFileAtomic(join(root, 'complete.bin'), {
			what: 'complete.bin',
			bytes,
			writeChunk: (handle, buffer, offset, length) => {
				const written = Math.min(7, length);
				chunks.push(written);
				return writeSync(handle, buffer, offset, written);
			}
		});
		expect(chunks.length).toBeGreaterThan(1);
		expect(readFileSync(join(root, 'complete.bin'))).toEqual(bytes);
	});

	// The no-progress refusal (writeChunk returning 0 or a negative count)
	// lives in `containedGuards.test.ts`, in a child process under a hard
	// timeout: with the check neutered the writer spins inside a synchronous
	// loop, and an in-process assertion would hang the suite instead of
	// failing it.
});

describe('directory identity, not directory name', () => {
	it('refuses a parent swapped for a different ordinary directory after open', () => {
		const root = makeDiskRoot('contained-ordinary-swap');
		const admin = join(root, 'admin');
		mkdirSync(admin, { recursive: true });
		writeFileSync(join(admin, 'state.json'), 'inside\n', 'utf8');
		const held = `${admin}-held`;
		const replacement = makeDiskRoot('contained-ordinary-swap-replacement');
		writeFileSync(join(replacement, 'state.json'), 'replacement\n', 'utf8');
		const replacementBefore = readFileSync(join(replacement, 'state.json'));

		expect(() =>
			readContainedFile(root, 'admin/state.json', {
				what: 'admin/state.json',
				afterOpen: () => {
					renameSync(admin, held);
					// An ordinary directory, not a symlink: only dev/ino tells them apart.
					renameSync(replacement, admin);
				}
			})
		).toThrow(/changed while it was being read/);
		expect(readFileSync(join(admin, 'state.json'))).toEqual(replacementBefore);
		renameSync(admin, replacement);
		renameSync(held, admin);
	});

	it('refuses a leaf that vanished between the open and the append proof', () => {
		// The leaf half of the append opener's post-open re-verification: the
		// parent is untouched, so the parent comparison passes and only the
		// leaf identity check can refuse. An absent name is not a descriptor.
		const root = makeDiskRoot('contained-append-leaf-gone');
		const admin = join(root, 'admin');
		mkdirSync(admin, { recursive: true });
		writeFileSync(join(admin, 'transpile.log'), 'a line\n', 'utf8');
		expect(() =>
			openContainedFileAppend(root, 'admin/transpile.log', {
				what: 'admin/transpile.log',
				afterOpen: () => {
					unlinkSync(join(admin, 'transpile.log'));
				}
			})
		).toThrow(/changed while the append descriptor was being opened/);
	});
});

describe('hard-linked runtime leaves', () => {
	it('refuses to append to a leaf that shares an inode with an outside file', () => {
		const root = makeDiskRoot('contained-hardlink-append');
		const outside = makeDiskRoot('contained-hardlink-outside');
		const sentinel = join(outside, 'peer.log');
		writeFileSync(sentinel, 'outside\n', 'utf8');
		const runtime = join(root, 'admin');
		mkdirSync(runtime, { recursive: true });
		linkSync(sentinel, join(runtime, 'peer.log'));
		const before = readFileSync(sentinel);
		const beforeMtime = statSync(sentinel).mtimeMs;

		expect(() => openContainedFileAppend(root, 'admin/peer.log', { what: 'admin/peer.log' })).toThrow(/more than one hard link/);
		expect(readFileSync(sentinel)).toEqual(before);
		expect(statSync(sentinel).mtimeMs).toBe(beforeMtime);
	});

	it('appends normally to a singly linked leaf', () => {
		const root = makeDiskRoot('contained-hardlink-single');
		const handle = openContainedFileAppend(root, 'admin/single.log', { what: 'admin/single.log' });
		closeSync(handle);
		expect(readFileSync(join(root, 'admin', 'single.log'), 'utf8')).toBe('');
	});
});

describe('the contained removal treats absence as completion, not as an error', () => {
	it('returns when the administrative parent does not exist at all', () => {
		// The contract says absent is already complete, and `ensureAdminDirectory`
		// with `create: false` is explicitly allowed to return a path whose
		// components do not exist: a raw `ENOENT` out of the parent stat would
		// surface an internal errno instead of the completion the caller asked
		// for - the asymmetry an audit found against this function's own contract
		// and its sibling's convention.
		const root = makeDiskRoot('contained-remove-no-parent');
		expect(() => removeContainedFile(root, 'admin/gone.json', { what: 'admin/gone.json' })).not.toThrow();
		expect(existsSync(join(root, 'admin'))).toBe(false);
	});

	it('returns when the parent vanishes between the shape proofs and the removal', () => {
		// The same state reached mid-call: a directory that disappeared holds no
		// contained leaf, so there is nothing left to remove and nothing to
		// refuse - distinct from the swapped-parent refusal, whose replacement
		// directory still stands.
		const root = makeDiskRoot('contained-remove-vanished-parent');
		const admin = join(root, 'admin');
		mkdirSync(admin, { recursive: true });
		writeFileSync(join(admin, 'gone.json'), '{}\n', 'utf8');
		expect(() =>
			removeContainedFile(root, 'admin/gone.json', {
				what: 'admin/gone.json',
				afterOpen: () => {
					rmSync(admin, { recursive: true, force: true });
				}
			})
		).not.toThrow();
		expect(existsSync(admin)).toBe(false);
	});
});
