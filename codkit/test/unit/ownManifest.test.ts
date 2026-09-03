// unit: the own manifest delta/own/patchset.delta.json and its coverage rule
// (PROP-005 sec. 3, ##OWN-MANIFEST).
//
// Own code has no upstream file to inherit an owner from, so the manifest is the
// only place that says who owns a file and why it exists. The coverage rule -
// exactly one unit per file - is what keeps that statement complete; the two
// lists this module returns are what `verify` turns into CK-E-OWN-UNCOVERED.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkServiceOverrideModules, checkUnitCoverage, loadOwnManifest, parseOwnManifest } from '../../src/lib/layers/ownManifest.ts';
import type { OwnManifest } from '../../src/lib/layers/ownManifest.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { OWN_UNIT_ID, makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const PIN = '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5';

const UNIT = {
	id: 'CK-workbench-002',
	layer: 'own',
	type: 'extend',
	category: 'own',
	owner: 'workbench-core',
	reason: 'patchset workbench contribution root',
	link: 'none',
	cause: 'none',
	pin: PIN,
	contractTests: [],
	roots: ['patchset.contribution.ts', 'modes/']
};

const SERVICE_OVERRIDE = {
	id: 'CK-workbench-003',
	serviceId: 'IUserActivityService',
	module: 'services/userActivity.override.ts',
	owner: 'workbench-core',
	reason: 'patchset keeps the window awake while a long task runs',
	link: 'none',
	cause: 'none',
	pin: PIN,
	contractTests: ['patchset.contract.user-activity']
};

const VALID = { codkitOwnManifest: 2, units: [UNIT], serviceOverrides: [SERVICE_OVERRIDE] };

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

/** A manifest value from unit declarations, without touching the disk. */
function manifest(units: readonly unknown[], serviceOverrides: readonly unknown[] = []): OwnManifest {
	const parsed = parseOwnManifest({ codkitOwnManifest: 2, units, serviceOverrides });
	return { units: parsed.units, serviceOverrides: parsed.serviceOverrides, present: true };
}

let patchesDir: string;

beforeAll(() => {
	const upstream = makeUpstream(makeTempRoot('ownmanifest-upstream'));
	patchesDir = makeTempRoot('ownmanifest-patchset');
	makePatchSet(patchesDir, upstream);
});

afterAll(() => {
	cleanupTempRoots();
});

describe('own manifest schema', () => {
	it('accepts the sample of the spec', () => {
		const parsed = parseOwnManifest(VALID);

		expect(parsed.units.length).toBe(1);
		expect(parsed.units[0]?.roots).toEqual(['patchset.contribution.ts', 'modes/']);
		expect(parsed.serviceOverrides[0]?.serviceId).toBe('IUserActivityService');
	});

	it('takes an absent serviceOverrides list as an empty one', () => {
		expect(parseOwnManifest({ codkitOwnManifest: 2, units: [UNIT] }).serviceOverrides).toEqual([]);
	});

	it('refuses a unit of another layer: this manifest declares own code', () => {
		const failure = failureOf(() => parseOwnManifest({ ...VALID, units: [{ ...UNIT, layer: 'patch' }] }));

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain('layer must be the literal "own"');
		expect(failure.file).toBe('delta/own/patchset.delta.json');
	});

	it('refuses a unit that claims no root', () => {
		expect(failureOf(() => parseOwnManifest({ ...VALID, units: [{ ...UNIT, roots: [] }] })).message).toContain('roots');
	});

	it('refuses a service override without the decorator it replaces', () => {
		const broken: Record<string, unknown> = { ...SERVICE_OVERRIDE };
		delete broken['serviceId'];
		expect(failureOf(() => parseOwnManifest({ ...VALID, serviceOverrides: [broken] })).message).toContain('serviceId');
	});

	it('refuses a document of another schema version', () => {
		expect(failureOf(() => parseOwnManifest({ ...VALID, codkitOwnManifest: 3 })).message).toContain('codkitOwnManifest must be exactly 2');
	});
});

describe('loadOwnManifest', () => {
	it('reads the manifest of the patchset fixture', () => {
		const loaded = loadOwnManifest(patchesDir);

		expect(loaded.present).toBe(true);
		expect(loaded.units.map((unit) => unit.id)).toEqual([OWN_UNIT_ID]);
		expect(loaded.units[0]?.layer).toBe('own');
	});

	it('is empty, not an error, when there is no manifest file', () => {
		const loaded = loadOwnManifest(makeTempRoot('ownmanifest-none'));

		expect(loaded.present).toBe(false);
		expect(loaded.units).toEqual([]);
		expect(loaded.serviceOverrides).toEqual([]);
	});
});

describe('checkUnitCoverage', () => {
	it('covers a file by an exact root and a directory by a trailing slash', () => {
		const coverage = checkUnitCoverage(manifest([UNIT]), ['patchset.contribution.ts', 'modes/zen/zenMode.ts', 'modes/focus.ts']);

		expect(coverage.uncovered).toEqual([]);
		expect(coverage.overlapping).toEqual([]);
	});

	it('never expects the manifest itself or a .gitkeep to be claimed', () => {
		const coverage = checkUnitCoverage(manifest([UNIT]), ['patchset.delta.json', '.gitkeep', 'modes/.gitkeep']);

		expect(coverage.uncovered).toEqual([]);
	});

	it('reports a file no unit claims', () => {
		const coverage = checkUnitCoverage(manifest([UNIT]), ['patchset.contribution.ts', 'services/orphan.ts']);

		expect(coverage.uncovered).toEqual(['services/orphan.ts']);
		expect(coverage.overlapping).toEqual([]);
	});

	it('does not read a root without a trailing slash as a directory', () => {
		// `modes` names one file; the directory form is `modes/`.
		const narrowed = manifest([{ ...UNIT, roots: ['modes'] }]);

		expect(checkUnitCoverage(narrowed, ['modes/focus.ts']).uncovered).toEqual(['modes/focus.ts']);
	});

	it('reports a file two units claim, and names both of them', () => {
		const second = { ...UNIT, id: 'CK-workbench-004', roots: ['modes/zen/'] };
		const coverage = checkUnitCoverage(manifest([UNIT, second]), ['modes/zen/zenMode.ts', 'modes/focus.ts']);

		expect(coverage.uncovered).toEqual([]);
		expect(coverage.overlapping).toEqual([['modes/zen/zenMode.ts', ['CK-workbench-002', 'CK-workbench-004']]]);
	});

	it('reports every own file as uncovered when there is no manifest at all', () => {
		const empty: OwnManifest = { units: [], serviceOverrides: [], present: false };

		expect(checkUnitCoverage(empty, ['hello.ts']).uncovered).toEqual(['hello.ts']);
	});

	it('agrees with the patchset fixture: its one own file is claimed by its one unit', () => {
		expect(checkUnitCoverage(loadOwnManifest(patchesDir), ['hello.ts', 'patchset.delta.json'])).toEqual({ uncovered: [], overlapping: [] });
	});
});

describe('checkServiceOverrideModules', () => {
	it('requires the named module to be delivered and claimed by exactly one unit', () => {
		const second = { ...UNIT, id: 'CK-workbench-004', roots: ['services/userActivity.override.ts'] };
		const checked = checkServiceOverrideModules(manifest([UNIT, second], [SERVICE_OVERRIDE]), ['services/userActivity.override.ts']);

		expect(checked).toEqual([
			{
				override: SERVICE_OVERRIDE,
				module: 'services/userActivity.override.ts',
				delivered: true,
				units: ['CK-workbench-004']
			}
		]);
	});

	it('distinguishes a missing module from a delivered module outside every unit', () => {
		const missing = checkServiceOverrideModules(manifest([UNIT], [SERVICE_OVERRIDE]), []);
		const uncovered = checkServiceOverrideModules(manifest([UNIT], [SERVICE_OVERRIDE]), ['services/userActivity.override.ts']);

		expect(missing[0]).toMatchObject({ delivered: false, units: [] });
		expect(uncovered[0]).toMatchObject({ delivered: true, units: [] });
	});

	it('reports every unit claiming an override module', () => {
		const broad = { ...UNIT, roots: ['services/'] };
		const exact = { ...UNIT, id: 'CK-workbench-004', roots: ['services/userActivity.override.ts'] };

		expect(
			checkServiceOverrideModules(manifest([broad, exact], [SERVICE_OVERRIDE]), ['services/userActivity.override.ts'])[0]?.units
		).toEqual(['CK-workbench-002', 'CK-workbench-004']);
	});
});
