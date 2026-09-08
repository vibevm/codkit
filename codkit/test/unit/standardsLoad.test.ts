// PROP-014 ##STD-LOAD-ALL-PACKAGES and ##STD-LOAD-UPGRADE at the library level:
// what one run does to a patch set when the tool ships more than one package,
// and what the explicit flag changes about a copy that disagrees.
//
// The tool root is this repository, so the packages are the real ones; the
// patch set is a temporary directory with nothing but a vibevm manifest.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCkError } from '../../src/lib/messages.ts';
import { runStandardsCheck } from '../../src/lib/standardsCheck.ts';
import { nextSteps, planStandardsLoad, refuseOnDrift, runStandardsLoad } from '../../src/lib/standardsLoad.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SKILL = 'vibevm/vibepacks/org.vibevm.codkit/agent-skills/v1.0.0/vibevm/vibespecs/skills/ck-orient/SKILL.md';

function makePatchSet(label: string): string {
	const root = makeTempRoot(`load-${label}`);
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'vibe.toml'), '[project]\nname = "fixture"\nversion = "0.0.1"\n', 'utf8');
	return root;
}

function options(patchesDir: string, upgrade = false) {
	return { toolRoot, patchesDir, sourceOverride: null, dryRun: false, upgrade };
}

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not-a-ck-error';
	}
}

describe('one run over the whole shipped set', () => {
	it('delivers every package and says what comes next', () => {
		const patchesDir = makePatchSet('all');

		const outcome = runStandardsLoad(options(patchesDir));

		expect(outcome.packages.map((entry) => entry.name)).toEqual(['standards', 'agent-skills']);
		expect(outcome.packages.every((entry) => entry.state === 'created')).toBe(true);
		expect(outcome.filesCreated).toBe(outcome.plan.packages.reduce((total, entry) => total + entry.fileCount, 0));
		// ##STD-LOAD-ALL-PACKAGES: the projection step, because a package declares skills.
		expect(nextSteps(outcome.plan, false)).toEqual(['vibe install --offline', 'vibe skill install']);
		expect(nextSteps(outcome.plan, true)).toEqual(['vibe install --offline --force', 'vibe skill install']);
		expect(runStandardsCheck(options(patchesDir)).findings).toEqual([]);
	});
});

describe('an installed copy that disagrees', () => {
	it('refuses without the flag and replaces the directory with it', () => {
		const patchesDir = makePatchSet('upgrade');
		runStandardsLoad(options(patchesDir));
		const installed = join(patchesDir, ...SKILL.split('/'));
		writeFileSync(installed, `${readFileSync(installed, 'utf8')}mine\n`, 'utf8');

		const plan = planStandardsLoad(options(patchesDir));
		expect(plan.packages.find((entry) => entry.package.name === 'agent-skills')?.replace).toEqual([
			'vibevm/vibespecs/skills/ck-orient/SKILL.md'
		]);
		expect(codeOf(() => refuseOnDrift(plan, false))).toBe('STANDARDS-DRIFT');
		// ##STD-LOAD-UPGRADE: the flag is the word that turns drift into a replacement.
		expect(codeOf(() => refuseOnDrift(plan, true))).toBeNull();

		const upgraded = runStandardsLoad(options(patchesDir, true));
		expect(upgraded.packages.find((entry) => entry.name === 'agent-skills')?.state).toBe('upgraded');
		expect(readFileSync(installed, 'utf8').endsWith('mine\n')).toBe(false);
		expect(runStandardsCheck(options(patchesDir)).findings).toEqual([]);
	});

	it('keeps refusing an edited notice copy even with the flag', () => {
		const patchesDir = makePatchSet('notice');
		runStandardsLoad(options(patchesDir));
		writeFileSync(join(patchesDir, 'LICENSE-CODKIT.md'), 'mine\n', 'utf8');

		// The notice belongs to two delivering commands; neither replaces an edit.
		expect(codeOf(() => runStandardsLoad(options(patchesDir, true)))).toBe('STANDARDS-DRIFT');
	});
});
