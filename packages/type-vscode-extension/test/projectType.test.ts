// The `vscode-extension` type answers its own contract, unconfigured and
// configured alike, and its declarative manifest agrees with what it exports
// (spec://codkit/modules/vscode-extension/PROP-001#root; PROP-016
// ##TYPE-CONFIGURED, ##TYPE-MANIFEST-HANDSHAKE).

import { readFileSync } from 'node:fs';
import { projectTypeProblems, validateTypeManifest } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, configSchema, conventions, PLACEHOLDER_CONFIG, projectType, projectTypeFor, TYPE_ID } from '../src/index.ts';
import { FULL, MINIMAL } from './support/config.ts';

describe('the shape of the type', () => {
	it('answers the contract, unconfigured and configured alike', () => {
		expect(projectTypeProblems(projectType)).toEqual([]);
		expect(projectTypeProblems(projectTypeFor(MINIMAL))).toEqual([]);
		expect(projectTypeProblems(projectTypeFor(FULL))).toEqual([]);
		expect(projectType.id).toBe(TYPE_ID);
		expect(TYPE_ID).toBe('vscode-extension');
	});

	it('declares the six capabilities every patch set of this family has, and the absences are answers too', () => {
		// ##VSX-CAPABILITIES, ##VSX-ABSENCES
		expect([...projectType.capabilities].sort()).toEqual([
			'build-channels',
			'config-overlay',
			'entry-module',
			'gen-brand',
			'preview',
			'upgrade-advisory'
		]);
		expect([...projectType.capabilities].sort()).toEqual([...CAPABILITIES].sort());
		for (const absent of ['own-extensions', 'service-override', 'dev-channel', 'brand-images', 'runtime-library'] as const) {
			expect(projectType.capabilities.has(absent), absent).toBe(false);
		}
		expect(projectType.brandImages).toBeUndefined();
		expect(projectType.runtime).toBeUndefined();
		expect(projectType.preview).toBeDefined();
		expect(projectType.generators.brandGraft).toBeDefined();
		expect(projectType.layers.ownExtensions).toBeNull();
		expect(projectType.layers.serviceOverride).toBeNull();
		expect(projectType.layers.entryModule).not.toBeNull();
		// ##VSX-CONFIGURED-TYPE: the same capabilities for every configuration.
		expect(projectType.configurableCapabilities ?? new Set()).toEqual(new Set());
		expect([...projectTypeFor(FULL).capabilities].sort()).toEqual([...projectType.capabilities].sort());
	});

	it('configures itself from typeConfig and keeps its identifier', () => {
		const configured = projectType.configure?.(FULL);
		expect(configured?.id).toBe(TYPE_ID);
		expect(configured?.layers.overlayTargets[0]?.path).toBe('packages/acme-sample/package.json');
		expect(configured?.build.install[0]?.command).toBe('pnpm');
		expect(projectTypeProblems(configured ?? projectType)).toEqual([]);
	});

	it('survives a section it never validated by falling back to the placeholder', () => {
		const configured = projectType.configure?.({ nonsense: true });
		expect(configured?.layers.overlayTargets[0]?.path).toBe('package.json');
		expect(configured?.layout.ownRootProblem(PLACEHOLDER_CONFIG.ownRoot)).toBeNull();
	});

	it('hands the engine the schema its own suite validates with', () => {
		expect(projectType.configSchema).toBe(configSchema);
		expect(projectType.conventions).toBe(conventions);
	});
});

describe('the declarative manifest', () => {
	it('agrees with the exported type and with the package', () => {
		// ##TYPE-MANIFEST-HANDSHAKE
		const raw: unknown = JSON.parse(readFileSync(new URL('../type-manifest.json', import.meta.url), 'utf8'));
		const result = validateTypeManifest(raw, {
			id: TYPE_ID,
			package: '@codkit/type-vscode-extension',
			version: '1.0.0',
			engineVersion: '1.0.0'
		});
		expect(result.ok, result.ok ? '' : result.problem.message).toBe(true);
		if (!result.ok) {
			return;
		}
		expect([...result.manifest.capabilities]).toEqual([...projectType.capabilities].sort());
		expect([...result.manifest.configurableCapabilities]).toEqual([]);
		const packageJson: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
		expect(packageJson).toMatchObject({ name: result.manifest.package, version: result.manifest.version });
	});
});
