// unit: the removed-registry delta/removed.json (PROP-005 sec. 10).
//
// The layer exists because deleting is forbidden: everything the product does
// without is switched off somewhere above and recorded here. The one property
// the format enforces by itself is the guard test - without it an upgrade brings
// the removed thing back and nobody notices.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadRemoved, parseRemoved } from '../../src/lib/layers/removed.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { REMOVED_ID, makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const VALID = {
	codkitRemoved: 1,
	entries: [
		{
			id: 'CK-workbench-904',
			kind: 'setting',
			target: 'fixture.telemetry.enabled',
			how: 'default flipped in own code, never registered by the workbench',
			owner: 'workbench-core',
			reason: 'nothing must re-introduce this setting',
			link: 'none',
			pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
			contractTests: ['patchset.guard.removed-setting']
		}
	]
};

function withEntry(overrides: Record<string, unknown>): unknown {
	return { codkitRemoved: 1, entries: [{ ...VALID.entries[0], ...overrides }] };
}

function failureOf(run: () => unknown): { code: string; message: string; file?: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return { code: error.code, message: error.message, ...(error.file === undefined ? {} : { file: error.file }) };
		}
		throw error;
	}
	throw new Error('expected the call to fail');
}

let patchesDir: string;

beforeAll(() => {
	const upstream = makeUpstream(makeTempRoot('removed-upstream'));
	patchesDir = makeTempRoot('removed-patchset');
	makePatchSet(patchesDir, upstream);
});

afterAll(() => {
	cleanupTempRoots();
});

describe('removed registry schema', () => {
	it('accepts an entry with all its fields', () => {
		const registry = parseRemoved(VALID);

		expect(registry.entries.length).toBe(1);
		expect(registry.entries[0]?.kind).toBe('setting');
		expect(registry.entries[0]?.how).toContain('own code');
	});

	it('requires a guard test on every entry', () => {
		const failure = failureOf(() => parseRemoved(withEntry({ contractTests: [] })));

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain('contractTests');
		expect(failure.message).toContain('guard test is mandatory');
		expect(failure.file).toBe('delta/removed.json');
	});

	it('refuses a kind outside the four the spec names', () => {
		expect(failureOf(() => parseRemoved(withEntry({ kind: 'command' }))).message).toContain('file, dependency, registration, setting');
	});

	it('refuses an entry that does not say how the removal was done', () => {
		expect(failureOf(() => parseRemoved(withEntry({ how: '' }))).message).toContain('how');
	});

	it('refuses an entry without a target', () => {
		const broken: Record<string, unknown> = { ...VALID.entries[0] };
		delete broken['target'];
		expect(failureOf(() => parseRemoved({ codkitRemoved: 1, entries: [broken] })).message).toContain('target');
	});

	it('refuses a document of another schema version', () => {
		expect(failureOf(() => parseRemoved({ ...VALID, codkitRemoved: 2 })).message).toContain('codkitRemoved must be exactly 1');
	});
});

describe('loadRemoved', () => {
	it('reads the registry of the patchset fixture', () => {
		const registry = loadRemoved(patchesDir);

		expect(registry.present).toBe(true);
		expect(registry.entries.map((entry) => entry.id)).toEqual([REMOVED_ID]);
		expect(registry.entries[0]?.target).toBe('fixture.telemetry.enabled');
	});

	it('is empty, not an error, when the repository removes nothing', () => {
		const registry = loadRemoved(makeTempRoot('removed-none'));

		expect(registry.present).toBe(false);
		expect(registry.entries).toEqual([]);
	});
});
