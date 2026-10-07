/** @scope spec://codkit/modules/codkit/PROP-007#cmd-save */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { explicitRegenerationPaths } from '../../src/commands/save.ts';
import { makeTempRoot, cleanupTempRoots } from '../support/tmp.ts';
import { makeCliFixture } from '../support/cliFixture.ts';

afterAll(() => cleanupTempRoots());
function fixture() {
	const root = makeTempRoot('save-regenerate-scope');
	const tree = join(root, 'tree');
	const patches = join(root, 'patches');
	mkdirSync(tree);
	mkdirSync(join(patches, 'delta/patches'), { recursive: true });
	writeFileSync(join(tree, 'entry.ts'), 'existing bytes');
	writeFileSync(join(patches, 'delta/patches/entry.ts.ckpatch'), 'existing artifact');
	return { tree, patches };
}
describe('explicit existing patch regeneration scope', () => {
	it('accepts only addressed existing file/artifact pairs and deduplicates them', () => {
		const { tree, patches } = fixture();
		expect(explicitRegenerationPaths(['entry.ts', 'entry.ts'], tree, patches)).toEqual(['entry.ts']);
	});
	it('refuses empty, escaping and directory scopes without creating an artifact', () => {
		const { tree, patches } = fixture();
		mkdirSync(join(tree, 'directory'));
		for (const paths of [[], ['../entry.ts'], ['/entry.ts'], ['directory'], ['missing.ts']]) {
			expect(() => explicitRegenerationPaths(paths, tree, patches)).toThrow();
		}
	});
	it('refuses unowned files without an existing patch artifact', () => {
		const { tree, patches } = fixture();
		writeFileSync(join(tree, 'unowned.ts'), 'keep');
		expect(() => explicitRegenerationPaths(['unowned.ts'], tree, patches)).toThrow(/existing patch artifact/);
	});
});

describe('ordinary CLI canonical regeneration', () => {
	it('regenerates a clean existing marker target without manufacturing an edit', () => {
		const f = makeCliFixture('save-regenerate-clean');
		const target = 'source/base/common/util.ts';
		const artifact = 'delta/patches/source__base__common__util.ts.ckpatch';
		expect(f.run(['load']).status).toBe(0);
		expect(
			f.run([
				'marker',
				'new',
				target,
				'--id',
				'CK-base-953',
				'--type',
				'hook',
				'--owner',
				'shell-core',
				'--reason',
				'canonical regeneration fixture'
			]).status
		).toBe(0);
		const text = readFileSync(f.treePath(target), 'utf8');
		const at = text.indexOf('\n', text.indexOf('// codkit:begin CK-base-953')) + 1;
		writeFileSync(f.treePath(target), text.slice(0, at) + '\texport const regeneratedEntry = true;\n' + text.slice(at));
		expect(f.run(['save', target]).status).toBe(0);
		const bytes = readFileSync(f.patchesPath(artifact));
		const raw = f.run(['--json', 'save', '--regenerate', target]);
		expect(raw.status, JSON.stringify(raw)).toBe(0);
		const envelope = JSON.parse(raw.stdout);
		expect(envelope.data.files).toEqual([expect.objectContaining({ target, action: 'unchanged' })]);
		expect(readFileSync(f.patchesPath(artifact))).toEqual(bytes);
		const repeated = f.json(['save', '--regenerate', target]);
		expect(repeated.run.status, repeated.run.stderr).toBe(0);
		expect(readFileSync(f.patchesPath(artifact))).toEqual(bytes);
		writeFileSync(f.patchesPath(artifact), Buffer.concat([bytes, Buffer.from('\n')]));
		const shifted = readFileSync(f.patchesPath(artifact));
		const refused = f.json(['save', '--regenerate', target]);
		expect(refused.run.status).toBe(1);
		expect(refused.envelope.errors.some((error) => error.code === 'CK-E-PATCHSET-MOVED')).toBe(true);
		expect(readFileSync(f.patchesPath(artifact))).toEqual(shifted);
		// The serial native Windows CLI fixture took 382 seconds with all assertions reached.
		// Keep this budget local to the real-process regression, without relaxing semantic assertions.
	}, 600000);
});
