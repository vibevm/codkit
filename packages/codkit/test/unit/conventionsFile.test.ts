import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectType } from '../fixtures/stubType.ts';

const supplied = vi.hoisted(() => ({ version: 1, extension: null as string | null }));
vi.mock('../../src/lib/configFile.ts', () => ({ loadBaseConfig: () => ({ conventionsExtensionFile: supplied.extension }) }));
vi.mock('../../src/lib/containedFile.ts', async (original) => {
	const actual = await original<typeof import('../../src/lib/containedFile.ts')>();
	return {
		...actual,
		readContainedFile: (root: string, path: string, options: { what: string }) =>
			path === 'config/conventions.json'
				? {
						state: 'present',
						bytes: Buffer.from(
							JSON.stringify({
								codkitConventions: supplied.version,
								interventionTypes: ['modify'],
								categories: ['own'],
								layers: ['patch'],
								markerComment: { '.ts': { open: '// codkit:', close: '' } }
							})
						)
					}
				: actual.readContainedFile(root, path, options)
	};
});

const roots: string[] = [];
afterEach(() => {
	vi.resetModules();
	supplied.version = 1;
	supplied.extension = null;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function extension(document: unknown) {
	const root = mkdtempSync(join(tmpdir(), 'codkit-conventions-test-'));
	roots.push(root);
	mkdirSync(join(root, 'config'));
	writeFileSync(join(root, 'config', 'extension.json'), JSON.stringify(document));
	supplied.extension = 'config/extension.json';
	const { loadConventions } = await import('../../src/lib/conventionsFile.ts');
	return () => loadConventions(projectType, root);
}

describe('conventions format boundary', () => {
	it('reads the shipped version and retains type-owned restrictions', async () => {
		const { loadConventions } = await import('../../src/lib/conventionsFile.ts');
		const result = loadConventions(projectType);
		expect(result.interventionTypes).toEqual(['modify']);
		expect(result.forbiddenPatchTargets).toEqual(expect.arrayContaining([...projectType.layout.forbiddenPatchTargets]));
	});
	it('refuses a newer shipped schema', async () => {
		supplied.version = 2;
		const { loadConventions } = await import('../../src/lib/conventionsFile.ts');
		expect(() => loadConventions(projectType)).toThrow(/codkitConventions/);
	});
	it('composes additive restrictions and a new marker form', async () => {
		const read = await extension({
			codkitConventionsExtension: 1,
			subsystems: ['extra'],
			forbiddenPatchTargets: ['private/**'],
			forbiddenServiceIds: ['private-service'],
			markerComment: { '.xyz': { open: '# codkit:', close: '' } }
		});
		const result = read();
		expect(result.subsystems).toContain('extra');
		expect(result.forbiddenPatchTargets).toContain('private/**');
		expect(result.forbiddenPatchTargets).toEqual(expect.arrayContaining([...projectType.layout.forbiddenPatchTargets]));
		expect(result.forbiddenServiceIds).toContain('private-service');
		expect(result.markerComment['.xyz']).toEqual({ open: '# codkit:', close: '' });
	});
	it('refuses a newer additive schema', async () => {
		expect(await extension({ codkitConventionsExtension: 2 })).toThrow(/codkitConventionsExtension/);
	});
	it('refuses an extension that replaces a shipped marker', async () => {
		expect(await extension({ codkitConventionsExtension: 1, markerComment: { '.ts': { open: 'weaker', close: '' } } })).toThrow(
			/cannot replace/
		);
	});
	it('refuses an undeclared policy field', async () => {
		expect(await extension({ codkitConventionsExtension: 1, allowUnsafeTargets: true })).toThrow(/Unrecognized|unrecognized/);
	});
});
