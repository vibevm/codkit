// PROP-019 ##GEN-LICENSING: the plan of `codkit gen licensing` over the fixture
// patch set, in process. What the suite is about: the ids are the next free
// numbers of the type's licensing subsystem in a fixed order, an overlay the
// patch set already carries is merged and keeps what is not the engine's, a
// rerun keeps the ids of the artifacts it wrote, the owner comes from
// `owners.json` or `--owner`, and planning writes nothing at all.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectType } from '@codkit/type-api';
import { addFileBodyOf } from '../../src/lib/addFilePatch.ts';
import { applyUnified } from '../../src/lib/applyUnified.ts';
import { decodeUtf8Strict, encodeUtf8 } from '../../src/lib/bytes.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import { unitReminder } from '../../src/lib/genFeature.ts';
import {
	ANNOTATE_REMINDER,
	VERIFY_REMINDER,
	existingTargets,
	planLicensing,
	refuseExistingLicensing,
	writeLicensingPlan
} from '../../src/lib/genLicensing.ts';
import type { LicensingPlan, LicensingPlanOptions } from '../../src/lib/genLicensing.ts';
import { renderLicenceRtf } from '../../src/lib/licenceRtf.ts';
import { readLicensingProfile } from '../../src/lib/licensingProfile.ts';
import type { LicensingProfile } from '../../src/lib/licensingProfile.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { parseCkpatch } from '../../src/lib/patchFormat.ts';
import { OVERLAY_ID } from '../fixtures/makePatchSet.ts';
import { LICENCE_GUARD_PATH, licensingArea, projectType } from '../fixtures/stubType.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { FIXTURE_LICENSE_ID, FIXTURE_LICENSE_TEXT, fixtureBlockHeaderLines, installLicensingProfile } from '../support/licensingFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const MANIFEST_OVERLAY = 'delta/overlays/manifest.json.overlay.json';
const PACKAGE_OVERLAY = 'delta/overlays/package.json.overlay.json';
const LICENCE_PATCH = 'delta/patches/LICENSE.md.ckpatch';
const COMPONENT_PATCH = 'delta/patches/licenses__LICENSE-UPSTREAM.md.ckpatch';
const RENDERING_PATCH = 'delta/patches/LICENSE.rtf.ckpatch';

let fixture: CliFixture;
let config: CodkitConfig;
let profile: LicensingProfile;

beforeAll(() => {
	fixture = makeCliFixture('gen-licensing-plan');
	const lic = installLicensingProfile('gen-licensing-plan', fixture.patchesDir);
	const loaded = loadConfig(fixture.patchesDir);
	if (loaded === null) throw new Error('the fixture patch set has no configuration');
	config = loaded;
	const selected = readLicensingProfile(fixture.patchesDir, join(lic.home, '.codkit'));
	if (selected === null) throw new Error('the fixture patch set declares no profile');
	profile = selected;
});

function options(over: Partial<LicensingPlanOptions> = {}): LicensingPlanOptions {
	return {
		patchesDir: fixture.patchesDir,
		treeDir: fixture.treeDir,
		toolRoot: packageRoot,
		config,
		type: projectType,
		profile,
		owner: 'product',
		...over
	};
}

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not-a-ck-error';
	}
}

function patchIdOf(plan: LicensingPlan, path: string): string {
	const file = plan.files.find((candidate) => candidate.path === path);
	if (file === undefined) throw new Error(`${path} is not in the plan`);
	return parseCkpatch(encodeUtf8(file.text), loadConventions(projectType, fixture.patchesDir), path).header.id;
}

function textOf(plan: LicensingPlan, path: string): string {
	const file = plan.files.find((candidate) => candidate.path === path);
	if (file === undefined) throw new Error(`${path} is not in the plan`);
	return file.text;
}

function overlayOf(
	plan: LicensingPlan,
	path: string
): { id: string; contractTests: string[]; operations: { path: string[]; value?: unknown }[] } {
	return JSON.parse(textOf(plan, path)) as { id: string; contractTests: string[]; operations: { path: string[]; value?: unknown }[] };
}

function walk(root: string, prefix = ''): readonly string[] {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		return entry.isDirectory() ? walk(join(root, entry.name), relative) : [relative];
	});
}

function snapshot(root: string): string {
	return [...walk(root)]
		.sort()
		.map(
			(relative) =>
				`${relative} ${createHash('sha256')
					.update(readFileSync(join(root, ...relative.split('/'))))
					.digest('hex')}`
		)
		.join('\n');
}

describe('planLicensing', () => {
	it('plans the overlays, the licence file, the component, the rendering and the guard, in that order, writing nothing', () => {
		const before = snapshot(join(fixture.patchesDir, 'delta'));
		const plan = planLicensing(options());

		expect(plan.owner).toBe('product');
		expect(plan.files.map((file) => [file.path, file.kind, file.exists])).toEqual([
			[MANIFEST_OVERLAY, 'overlay', true],
			[PACKAGE_OVERLAY, 'overlay', false],
			[LICENCE_PATCH, 'patch', false],
			[COMPONENT_PATCH, 'patch', false],
			[RENDERING_PATCH, 'patch', false],
			[LICENCE_GUARD_PATH, 'guard', false]
		]);
		expect(plan.overlays).toEqual([
			{ artifact: MANIFEST_OVERLAY, target: 'manifest.json', operations: 2, merged: true },
			{ artifact: PACKAGE_OVERLAY, target: 'package.json', operations: 1, merged: false }
		]);
		expect(plan.reminders).toEqual([unitReminder('delta/own/test'), ANNOTATE_REMINDER, VERIFY_REMINDER]);
		expect(snapshot(join(fixture.patchesDir, 'delta'))).toBe(before);
	});

	it('allocates the next free ids of the licensing subsystem in the order of the plan', () => {
		const plan = planLicensing(options());

		// The fixture already uses CK-product-901 and CK-product-902, so the free
		// numbers start at 001: the new overlay first, then the add-file patches.
		expect(overlayOf(plan, PACKAGE_OVERLAY).id).toBe('CK-product-001');
		expect(patchIdOf(plan, LICENCE_PATCH)).toBe('CK-product-002');
		expect(patchIdOf(plan, COMPONENT_PATCH)).toBe('CK-product-003');
		expect(patchIdOf(plan, RENDERING_PATCH)).toBe('CK-product-004');
	});

	it('merges the operations into the existing overlay of the manifest and keeps what is not its own', () => {
		const plan = planLicensing(options());
		const merged = overlayOf(plan, MANIFEST_OVERLAY);

		expect(merged.id).toBe(OVERLAY_ID);
		expect(merged.contractTests).toEqual(['fixture.guard.product', 'licence-leftovers']);
		expect(merged.operations.map((operation) => operation.path)).toEqual([
			['displayName'],
			['patchsetUpstreamPin'],
			['licenseName'],
			['licenseFileName']
		]);
		expect(merged.operations[2]).toEqual({
			op: 'set',
			path: ['licenseName'],
			value: FIXTURE_LICENSE_ID,
			expectUpstream: { $absent: true }
		});
		expect(merged.operations[3]).toEqual({ op: 'set', path: ['licenseFileName'], value: 'LICENSE.md', expectUpstream: { $absent: true } });
	});

	it('writes the canonical text, the pin bytes of the upstream licence and the RTF as add-file patches with the guard among their contract tests', () => {
		const plan = planLicensing(options());
		const conventions = loadConventions(projectType, fixture.patchesDir);
		const licence = parseCkpatch(encodeUtf8(textOf(plan, LICENCE_PATCH)), conventions, LICENCE_PATCH);
		const component = parseCkpatch(encodeUtf8(textOf(plan, COMPONENT_PATCH)), conventions, COMPONENT_PATCH);
		const rendering = parseCkpatch(encodeUtf8(textOf(plan, RENDERING_PATCH)), conventions, RENDERING_PATCH);

		expect(licence.isAddFile).toBe(true);
		expect(licence.targetPath).toBe('LICENSE.md');
		expect(addFileBodyOf(licence)).toBe(FIXTURE_LICENSE_TEXT);
		expect(licence.header).toMatchObject({ type: 'extend', category: 'follow', owner: 'product', contractTests: ['licence-leftovers'] });
		expect(licence.header.pin).toBe(`${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`);
		expect(component.targetPath).toBe('licenses/LICENSE-UPSTREAM.md');
		expect(addFileBodyOf(component)).toBe(fixture.git(['show', `${fixture.upstream.t1.sha}:LICENSE`]).stdout);
		expect(rendering.targetPath).toBe('LICENSE.rtf');
		expect(addFileBodyOf(rendering)).toBe(renderLicenceRtf(FIXTURE_LICENSE_TEXT));
	});

	it('heads the guard from the profile and renders it with the words and the values of this patch set', () => {
		const guard = textOf(planLicensing(options()), LICENCE_GUARD_PATH);
		const lines = guard.split('\n');

		expect(lines.slice(0, 5)).toEqual(fixtureBlockHeaderLines());
		expect(lines[5]).toBe('');
		expect(guard).toContain("describe('licence-leftovers', () => {");
		expect(guard).toContain(`{ directory: 'source/own', expression: '${FIXTURE_LICENSE_ID}' }`);
		expect(guard).toContain("const SKIP_DIRECTORY = 'source/own/codkit';");
		expect(guard).toContain(`const LICENCE_SHA256 = '${createHash('sha256').update(FIXTURE_LICENSE_TEXT).digest('hex')}';`);
		expect(guard).toContain("path: ['licenseUrl'], expected: null");
		expect(guard).toContain("target: 'package.json', path: ['license']");
	});

	it('refuses the artifacts of an earlier run without --update, overlays excepted, and keeps their ids with it', () => {
		const first = planLicensing(options());
		writeLicensingPlan(fixture.patchesDir, first);

		expect(existsSync(fixture.patchesPath(LICENCE_PATCH))).toBe(true);
		const again = planLicensing(options());
		expect(existingTargets(again)).toEqual([LICENCE_PATCH, COMPONENT_PATCH, RENDERING_PATCH, LICENCE_GUARD_PATH]);
		expect(codeOf(() => refuseExistingLicensing(again))).toBe('GEN-EXISTS');
		// A rerun is stable: the same ids, the package.json overlay now merged.
		expect(overlayOf(again, PACKAGE_OVERLAY).id).toBe('CK-product-001');
		expect(again.overlays[1]).toEqual({ artifact: PACKAGE_OVERLAY, target: 'package.json', operations: 1, merged: true });
		expect(patchIdOf(again, LICENCE_PATCH)).toBe('CK-product-002');
		expect(patchIdOf(again, COMPONENT_PATCH)).toBe('CK-product-003');
		expect(patchIdOf(again, RENDERING_PATCH)).toBe('CK-product-004');
		expect(again.files.map((file) => file.text)).toEqual(first.files.map((file) => file.text));
	});

	it('takes the owner from --owner, which owners.json must declare, or the only owner the file declares', () => {
		expect(codeOf(() => planLicensing(options({ owner: null })))).toBe('CONFIG');
		expect(codeOf(() => planLicensing(options({ owner: 'nobody' })))).toBe('CONFIG');

		const owners = fixture.patchesPath('delta/owners.json');
		writeFileSync(
			owners,
			`${JSON.stringify({ codkitOwners: 1, owners: { product: { contact: 'fixture', paths: ['manifest.json'] } } }, null, '\t')}\n`,
			'utf8'
		);
		expect(planLicensing(options({ owner: null })).owner).toBe('product');
	});
});

describe('planLicensing with an exclusion of the distributable (S97)', () => {
	const EXCLUSION_PATCH = 'delta/patches/.gitignore.ckpatch';
	/** The stub's answer with one exclusion - the upstream's licence file through the ignore file the pin carries - and a runner that starts under the tree root. */
	const withExclusion: ProjectType = {
		...projectType,
		licensing: {
			...licensingArea,
			distributableExclusions: [{ ignoreFile: '.gitignore', entry: 'LICENSE' }],
			guard: () => ({ ...licensingArea.guard(''), runnerDirectory: 'source' })
		}
	};
	let own: CliFixture;
	let ownConfig: CodkitConfig;
	let ownProfile: LicensingProfile;

	beforeAll(() => {
		own = makeCliFixture('gen-licensing-exclusion');
		const lic = installLicensingProfile('gen-licensing-exclusion', own.patchesDir);
		const loaded = loadConfig(own.patchesDir);
		if (loaded === null) throw new Error('the fixture patch set has no configuration');
		ownConfig = loaded;
		const selected = readLicensingProfile(own.patchesDir, join(lic.home, '.codkit'));
		if (selected === null) throw new Error('the fixture patch set declares no profile');
		ownProfile = selected;
	});

	function plan(type: ProjectType = withExclusion): LicensingPlan {
		return planLicensing({
			patchesDir: own.patchesDir,
			treeDir: own.treeDir,
			toolRoot: packageRoot,
			config: ownConfig,
			type,
			profile: ownProfile,
			owner: 'product'
		});
	}

	it('plans the patch of the ignore file after the renderings, adding the entry inside a block of its own at the end of the file', () => {
		const planned = plan();
		const paths = planned.files.map((file) => file.path);
		expect(paths.indexOf(EXCLUSION_PATCH)).toBe(paths.indexOf(RENDERING_PATCH) + 1);
		expect(paths.indexOf(LICENCE_GUARD_PATH)).toBe(paths.indexOf(EXCLUSION_PATCH) + 1);

		const conventions = loadConventions(withExclusion, own.patchesDir);
		const patch = parseCkpatch(encodeUtf8(textOf(planned, EXCLUSION_PATCH)), conventions, EXCLUSION_PATCH);
		expect(patch.isAddFile).toBe(false);
		expect(patch.targetPath).toBe('.gitignore');
		expect(patch.header.id).toBe('CK-product-005');
		expect(patch.header).toMatchObject({ type: 'extend', category: 'follow', owner: 'product', contractTests: ['licence-leftovers'] });
		expect(patch.header.reason).toContain('left out of the distributable');
		const added = patch.hunks.flatMap((hunk) => hunk.lines.filter((line) => line.kind === '+').map((line) => line.text));
		expect(added).toEqual(['# codkit:begin CK-product-005', 'LICENSE', '# codkit:end CK-product-005']);

		// It applies to the pin: the file as the upstream wrote it, then the block.
		const pin = encodeUtf8(own.git(['show', `${own.upstream.t1.sha}:.gitignore`]).stdout);
		expect(decodeUtf8Strict(applyUnified(pin, patch))).toBe(`${decodeUtf8Strict(pin) ?? ''}${added.join('\n')}\n`);

		// The guard knows both: where the runner starts, and what the archive leaves out.
		const guard = textOf(planned, LICENCE_GUARD_PATH);
		expect(guard).toContain("const RUNNER_DIRECTORY = 'source';");
		expect(guard).toContain("{ ignoreFile: '.gitignore', entry: 'LICENSE' }");
	});

	it('keeps the id of its own patch on a rerun and refuses the patch of another intervention over the same file', () => {
		writeLicensingPlan(own.patchesDir, plan());
		const again = plan();
		const file = again.files.find((candidate) => candidate.path === EXCLUSION_PATCH);
		expect(file?.exists).toBe(true);
		expect(patchIdOf(again, EXCLUSION_PATCH)).toBe('CK-product-005');
		expect(existingTargets(again)).toContain(EXCLUSION_PATCH);

		// Somebody else's patch of the ignore file: one upstream file has one patch,
		// and the engine does not take it over.
		const foreign = readFileSync(own.patchesPath(EXCLUSION_PATCH), 'utf8').replace(
			/^# reason: .*$/mu,
			'# reason: the product ignores its own scratch'
		);
		writeFileSync(own.patchesPath(EXCLUSION_PATCH), foreign, 'utf8');
		expect(codeOf(() => plan())).toBe('CONFIG');
	});

	it('refuses an ignore file the pin does not carry, or one without a marker form', () => {
		const absent: ProjectType = {
			...withExclusion,
			licensing: { ...licensingArea, distributableExclusions: [{ ignoreFile: '.dockerignore', entry: 'LICENSE' }] }
		};
		expect(codeOf(() => plan(absent))).toBe('CONFIG');
		const formless: ProjectType = {
			...withExclusion,
			licensing: { ...licensingArea, distributableExclusions: [{ ignoreFile: 'package.json', entry: 'LICENSE' }] }
		};
		expect(codeOf(() => plan(formless))).toBe('CONFIG');
	});
});
