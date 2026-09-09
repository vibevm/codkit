/** @scope spec://codkit/modules/codkit/PROP-008#SAVE-REPLAYS-TREE-COMMITS */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../../src/lib/saveReplay.ts';
import { pendingPath } from '../../src/lib/pendingHeader.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const ARTIFACT = 'delta/patches/source__example.ts.ckpatch';
const TARGET = 'source/example.ts';

afterAll(() => {
	cleanupTempRoots();
});

/** A patchset root with one artifact on disk and one pending draft. */
function makeStore(): { readonly store: ArtifactStore; readonly root: string } {
	const root = makeTempRoot('savereplay-store');
	mkdirSync(join(root, 'delta', 'patches'), { recursive: true });
	writeFileSync(join(root, ...ARTIFACT.split('/')), 'on-disk bytes\n', 'utf8');
	writePending(root);
	return { store: new ArtifactStore(root), root };
}

function writePending(root: string): void {
	const path = pendingPath(root, TARGET);
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(
		path,
		JSON.stringify({
			id: 'CK-test-001',
			layer: 'patch',
			type: 'hook',
			category: 'follow',
			owner: 'shell-core',
			reason: 'unit',
			link: 'none'
		}),
		'utf8'
	);
}

describe('ArtifactStore', () => {
	it('reads the artifact from disk until a plan overlays it', () => {
		const { store, root } = makeStore();

		expect(store.read(ARTIFACT)).toEqual(Buffer.from('on-disk bytes\n', 'utf8'));
		expect(store.read('delta/patches/absent.ckpatch')).toBeNull();

		store.write(ARTIFACT, new Uint8Array([1, 2, 3]));
		expect(store.read(ARTIFACT)).toEqual(new Uint8Array([1, 2, 3]));
		// The disk still holds the pre-save bytes: pass 1 writes nothing.
		expect(readFileSync(join(root, ...ARTIFACT.split('/')), 'utf8')).toBe('on-disk bytes\n');
	});

	it('removes record as a null overlay, not as a disk deletion', () => {
		const { store, root } = makeStore();

		store.remove(ARTIFACT);
		expect(store.read(ARTIFACT)).toBeNull();
		expect(readFileSync(join(root, ...ARTIFACT.split('/')), 'utf8')).toBe('on-disk bytes\n');

		// A later state may bring the artifact back.
		store.write(ARTIFACT, Buffer.from('re-added\n', 'utf8'));
		expect(store.read(ARTIFACT)).toEqual(Buffer.from('re-added\n', 'utf8'));
	});

	it('hides a consumed pending draft from the states that follow', () => {
		const { store, root } = makeStore();

		expect(store.readPendingHeader(TARGET)?.id).toBe('CK-test-001');
		// The consumption is recorded the way pass 1 records it: as part of a plan.
		store.apply({ target: TARGET, artifact: ARTIFACT, artifactAbsolute: '', action: 'unchanged', bytes: null, consumesPending: true });
		expect(store.readPendingHeader(TARGET)).toBeNull();
		expect(store.readRebasePending(TARGET)).toBeNull();
		// The draft is still on disk; pass 2 removes it exactly once.
		expect(readFileSync(pendingPath(root, TARGET), 'utf8')).toContain('CK-test-001');
	});

	it('apply records created, updated, removed and pending consumption', () => {
		const { store } = makeStore();

		store.apply({
			target: TARGET,
			artifact: ARTIFACT,
			artifactAbsolute: '',
			action: 'created',
			bytes: Buffer.from('new\n'),
			consumesPending: true
		});
		expect(store.read(ARTIFACT)).toEqual(Buffer.from('new\n', 'utf8'));
		expect(store.readPendingHeader(TARGET)).toBeNull();

		store.apply({
			target: TARGET,
			artifact: ARTIFACT,
			artifactAbsolute: '',
			action: 'updated',
			bytes: Buffer.from('newer\n'),
			consumesPending: false
		});
		expect(store.read(ARTIFACT)).toEqual(Buffer.from('newer\n', 'utf8'));

		store.apply({ target: TARGET, artifact: ARTIFACT, artifactAbsolute: '', action: 'removed', bytes: null, consumesPending: false });
		expect(store.read(ARTIFACT)).toBeNull();

		// An unchanged plan records nothing: the store already holds that state.
		const before = store.read(ARTIFACT);
		store.apply({ target: TARGET, artifact: ARTIFACT, artifactAbsolute: '', action: 'unchanged', bytes: null, consumesPending: false });
		expect(store.read(ARTIFACT)).toBe(before);
	});
});
