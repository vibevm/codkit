// The compare-before-replace rule of the config-pin capability, on BOTH of its
// branches (PROP-002 ##CONFIG-PIN-CAPABILITY).
//
// An independent audit found the injectable-filesystem branch reading the
// configuration once and renaming over it: an external edit that landed between
// the compare and the replace was silently clobbered, so the mutation seam had
// weaker semantics than the production branch it stands in for. Both branches
// now re-read after the barrier and refuse, and the newer bytes survive.
//
// The barrier is the `beforeReplace` seam - the exact window the rule names -
// and the edit is written by an outside hand (plain fs), never through the
// capability under test.

import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeConfigFileSystem, writeConfigPin } from '../../src/lib/configPin.ts';
import { CONFIG_FILE_NAME } from '../../src/lib/configFile.ts';
import type { PinConfig } from '../../src/lib/configFile.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterEach(cleanupTempRoots);

/** The valid sample of PROP-003 sec. 2, as a configured patch-set root. */
const SAMPLE = {
	codkitConfig: 1,
	pin: { tag: '1.135.0', sha: '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5', date: '2026-08-25' },
	upstreamAnchorCommit: '0000000000000000000000000000000000000000',
	ownDirName: 'patchset',
	generatedBranchPrefix: 'codkit/applied/',
	cycleBranchPrefix: 'codkit/cycle/',
	releaseRefPrefix: 'codkit/release/',
	publishRemoteUrl: null
};

const NEXT_PIN: PinConfig = { tag: '1.136.0', sha: 'f'.repeat(40), date: '2026-09-01' };

function configuredRoot(label: string): string {
	const root = makeTempRoot(label);
	writeFileSync(join(root, CONFIG_FILE_NAME), `${JSON.stringify(SAMPLE, null, 2)}\n`, 'utf8');
	return root;
}

/** The edit a human or a tool makes while the pin update is between its steps. */
function plantNewerEdit(root: string): Uint8Array {
	const newer = `${JSON.stringify({ ...SAMPLE, ownDirName: 'newer-external-edit' }, null, 2)}\n`;
	writeFileSync(join(root, CONFIG_FILE_NAME), newer, 'utf8');
	return new Uint8Array(Buffer.from(newer));
}

describe('a newer external edit survives a pin update on both branches', () => {
	it.each([
		['the contained branch', {}],
		['the injectable-filesystem branch', { fileSystem: nodeConfigFileSystem }]
	] as const)('preserves it on %s: the update refuses instead of replacing it', (_label, extra) => {
		const root = configuredRoot('pin-external-edit');
		let newer: Uint8Array = new Uint8Array();

		const lock = acquireLock(root, 'cycle-global', 'config pin compare barrier');
		try {
			expect(() =>
				writeConfigPin(root, NEXT_PIN, {
					...extra,
					lock,
					beforeReplace: () => {
						newer = plantNewerEdit(root);
					}
				})
			).toThrow(/changed after compare and before replace/);
		} finally {
			lock.release();
		}

		// The newer document is what is on disk, byte for byte: the refused
		// update replaced nothing, not even partially.
		expect(readFileSync(join(root, CONFIG_FILE_NAME))).toEqual(Buffer.from(newer));
	});

	it('still performs the update when nothing interferes, so the refusals above name the edit and not a broken writer', () => {
		for (const [index, extra] of [{}, { fileSystem: nodeConfigFileSystem }].entries()) {
			const root = configuredRoot(`pin-clean-update-${index}`);
			const lock = acquireLock(root, 'cycle-global', 'config pin clean update');
			let updated: boolean;
			try {
				updated = writeConfigPin(root, NEXT_PIN, { ...extra, lock });
			} finally {
				lock.release();
			}
			expect(updated).toBe(true);
			expect(JSON.parse(readFileSync(join(root, CONFIG_FILE_NAME), 'utf8'))).toMatchObject({ pin: NEXT_PIN });
		}
	});
});

describe('the injectable pin writer refuses what it cannot prove, by name', () => {
	it('refuses a temporary suffix that is not one portable basename', () => {
		// The suffix lands inside a filename this module creates beside the
		// configuration; a separator or traversal in it is an argument-shape
		// error, and it was deletable with the suite green because no caller
		// passes a suffix but tests can.
		const root = configuredRoot('pin-bad-suffix');
		const lock = acquireLock(root, 'cycle-global', 'config pin suffix barrier');
		try {
			expect(() => writeConfigPin(root, NEXT_PIN, { fileSystem: nodeConfigFileSystem, lock, temporarySuffix: () => '../escape' })).toThrow(
				/config temporary suffix must be one portable non-empty basename/
			);
		} finally {
			lock.release();
		}
		expect(readFileSync(join(root, CONFIG_FILE_NAME), 'utf8')).toBe(`${JSON.stringify(SAMPLE, null, 2)}\n`);
	});

	it('refuses a symlinked configuration path as unsafe, before anything is written', () => {
		// The containment refusal of the resolved configuration path: a
		// symlink at `codkit.json` must not be written through on the
		// injectable branch either, and the refusal keeps its own words rather
		// than arriving as a permissions problem.
		const root = makeTempRoot('pin-symlinked-config');
		const outside = makeTempRoot('pin-symlinked-config-outside');
		const sentinel = join(outside, CONFIG_FILE_NAME);
		writeFileSync(sentinel, `${JSON.stringify(SAMPLE, null, 2)}\n`, 'utf8');
		writeFileSync(join(root, 'unrelated.json'), 'root file\n', 'utf8');
		symlinkSync(sentinel, join(root, CONFIG_FILE_NAME));
		const lock = acquireLock(root, 'cycle-global', 'config pin symlink barrier');
		try {
			expect(() => writeConfigPin(root, NEXT_PIN, { fileSystem: nodeConfigFileSystem, lock })).toThrow(
				/unsafe codkit\.json path: contains a symlink component/
			);
		} finally {
			lock.release();
		}
		expect(readFileSync(sentinel, 'utf8')).toBe(`${JSON.stringify(SAMPLE, null, 2)}\n`);
	});
});
