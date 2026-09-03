// e2e: codkit inventory (PROP-007 sec. 10).
//
// The real CLI, on the fixture triple: the document lands in .codkit/out/, the
// counters are the ones the artifacts imply, and `--diff` reads another commit
// of patchset through git rather than checking it out.

import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PATCH_ID, RESOURCE_ID, RULE_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let fixture: CliFixture;

type InventoryData = {
	inventory: {
		entries: { id: string; layer: string; subsystem: string }[];
		metrics: {
			byLayer: Record<string, number>;
			bySubsystem: Record<string, number>;
			patchAndRuleCount: number;
			hunks: number;
			patchLineTotal: number;
			contractCoverage: { covered: number; requiredCovered: number; requiredTotal: number };
		};
	};
	path: string;
	findings: unknown[];
	diff?: { ref: string; added: { id: string }[]; removed: { id: string }[]; changed: unknown[]; metrics: unknown[] };
};

beforeAll(() => {
	fixture = makeCliFixture('inventory');
	expect(fixture.run(['sync']).status).toBe(0);
});

afterAll(cleanupTempRoots);

describe('codkit inventory', () => {
	it('generates the document and prints its counters', () => {
		const outcome = fixture.json(['inventory']);
		const data = outcome.envelope.data as unknown as InventoryData;

		expect(outcome.run.status).toBe(0);
		expect(data.findings).toEqual([]);
		expect(data.inventory.entries).toHaveLength(5);
		expect(data.inventory.metrics.byLayer).toEqual({
			'config-overlay': 1,
			own: 1,
			patch: 1,
			'resource-file': 1,
			'rewrite-rule': 1
		});
		expect(data.inventory.metrics.bySubsystem).toEqual({ product: 2, workbench: 3 });
		expect(data.inventory.metrics.patchAndRuleCount).toBe(2);
		expect(data.inventory.metrics.hunks).toBe(1);
		expect(data.inventory.metrics.patchLineTotal).toBe(3);
		expect(data.inventory.metrics.contractCoverage).toEqual({ covered: 4, requiredCovered: 3, requiredTotal: 3 });
	});

	it('writes .codkit/out/inventory.json, and the markdown only when asked', () => {
		rmSync(fixture.patchesPath('.codkit/out'), { recursive: true, force: true });

		expect(fixture.run(['inventory']).status).toBe(0);
		expect(existsSync(fixture.patchesPath('.codkit/out/inventory.json'))).toBe(true);
		expect(existsSync(fixture.patchesPath('.codkit/out/inventory.md'))).toBe(false);

		expect(fixture.run(['inventory', '--md']).status).toBe(0);
		const markdown = readFileSync(fixture.patchesPath('.codkit/out/inventory.md'), 'utf8');
		expect(markdown).toContain(PATCH_ID);
		expect(markdown).toContain(RESOURCE_ID);
	});

	it('regenerates byte-identical output', () => {
		fixture.run(['inventory']);
		const first = readFileSync(fixture.patchesPath('.codkit/out/inventory.json'), 'utf8');
		fixture.run(['inventory']);
		expect(readFileSync(fixture.patchesPath('.codkit/out/inventory.json'), 'utf8')).toBe(first);
	});

	it('diffs against another commit of patchset without checking it out', () => {
		// The fixture repository has two commits: the first carries the config and
		// the owners, the second adds one artifact of every layer.
		const outcome = fixture.json(['inventory', '--diff', 'HEAD~1']);
		const data = outcome.envelope.data as unknown as InventoryData;

		expect(outcome.run.status).toBe(0);
		expect(data.diff?.ref).toBe('HEAD~1');
		expect(data.diff?.added.map((entry) => entry.id).sort()).toEqual(data.inventory.entries.map((entry) => entry.id).sort());
		expect(data.diff?.removed).toEqual([]);
		expect(data.diff?.metrics).toContainEqual({ name: 'patchAndRuleCount', before: 0, after: 2 });
		// The scratch materialization of the ref leaves nothing behind.
		expect(readdirSync(fixture.patchesPath('.codkit/tmp')).filter((name) => name.startsWith('inventory-'))).toEqual([]);
	});

	it('refuses a --diff ref this repository does not carry', () => {
		const outcome = fixture.json(['inventory', '--diff', 'no-such-ref']);
		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-CONFIG');
	});

	it('exits 1 when the delta it describes is inconsistent', () => {
		const rule = fixture.patchesPath('delta/rules/example.ckrule.json');
		const saved = readFileSync(rule, 'utf8');
		try {
			writeFileSync(rule, saved.replace('"expectedMatches": 1', '"expectedMatches": 4'), 'utf8');
			const outcome = fixture.json(['inventory']);

			expect(outcome.run.status).toBe(1);
			expect(outcome.envelope.errors.map((error) => error.code)).toContain('CK-E-RULE-DRIFT');
			// The document is still generated: the inventory is a report, and a
			// broken delta is exactly when a reviewer needs to read it.
			const data = outcome.envelope.data as unknown as InventoryData;
			expect(data.inventory.entries.map((entry) => entry.id)).toContain(RULE_ID);
			expect(existsSync(fixture.patchesPath('.codkit/out/inventory.json'))).toBe(true);
		} finally {
			writeFileSync(rule, saved, 'utf8');
		}
	});
});
