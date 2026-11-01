// The licensing answer of the type: the family's part of a licence as data
// (modules/vscode/PROP-010 ##VSCODE-LICENSING-AREA, ##VSCODE-LICENCE-FIELDS,
// ##VSCODE-COMPONENT-LICENCES, ##VSCODE-INSTALLER-RTF, ##VSCODE-LICENCE-GUARD;
// PROP-016 ##TYPE-AREA-LICENSING).

import { projectTypeProblems } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import {
	COMPONENT_LICENCE_DIRECTORY,
	LICENCE_FIELDS,
	LICENCE_GUARD_PATH,
	LICENCE_RENDERINGS,
	licenceGuard,
	licensing,
	overlayTargets,
	projectType,
	UPSTREAM_LICENCE_FILES
} from '../src/index.ts';

describe('the licensing answer', () => {
	it('declares the capability and answers the area, and the contract accepts the shape', () => {
		expect(projectType.capabilities.has('licensing')).toBe(true);
		expect(projectType.licensing).toBe(licensing);
		expect(projectTypeProblems(projectType)).toEqual([]);
	});

	it('names five manifest fields in two declared overlay targets, each a known key', () => {
		const targets = new Set(overlayTargets.map((target) => target.path));
		for (const field of LICENCE_FIELDS) expect(targets.has(field.target)).toBe(true);
		expect(LICENCE_FIELDS.map((field) => `${field.target}:${field.path.join('.')}:${field.role}`)).toEqual([
			'product.json:licenseName:expression',
			'product.json:licenseFileName:file-name',
			'product.json:licenseUrl:url',
			'product.json:serverLicenseUrl:url',
			'package.json:license:expression'
		]);
	});

	it('admits a guarded replacement of the license key of the tree manifest, and additions under scripts only', () => {
		const target = overlayTargets.find((candidate) => candidate.path === 'package.json');
		expect(target?.allowedKeys).toEqual(['scripts']);
		expect(target?.allowedScalarKeys).toEqual(['license']);
	});

	it('puts the licence file at the root and the component licences where the build copies them', () => {
		expect(licensing.headerStyle).toBe('block');
		expect(licensing.licenceFileDirectory).toBe('');
		expect(licensing.componentLicenceDirectory).toBe(COMPONENT_LICENCE_DIRECTORY);
		expect(COMPONENT_LICENCE_DIRECTORY).toBe('licenses');
		expect(licensing.subsystem).toBe('product');
	});

	it("ships the upstream's own terms as the component code-oss and one RTF for the installer", () => {
		expect(UPSTREAM_LICENCE_FILES).toEqual([{ path: 'LICENSE.txt', component: 'code-oss' }]);
		expect(LICENCE_RENDERINGS).toEqual([{ path: 'LICENSE.rtf', format: 'rtf' }]);
	});

	it('writes the guard under the own tests with the words of the Mocha-style runner', () => {
		expect(licenceGuard('src/vs/patchset')).toEqual({ path: LICENCE_GUARD_PATH, suite: 'suite', test: 'test' });
		expect(LICENCE_GUARD_PATH).toBe('delta/own/test/node/licence.leftovers.test.ts');
	});
});
