import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseBaseConfig, parseLocalConfig, serializeBaseConfig } from '../../src/lib/configFile.ts';
import { applyConfigMigration, planConfigMigration, readConfigMigration } from '../../src/lib/configMigration.ts';
import { declaredDiscipline, disciplineOf, MINIMAL_DISCIPLINE } from '../../src/lib/discipline.ts';
import { deltaFingerprint } from '../../src/lib/fingerprint.ts';
import { acquireLock } from '../../src/lib/lock.ts';

const legacy = {
	codkitConfig: 2,
	pin: { tag: 't1', sha: 'a'.repeat(40), date: '2026-01-01' },
	upstreamAnchorCommit: 'b'.repeat(40),
	type: 'stub',
	typeConfig: { ownRoot: 'source/own' },
	generatedBranchPrefix: 'codkit/applied/',
	cycleBranchPrefix: 'codkit/cycle/',
	releaseRefPrefix: 'codkit/release/'
};
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'codkit-config-migration-'));
	roots.push(root);
	writeFileSync(join(root, 'codkit.json'), serializeBaseConfig(parseBaseConfig(legacy, 'codkit.json')));
	return root;
}

describe('explicit discipline versioning', () => {
	it('keeps legacy config serialization and fingerprint bytes unchanged', () => {
		const parsed = parseBaseConfig(legacy, 'codkit.json');
		expect(disciplineOf(parsed)).toBe(MINIMAL_DISCIPLINE);
		expect(declaredDiscipline(parsed)).toBeUndefined();
		const bytes = serializeBaseConfig(parsed);
		expect(JSON.parse(bytes)).toEqual({ ...legacy, publishRemoteUrl: null, buildWatchFile: null, conventionsExtensionFile: null });
		expect(bytes).not.toContain('discipline');
		const root = fixture();
		const expected = createHash('sha256').update(`pin ${legacy.pin.sha}\nschema 1\n`).digest('hex');
		expect(deltaFingerprint(root, legacy.pin.sha, declaredDiscipline(parsed))).toBe(expected);
	});
	it('requires a supported profile in schema 3 and refuses local override', () => {
		expect(() => parseBaseConfig({ ...legacy, codkitConfig: 3 }, 'codkit.json')).toThrow(/discipline/);
		expect(() => parseBaseConfig({ ...legacy, codkitConfig: 3, discipline: 'patch-heavy@1' }, 'codkit.json')).toThrow(/discipline/);
		expect(() => parseLocalConfig({ discipline: MINIMAL_DISCIPLINE }, 'codkit.local.json')).toThrow(/cannot be overridden locally/);
		expect(() => parseBaseConfig({ ...legacy, discipline: MINIMAL_DISCIPLINE }, 'codkit.json')).toThrow(/requires codkitConfig: 3/);
	});
	it('plans an idempotent explicit migration and a distinct fingerprint domain', () => {
		const plan = planConfigMigration(legacy);
		expect(plan).toMatchObject({ from: 2, to: 3, changed: true });
		expect(plan.config.discipline).toBe(MINIMAL_DISCIPLINE);
		expect(planConfigMigration(JSON.parse(plan.contents)).changed).toBe(false);
		const root = fixture();
		expect(deltaFingerprint(root, legacy.pin.sha, declaredDiscipline(plan.config))).not.toBe(deltaFingerprint(root, legacy.pin.sha));
	});
	it('writes only with the live config lock and preserves idempotency', () => {
		const root = fixture();
		const current = readConfigMigration(root);
		const lock = acquireLock(root, 'cycle-global', 'config migration test');
		try {
			expect(applyConfigMigration(root, current.bytes, lock).changed).toBe(true);
			const migrated = readConfigMigration(root);
			expect(applyConfigMigration(root, migrated.bytes, lock).changed).toBe(false);
		} finally {
			lock.release();
		}
		expect(JSON.parse(readFileSync(join(root, 'codkit.json'), 'utf8'))).toMatchObject({ codkitConfig: 3, discipline: MINIMAL_DISCIPLINE });
		expect(() => applyConfigMigration(root, current.bytes, lock)).toThrow(/lock|capability/i);
	});
	it('preserves an edit that lands after the migration comparison', () => {
		const root = fixture();
		const current = readConfigMigration(root);
		const lock = acquireLock(root, 'cycle-global', 'config migration race');
		const changed = serializeBaseConfig(parseBaseConfig({ ...legacy, publishRemoteUrl: 'https://example.invalid/new' }, 'codkit.json'));
		try {
			expect(() => applyConfigMigration(root, current.bytes, lock, () => writeFileSync(join(root, 'codkit.json'), changed))).toThrow(
				/changed before migration/
			);
		} finally {
			lock.release();
		}
		expect(readFileSync(join(root, 'codkit.json'), 'utf8')).toBe(changed);
	});
});
