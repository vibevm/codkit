// unit: the generated inventory (PROP-006 sec. 3-4).
//
// The fixture patchset carries one artifact of every layer, so the inventory built
// from it is the smallest complete answer to "what does this delta do": every
// layer present once, ids sorted, subsystems derived, metrics agreeing with the
// artifacts they came from.
//
// Contract coverage is checked against the fixture's own test file, which
// declares the guard ids its artifacts name - the resolution PROP-010
// ##CONTRACT-TESTS-MANDATE describes, done by finding the id in own code.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/configFile.ts';
import {
	DELIVERED_CATEGORY,
	DELIVERED_RUNTIME_ID,
	buildInventory,
	declaredTestIds,
	diffInventories,
	expandRoots,
	ownTestIds,
	renderInventoryMarkdown,
	serializeInventory,
	subsystemOf
} from '../../src/lib/inventory.ts';
import type { Inventory } from '../../src/lib/inventory.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { OVERLAY_ID, OWN_UNIT_ID, PATCH_FILE_NAME, PATCH_ID, RESOURCE_ID, RULE_ID, makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

let patchesDir: string;
let inventory: Inventory;

beforeAll(() => {
	const upstream = makeUpstream(makeTempRoot('inventory-upstream'));
	patchesDir = makeTempRoot('inventory-patchset');
	makePatchSet(patchesDir, upstream);
	inventory = buildInventory(patchesDir, vscodeType, { config: loadConfig(patchesDir) });
});

afterAll(cleanupTempRoots);

describe('the delivered runtime library', () => {
	it('is one synthetic entry naming its version, not two hundred files', () => {
		// PROP-015 ##RT-INVENTORY-ENTRY: the library is a managed copy, so what
		// the inventory owes a reader is that it is installed and which version.
		const root = join(patchesDir, 'delta', 'own', 'codkit', 'common');
		mkdirSync(root, { recursive: true });
		try {
			writeFileSync(join(root, 'version.ts'), "export const CODKIT_RUNTIME_VERSION = '0.1.0';\n", 'utf8');
			const built = buildInventory(patchesDir, vscodeType, { config: loadConfig(patchesDir) });
			const delivered = built.entries.filter((entry) => entry.id === DELIVERED_RUNTIME_ID);

			expect(delivered).toHaveLength(1);
			expect(delivered[0]?.layer).toBe('own');
			expect(delivered[0]?.category).toBe(DELIVERED_CATEGORY);
			expect(delivered[0]?.reason).toBe('Codkit runtime 0.1.0');
			expect(delivered[0]?.synthetic).toBe(true);
			expect(delivered[0]?.files).toEqual(['codkit/']);
		} finally {
			rmSync(join(patchesDir, 'delta', 'own', 'codkit'), { recursive: true, force: true });
		}
	});

	it('is absent from a product that never installed the library', () => {
		expect(inventory.entries.filter((entry) => entry.id === DELIVERED_RUNTIME_ID)).toEqual([]);
	});
});

describe('buildInventory', () => {
	it('carries one entry per artifact of the fixture, sorted by id', () => {
		expect(inventory.entries.map((entry) => entry.id)).toEqual([OVERLAY_ID, RESOURCE_ID, PATCH_ID, OWN_UNIT_ID, RULE_ID].sort());
	});

	it('attributes every entry to the layer of its artifact', () => {
		expect(layerOf(PATCH_ID)).toBe('patch');
		expect(layerOf(OVERLAY_ID)).toBe('config-overlay');
		expect(layerOf(RESOURCE_ID)).toBe('resource-file');
		expect(layerOf(RULE_ID)).toBe('rewrite-rule');
		expect(layerOf(OWN_UNIT_ID)).toBe('own');
	});

	it('names the artifact file each record lives in', () => {
		expect(entry(PATCH_ID).artifact).toBe(`delta/patches/${PATCH_FILE_NAME}`);
		expect(entry(OVERLAY_ID).artifact).toBe('delta/overlays/product.json.overlay.json');
		expect(entry(RESOURCE_ID).artifact).toBe('delta/resources/map.json');
		expect(entry(RULE_ID).artifact).toBe('delta/rules/example.ckrule.json');
		expect(entry(OWN_UNIT_ID).artifact).toBe('delta/own/patchset.delta.json');
	});

	it('takes the subsystem from the second component of the id', () => {
		expect(entry(PATCH_ID).subsystem).toBe('workbench');
		expect(entry(OVERLAY_ID).subsystem).toBe('product');
		expect(subsystemOf('CK-editor-042')).toBe('editor');
	});

	it('names the files each record changes', () => {
		expect(entry(PATCH_ID).files).toEqual(['src/vs/workbench/browser/parts/example/examplePart.ts']);
		expect(entry(OVERLAY_ID).files).toEqual(['product.json']);
		expect(entry(RESOURCE_ID).files).toEqual(['resources/app-icon.bin']);
		// A unit declares roots; the entry names the files those roots cover.
		expect(entry(OWN_UNIT_ID).files).toEqual(['hello.ts', 'test/fixture.test.ts']);
	});

	it('renders a cause of "none" as null and keeps link as written', () => {
		expect(entry(PATCH_ID).cause).toBeNull();
		expect(entry(PATCH_ID).link).toBe('none');
	});

	it('states the pin and the patchset commit', () => {
		expect(inventory.pin).toMatch(/^t1@[0-9a-f]{40}$/);
		expect(inventory.patchSetCommit).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe('metrics', () => {
	it('counts entries by layer and by subsystem', () => {
		expect(inventory.metrics.byLayer).toEqual({ 'config-overlay': 1, own: 1, patch: 1, 'resource-file': 1, 'rewrite-rule': 1 });
		expect(inventory.metrics.bySubsystem).toEqual({ product: 2, workbench: 3 });
	});

	it('counts only the two bottom layers in the shrink metric', () => {
		// ##LAYER-METRIC: rewrite-rule plus patch, and entry-module is a layer of
		// its own that this number deliberately leaves out.
		expect(inventory.metrics.patchAndRuleCount).toBe(2);
	});

	it('takes a patch out of the shrink metric once its header says entry-module', () => {
		const path = join(patchesDir, 'delta', 'patches', PATCH_FILE_NAME);
		const saved = readFileSync(path, 'utf8');
		try {
			writeFileSync(path, saved.replace(`# id: ${PATCH_ID}\n`, `# id: ${PATCH_ID}\n# layer: entry-module\n`), 'utf8');
			const after = buildInventory(patchesDir, vscodeType, { config: loadConfig(patchesDir) });

			expect(after.entries.find((item) => item.id === PATCH_ID)?.layer).toBe('entry-module');
			expect(after.metrics.byLayer['entry-module']).toBe(1);
			expect(after.metrics.patchAndRuleCount).toBe(1);
		} finally {
			writeFileSync(path, saved, 'utf8');
		}
	});

	it('sums the hunks and the added lines of the patches', () => {
		expect(inventory.metrics.hunks).toBe(1);
		// The fixture patch adds the three lines of one marker block.
		expect(inventory.metrics.patchLineTotal).toBe(3);
	});

	it('resolves contract coverage against the own tests', () => {
		// Four of the five entries name a guard, and every id is declared by the
		// fixture's own test file; the patch names none.
		expect(inventory.metrics.contractCoverage.covered).toBe(4);
		// Required: the overlay, the resource entry and the removed record.
		expect(inventory.metrics.contractCoverage).toEqual({ covered: 4, requiredCovered: 3, requiredTotal: 3 });
	});

	it('drops coverage when the guard id no longer exists in own code', () => {
		const path = join(patchesDir, 'delta', 'own', 'test', 'fixture.test.ts');
		const saved = readFileSync(path, 'utf8');
		try {
			writeFileSync(path, saved.split("suite('fixture.guard.icon'").join("suite('fixture.guard.gone'"), 'utf8');
			const after = buildInventory(patchesDir, vscodeType, { config: loadConfig(patchesDir) });
			expect(after.metrics.contractCoverage).toEqual({ covered: 3, requiredCovered: 2, requiredTotal: 3 });
		} finally {
			writeFileSync(path, saved, 'utf8');
		}
	});
});

describe('test id scanning', () => {
	it('reads suite and test declarations in every quote form', () => {
		expect(declaredTestIds('suite(\'a.b\', () => {});\ntest("c.d", () => {});\nsuite(`e.f`, () => {});')).toEqual(['a.b', 'c.d', 'e.f']);
	});

	it('ignores a call that is not a declaration', () => {
		expect(declaredTestIds("describe('x.y', () => {});")).toEqual([]);
	});

	it('ignores declaration-shaped text in comments, strings and template text', () => {
		const source = [
			"// suite('comment.line', () => {});",
			"/* test('comment.block', () => {}); */",
			'const quoted = "suite(\'string.value\', () => {});";',
			"const template = `test('template.value', () => {});`;"
		].join('\n');

		expect(declaredTestIds(source)).toEqual([]);
	});

	it('ignores property calls, disabled forms and interpolated names', () => {
		const source = [
			"runner.test('property.call', () => {});",
			"test.skip('disabled.test', () => {});",
			"suite.skip('disabled.suite', () => {});",
			"test.todo('todo.test');",
			"xtest('disabled.alias', () => {});",
			"test?.('optional.test', () => {});",
			'test(`dynamic.${name}`, () => {});'
		].join('\n');

		expect(declaredTestIds(source)).toEqual([]);
	});

	it('finds the ids of the fixture own tests', () => {
		// ##CONTRACT-TESTS-MANDATE names both forms, so the names of the inner
		// `test(...)` cases are collected too; a guard id is simply one of them.
		const ids = ownTestIds(patchesDir);
		for (const id of ['fixture.guard.icon', 'fixture.guard.product', 'fixture.guard.removed', 'fixture.guard.rule', 'fixture.unit.hello']) {
			expect(ids.has(id), id).toBe(true);
		}
		expect(ids.has('fixture.guard.gone')).toBe(false);
	});
});

describe('expandRoots', () => {
	it('takes a directory root as a prefix and a plain root as one file', () => {
		expect(expandRoots(['modes/', 'root.ts'], ['modes/a.ts', 'modes/zen/b.ts', 'root.ts', 'other.ts'])).toEqual([
			'modes/a.ts',
			'modes/zen/b.ts',
			'root.ts'
		]);
	});
});

describe('serialization', () => {
	it('is deterministic: two builds of one state are byte-identical', () => {
		const again = buildInventory(patchesDir, vscodeType, { config: loadConfig(patchesDir) });
		expect(serializeInventory(again)).toBe(serializeInventory(inventory));
	});

	it('indents with two spaces and ends with a newline', () => {
		const text = serializeInventory(inventory);
		expect(text.startsWith('{\n  "codkitInventory": 2,\n')).toBe(true);
		expect(text.endsWith('}\n')).toBe(true);
	});

	it('keeps the key order of the schema', () => {
		expect(Object.keys(inventory)).toEqual(['codkitInventory', 'patchSetCommit', 'pin', 'entries', 'metrics']);
		expect(Object.keys(inventory.entries[0] ?? {})).toEqual([
			'id',
			'layer',
			'type',
			'category',
			'subsystem',
			'files',
			'owner',
			'reason',
			'link',
			'cause',
			'pin',
			'contractTests',
			'artifact'
		]);
	});

	it('renders a markdown table that names every entry', () => {
		const markdown = renderInventoryMarkdown(inventory);
		for (const id of [PATCH_ID, OVERLAY_ID, RESOURCE_ID, RULE_ID, OWN_UNIT_ID]) {
			expect(markdown).toContain(id);
		}
		expect(markdown).toContain('| id | layer | subsystem | category | owner | files | guard tests |');
	});
});

describe('diffInventories', () => {
	it('reports an entry that only one side has, and the metric that moved', () => {
		const reduced: Inventory = {
			...inventory,
			entries: inventory.entries.filter((item) => item.id !== RULE_ID),
			metrics: { ...inventory.metrics, patchAndRuleCount: 1 }
		};
		const diff = diffInventories(reduced, inventory);

		expect(diff.added.map((item) => item.id)).toEqual([RULE_ID]);
		expect(diff.removed).toEqual([]);
		expect(diff.changed).toEqual([]);
		expect(diff.metrics).toContainEqual({ name: 'patchAndRuleCount', before: 1, after: 2 });
	});

	it('names the fields of an entry that changed', () => {
		const edited: Inventory = {
			...inventory,
			entries: inventory.entries.map((item) => (item.id === PATCH_ID ? { ...item, owner: 'platform', files: ['other.ts'] } : item))
		};
		const diff = diffInventories(inventory, edited);

		expect(diff.changed.map((item) => item.id)).toEqual([PATCH_ID]);
		expect(diff.changed[0]?.fields).toEqual(['files', 'owner']);
	});
});

function entry(id: string) {
	const found = inventory.entries.find((item) => item.id === id);
	if (found === undefined) {
		throw new Error(`the inventory has no entry ${id}`);
	}
	return found;
}

function layerOf(id: string): string {
	return entry(id).layer;
}
