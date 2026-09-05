// The ordinary-directory swap every parent-identity proof is anchored with.
//
// A naive replacement directory is refused for the wrong reason: the leaf the
// operation is holding is absent from it, or is a different inode, so the leaf
// checks fire first and the `sameFile` parent comparisons can all be deleted
// with the suite still green. The replacement therefore carries a *hard link
// to the very same leaf inode*: every leaf identity check passes, and the
// parent comparison is the only guard left standing between the operation and
// the wrong directory.

import { linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { makeDiskRoot } from './diskRoot.ts';

/** One ordinary directory swapped for another: only dev/ino separates them. */
export type Swap = {
	readonly root: string;
	readonly parent: string;
	readonly replacement: string;
	readonly swap: () => void;
	/** Bytes, names and mtimes of the replacement, captured before the swap. */
	readonly expectReplacementUntouched: () => void;
};

export function ordinarySwap(label: string, relativeParent: string, leaf?: { readonly name: string; readonly bytes: string }): Swap {
	// Both roots on the disk fixture root: this helper anchors the parent
	// identity proofs of the generation-election modules, whose fixtures are
	// obliged to live where inode numbers are recycled.
	const root = makeDiskRoot(label);
	const parent = join(root, ...relativeParent.split('/'));
	mkdirSync(parent, { recursive: true });
	const replacement = makeDiskRoot(`${label}-replacement`);
	writeFileSync(join(replacement, 'decoy.json'), 'replacement\n', 'utf8');
	if (leaf !== undefined) {
		writeFileSync(join(parent, leaf.name), leaf.bytes, 'utf8');
		// Same dev/ino under both parents: the leaf proofs cannot tell them apart.
		linkSync(join(parent, leaf.name), join(replacement, leaf.name));
	}
	let names: string[] = [];
	let bytes: Buffer = Buffer.alloc(0);
	let mtime = 0;
	const held = `${parent}-held`;
	return {
		root,
		parent,
		replacement,
		swap: () => {
			// Snapshot at swap time, not fixture-construction time: a test may
			// add links to the replacement after building the fixture, and the
			// question is what the refused operation changed, not what the test
			// arranged.
			names = readdirSync(replacement).sort();
			bytes = readFileSync(join(replacement, 'decoy.json'));
			mtime = statSync(join(replacement, 'decoy.json')).mtimeMs;
			renameSync(parent, held);
			renameSync(replacement, parent);
		},
		expectReplacementUntouched: () => {
			// After the swap the replacement lives at `parent`; nothing the
			// refused operation did may have reached it.
			expect(readdirSync(parent).sort()).toEqual(names);
			expect(readFileSync(join(parent, 'decoy.json'))).toEqual(bytes);
			expect(statSync(join(parent, 'decoy.json')).mtimeMs).toBe(mtime);
		}
	};
}
