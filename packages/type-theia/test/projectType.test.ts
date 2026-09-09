// The `theia` type answers its own contract, and answers it the way the facts of
// upstream master 1.75.0 say (spec://codkit/modules/theia/PROP-001#root).
//
// Nothing here runs Theia: every assertion is about what the type says, and each
// one cites the fact of `modules/theia` it comes from.

import { projectTypeProblems } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import { configSchema, PLACEHOLDER_CONFIG, projectType, projectTypeFor, TYPE_ID } from '../src/index.ts';
import type { TheiaTypeConfig } from '../src/index.ts';

const CONFIG: TheiaTypeConfig = {
	ownRoot: 'packages/acme',
	ownPackageName: '@acme/theia-product',
	applicationRoot: 'examples/electron'
};

describe('the shape of the type', () => {
	it('answers the contract, unconfigured and configured alike', () => {
		expect(projectTypeProblems(projectType)).toEqual([]);
		expect(projectTypeProblems(projectTypeFor(CONFIG))).toEqual([]);
		expect(projectType.id).toBe(TYPE_ID);
	});

	it('declares the four capabilities every patch set of this family has', () => {
		expect([...projectType.capabilities].sort()).toEqual(['build-channels', 'config-overlay', 'service-override', 'upgrade-advisory']);
		// ##THEIA-CAPABILITIES: the absences are answers too.
		expect(projectType.capabilities.has('dev-channel')).toBe(false);
		expect(projectType.capabilities.has('entry-module')).toBe(false);
		expect(projectType.capabilities.has('own-extensions')).toBe(false);
		expect(projectType.capabilities.has('brand-images')).toBe(false);
		expect(projectType.capabilities.has('gen-brand')).toBe(false);
		expect(projectType.capabilities.has('runtime-library')).toBe(false);
		expect(projectType.brandImages).toBeUndefined();
		expect(projectType.runtime).toBeUndefined();
		expect(projectType.generators.brandGraft).toBeUndefined();
	});

	it('configures itself from typeConfig and keeps its identifier', () => {
		const configured = projectType.configure?.(CONFIG);
		expect(configured?.id).toBe(TYPE_ID);
		expect(configured?.layers.overlayTargets.map((target) => target.path)).toEqual(['examples/electron/package.json', 'package.json']);
	});

	it('survives a section it never validated by falling back to the placeholder', () => {
		const configured = projectType.configure?.({ nonsense: true });
		expect(configured?.layers.overlayTargets[0]?.path).toBe(`${PLACEHOLDER_CONFIG.applicationRoot}/package.json`);
	});
});

describe('the schema of typeConfig', () => {
	it('takes the three answers upstream cannot give', () => {
		expect(configSchema.safeParse(CONFIG).success).toBe(true);
	});

	it('refuses an own root outside the workspace globs of the monorepo', () => {
		// ##THEIA-OWN-ROOT: a package outside them misses the lerna fan-out.
		const refused = configSchema.safeParse({ ...CONFIG, ownRoot: 'src/acme' });
		expect(refused.success).toBe(false);
		expect(JSON.stringify(refused.error?.issues)).toContain('workspace glob');
		expect(configSchema.safeParse({ ...CONFIG, ownRoot: 'packages/a/b' }).success).toBe(false);
		expect(configSchema.safeParse({ ...CONFIG, ownRoot: 'dev-packages/acme' }).success).toBe(true);
		expect(configSchema.safeParse({ ...CONFIG, ownRoot: 'sample-plugins/acme/one' }).success).toBe(false);
	});

	it('refuses a package name that lerna could not select by', () => {
		expect(configSchema.safeParse({ ...CONFIG, ownPackageName: 'Acme Product' }).success).toBe(false);
	});

	it('refuses an unknown field rather than ignoring it', () => {
		expect(configSchema.safeParse({ ...CONFIG, ownDirName: 'acme' }).success).toBe(false);
	});
});
