/** @scope spec://codkit/modules/codkit/PROP-008#root */

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import type { UpstreamRef } from '../fixtures/makeUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const TARGET = 'src/vs/base/common/util.ts';
const ARTIFACT = 'delta/patches/src__vs__base__common__util.ts.ckpatch';
const OTHER_ARTIFACT = 'delta/patches/src__vs__base__common__other.ts.ckpatch';
const FIRST = 'CK-base-951';
const SECOND = 'CK-base-952';

afterAll(() => cleanupTempRoots());

describe('save entry-module marker ownership', () => {
	it('allows the exact entry-module id set to share marker layout', () => {
		const fixture = makeCliFixture('save-entry-module-shared');
		// The sibling artifact is authored in patchset BEFORE the load: a patch
		// artifact that appears under a loaded tree is the moved patchset that
		// `save` refuses (##PATCHSET-MOVED-RULE), so the author-then-load order
		// is the legal shape. An add-file patch asks nothing of the pin; its id
		// is the whole point - the entry-module set shares the marker layout.
		writeFileSync(fixture.patchesPath(OTHER_ARTIFACT), siblingEntryModulePatch(fixture.upstream.t1, SECOND));
		expect(fixture.run(['load']).status).toBe(0);
		scaffold(fixture, FIRST, 'entry-module');
		writeFileSync(fixture.treePath(TARGET), fillFirst(readFileSync(fixture.treePath(TARGET), 'utf8'), FIRST), 'utf8');
		writeFileSync(fixture.treePath(TARGET), appendBlock(readFileSync(fixture.treePath(TARGET), 'utf8'), FIRST, SECOND), 'utf8');
		writeFileSync(fixture.treePath(EXAMPLE_PART_PATH), `${readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')}\n// left out\n`);

		const saved = fixture.run(['save', TARGET]);
		expect(saved.status, saved.stderr).toBe(0);
		expect(readFileSync(fixture.patchesPath(ARTIFACT), 'utf8')).toContain(`+\t// codkit:begin ${SECOND}`);
	});

	it('keeps a plain patch strict against a foreign marker id', () => {
		const fixture = makeCliFixture('save-plain-foreign-marker');
		expect(fixture.run(['load']).status).toBe(0);
		scaffold(fixture, FIRST, 'patch');
		writeFileSync(fixture.treePath(TARGET), fillFirst(readFileSync(fixture.treePath(TARGET), 'utf8'), FIRST), 'utf8');
		expect(fixture.run(['save', TARGET]).status).toBe(0);
		writeFileSync(fixture.treePath(TARGET), appendBlock(readFileSync(fixture.treePath(TARGET), 'utf8'), FIRST, SECOND), 'utf8');
		writeFileSync(fixture.treePath(EXAMPLE_PART_PATH), `${readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')}\n// left out\n`);

		const saved = fixture.run(['save', TARGET]);
		expect(saved.status).toBe(1);
		expect(saved.stderr).toContain('MARKER-ARTIFACT-MISMATCH');
	});
});

function scaffold(fixture: ReturnType<typeof makeCliFixture>, id: string, layer: 'patch' | 'entry-module'): void {
	const result = fixture.run([
		'marker',
		'new',
		TARGET,
		'--id',
		id,
		'--type',
		'hook',
		'--owner',
		'workbench-core',
		'--reason',
		'shared entry marker layout',
		'--layer',
		layer
	]);
	expect(result.status, result.stderr).toBe(0);
}

function fillFirst(text: string, id: string): string {
	const begin = `// codkit:begin ${id}`;
	const offset = text.indexOf('\n', text.indexOf(begin)) + 1;
	return `${text.slice(0, offset)}\texport const firstEntry = true;\n${text.slice(offset)}`;
}

function appendBlock(text: string, first: string, second: string): string {
	const end = `// codkit:end ${first}`;
	const offset = text.indexOf('\n', text.indexOf(end)) + 1;
	const block = `\t// codkit:begin ${second}\n\texport const secondEntry = true;\n\t// codkit:end ${second}\n`;
	return `${text.slice(0, offset)}${block}${text.slice(offset)}`;
}

/** A hand-authored sibling artifact of the entry-module layer, as a minimal add-file patch. */
function siblingEntryModulePatch(pin: UpstreamRef, id: string): string {
	return [
		'# codkit-patch: 2',
		`# id: ${id}`,
		'# layer: entry-module',
		'# type: hook',
		'# category: follow',
		'# owner: workbench-core',
		'# reason: sibling entry-module patch sharing the marker layout',
		'# link: none',
		'# cause: none',
		`# pin: ${pin.tag}@${pin.sha}`,
		'# contract-tests: none',
		'--- /dev/null',
		'+++ b/src/vs/base/common/other.ts',
		'@@ -0,0 +1,3 @@',
		`+// codkit:begin ${id}`,
		'+// the sibling entry-module body',
		`+// codkit:end ${id}`,
		''
	].join('\n');
}
