// The licensing answer of the type: the family's part of a licence as a
// function of the configuration (modules/vscode-extension/PROP-006
// ##VSX-LICENSING-AREA, ##VSX-LICENCE-FIELD, ##VSX-COMPONENT-LICENCES,
// ##VSX-DISTRIBUTABLE-EXCLUSION, ##VSX-LICENCE-GUARD; PROP-016
// ##TYPE-AREA-LICENSING), over the two configurations of the suites.

import { projectTypeProblems } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import {
	COMPONENT_LICENCE_DIRECTORY,
	configSchema,
	DEFAULT_UPSTREAM_COMPONENT,
	DEFAULT_UPSTREAM_LICENCE_FILE,
	IGNORE_FILE,
	LICENCE_GUARD_PATH,
	LICENSING_SUBSYSTEM,
	makeLicensing,
	projectType,
	projectTypeFor,
	SUBSYSTEMS
} from '../src/index.ts';
import type { VsxTypeConfig } from '../src/index.ts';
import { FULL, MINIMAL } from './support/config.ts';

/** The full configuration with the upstream's licence file and component named. */
const NAMED: VsxTypeConfig = { ...FULL, licensing: { upstreamLicenceFile: 'LICENSE.txt', upstreamComponent: 'acme-upstream' } };

describe('the licensing answer', () => {
	it('declares the capability and answers the area for every configuration, and the contract accepts the shape', () => {
		for (const config of [MINIMAL, FULL, NAMED]) {
			const type = projectTypeFor(config);
			expect(type.capabilities.has('licensing')).toBe(true);
			const { guard, ...answer } = makeLicensing(config);
			expect(type.licensing).toMatchObject(answer);
			expect(type.licensing?.guard(config.ownRoot)).toEqual(guard(config.ownRoot));
			expect(projectTypeProblems(type)).toEqual([]);
		}
		expect(projectType.capabilities.has('licensing')).toBe(true);
	});

	it('heads own files with the four-line form and numbers the interventions in the config subsystem', () => {
		const area = makeLicensing(FULL);
		expect(area.headerStyle).toBe('line');
		expect(area.subsystem).toBe(LICENSING_SUBSYSTEM);
		expect(SUBSYSTEMS).toContain(area.subsystem);
		expect(area.renderings).toEqual([]);
	});

	it('puts the licence file and the component licences in the extension root, where the archive is packed from', () => {
		const full = makeLicensing(FULL);
		expect(full.licenceFileDirectory).toBe('packages/acme-sample');
		expect(full.componentLicenceDirectory).toBe(`packages/acme-sample/${COMPONENT_LICENCE_DIRECTORY}`);

		const minimal = makeLicensing(MINIMAL);
		expect(minimal.licenceFileDirectory).toBe('');
		expect(minimal.componentLicenceDirectory).toBe(COMPONENT_LICENCE_DIRECTORY);
	});

	it('names one field: the license key of the extension manifest, which is an overlay target', () => {
		const area = makeLicensing(FULL);
		expect(area.fields).toEqual([{ target: 'packages/acme-sample/package.json', path: ['license'], role: 'expression' }]);
		const targets = projectTypeFor(FULL).layers.overlayTargets.map((target) => target.path);
		expect(targets).toContain(area.fields[0]?.target);
		expect(makeLicensing(MINIMAL).fields).toEqual([{ target: 'package.json', path: ['license'], role: 'expression' }]);
	});

	it("ships the upstream's licence file as a component named by the configuration, with the family's defaults", () => {
		expect(makeLicensing(FULL).upstreamLicenceFiles).toEqual([
			{ path: `packages/acme-sample/${DEFAULT_UPSTREAM_LICENCE_FILE}`, component: DEFAULT_UPSTREAM_COMPONENT }
		]);
		expect(makeLicensing(MINIMAL).upstreamLicenceFiles).toEqual([{ path: 'LICENSE', component: 'upstream' }]);
		expect(makeLicensing(NAMED).upstreamLicenceFiles).toEqual([{ path: 'packages/acme-sample/LICENSE.txt', component: 'acme-upstream' }]);
	});

	it("leaves the upstream's licence file out of the archive through one line of the ignore file", () => {
		expect(makeLicensing(FULL).distributableExclusions).toEqual([{ ignoreFile: `packages/acme-sample/${IGNORE_FILE}`, entry: 'LICENSE' }]);
		expect(makeLicensing(MINIMAL).distributableExclusions).toEqual([{ ignoreFile: '.vscodeignore', entry: 'LICENSE' }]);
		expect(makeLicensing(NAMED).distributableExclusions).toEqual([
			{ ignoreFile: 'packages/acme-sample/.vscodeignore', entry: 'LICENSE.txt' }
		]);
	});

	it('writes the guard beside the brand guard in the words of the declared runner, starting in the extension root', () => {
		expect(makeLicensing(FULL).guard('packages/acme-sample/src/own')).toEqual({
			path: LICENCE_GUARD_PATH,
			suite: 'describe',
			test: 'test',
			runnerDirectory: 'packages/acme-sample'
		});
		expect(makeLicensing(MINIMAL).guard('src/acme')).toEqual({
			path: LICENCE_GUARD_PATH,
			suite: 'describe',
			test: 'test',
			runnerDirectory: ''
		});
		const mocha: VsxTypeConfig = { ...MINIMAL, scripts: { test: { command: 'mocha --recursive' } } };
		expect(makeLicensing(mocha).guard('src/acme')).toMatchObject({ suite: 'describe', test: 'it' });
		const host: VsxTypeConfig = { ...MINIMAL, scripts: { test: { command: 'vscode-test' } } };
		expect(makeLicensing(host).guard('src/acme')).toMatchObject({ suite: 'suite', test: 'test' });
		expect(LICENCE_GUARD_PATH).toBe('delta/own/test/licence.leftovers.test.ts');
	});

	it('takes the licensing keys of the configuration and refuses a separator, a dot segment and the tool as the component', () => {
		expect(configSchema.safeParse(NAMED).success).toBe(true);
		expect(configSchema.safeParse({ ...MINIMAL, licensing: {} }).success).toBe(true);
		for (const licensing of [
			{ upstreamLicenceFile: 'legal/LICENSE' },
			{ upstreamLicenceFile: '..' },
			{ upstreamComponent: 'Upstream' },
			{ upstreamComponent: 'codkit' },
			{ other: true }
		]) {
			expect(configSchema.safeParse({ ...MINIMAL, licensing }).success, JSON.stringify(licensing)).toBe(false);
		}
	});
});
