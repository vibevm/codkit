/** @scope spec://codkit/modules/codkit/PROP-007#cmd-marker-new */
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { insertBlock } from '../../src/commands/markerNew.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
afterAll(() => cleanupTempRoots());
const fields = {
	id: 'CK-workbench-997',
	type: 'modify',
	category: 'follow',
	owner: 'product-core',
	reason: 'bounded authoring',
	layer: 'patch' as const,
	line: 2
};
const form = { open: '// codkit:', close: '' };
describe('tool-owned bounded marker body authoring', () => {
	it('neutralizes only the addressed header and retains surrounding method body and final newline', () => {
		const source = 'class Item {\n\toverride updateChecked(): void {\n\t\tsuper.updateChecked();\n\t}\n}\n';
		const result = insertBlock(
			source,
			form,
			{ ...fields, body: 'protected override updateChecked(): void {\n', replaceLines: 1 },
			'source/item.ts'
		);
		expect(result.text).toBe(
			'class Item {\n\t// codkit:begin CK-workbench-997\n\t// override updateChecked(): void {\n\tprotected override updateChecked(): void {\n\t\t// codkit:end CK-workbench-997\n\t\tsuper.updateChecked();\n\t}\n}\n'
		);
	});
	it('preserves a no-final-newline file and refuses ranges crossing marker ownership or EOF', () => {
		const source = 'before\nline';
		expect(insertBlock(source, form, { ...fields, body: 'owned();', replaceLines: 1 }, 'source/item.ts').text.endsWith('\n')).toBe(false);
		expect(() => insertBlock(source, form, { ...fields, body: 'owned();', replaceLines: 2 }, 'source/item.ts')).toThrow(/range/);
		expect(() =>
			insertBlock('before\n// codkit:begin CK-other-001\n', form, { ...fields, body: 'owned();', replaceLines: 1 }, 'source/item.ts')
		).toThrow(/ownership/);
	});
	it('retains the existing empty-scaffold behavior when body authoring is absent', () => {
		expect(insertBlock('before\nline\n', form, fields, 'source/item.ts').text).toBe(
			'before\n// codkit:begin CK-workbench-997\n// codkit:end CK-workbench-997\nline\n'
		);
	});
});

describe('real marker body authoring transaction', () => {
	it('authors and canonically saves a bounded original-header replacement through the CLI', () => {
		const f = makeCliFixture('marker-body-cli');
		const target = 'source/base/common/util.ts';
		expect(f.run(['load']).status).toBe(0);
		const before = readFileSync(f.treePath(target), 'utf8');
		const lines = before.split('\n');
		const at = lines.findIndex((line) => line.includes('export function'));
		expect(at).toBeGreaterThanOrEqual(0);
		writeFileSync(f.patchesPath('body.txt'), lines[at]?.trimStart() + '\n');
		const command = [
			'marker',
			'new',
			target,
			'--id',
			'CK-base-998',
			'--type',
			'modify',
			'--owner',
			'shell-core',
			'--reason',
			'bounded declaration authoring',
			'--line',
			String(at + 1),
			'--body-file',
			'body.txt',
			'--replace-lines',
			'1'
		];
		const authored = f.json(command);
		expect(authored.run.status, authored.run.stderr).toBe(0);
		const bytes = readFileSync(f.treePath(target), 'utf8');
		expect(bytes).toContain('// codkit:begin CK-base-998');
		expect(bytes).toContain('// ' + lines[at]?.trimStart());
		const refusedReplay = f.json(command);
		expect(refusedReplay.run.status).toBe(2);
		expect(readFileSync(f.treePath(target), 'utf8')).toBe(bytes);
		const saved = f.json(['save', target]);
		expect(saved.run.status, saved.run.stderr).toBe(0);
		expect(readFileSync(f.patchesPath('delta/patches/source__base__common__util.ts.ckpatch'), 'utf8')).toContain('CK-base-998');
	}, 600000);
});
