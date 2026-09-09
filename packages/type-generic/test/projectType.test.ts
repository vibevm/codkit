// The shape of the `generic` type, configured and unconfigured (PROP-016
// ##TYPE-GENERIC, ##TYPE-CONFIGURED).

import { CAPABILITIES, projectTypeProblems } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import { CONFIGURABLE_CAPABILITIES, TYPE_ID, projectType, projectTypeFor } from '../src/index.ts';

/** One declared watch channel: a script plus where a pass begins and ends. */
const watchChannel = { script: 'watch', passStart: ['^Starting$'], passEnd: ['^Done$'], errorCountLine: ['^(\\d+) errors$'] };

describe('the unconfigured type', () => {
	it('answers its own contract and declares nothing before a patch set is read', () => {
		expect(projectType.id).toBe(TYPE_ID);
		expect(projectTypeProblems(projectType)).toEqual([]);
		expect([...projectType.capabilities]).toEqual([]);
		expect([...(projectType.configurableCapabilities ?? [])].sort()).toEqual([...CONFIGURABLE_CAPABILITIES].sort());
	});

	it('has no product model at all: no extensions, no service seam, no entry list, no images, no runtime', () => {
		expect(projectType.layers.ownExtensions).toBeNull();
		expect(projectType.layers.serviceOverride).toBeNull();
		expect(projectType.layers.entryModule).toBeNull();
		expect(projectType.brandImages).toBeUndefined();
		expect(projectType.runtime).toBeUndefined();
		expect(projectType.generators.brandGraft).toBeUndefined();
		expect(projectType.advisory.readers).toEqual([]);
		expect(projectType.standards.packages).toEqual([]);
	});

	it('names only capabilities that exist in the contract', () => {
		for (const capability of projectType.configurableCapabilities ?? []) {
			expect(CAPABILITIES).toContain(capability);
		}
	});
});

describe('what typeConfig turns the type into', () => {
	it('declares config-overlay exactly when the patch set declared a target, with no dev channel', () => {
		const without = projectTypeFor({ ownRoot: 'own' });
		expect(without.capabilities.has('config-overlay')).toBe(false);
		expect(without.layers.overlayTargets).toEqual([]);

		const with_ = projectTypeFor({ ownRoot: 'own', overlayTargets: ['app.json', 'config/tool.json'] });
		expect(with_.capabilities.has('config-overlay')).toBe(true);
		expect(with_.capabilities.has('dev-channel')).toBe(false);
		expect(with_.layers.overlayTargets.map((target) => target.path)).toEqual(['app.json', 'config/tool.json']);
		expect(with_.layers.overlayTargets.every((target) => target.devChannel === null)).toBe(true);
		expect(projectTypeProblems(with_)).toEqual([]);
	});

	it('declares build-channels exactly when the patch set declared compile scripts', () => {
		expect(projectTypeFor({ ownRoot: 'own' }).capabilities.has('build-channels')).toBe(false);
		const configured = projectTypeFor({ ownRoot: 'own', commands: { compile: [watchChannel] } });
		expect(configured.capabilities.has('build-channels')).toBe(true);
		expect(projectTypeProblems(configured)).toEqual([]);
	});

	it('never declares a capability it did not announce as configurable', () => {
		const configured = projectTypeFor({
			ownRoot: 'own',
			overlayTargets: ['app.json'],
			commands: { compile: [watchChannel] }
		});
		for (const capability of configured.capabilities) {
			expect(CONFIGURABLE_CAPABILITIES).toContain(capability);
		}
	});

	it('builds the same answers through configure as through the section itself', () => {
		const section = { ownRoot: 'packages/own', overlayTargets: ['app.json'] };
		const configured = projectType.configure?.(section);
		expect(configured?.id).toBe(TYPE_ID);
		expect(configured?.layers.overlayTargets.map((target) => target.path)).toEqual(['app.json']);
		expect(projectTypeProblems(configured ?? projectType)).toEqual([]);
	});

	it('carries the declared manifest as the fingerprint of a healthy tree', () => {
		const configured = projectTypeFor({ ownRoot: 'own', identity: { manifest: { path: 'app.json', nameField: 'name' } } });
		expect(configured.identity.fingerprints.map((print) => print.path)).toEqual(['app.json']);
		expect(configured.identity.fingerprints[0]?.kind).toBe('file');
		expect(configured.identity.fingerprints[0]?.why).toContain('name');
		expect(projectTypeFor({ ownRoot: 'own' }).identity.fingerprints).toEqual([]);
	});

	it('takes the cleanup whitelist from the patch set and forbids no patch target of its own', () => {
		const configured = projectTypeFor({ ownRoot: 'own', cleanupWhitelist: ['build/', 'node_modules/'] });
		expect(configured.layout.cleanupWhitelist).toEqual(['build/', 'node_modules/']);
		expect(configured.layout.forbiddenPatchTargets).toEqual([]);
		expect(configured.layout.ownExtensionPath('sample')).toBeNull();
	});
});

describe('the own root of a plain upstream', () => {
	it('accepts any directory of the tree', () => {
		for (const ownRoot of ['own', 'src/own', 'packages/app/src/own']) {
			expect(projectType.layout.ownRootProblem(ownRoot)).toBeNull();
		}
	});

	it('refuses what is not a repository-relative POSIX directory', () => {
		expect(projectType.layout.ownRootProblem('')).toContain('path from the tree root');
		expect(projectType.layout.ownRootProblem('/abs')).toContain('leading or trailing slash');
		expect(projectType.layout.ownRootProblem('own/')).toContain('leading or trailing slash');
		expect(projectType.layout.ownRootProblem('own\\code')).toContain('forward slashes');
		expect(projectType.layout.ownRootProblem('../escape')).toContain('dot-dot');
	});

	it('accepts an ordinary git tag as a pin tag', () => {
		for (const tag of ['v1.0.0', '1.0.0', 'release-2026-01-01', 'v1.0.0-rc.1']) {
			expect(projectType.identity.tagPattern.test(tag)).toBe(true);
		}
		expect(projectType.identity.tagPattern.test('')).toBe(false);
		expect(projectType.identity.tagPattern.test('-leading')).toBe(false);
	});
});
