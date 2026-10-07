/** @scope spec://codkit/modules/codkit/PROP-007#CMD-MARKER-REASON */
import { afterAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { PATCH_FILE_NAME, PATCH_ID } from '../fixtures/makePatchSet.ts';

afterAll(() => cleanupTempRoots());
describe('public marker reason CLI', () => {
	it('previews and authors Source only, preserving all Git/fork bytes and refusing stale hash', () => {
		const f = makeCliFixture('marker-reason');
		const artifact = f.patchesPath('delta/patches/' + PATCH_FILE_NAME);
		const before = readFileSync(artifact);
		const digest = createHash('sha256').update(before).digest('hex');
		const treeFile = readFileSync(f.treePath(EXAMPLE_PART_PATH));
		const treeHead = f.git(['rev-parse', 'HEAD']).stdout;
		const treeStatus = f.git(['status', '--porcelain']).stdout;
		const sourceHead = f.patchGit(['rev-parse', 'HEAD']).stdout;
		const sourceIndex = f.patchGit(['write-tree']).stdout;
		const args = [
			'marker',
			'reason',
			EXAMPLE_PART_PATH,
			'--id',
			PATCH_ID,
			'--expected-sha256',
			digest,
			'--reason',
			'not own: public metadata witness'
		];
		const preview = f.json([...args, '--dry-run']);
		expect(preview.run.status).toBe(0);
		expect(preview.envelope.data['status']).toBe('dry-run');
		expect(readFileSync(artifact)).toEqual(before);
		const apply = f.json(args);
		expect(apply.run.status).toBe(0);
		expect(apply.envelope.data['status']).toBe('updated');
		const after = readFileSync(artifact);
		expect(after.toString()).toContain('# reason: not own: public metadata witness');
		expect(f.json(args).run.status).toBe(1);
		expect(readFileSync(artifact)).toEqual(after);
		expect(readFileSync(f.treePath(EXAMPLE_PART_PATH))).toEqual(treeFile);
		expect(f.git(['rev-parse', 'HEAD']).stdout).toBe(treeHead);
		expect(f.git(['status', '--porcelain']).stdout).toBe(treeStatus);
		expect(f.patchGit(['rev-parse', 'HEAD']).stdout).toBe(sourceHead);
		expect(f.patchGit(['write-tree']).stdout).toBe(sourceIndex);
	}, 120000);
});
