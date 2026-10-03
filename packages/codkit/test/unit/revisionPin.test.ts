import { describe, expect, it } from 'vitest';
import { parseBaseConfig, serializeBaseConfig } from '../../src/lib/configFile.ts';
import { planConfigMigration } from '../../src/lib/configMigration.ts';
import { pinKey } from '../../src/lib/pinIdentity.ts';
import { overlayVarContext } from '../../src/lib/syncEngine.ts';

const raw = {
	codkitConfig: 4,
	discipline: 'minimal-intervention@1',
	pin: { sha: 'a'.repeat(40), date: '2026-01-01' },
	upstreamAnchorCommit: 'b'.repeat(40),
	type: 'generic',
	typeConfig: { ownRoot: 'own' },
	generatedBranchPrefix: 'codkit/applied/',
	cycleBranchPrefix: 'codkit/cycle/',
	releaseRefPrefix: 'codkit/release/'
};

describe('revision-only pin boundary', () => {
	it('keeps label absence in canonical bytes and uses full SHA only for operational names', () => {
		const config = parseBaseConfig(raw, 'codkit.json');
		expect(config.pin.tag).toBeNull();
		expect(() => parseBaseConfig({ ...raw, pin: { ...raw.pin, tag: `sha-${raw.pin.sha}` } }, 'codkit.json')).toThrow(/reserved/);
		expect(pinKey(config.pin)).toBe(`sha-${raw.pin.sha}`);
		const bytes = serializeBaseConfig(config);
		expect(JSON.parse(bytes).pin).toEqual(raw.pin);
		expect(serializeBaseConfig(parseBaseConfig(JSON.parse(bytes), 'codkit.json'))).toBe(bytes);
		expect(overlayVarContext(config, '2026-01-01T00:00:00Z', 'c'.repeat(40)).pinTag).toBe('');
	});
	it.each([2, 3])('does not loosen tagged schema %s or migrate ordinary serialization', (version) => {
		const tagged = { ...raw, codkitConfig: version, pin: { ...raw.pin, tag: 't1' } };
		const { discipline, ...withoutDiscipline } = tagged;
		expect(discipline).toBe('minimal-intervention@1');
		const legacy = version === 2 ? withoutDiscipline : tagged;
		const config = parseBaseConfig(legacy, 'codkit.json');
		expect(JSON.parse(serializeBaseConfig(config)).codkitConfig).toBe(version);
		expect(() => parseBaseConfig({ ...legacy, pin: raw.pin }, 'codkit.json')).toThrow(/pin.tag/);
		expect(planConfigMigration(legacy)).toMatchObject({ from: version, to: 4, changed: true });
	});
	it('validates provenance and preserves it as declaration data', () => {
		const pin = { ...raw.pin, resolvedAt: '2026-10-03T12:00:00Z', provenance: { source: 'topology-fixture', sha256: 'c'.repeat(64) } };
		expect(JSON.parse(serializeBaseConfig(parseBaseConfig({ ...raw, pin }, 'codkit.json'))).pin).toEqual(pin);
		expect(() =>
			parseBaseConfig({ ...raw, pin: { ...pin, provenance: { source: '../adapter.js', sha256: 'bad' } } }, 'codkit.json')
		).toThrow();
		expect(() => parseBaseConfig({ ...raw, pin: { ...pin, resolvedAt: 'not a timestamp' } }, 'codkit.json')).toThrow();
		expect(() => parseBaseConfig({ ...raw, codkitConfig: 5 }, 'codkit.json')).toThrow(/newer than/);
	});
});
