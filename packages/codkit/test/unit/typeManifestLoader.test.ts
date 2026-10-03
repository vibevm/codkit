import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registeredTypes, resolveProjectType } from '../../src/types/registry.ts';
import { TYPE_PACKAGE_ENV } from '../../src/types/testSeam.ts';

const roots: string[] = [];
const originalArgv = [...process.execArgv];
afterEach(() => {
	process.execArgv.splice(0, process.execArgv.length, ...originalArgv);
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(id: string, changes: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), 'codkit-type-handshake-'));
	roots.push(root);
	const adapter = join(root, 'adapter.mjs');
	const sentinel = join(root, 'executed');
	writeFileSync(
		adapter,
		`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed'); throw new Error('adapter executed');`
	);
	writeFileSync(
		`${adapter}.manifest.json`,
		JSON.stringify({
			typeManifestVersion: 1,
			contractVersion: 1,
			id,
			package: '@codkit/test-stub',
			version: '1.0.0',
			engineRange: { min: '1.0.0', maxExclusive: '2.0.0' },
			capabilities: [],
			configurableCapabilities: [],
			...changes
		})
	);
	process.execArgv.push('--conditions=codkit-test');
	vi.stubEnv(TYPE_PACKAGE_ENV, `${id}=${adapter}`);
	return { sentinel };
}

describe('pre-import type manifest boundary', () => {
	it.each(['typeManifestVersion', 'contractVersion'])('refuses incompatible %s before adapter evaluation', async (field) => {
		const probe = fixture(`wrong-${field.toLowerCase()}`, { [field]: 99 });
		await expect(resolveProjectType(`wrong-${field.toLowerCase()}`)).rejects.toThrow(/expected.*1, actual 99/);
		expect(existsSync(probe.sentinel)).toBe(false);
	});
	it('inspects registered metadata without evaluating even a throwing adapter', async () => {
		const probe = fixture('inspect-only');
		const rows = await registeredTypes();
		expect(rows.find((row) => row.id === 'inspect-only')).toMatchObject({
			installed: true,
			manifestVersion: 1,
			contractVersion: 1,
			source: 'test-seam',
			capabilities: []
		});
		expect(existsSync(probe.sentinel)).toBe(false);
	});
	it('starts adapter evaluation only after a compatible handshake', async () => {
		const probe = fixture('compatible-throw');
		await expect(resolveProjectType('compatible-throw')).rejects.toThrow(/adapter executed/);
		expect(existsSync(probe.sentinel)).toBe(true);
	});
});
