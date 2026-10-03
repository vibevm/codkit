import { describe, expect, expectTypeOf, it } from 'vitest';
import { TYPE_CONTRACT_VERSION, TYPE_MANIFEST_VERSION, validateTypeManifest } from '../src/typeManifest.ts';
import type { TypeManifest, TypeManifestResult } from '../src/typeManifest.ts';

const expected = { id: 'sample', package: '@codkit/type-sample', version: '1.0.0', engineVersion: '1.0.0' };
const valid = {
	typeManifestVersion: TYPE_MANIFEST_VERSION,
	contractVersion: TYPE_CONTRACT_VERSION,
	id: expected.id,
	package: expected.package,
	version: expected.version,
	engineRange: { min: '1.0.0', maxExclusive: '2.0.0' },
	capabilities: ['config-overlay'],
	configurableCapabilities: ['build-channels']
};

describe('type manifest compatibility', () => {
	it('accepts a compatible declarative manifest with a typed result', () => {
		const result = validateTypeManifest(valid, expected);
		expect(result.ok).toBe(true);
		expectTypeOf(result).toEqualTypeOf<TypeManifestResult>();
		if (result.ok) {
			expectTypeOf(result.manifest).toEqualTypeOf<TypeManifest>();
			expectTypeOf(result.manifest.id).not.toMatchTypeOf<typeof result.manifest.package>();
			expectTypeOf(result.manifest.version).not.toMatchTypeOf<typeof result.manifest.engineRange.min>();
		}
	});
	it.each(['typeManifestVersion', 'contractVersion'] as const)('refuses a newer %s with expected/actual versions and package', (field) => {
		const result = validateTypeManifest({ ...valid, [field]: 99 }, expected);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.problem.message).toContain('@codkit/type-sample');
			expect(result.problem.message).toContain(`expected ${field} 1, actual 99`);
		}
	});
	it.each([
		{ min: '1.0.1', maxExclusive: '2.0.0' },
		{ min: '0.1.0', maxExclusive: '1.0.0' },
		{ min: '2.0.0', maxExclusive: '1.0.0' }
	])('refuses unsupported or empty engine intervals', (engineRange) => {
		expect(validateTypeManifest({ ...valid, engineRange }, expected).ok).toBe(false);
	});
	it('compares numeric components instead of lexicographic version strings', () => {
		expect(
			validateTypeManifest({ ...valid, engineRange: { min: '1.2.0', maxExclusive: '1.11.0' } }, { ...expected, engineVersion: '1.10.0' }).ok
		).toBe(true);
	});
	it.each([{ id: 'another' }, { package: '@elsewhere/type-sample' }, { version: '1.0.1' }])('refuses identity disagreement', (change) => {
		expect(validateTypeManifest({ ...valid, ...change }, expected).ok).toBe(false);
	});
	it.each([
		{ adapterPath: '/untrusted/code.mjs' },
		{ capabilities: ['not-a-capability'] },
		{ capabilities: ['config-overlay', 'config-overlay'] },
		{ engineRange: { min: '1.0.0-beta', maxExclusive: '2.0.0' } }
	])('refuses malformed or undeclared manifest data', (change) => {
		expect(validateTypeManifest({ ...valid, ...change }, expected).ok).toBe(false);
	});
});
