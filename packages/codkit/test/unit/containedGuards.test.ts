// Adversarial evidence for the containment guards every daemon-runtime file
// passes through (PROP-002 ##CONTAINED-FILE-IO, PROP-010 ##DAEMON-CHANNEL-LOCK).
//
// Two defect classes are held here, both found by independent audit against
// bytes whose own suite was fully green:
//
//   * a non-regular leaf - a FIFO, most cheaply - planted at any contained
//     name. `O_NOFOLLOW` does not refuse one, and `open` on a FIFO blocks until
//     a peer appears, so the post-open `isFile()` refusal never runs. Every
//     command loads configuration through this path, so one named pipe in the
//     patch-set root hung the entire tool with no error and no timeout. Each
//     probe below therefore runs in a child process under a hard timeout, and
//     the child runs FIRST: an in-process open of a FIFO blocks inside a
//     synchronous syscall, where vitest's own timeout cannot fire because the
//     event loop never runs again. With both defenses gone, the child returns a
//     clean failure before any in-process call is reached; the in-process
//     assertion that follows is a second opinion, not the instrument.
//
//   * a parent directory replaced by a *different ordinary directory*. A
//     symlinked parent is refused earlier, by the administrative walk, and
//     never reaches the dev/ino comparison - so a suite whose only "ancestor
//     swapped" cases use symlinks leaves every `sameFile` parent check
//     deletable with the suite still green. Each seam that publishes, appends,
//     renames, removes or retires bytes gets a real ordinary-directory swap -
//     the generation-election seams, the orphan recovery's included, in
//     `containedGeneration.test.ts`.

import { execFileSync } from 'node:child_process';
import {
	closeSync,
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	openContainedFileAppend,
	readContainedFile,
	removeContainedFile,
	renameContainedFile,
	writeContainedFileExclusive,
	writeRegularFileAtomic
} from '../../src/lib/containedFile.ts';
import { ensureAdminDirectory, unlinkIfPresent } from '../../src/lib/containedPath.ts';
import { ordinarySwap } from '../support/ordinarySwap.ts';
import { cleanupDiskRoots, makeDiskRoot } from '../support/diskRoot.ts';

afterAll(() => {
	cleanupDiskRoots();
});

const RUNTIME = '.codkit/build';
const LOCKS = '.codkit/locks';
const EMITTED = fileURLToPath(new URL('../../dist/lib/containedFile.js', import.meta.url));

/** A named pipe at `path`; the cheapest non-regular leaf that blocks an open. */
function plantFifo(path: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
	execFileSync('mkfifo', [path]);
}

/** A unix socket file at `path`, bound and then abandoned by its process. */
function plantSocket(path: string): void {
	mkdirSync(join(path, '..'), { recursive: true });
	execFileSync(process.execPath, [
		'--input-type=module',
		'-e',
		'import net from "node:net"; const server = net.createServer(); server.listen(process.argv[2], () => process.exit(0));',
		'',
		path
	]);
}

/**
 * Run one contained call against the emitted runtime in a child process.
 *
 * The timeout is the assertion: a guard that stops refusing before the open
 * turns this into a killed child, not a hung suite.
 */
function probeEmitted(body: string): string {
	const script = `
		const { readContainedFile, openContainedFileAppend, renameContainedFile, removeContainedFile, writeRegularFileAtomic, writeContainedFileExclusive } = await import(${JSON.stringify(EMITTED)});
		const { execFileSync } = await import('node:child_process');
		const { symlinkSync, unlinkSync } = await import('node:fs');
		try {
			${body}
			console.log('NOT-REFUSED');
		} catch (error) {
			console.log('REFUSED: ' + (error && error.message ? error.message : String(error)));
		}
	`;
	try {
		return execFileSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 8000, encoding: 'utf8' }).trim();
	} catch (error) {
		const killed = (error as { killed?: boolean }).killed === true;
		throw new Error(killed ? 'the contained call did not return within 8s: a non-regular leaf blocked the open' : String(error));
	}
}

describe('a non-regular leaf is refused before the open, on every contained path', () => {
	it.each([
		['the configuration file', 'codkit.json'],
		['a daemon record', `${RUNTIME}/transpile.json`],
		['a channel lock', `${LOCKS}/daemon-0.lock`]
	])('refuses a FIFO planted at %s', (_label, relative) => {
		const root = makeDiskRoot('fifo-read');
		plantFifo(join(root, relative));
		const emitted = probeEmitted(`readContainedFile(${JSON.stringify(root)}, ${JSON.stringify(relative)}, { what: 'probe' });`);
		expect(emitted).toMatch(/^REFUSED: .*must be a regular file/);
		expect(() => readContainedFile(root, relative, { what: relative })).toThrow(/must be a regular file/);
	});

	it('refuses a FIFO planted at the daemon log instead of blocking the append opener', () => {
		const root = makeDiskRoot('fifo-append');
		const relative = `${RUNTIME}/transpile.log`;
		plantFifo(join(root, relative));
		const emitted = probeEmitted(`openContainedFileAppend(${JSON.stringify(root)}, ${JSON.stringify(relative)}, { what: 'probe' });`);
		expect(emitted).toMatch(/^REFUSED: .*must be a regular file/);
		expect(() => openContainedFileAppend(root, relative, { what: relative })).toThrow(/must be a regular file/);
	});

	it('refuses a FIFO planted at the rotation target instead of renaming onto it', () => {
		const root = makeDiskRoot('fifo-rotate');
		const from = `${RUNTIME}/transpile.log`;
		const to = `${RUNTIME}/transpile.log.1`;
		mkdirSync(join(root, RUNTIME), { recursive: true });
		writeFileSync(join(root, from), 'a pass\n', 'utf8');
		plantFifo(join(root, to));
		const emitted = probeEmitted(
			`renameContainedFile(${JSON.stringify(root)}, ${JSON.stringify(from)}, ${JSON.stringify(to)}, { what: 'probe' });`
		);
		expect(emitted).toMatch(/^REFUSED: .*rename target must be absent or a regular file/);
		expect(() => renameContainedFile(root, from, to, { what: from })).toThrow(/rename target must be absent or a regular file/);
		// The source log is intact: a refused rotation loses no lines.
		expect(readFileSync(join(root, from), 'utf8')).toBe('a pass\n');
	});

	it('refuses a FIFO planted at the rotation source instead of renaming it away', () => {
		// The source-shape check of the rename: the target side has its own probe
		// above, and the source side was held by nothing - a FIFO where a
		// regular log must be is refused, not moved.
		const root = makeDiskRoot('fifo-rotate-source');
		const from = `${RUNTIME}/transpile.log`;
		const to = `${RUNTIME}/transpile.log.1`;
		plantFifo(join(root, from));
		const emitted = probeEmitted(
			`renameContainedFile(${JSON.stringify(root)}, ${JSON.stringify(from)}, ${JSON.stringify(to)}, { what: 'probe' });`
		);
		expect(emitted).toMatch(/^REFUSED: .*rename source must be a regular file/);
		expect(() => renameContainedFile(root, from, to, { what: from })).toThrow(/rename source must be a regular file/);
		expect(statSync(join(root, from)).isFIFO()).toBe(true);
		expect(existsSync(join(root, to))).toBe(false);
	});
});

describe('a leaf that becomes a FIFO inside the check-then-open window', () => {
	it('returns instead of blocking, and the post-open shape proof refuses it', () => {
		// `O_NONBLOCK` is the whole defense here: the pre-open check saw a regular
		// file, so only the open itself can still be told. Without it this call
		// blocks forever inside a synchronous syscall - which is why the assertion
		// is the child's hard timeout, not an in-process expectation.
		const root = makeDiskRoot('fifo-in-window');
		const relative = 'codkit.json';
		const path = join(root, relative);
		writeFileSync(path, '{}\n', 'utf8');
		const emitted = probeEmitted(`
			readContainedFile(${JSON.stringify(root)}, ${JSON.stringify(relative)}, {
				what: 'probe',
				beforeOpen: () => {
					unlinkSync(${JSON.stringify(path)});
					execFileSync('mkfifo', [${JSON.stringify(path)}]);
				}
			});
		`);
		expect(emitted).toMatch(/^REFUSED: .*must be a regular non-symlink file/);
	});

	it('refuses a symlink planted in that window instead of reading through it', () => {
		// `O_NOFOLLOW` is the whole defense here, and this window is the only
		// place it is load-bearing: the pre-open shape check saw a regular file,
		// and the post-open containment proof would happily accept a descriptor
		// that names a regular file outside the root were the open to follow the
		// link. Without the flag the sentinel's bytes are read as the
		// configuration's.
		const root = makeDiskRoot('symlink-in-window');
		const relative = 'codkit.json';
		const path = join(root, relative);
		writeFileSync(path, '{}\n', 'utf8');
		const outside = makeDiskRoot('symlink-in-window-out');
		const sentinel = join(outside, 'sentinel');
		writeFileSync(sentinel, '{"stolen":true}\n', 'utf8');
		const emitted = probeEmitted(`
			readContainedFile(${JSON.stringify(root)}, ${JSON.stringify(relative)}, {
				what: 'probe',
				beforeOpen: () => {
					unlinkSync(${JSON.stringify(path)});
					symlinkSync(${JSON.stringify(sentinel)}, ${JSON.stringify(path)});
				}
			});
		`);
		expect(emitted).toMatch(/^REFUSED: .*must be a regular non-symlink file/);
		expect(() =>
			readContainedFile(root, relative, {
				what: 'probe',
				beforeOpen: () => {
					unlinkSync(path);
					symlinkSync(sentinel, path);
				}
			})
		).toThrow(/must be a regular non-symlink file/);
		expect(readFileSync(sentinel, 'utf8')).toBe('{"stolen":true}\n');
	});
});

describe('parent identity, not parent name, guards every contained mutation', () => {
	it('refuses exclusive publication into a swapped ordinary parent', () => {
		const fixture = ordinarySwap('swap-exclusive', RUNTIME);
		expect(() =>
			writeContainedFileExclusive(fixture.root, `${RUNTIME}/transpile.json`, {
				what: 'record',
				bytes: Buffer.from('{"pid":1}\n', 'utf8'),
				afterOpen: fixture.swap
			})
		).toThrow(/runtime parent identity changed before exclusive publication/);
		fixture.expectReplacementUntouched();
		expect(existsSync(join(fixture.parent, 'transpile.json'))).toBe(false);
	});

	it('refuses an append descriptor whose parent was swapped, by parent identity alone', () => {
		// The recorded rationale for leaving this held by no test was wrong: the append
		// opener refuses a multiply linked leaf only when the second link exists
		// BEFORE the call. Adding it inside the seam lets every leaf proof pass -
		// same inode under both parents - so the parent comparison is the only
		// guard that can still refuse.
		const fixture = ordinarySwap('swap-append-parent', RUNTIME);
		writeFileSync(join(fixture.parent, 'transpile.log'), 'first\n', 'utf8');
		expect(() =>
			openContainedFileAppend(fixture.root, `${RUNTIME}/transpile.log`, {
				what: 'log',
				afterOpen: () => {
					linkSync(join(fixture.parent, 'transpile.log'), join(fixture.replacement, 'transpile.log'));
					fixture.swap();
				}
			})
		).toThrow(/changed while the append descriptor was being opened/);
		fixture.expectReplacementUntouched();
	});

	it('refuses an append descriptor whose parent was swapped after the open', () => {
		// The same swap without the in-seam link: here the leaf identity check is
		// what refuses, and the parent comparison is redundancy.
		const fixture = ordinarySwap('swap-append', RUNTIME);
		writeFileSync(join(fixture.parent, 'transpile.log'), 'first\n', 'utf8');
		expect(() =>
			openContainedFileAppend(fixture.root, `${RUNTIME}/transpile.log`, {
				what: 'log',
				afterOpen: fixture.swap
			})
		).toThrow(/changed while the append descriptor was being opened/);
		fixture.expectReplacementUntouched();
	});

	it('refuses a rotation whose parent was swapped after the shapes were proven', () => {
		const fixture = ordinarySwap('swap-rename', RUNTIME, { name: 'transpile.log', bytes: 'a pass\n' });
		expect(() =>
			renameContainedFile(fixture.root, `${RUNTIME}/transpile.log`, `${RUNTIME}/transpile.log.1`, {
				what: 'log',
				afterOpen: fixture.swap
			})
		).toThrow(/runtime parent identity changed before rename/);
		fixture.expectReplacementUntouched();
		expect(existsSync(join(fixture.parent, 'transpile.log.1'))).toBe(false);
	});

	it('refuses a removal whose parent was swapped after the shapes were proven', () => {
		const fixture = ordinarySwap('swap-remove', RUNTIME, { name: 'transpile.json', bytes: '{"pid":1}\n' });
		expect(() =>
			removeContainedFile(fixture.root, `${RUNTIME}/transpile.json`, {
				what: 'record',
				afterOpen: fixture.swap
			})
		).toThrow(/changed before contained removal/);
		fixture.expectReplacementUntouched();
	});

	it('refuses an atomic replacement whose parent was swapped before the rename', () => {
		// The writer behind every daemon-record replacement, hook, tree mark,
		// `info/exclude` and config pin. The target is absent under both parents,
		// so the leaf half of the re-verification is satisfied either way and the
		// parent comparison is the only guard that can refuse. (A hard-linked
		// leaf cannot serve here: this writer refuses a multiply linked leaf
		// before it ever compares parents.)
		const fixture = ordinarySwap('swap-replace-before', RUNTIME);
		expect(() =>
			writeRegularFileAtomic(join(fixture.parent, 'transpile.json'), {
				what: 'record',
				bytes: Buffer.from('{"pid":2}\n', 'utf8'),
				afterOpen: fixture.swap
			})
		).toThrow(/the parent or target changed before atomic replacement/);
		fixture.expectReplacementUntouched();
	});

	it('reports an atomic replacement whose parent was swapped after the rename', () => {
		// The post-write proof. `afterOpen` never reaches it - the pre-rename
		// re-verification refuses first - so this is the only seam that can pin
		// it, and without a test here it was deletable with the suite green.
		const fixture = ordinarySwap('swap-replace-after', RUNTIME);
		expect(() =>
			writeRegularFileAtomic(join(fixture.parent, 'transpile.json'), {
				what: 'record',
				bytes: Buffer.from('{"pid":2}\n', 'utf8'),
				afterReplace: fixture.swap
			})
		).toThrow(/the parent directory changed during the write/);
		fixture.expectReplacementUntouched();
	});

	it('refuses to replace a leaf that shares its inode with another name', () => {
		// The write half of the multi-link refusal REPAIR-009 ordered for append
		// AND write; only the append half was held. Replacing a multiply linked
		// leaf would publish runtime bytes through somebody else's name.
		const root = makeDiskRoot('replace-multilink');
		const parent = join(root, ...RUNTIME.split('/'));
		mkdirSync(parent, { recursive: true });
		const leaf = join(parent, 'transpile.json');
		writeFileSync(leaf, '{"pid":1}\n', 'utf8');
		linkSync(leaf, join(parent, 'transpile.json.sentinel'));
		expect(() => writeRegularFileAtomic(leaf, { what: 'record', bytes: Buffer.from('{"pid":2}\n', 'utf8') })).toThrow(
			/has more than one hard link; refusing replacement/
		);
		expect(readFileSync(leaf, 'utf8')).toBe('{"pid":1}\n');
	});
});

describe('a refused operation leaves no temporary behind, and a peer is not a failure', () => {
	it('unlinks the publication candidate when the seam throws', () => {
		const root = makeDiskRoot('candidate-litter');
		expect(() =>
			writeContainedFileExclusive(root, `${RUNTIME}/transpile.json`, {
				what: 'record',
				bytes: Buffer.from('{"pid":1}\n', 'utf8'),
				afterOpen: () => {
					throw new Error('injected seam throw');
				}
			})
		).toThrow(/injected seam throw/);
		expect(readdirSync(join(root, ...RUNTIME.split('/')))).toEqual([]);
	});

	it('unlinks the atomic temporary when the seam throws', () => {
		const root = makeDiskRoot('temporary-litter');
		const parent = join(root, ...RUNTIME.split('/'));
		mkdirSync(parent, { recursive: true });
		expect(() =>
			writeRegularFileAtomic(join(parent, 'transpile.json'), {
				what: 'record',
				bytes: Buffer.from('{"pid":1}\n', 'utf8'),
				afterOpen: () => {
					throw new Error('injected seam throw');
				}
			})
		).toThrow(/injected seam throw/);
		expect(readdirSync(parent)).toEqual([]);
	});

	it('unlinks the atomic temporary when applying the mode fails', () => {
		// The cleanup spans every exit between the open and the rename, so a
		// failure at the mode step - which the real `chmod` almost never
		// produces on a file its own writer created - leaves no temporary
		// either. The seam is the only way to express that failure.
		const root = makeDiskRoot('mode-failure-litter');
		const parent = join(root, ...RUNTIME.split('/'));
		mkdirSync(parent, { recursive: true });
		expect(() =>
			writeRegularFileAtomic(join(parent, 'transpile.json'), {
				what: 'record',
				bytes: Buffer.from('{"pid":1}\n', 'utf8'),
				mode: 0o644,
				applyMode: () => {
					throw new Error('injected mode failure');
				}
			})
		).toThrow(/cannot set the mode/);
		expect(readdirSync(parent)).toEqual([]);
	});

	it('refuses a writer that makes no progress, in a child under a hard timeout', () => {
		// The no-progress check guards against a synchronous infinite loop, so
		// its own regression cannot be an in-process failure: vitest's timeout
		// never fires while the event loop is spun inside one syscall loop.
		// The child's hard timeout is the assertion - a deleted check turns
		// this into a killed child, not a hung suite.
		const root = makeDiskRoot('no-progress-child');
		for (const chunk of ['0', '-1']) {
			const emitted = probeEmitted(`
				writeRegularFileAtomic(${JSON.stringify(join(root, `partial-${chunk}.bin`))}, {
					what: 'partial.bin',
					bytes: Buffer.from('abcdef', 'utf8'),
					writeChunk: () => ${chunk}
				});
			`);
			expect(emitted).toMatch(/^REFUSED: .*short write made no valid progress/);
			const exclusive = probeEmitted(`
				writeContainedFileExclusive(${JSON.stringify(root)}, ${JSON.stringify(`${RUNTIME}/first-${chunk}.json`)}, {
					what: 'first.json',
					bytes: Buffer.from('{"a":1}\\n', 'utf8'),
					writeChunk: () => ${chunk}
				});
			`);
			expect(exclusive).toMatch(/^REFUSED: .*short write made no valid progress/);
		}
		// The administrative parent directories exist; no candidate file does.
		expect(readdirSync(join(root, ...RUNTIME.split('/')))).toEqual([]);
	});

	it('accepts an administrative component a peer created in the same instant', () => {
		// Two commands on one patch set, first run on a fresh checkout: both see
		// the component missing and one `mkdir` loses with EEXIST. That is a peer,
		// not a failure, and refusing it was a spurious command failure on the
		// intended shared topology.
		const root = makeDiskRoot('admin-peer-race');
		const created = ensureAdminDirectory(root, LOCKS.split('/'), {
			what: 'locks',
			beforeCreate: () => mkdirSync(join(root, ...LOCKS.split('/')), { recursive: true })
		});
		expect(created).toBe(join(root, ...LOCKS.split('/')));
		expect(statSync(created).isDirectory()).toBe(true);
	});

	it('still refuses when what the peer created is not a real directory', () => {
		// Tolerating EEXIST must not become trusting it: the component the peer
		// left still has to pass the same shape proof.
		const root = makeDiskRoot('admin-peer-symlink');
		const elsewhere = makeDiskRoot('admin-peer-elsewhere');
		mkdirSync(join(root, '.codkit'), { recursive: true });
		expect(() =>
			ensureAdminDirectory(root, LOCKS.split('/'), {
				what: 'locks',
				beforeCreate: () => symlinkSync(elsewhere, join(root, ...LOCKS.split('/')))
			})
		).toThrow(/is a symlink, not a real directory/);
	});
});

describe('the append opener leaves no descriptor behind when it refuses', () => {
	it('closes the descriptor it opened before refusing a swapped parent', () => {
		const fixture = ordinarySwap('swap-append-fd', RUNTIME);
		writeFileSync(join(fixture.parent, 'transpile.log'), 'first\n', 'utf8');
		let handle: number | null = null;
		expect(() => {
			handle = openContainedFileAppend(fixture.root, `${RUNTIME}/transpile.log`, {
				what: 'log',
				afterOpen: fixture.swap
			});
		}).toThrow(/changed while the append descriptor was being opened/);
		// The refusal path owns the descriptor; nothing is returned to close.
		expect(handle).toBeNull();
	});

	it('returns a usable descriptor when nothing was swapped', () => {
		const root = makeDiskRoot('append-clean');
		const handle = openContainedFileAppend(root, `${RUNTIME}/transpile.log`, { what: 'log' });
		closeSync(handle);
		expect(readFileSync(join(root, RUNTIME, 'transpile.log'), 'utf8')).toBe('');
	});
});

describe('a non-regular leaf is named for what it is, on every path that touches it', () => {
	it('refuses to remove a socket leaf as a regular file, not as a symlink', () => {
		// The refusal names the state it refuses: `must be a regular file` for a
		// pipe, socket or device - the wording a symlink gets is wrong here and
		// sends the operator hunting a link that does not exist.
		const root = makeDiskRoot('remove-socket-leaf');
		const path = join(root, ...RUNTIME.split('/'), 'transpile.json');
		plantSocket(path);
		expect(() => removeContainedFile(root, `${RUNTIME}/transpile.json`, { what: 'record' })).toThrow(/must be a regular file/);
		expect(statSync(path).isSocket()).toBe(true);
		// A link still gets the link's own wording: the two refusals are
		// different guards with different hints.
		const linked = makeDiskRoot('remove-symlink-leaf');
		const outside = makeDiskRoot('remove-symlink-leaf-out');
		writeFileSync(join(outside, 'sentinel'), 'outside\n', 'utf8');
		const leaf = join(linked, ...RUNTIME.split('/'), 'transpile.json');
		mkdirSync(join(leaf, '..'), { recursive: true });
		symlinkSync(join(outside, 'sentinel'), leaf);
		expect(() => removeContainedFile(linked, `${RUNTIME}/transpile.json`, { what: 'record' })).toThrow(
			/must be a regular non-symlink file/
		);
		expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('outside\n');
	});

	it('refuses to atomically replace a socket leaf instead of deleting it', () => {
		// The atomic writer replaces regular files; every other operation in
		// this layer refuses a non-regular leaf, and a silent rename over one
		// is an unannounced deletion of an entry a human placed there.
		const root = makeDiskRoot('replace-socket-leaf');
		const path = join(root, ...RUNTIME.split('/'), 'transpile.json');
		plantSocket(path);
		expect(() => writeRegularFileAtomic(path, { what: 'record', bytes: Buffer.from('{"pid":2}\n', 'utf8') })).toThrow(
			/must be a regular file/
		);
		expect(statSync(path).isSocket()).toBe(true);
	});

	it('refuses to atomically replace a FIFO leaf instead of deleting it', () => {
		const root = makeDiskRoot('replace-fifo-leaf');
		const path = join(root, ...RUNTIME.split('/'), 'transpile.json');
		plantFifo(path);
		expect(() => writeRegularFileAtomic(path, { what: 'record', bytes: Buffer.from('{"pid":2}\n', 'utf8') })).toThrow(
			/must be a regular file/
		);
		expect(existsSync(path)).toBe(true);
	});
});

describe('the administrative directory walk refuses what it cannot prove', () => {
	it('refuses an administrative component that is not a directory', () => {
		// A file planted where a directory must descend: the shape proof, not
		// the errno of a mkdir that lost a race to it.
		const root = makeDiskRoot('admin-not-a-directory');
		mkdirSync(join(root, '.codkit'), { recursive: true });
		writeFileSync(join(root, '.codkit', 'locks'), 'a file\n', 'utf8');
		expect(() => ensureAdminDirectory(root, LOCKS.split('/'), { what: 'locks' })).toThrow(/is not a directory/);
		expect(readFileSync(join(root, '.codkit', 'locks'), 'utf8')).toBe('a file\n');
	});

	it('refuses to remove a directory leaf, and the hint names the directory', () => {
		// The refusal names the state it refuses: a directory at a contained
		// removal target is not a pipe, socket or device either, and the hint
		// is what sends the operator's hand - it must name the entry that is
		// actually there.
		const root = makeDiskRoot('remove-directory-leaf');
		const path = join(root, ...RUNTIME.split('/'), 'transpile.json');
		mkdirSync(join(root, ...RUNTIME.split('/')), { recursive: true });
		mkdirSync(path);
		expect(() => removeContainedFile(root, `${RUNTIME}/transpile.json`, { what: 'record' })).toThrow(/must be a regular file/);
		let hint = '';
		try {
			removeContainedFile(root, `${RUNTIME}/transpile.json`, { what: 'record' });
		} catch (error) {
			hint = (error as { hint?: string }).hint ?? '';
		}
		expect(hint).toContain('directory');
		expect(statSync(path).isDirectory()).toBe(true);
	});

	it('rethrows every unlink error but ENOENT, so tolerance cannot swallow damage', () => {
		// The errno narrowing of `unlinkIfPresent`: only ENOENT is a peer
		// winning a race. Anything else - here EISDIR, a directory where a file
		// was about to be removed - must escape, or every cleanup this module
		// runs could hide real damage behind a tolerant catch.
		const root = makeDiskRoot('unlink-narrowing');
		const path = join(root, 'not-a-file');
		mkdirSync(path);
		expect(() => unlinkIfPresent(path)).toThrow(/EISDIR/);
		// Absent is already complete, not an error.
		expect(() => unlinkIfPresent(join(root, 'absent'))).not.toThrow();
	});

	it('refuses an administrative component that is not a portable path segment', () => {
		// The lexical guard runs before anything is created: a `..` segment
		// would walk the administrative path out of the root it must stay in.
		const root = makeDiskRoot('admin-unsafe-segment');
		mkdirSync(join(root, '.codkit'), { recursive: true });
		const outside = makeDiskRoot('admin-unsafe-segment-outside');
		writeFileSync(join(outside, 'sentinel'), 'outside\n', 'utf8');
		expect(() => ensureAdminDirectory(root, ['.codkit', '..'], { what: 'locks' })).toThrow(/unsafe administrative path component/);
		expect(existsSync(join(outside, 'sentinel'))).toBe(true);
		expect(readdirSync(join(root, '.codkit'))).toEqual([]);
	});
});
