// e2e: `codkit marker new` and `codkit save` through the real launcher.
//
// Contracts under test: PROP-007 sec. 7-8 (##CMD-SAVE, ##CMD-MARKER-NEW,
// ##PENDING-HEADER-MECHANISM), PROP-008 sec. 4 (the save pseudocode and
// ##PATCHSET-SIDE-EDIT-RULE), PROP-004 sec. 4-5 (patch shape and regeneration),
// PROP-006 sec. 5 (every hunk inside a marker).
//
// The scenarios are the mini versions of S04 (a change made in the tree becomes
// an artifact in patchset) and S06 (a change outside a marker block is refused).

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_PART_PATH, STATUS_PART_PATH } from '../fixtures/makeUpstream.ts';
import { PATCH_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const UTIL_PATH = 'src/vs/base/common/util.ts';
const UTIL_PATCH = 'delta/patches/src__vs__base__common__util.ts.ckpatch';
const UTIL_PENDING = '.codkit/pending/src__vs__base__common__util.ts.json';
const EXAMPLE_PATCH = 'delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch';
const OWN_IN_TREE = 'src/vs/patchset/hello.ts';
const OWN_IN_PATCHSET = 'delta/own/hello.ts';

const HOOK_ID = 'CK-base-905';
const HOOK_LINE = '\t// the hook body lives in patchset own code';

afterAll(() => {
	cleanupTempRoots();
});

/** Put a line inside the block the scaffold left in `text`. */
function fillBlock(text: string, id: string, line: string): string {
	const begin = `// codkit:begin ${id}`;
	const at = text.indexOf(begin);
	if (at === -1) {
		throw new Error(`the block ${id} is not in the file`);
	}
	const endOfBegin = text.indexOf('\n', at) + 1;
	return `${text.slice(0, endOfBegin)}${line}\n${text.slice(endOfBegin)}`;
}

function headerOf(patch: string): Map<string, string> {
	const fields = new Map<string, string>();
	for (const line of patch.split('\n')) {
		if (!line.startsWith('# ')) {
			break;
		}
		const at = line.indexOf(': ');
		fields.set(line.slice(2, at), line.slice(at + 2));
	}
	return fields;
}

describe('codkit save: the round trip of one change (S04)', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('save-cycle');
		expect(fixture.run(['load']).status).toBe(0);
	});

	it('scaffolds a marker block and leaves a pending header', () => {
		const outcome = fixture.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			HOOK_ID,
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'test hook'
		]);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data['id']).toBe(HOOK_ID);
		const inTree = readFileSync(fixture.treePath(UTIL_PATH), 'utf8');
		expect(inTree).toContain(`// codkit:begin ${HOOK_ID}`);
		expect(inTree).toContain(`// codkit:end ${HOOK_ID}`);
		// The draft carries the metadata of the future patch, in header order.
		const pending = JSON.parse(readFileSync(fixture.patchesPath(UTIL_PENDING), 'utf8')) as Record<string, string>;
		expect(Object.keys(pending)).toEqual(['id', 'layer', 'type', 'category', 'owner', 'reason', 'link']);
		expect(pending['layer']).toBe('patch');
		expect(pending['category']).toBe('follow');
		expect(pending['reason']).toBe('test hook');
	});

	it('refuses an id that is already used', () => {
		const outcome = fixture.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			PATCH_ID,
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'x'
		]);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-MARKER-DUP-ID');
		expect(outcome.envelope.errors[0]?.message).toContain('id already used');
	});

	it('extracts the filled block into a patch and commits it', () => {
		const target = fixture.treePath(UTIL_PATH);
		writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), HOOK_ID, HOOK_LINE), 'utf8');

		const outcome = fixture.json(['save', '--commit']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data['status']).toBe('saved');

		// The artifact exists and carries the header of the draft.
		const patch = readFileSync(fixture.patchesPath(UTIL_PATCH), 'utf8');
		const header = headerOf(patch);
		expect(header.get('id')).toBe(HOOK_ID);
		expect(header.get('type')).toBe('hook');
		expect(header.get('owner')).toBe('workbench-core');
		expect(header.get('reason')).toBe('test hook');
		expect(header.get('category')).toBe('follow');
		expect(header.get('link')).toBe('none');
		expect(header.get('cause')).toBe('none');
		expect(header.get('contract-tests')).toBe('none');
		expect(header.get('pin')).toBe(`${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`);
		expect(patch).toContain(`--- a/${UTIL_PATH}`);
		expect(patch).toContain(HOOK_LINE);

		// The draft is consumed.
		expect(existsSync(fixture.patchesPath(UTIL_PENDING))).toBe(false);
	});

	it('commits only delta/ paths in patchset, with the message of the contract', () => {
		const subject = fixture.patchGit(['log', '-1', '--format=%s']).stdout.trim();
		expect(subject).toBe('codkit save: 1 file(s)');
		const touched = fixture.patchGit(['show', '--name-only', '--format=', 'HEAD']).stdout.trim().split('\n');
		expect(touched).toEqual([UTIL_PATCH]);
	});

	it('leaves the tree clean and on the generated branch', () => {
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
		expect(fixture.git(['symbolic-ref', 'HEAD']).stdout.trim()).toBe(`refs/heads/${fixture.branch}`);
		// The branch carries the block, so a later load reproduces the tree.
		expect(fixture.git(['show', `HEAD:${UTIL_PATH}`]).stdout).toContain(HOOK_LINE);
	});

	it('removes the artifact when the file goes back to the pin', () => {
		const atPin = fixture.git(['show', `${fixture.upstream.t1.sha}:${UTIL_PATH}`]).stdout;
		writeFileSync(fixture.treePath(UTIL_PATH), atPin, 'utf8');

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(0);
		expect(existsSync(fixture.patchesPath(UTIL_PATCH))).toBe(false);
		expect(outcome.envelope.messages.some((message) => message.text.includes('back at the pin'))).toBe(true);
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');

		// Put the block back for the idempotency case below.
		expect(
			fixture.run(['marker', 'new', UTIL_PATH, '--id', HOOK_ID, '--type', 'hook', '--owner', 'workbench-core', '--reason', 'test hook'])
				.status
		).toBe(0);
		const target = fixture.treePath(UTIL_PATH);
		writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), HOOK_ID, HOOK_LINE), 'utf8');
		const back = fixture.json(['save', '--commit']);
		expect(back.run.status).toBe(0);
		// The patch came back byte for byte, so there is nothing left for the
		// commit to record - and an empty commit is not an error.
		expect(back.envelope.messages.some((message) => message.text.startsWith('nothing to commit'))).toBe(true);
		expect(fixture.patchGit(['status', '--porcelain', '--', 'delta']).stdout.trim()).toBe('');
	});

	it('is a no-op the second time and does not touch the artifacts', () => {
		const path = fixture.patchesPath(UTIL_PATCH);
		const before = readFileSync(path);
		const mtimeBefore = statSync(path).mtimeMs;

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.data['status']).toBe('nothing');
		expect(outcome.envelope.messages.some((message) => message.text === 'nothing to save')).toBe(true);
		expect(readFileSync(path).equals(before)).toBe(true);
		expect(statSync(path).mtimeMs).toBe(mtimeBefore);
	});
});

describe('codkit save: entry-module attribution', () => {
	it('carries the pending layer into the new patch header', () => {
		const fixture = makeCliFixture('save-entry-module');
		expect(fixture.run(['load']).status).toBe(0);
		const id = 'CK-base-940';
		const scaffold = fixture.run([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			id,
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'entry graft',
			'--layer',
			'entry-module'
		]);
		expect(scaffold.status, scaffold.stderr).toBe(0);
		const target = fixture.treePath(UTIL_PATH);
		writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), id, '\t// entry graft body'), 'utf8');
		const saved = fixture.json(['save']);
		expect(saved.run.status, saved.run.stderr).toBe(0);
		expect(headerOf(readFileSync(fixture.patchesPath(UTIL_PATCH), 'utf8')).get('layer')).toBe('entry-module');
	});

	it('accepts marker ids declared by other entry-module artifacts', () => {
		const fixture = makeCliFixture('save-entry-module-shared-markers');
		expect(fixture.run(['load']).status).toBe(0);
		const first = 'CK-base-942';
		const second = 'CK-workbench-942';
		for (const [target, id] of [
			[UTIL_PATH, first],
			[STATUS_PART_PATH, second]
		] as const) {
			const scaffold = fixture.run([
				'marker',
				'new',
				target,
				'--id',
				id,
				'--type',
				'hook',
				'--owner',
				'workbench-core',
				'--reason',
				'shared entry markers',
				'--layer',
				'entry-module'
			]);
			expect(scaffold.status, scaffold.stderr).toBe(0);
			const path = fixture.treePath(target);
			writeFileSync(path, fillBlock(readFileSync(path, 'utf8'), id, `\t// body for ${id}`), 'utf8');
		}
		const secondSave = fixture.json(['save', STATUS_PART_PATH]);
		expect(secondSave.run.status, secondSave.run.stderr).toBe(0);

		const firstPath = fixture.treePath(UTIL_PATH);
		writeFileSync(
			firstPath,
			`${readFileSync(firstPath, 'utf8')}// codkit:begin ${second}\n// shared entry marker\n// codkit:end ${second}\n`,
			'utf8'
		);
		const firstSave = fixture.json(['save', UTIL_PATH]);
		expect(firstSave.run.status, firstSave.run.stderr).toBe(0);
		expect(headerOf(readFileSync(fixture.patchesPath(UTIL_PATCH), 'utf8')).get('layer')).toBe('entry-module');
	});
});

describe('codkit save: a change outside a marker block (S06)', () => {
	it('exits 1, names the file and leaves the patch byte for byte as it was', () => {
		const fixture = makeCliFixture('save-outside');
		expect(fixture.run(['load']).status).toBe(0);
		const patchPath = fixture.patchesPath(EXAMPLE_PATCH);
		const before = readFileSync(patchPath);
		const mtimeBefore = statSync(patchPath).mtimeMs;

		const target = fixture.treePath(EXAMPLE_PART_PATH);
		writeFileSync(target, `${readFileSync(target, 'utf8')}\n// an edit outside every block\n`, 'utf8');

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(1);
		const [error] = outcome.envelope.errors;
		expect(error?.code).toBe('CK-E-HUNK-OUTSIDE-MARKER');
		expect(error?.file).toBe(EXAMPLE_PATCH);
		expect(error?.message).toMatch(/target line \d+/);
		expect(readFileSync(patchPath).equals(before)).toBe(true);
		expect(statSync(patchPath).mtimeMs).toBe(mtimeBefore);
	});
});

describe('codkit save: things that are not a patch', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('save-refusals');
		expect(fixture.run(['load']).status).toBe(0);
	});

	it('refuses to record the deletion of an upstream file', () => {
		const victim = 'src/vs/base/common/lifecycle.ts';
		rmSync(fixture.treePath(victim));
		try {
			const outcome = fixture.json(['save']);

			expect(outcome.run.status).toBe(1);
			const [error] = outcome.envelope.errors;
			expect(error?.code).toBe('CK-E-DELETES-UPSTREAM-FILE');
			expect(error?.file).toBe(victim);
			expect(error?.hint).toContain('delta/removed.json');
		} finally {
			fixture.git(['checkout', '--', victim]);
		}
	});

	it('refuses a new file in the upstream zone until it is allowed explicitly', () => {
		const newFile = 'src/vs/workbench/browser/parts/example/exampleExtra.ts';
		writeFileSync(fixture.treePath(newFile), '// a file that does not exist at the pin\n', 'utf8');
		try {
			const refused = fixture.json(['save']);

			expect(refused.run.status).toBe(1);
			const [error] = refused.envelope.errors;
			expect(error?.code).toBe('CK-E-NEW-FILE-IN-UPSTREAM-ZONE');
			expect(error?.hint).toContain('--allow-new-file');
			expect(existsSync(fixture.patchesPath(`delta/patches/${newFile.split('/').join('__')}.ckpatch`))).toBe(false);
		} finally {
			rmSync(fixture.treePath(newFile));
		}
	});

	it('refuses a marker block that is never closed', () => {
		const target = fixture.treePath(UTIL_PATH);
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}\n// codkit:begin CK-base-909\n`, 'utf8');
		try {
			const outcome = fixture.json(['save']);

			expect(outcome.run.status).toBe(1);
			expect(outcome.envelope.errors[0]?.code).toBe('CK-E-MARKER-UNCLOSED');
			expect(outcome.envelope.errors[0]?.file).toBe(UTIL_PATH);
		} finally {
			writeFileSync(target, before, 'utf8');
		}
	});

	it('refuses a changed file that no patch and no draft describes', () => {
		const target = fixture.treePath(UTIL_PATH);
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}// a line nobody scaffolded\n`, 'utf8');
		try {
			const outcome = fixture.json(['save']);

			expect(outcome.run.status).toBe(1);
			expect(outcome.envelope.errors[0]?.code).toBe('CK-E-HEADER-MISSING');
			expect(outcome.envelope.errors[0]?.hint).toContain('marker new');
		} finally {
			writeFileSync(target, before, 'utf8');
		}
	});
});

describe('codkit save <paths>', () => {
	it('extracts only the given paths and leaves the branch alone until the rest follows', () => {
		const fixture = makeCliFixture('save-addressed');
		expect(fixture.run(['load']).status).toBe(0);

		// Two independent changes: one in a file with a patch, one in a file that
		// is about to get its first patch.
		const example = fixture.treePath(EXAMPLE_PART_PATH);
		const exampleText = readFileSync(example, 'utf8');
		const at = exampleText.indexOf('// (hook body lives in patchset own code; this block only delegates)');
		writeFileSync(example, `${exampleText.slice(0, at)}// one more line\n\t\t${exampleText.slice(at)}`, 'utf8');

		expect(
			fixture.run(['marker', 'new', UTIL_PATH, '--id', HOOK_ID, '--type', 'hook', '--owner', 'workbench-core', '--reason', 'test hook'])
				.status
		).toBe(0);
		const util = fixture.treePath(UTIL_PATH);
		writeFileSync(util, fillBlock(readFileSync(util, 'utf8'), HOOK_ID, HOOK_LINE), 'utf8');

		const examplePatchBefore = readFileSync(fixture.patchesPath(EXAMPLE_PATCH));
		const outcome = fixture.json(['save', UTIL_PATH, '--commit', '--message', 'delta: the hook only']);

		expect(outcome.run.status).toBe(0);
		expect(existsSync(fixture.patchesPath(UTIL_PATCH))).toBe(true);
		// --message replaces the generated subject.
		expect(fixture.patchGit(['log', '-1', '--format=%s']).stdout.trim()).toBe('delta: the hook only');
		expect(fixture.patchGit(['show', '--name-only', '--format=', 'HEAD']).stdout.trim()).toBe(UTIL_PATCH);
		// The file that was not addressed kept its artifact and its edit.
		expect(readFileSync(fixture.patchesPath(EXAMPLE_PATCH)).equals(examplePatchBefore)).toBe(true);
		expect(readFileSync(example, 'utf8')).toContain('// one more line');
		expect(outcome.envelope.messages.some((message) => message.level === 'warn' && message.text.includes('outside the paths'))).toBe(true);

		// And a save without paths finishes the job.
		const rest = fixture.json(['save']);
		expect(rest.run.status).toBe(0);
		expect(readFileSync(fixture.patchesPath(EXAMPLE_PATCH)).equals(examplePatchBefore)).toBe(false);
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
	});
});

describe('codkit save --allow-new-file', () => {
	it('writes an add-file patch for a file that has to live in the upstream zone', () => {
		const fixture = makeCliFixture('save-add-file');
		expect(fixture.run(['load']).status).toBe(0);

		const newFile = 'src/vs/workbench/browser/parts/example/exampleExtra.ts';
		const artifact = `delta/patches/${newFile.split('/').join('__')}.ckpatch`;
		writeFileSync(fixture.treePath(newFile), '// a resource that must sit at this exact path\n', 'utf8');

		const scaffold = fixture.run([
			'marker',
			'new',
			newFile,
			'--id',
			'CK-workbench-907',
			'--type',
			'extend',
			'--owner',
			'workbench-core',
			'--reason',
			'a file that must live in the upstream zone'
		]);
		expect(scaffold.status).toBe(0);
		const target = fixture.treePath(newFile);
		writeFileSync(target, fillBlock(readFileSync(target, 'utf8'), 'CK-workbench-907', '// the body of the new file'), 'utf8');

		const outcome = fixture.json(['save', '--allow-new-file', newFile]);

		expect(outcome.run.status).toBe(0);
		const patch = readFileSync(fixture.patchesPath(artifact), 'utf8');
		expect(patch).toContain('--- /dev/null');
		expect(patch).toContain(`+++ b/${newFile}`);
		expect(patch).toMatch(/@@ -0,0 \+1,\d+ @@/);
		expect(headerOf(patch).get('id')).toBe('CK-workbench-907');
		// The file is part of the generated branch now, and the tree is clean.
		expect(fixture.git(['show', `HEAD:${newFile}`]).stdout).toContain('the body of the new file');
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
	});
});

describe('codkit save: own code', () => {
	it('keeps the patchset version of a file only patchset changed', () => {
		const fixture = makeCliFixture('save-own-patchset');
		expect(fixture.run(['load']).status).toBe(0);
		const inPatchSet = fixture.patchesPath(OWN_IN_PATCHSET);
		const edited = '// edited in patchset, not in the tree\nexport function hello(name: string): string {\n\treturn name;\n}\n';
		writeFileSync(inPatchSet, edited, 'utf8');

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(0);
		// save must never let an out-of-date tree overwrite work that is only in
		// patchset: there is nothing to extract here, and the file stays as patchset
		// has it. The next load is what materializes it in the tree.
		expect(readFileSync(inPatchSet, 'utf8')).toBe(edited);
		expect((outcome.envelope.data['own'] as Record<string, number>)['kept']).toBe(1);

		expect(fixture.run(['load']).status).toBe(0);
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toBe(edited);
	});

	it('extracts a file the tree changed', () => {
		const fixture = makeCliFixture('save-own-tree');
		expect(fixture.run(['load']).status).toBe(0);
		const edited = '// edited in the tree\nexport function hello(name: string): string {\n\treturn name;\n}\n';
		writeFileSync(fixture.treePath(OWN_IN_TREE), edited, 'utf8');

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(0);
		expect(readFileSync(fixture.patchesPath(OWN_IN_PATCHSET), 'utf8')).toBe(edited);
		expect((outcome.envelope.data['own'] as Record<string, number>)['extracted']).toBe(1);
	});

	it('refuses to choose when both sides edited the same file', () => {
		const fixture = makeCliFixture('save-own-both');
		expect(fixture.run(['load']).status).toBe(0);
		writeFileSync(fixture.patchesPath(OWN_IN_PATCHSET), '// the patchset version\n', 'utf8');
		writeFileSync(fixture.treePath(OWN_IN_TREE), '// the tree version\n', 'utf8');

		const outcome = fixture.json(['save']);

		expect(outcome.run.status).toBe(1);
		const [error] = outcome.envelope.errors;
		expect(error?.code).toBe('CK-E-BOTH-SIDES-EDITED');
		// The file the two sides disagree on is the location of the diagnostic.
		expect(error?.file).toBe(OWN_IN_PATCHSET);
		expect(error?.hint).toContain('resolve manually');
		// Neither side was touched.
		expect(readFileSync(fixture.patchesPath(OWN_IN_PATCHSET), 'utf8')).toBe('// the patchset version\n');
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toBe('// the tree version\n');
	});
});

describe('codkit save: an artifact of a layer save does not extract', () => {
	const CSS_TARGET = 'src/vs/workbench/browser/parts/status/statusPart.css';
	const CSS_SOURCE = 'delta/resources/files/statusPart.css';
	const BRANDED_CSS = '/* the status bar patchset ships instead of the upstream one */\n.fixture-status-bar {\n\tdisplay: none;\n}\n';

	it('materializes a hand-written resource instead of stopping at its own assertion', () => {
		const fixture = makeCliFixture('save-resource');
		expect(fixture.run(['load']).status).toBe(0);

		// The procedure for a resource: write the artifact into delta/resources/ by
		// hand, and let a run put it into the tree. Here that run is `save`, which
		// rebuilds the branch right after extracting the work of the tree.
		const mapPath = fixture.patchesPath('delta/resources/map.json');
		const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { entries: Record<string, unknown>[] };
		map.entries.push({
			id: 'CK-product-903',
			target: CSS_TARGET,
			source: CSS_SOURCE,
			type: 'modify',
			category: 'own',
			owner: 'workbench-core',
			reason: 'fixture status bar: a resource written by hand between two saves',
			link: 'none',
			cause: 'none',
			pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
			contractTests: ['fixture.guard.statusbar']
		});
		writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
		writeFileSync(fixture.patchesPath(CSS_SOURCE), BRANDED_CSS, 'utf8');

		// ...and one change of the kind `save` does extract.
		const edited = '// edited in the tree\nexport function hello(name: string): string {\n\treturn name;\n}\n';
		writeFileSync(fixture.treePath(OWN_IN_TREE), edited, 'utf8');

		const outcome = fixture.json(['save', '--commit']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		expect(outcome.envelope.data['status']).toBe('saved');
		// The one file the rebuild had to write is explained by the artifact that
		// asked for it, and is said out loud rather than passed over.
		expect(outcome.envelope.messages.some((message) => message.text.startsWith('reconciled ') && message.text.includes(CSS_TARGET))).toBe(
			true
		);

		// The resource is in the tree, and on the branch, as patchset has it.
		expect(readFileSync(fixture.treePath(CSS_TARGET), 'utf8')).toBe(BRANDED_CSS);
		expect(fixture.git(['show', `HEAD:${CSS_TARGET}`]).stdout).toBe(BRANDED_CSS);

		// --commit was not skipped: the work `save` extracted is committed.
		expect(outcome.envelope.data['commit']).toMatch(/^[0-9a-f]{40}$/);
		expect(fixture.patchGit(['show', '--name-only', '--format=', 'HEAD']).stdout.trim()).toBe(OWN_IN_PATCHSET);
		expect(readFileSync(fixture.patchesPath(OWN_IN_PATCHSET), 'utf8')).toBe(edited);

		// And there is nothing left over: the tree is clean and the next save has
		// nothing to do.
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
		const again = fixture.json(['save']);
		expect(again.run.status).toBe(0);
		expect(again.envelope.data['status']).toBe('nothing');
		expect(again.envelope.messages.some((message) => message.text === 'nothing to save')).toBe(true);
	});
});

describe('codkit load: own code edited in patchset', () => {
	it('warns and applies the patchset version (##PATCHSET-SIDE-EDIT-RULE)', () => {
		const fixture = makeCliFixture('sync-patchset-side');
		expect(fixture.run(['load']).status).toBe(0);
		const edited = '// the patchset side moved\nexport function hello(name: string): string {\n\treturn name;\n}\n';
		writeFileSync(fixture.patchesPath(OWN_IN_PATCHSET), edited, 'utf8');

		const outcome = fixture.json(['load']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.messages.some((message) => message.code === 'CK-W-PATCHSET-SIDE-EDIT')).toBe(true);
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toBe(edited);
	});

	it('refuses when both sides moved', () => {
		const fixture = makeCliFixture('sync-both-sides');
		expect(fixture.run(['load']).status).toBe(0);
		writeFileSync(fixture.patchesPath(OWN_IN_PATCHSET), '// the patchset version\n', 'utf8');
		writeFileSync(fixture.treePath(OWN_IN_TREE), '// the tree version\n', 'utf8');

		const outcome = fixture.json(['load']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-BOTH-SIDES-EDITED');
	});
});
