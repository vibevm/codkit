// PROP-016 ##TYPE-ENGINE-TESTS: the registry itself, so this suite names the
// official types by definition; it is the one engine suite that must.
// The registry of project types and the capability refusal (PROP-016
// ##TYPE-REGISTRY, ##TYPE-UNKNOWN, ##TYPE-CAPABILITY-REFUSAL).
//
// The set of loadable code is fixed by the tool's own release: a type is a
// package name in this table and nothing else can be loaded, so the test that
// matters is what happens to an identifier the table does not carry.

import type { Capability, ProjectType } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { describe, expect, it } from 'vitest';
import { isCkError } from '../../src/lib/messages.ts';
import { requireCapability } from '../../src/types/capability.ts';
import { configureProjectType } from '../../src/types/configure.ts';
import { registeredTypes, resolveProjectType, TYPE_REGISTRY } from '../../src/types/registry.ts';

/** A type that answers nothing optional, for the refusals. */
function stub(capabilities: readonly Capability[]): ProjectType {
	return { ...vscodeType, id: 'stub', capabilities: new Set(capabilities) };
}

async function refusal(id: string): Promise<{ code: string; message: string; hint: string }> {
	try {
		await resolveProjectType(id);
	} catch (error) {
		if (!isCkError(error)) throw error;
		return { code: error.code, message: error.message, hint: error.hint ?? '' };
	}
	throw new Error(`resolving ${id} did not refuse`);
}

describe('the registry', () => {
	it('resolves the identifier a patch set declares into the package that implements it', async () => {
		expect(TYPE_REGISTRY.get('vscode')).toBe('@codkit/type-vscode');
		const resolved = await resolveProjectType('vscode');
		expect(resolved.id).toBe('vscode');
	});

	it('returns the same instance twice: a type is resolved once per run', async () => {
		expect(await resolveProjectType('vscode')).toBe(await resolveProjectType('vscode'));
	});

	it('refuses an identifier it does not know, naming what it does know', async () => {
		const outcome = await refusal('kettle');
		expect(outcome.code).toBe('TYPE-UNKNOWN');
		expect(outcome.message).toContain('"kettle"');
		expect(outcome.hint).toContain('vscode');
		expect(outcome.hint).toContain('generic');
	});

	it('prints one row per registered type, with its package, version and capabilities', async () => {
		const rows = await registeredTypes();
		expect(rows.map((row) => row.id)).toEqual(['vscode', 'generic', 'theia']);
		expect(rows.every((row) => row.installed)).toBe(true);
		expect(rows.every((row) => row.version === '1.0.0')).toBe(true);
		expect(rows[0]?.capabilities).toContain('brand-images');
	});

	it('says which abilities a type declares only for a patch set that asks for them', async () => {
		const rows = await registeredTypes();
		const generic = rows.find((row) => row.id === 'generic');
		expect(generic?.capabilities).toEqual([]);
		expect(generic?.configurableCapabilities).toEqual(['build-channels', 'config-overlay']);
		expect(rows.find((row) => row.id === 'vscode')?.configurableCapabilities).toEqual([]);
		// The theia type is configured too, and yet its capability matrix is the
		// same for every patch set: what its section moves are paths, not answers.
		expect(rows.find((row) => row.id === 'theia')?.configurableCapabilities).toEqual([]);
	});
});

describe('the configured type', () => {
	it('is the type a section of typeConfig makes, and every engine below asks that one', async () => {
		const generic = await resolveProjectType('generic');
		const configured = configureProjectType(generic, { ownRoot: 'own', overlayTargets: ['app.json'] });
		expect(configured.id).toBe('generic');
		expect(configured.capabilities.has('config-overlay')).toBe(true);
		expect(configured.layers.overlayTargets.map((target) => target.path)).toEqual(['app.json']);
	});

	it('returns a type without a configure step unchanged', () => {
		const { configure, ...withoutConfigure } = vscodeType;
		const plain: ProjectType = { ...withoutConfigure, id: 'plain' };
		expect(configureProjectType(plain, { ownRoot: 'src/vs/patchset' })).toBe(plain);
	});

	it('takes the quality channel of the first family from the section it was handed', async () => {
		// ##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER: the one answer of this type that
		// a patch set moves, and the engine below asks only the configured type.
		const vscode = await resolveProjectType('vscode');
		const configured = configureProjectType(vscode, { ownRoot: 'src/vs/patchset', quality: 'stable' });

		expect(configured.build.packageStamps).toContainEqual({ name: 'VSCODE_QUALITY', source: 'literal', value: 'stable' });
		expect(configureProjectType(vscode, { ownRoot: 'src/vs/patchset' }).build.packageStamps).toContainEqual({
			name: 'VSCODE_QUALITY',
			source: 'pin-tag'
		});
	});

	it('refuses a configure that declares a capability the type never announced', () => {
		const rogue: ProjectType = {
			...vscodeType,
			id: 'rogue',
			capabilities: new Set<Capability>(),
			configurableCapabilities: new Set<Capability>(['config-overlay']),
			configure: () => ({ ...vscodeType, id: 'rogue', capabilities: new Set<Capability>(['gen-brand']) })
		};
		let thrown: unknown;
		try {
			configureProjectType(rogue, {});
		} catch (error) {
			thrown = error;
		}
		expect(isCkError(thrown)).toBe(true);
		if (!isCkError(thrown)) return;
		expect(thrown.code).toBe('TYPE-UNKNOWN');
		expect(thrown.message).toContain('gen-brand');
	});
});

describe('the capability refusal', () => {
	it('lets a verb through when the type declares what it needs', () => {
		expect(() => requireCapability(vscodeType, 'brand-images', 'imageset gen')).not.toThrow();
	});

	it('refuses, names the type and the capability, and says nothing was written', () => {
		let thrown: unknown;
		try {
			requireCapability(stub([]), 'brand-images', 'imageset gen');
		} catch (error) {
			thrown = error;
		}
		expect(isCkError(thrown)).toBe(true);
		if (!isCkError(thrown)) return;
		expect(thrown.code).toBe('TYPE-CAPABILITY');
		expect(thrown.message).toContain('imageset gen');
		expect(thrown.message).toContain('brand-images');
		expect(thrown.message).toContain('stub');
		expect(thrown.hint).toContain('nothing was written');
	});

	it('asks nothing of a patch set that has no configuration, and therefore no type', () => {
		expect(() => requireCapability(null, 'runtime-library', 'runtime load')).not.toThrow();
	});
});
