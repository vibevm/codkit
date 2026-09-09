// The pending patch header (PROP-007 ##PENDING-HEADER-MECHANISM).
//
// A draft is what closes the gap between `marker new`, which knows the metadata
// of an intervention, and `save`, which is the only command that writes a patch.
// Two properties are load-bearing: the draft is named after the same target
// encoding the patch file uses, and its fields come out in the order the patch
// header fixes (PROP-004 sec. 4), so a draft reads like the header it becomes.

import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isCkError } from '../../src/lib/messages.ts';
import { formatPatchHeader } from '../../src/lib/patchFormat.ts';
import {
	PENDING_DIR,
	listPendingHeaders,
	pendingFileName,
	pendingPath,
	readPendingHeader,
	removePendingHeader,
	writePendingHeader
} from '../../src/lib/pendingHeader.ts';
import type { PendingHeader } from '../../src/lib/pendingHeader.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TARGET = 'source/app/browser/parts/example/examplePart.ts';

const DRAFT: PendingHeader = {
	id: 'CK-shell-001',
	layer: 'patch',
	type: 'hook',
	category: 'follow',
	owner: 'shell-core',
	reason: 'mount point for patchset center-area host initialization',
	link: 'none'
};

afterAll(() => {
	cleanupTempRoots();
});

describe('pendingPath', () => {
	it('encodes the target the way the patch file name does', () => {
		const root = makeTempRoot('pending-path');
		expect(pendingFileName(TARGET)).toBe('source__app__browser__parts__example__examplePart.ts.json');
		expect(pendingPath(root, TARGET)).toBe(join(root, ...PENDING_DIR.split('/'), pendingFileName(TARGET)));
	});
});

describe('a draft round trip', () => {
	it('writes, reads back and deletes', () => {
		const root = makeTempRoot('pending-round-trip');

		const path = writePendingHeader(root, TARGET, DRAFT);
		expect(existsSync(path)).toBe(true);
		expect(readPendingHeader(root, TARGET)).toEqual(DRAFT);

		removePendingHeader(root, TARGET);
		expect(existsSync(path)).toBe(false);
		expect(readPendingHeader(root, TARGET)).toBeNull();
		// Deleting a draft that is not there is not an error: `save` deletes the
		// draft it consumed without first asking whether one exists.
		removePendingHeader(root, TARGET);
	});

	it('is idempotent for one exact target intent and never overwrites it', () => {
		const root = makeTempRoot('pending-exclusive-intent');
		const path = writePendingHeader(root, TARGET, DRAFT);
		const before = readFileSync(path);

		expect(writePendingHeader(root, TARGET, DRAFT)).toBe(path);
		expect(() => writePendingHeader(root, TARGET, { ...DRAFT, id: 'CK-shell-002' })).toThrow(/another pending header/);
		expect(readFileSync(path)).toEqual(before);
	});

	it('writes the fields in the order of the patch header', () => {
		const root = makeTempRoot('pending-order');
		const path = writePendingHeader(root, TARGET, DRAFT);
		const text = readFileSync(path, 'utf8');

		expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
			'id',
			'layer',
			'type',
			'category',
			'owner',
			'reason',
			'link'
		]);
		expect(text.endsWith('}\n')).toBe(true);

		// And those fields, in that order, are what the header of the patch says.
		const header = formatPatchHeader({
			...DRAFT,
			cause: 'none',
			pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
			contractTests: []
		});
		expect(header.split('\n').slice(0, 7)).toEqual([
			'# codkit-patch: 2',
			`# id: ${DRAFT.id}`,
			`# type: ${DRAFT.type}`,
			`# category: ${DRAFT.category}`,
			`# owner: ${DRAFT.owner}`,
			`# reason: ${DRAFT.reason}`,
			`# link: ${DRAFT.link}`
		]);
	});

	it('round-trips entry-module explicitly and rejects generated-only layers', () => {
		const root = makeTempRoot('pending-entry-module');
		const path = writePendingHeader(root, TARGET, { ...DRAFT, layer: 'entry-module' });
		expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>)).toEqual([
			'id',
			'layer',
			'type',
			'category',
			'owner',
			'reason',
			'link'
		]);
		expect(readPendingHeader(root, TARGET)).toEqual({ ...DRAFT, layer: 'entry-module' });
		writeFileSync(path, readFileSync(path, 'utf8').replace('entry-module', 'rewrite-rule'), 'utf8');
		expect(() => readPendingHeader(root, TARGET)).toThrow(/layer/);
	});

	it('does not follow a symlinked runtime ancestor', () => {
		const root = makeTempRoot('pending-symlink');
		const outside = makeTempRoot('pending-symlink-outside');
		symlinkSync(outside, join(root, '.codkit'), 'dir');
		expect(() => writePendingHeader(root, TARGET, DRAFT)).toThrow(/unsafe pending path|symlink/);
		expect(existsSync(join(outside, 'pending'))).toBe(false);
	});
});

describe('listPendingHeaders', () => {
	it('is empty when nothing was scaffolded', () => {
		expect(listPendingHeaders(makeTempRoot('pending-empty'))).toEqual([]);
	});

	it('lists every draft in file-name order', () => {
		const root = makeTempRoot('pending-list');
		writePendingHeader(root, TARGET, DRAFT);
		writePendingHeader(root, 'source/base/common/util.ts', { ...DRAFT, id: 'CK-base-002' });

		const listed = listPendingHeaders(root);

		expect(listed.map((entry) => entry.header.id)).toEqual(['CK-shell-001', 'CK-base-002']);
		expect(listed[0]?.fileName).toBe('source__app__browser__parts__example__examplePart.ts.json');
	});

	it('refuses a draft that is not readable rather than ignoring it', () => {
		const root = makeTempRoot('pending-broken');
		const path = writePendingHeader(root, TARGET, DRAFT);
		writeFileSync(path, '{ "id": "CK-shell-001" }\n', 'utf8');

		try {
			readPendingHeader(root, TARGET);
			throw new Error('expected the read to fail');
		} catch (error) {
			expect(isCkError(error)).toBe(true);
			if (isCkError(error)) {
				expect(error.code).toBe('HEADER-MISSING');
				expect(error.hint).toContain('marker new');
			}
		}
	});
});
