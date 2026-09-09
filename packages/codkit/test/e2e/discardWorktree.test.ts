// e2e: `load --fresh --discard` drops working-tree edits by name (PROP-007
// ##CMD-LOAD-DISCARD-WORKTREE, acceptance scenario S59 of FEAT-002).
//
// Building the tree rewrites a tracked upstream file with an artifact of the
// build, and those bytes read exactly like a human edit: the drift guard refuses
// and used to leave a `git checkout` by hand as the only way back into dev mode.
// The flag is that way back, and every test here has to prove both halves of the
// bargain - the named path really goes back to the pin plus the delta, and
// everything the flag was not asked about is exactly as it was: a file with a
// marker block, own code, and the tree without `--fresh`.

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

/** A tracked upstream file the delta never touches: no marker block anywhere in it. */
const PLAIN_UPSTREAM = 'source/base/common/lifecycle.ts';
/** The own-code pair of the fixture: patchset source and materialized tree target. */
const OWN_IN_TREE = 'source/own/hello.ts';

/** The line a tree build leaves behind in a tracked file. */
const BUILD_ARTIFACT = '// written by the tree build, not by a human\n';

afterAll(() => {
	cleanupTempRoots();
});

function append(fixture: CliFixture, relative: string, line: string): void {
	const path = fixture.treePath(relative);
	writeFileSync(path, `${readFileSync(path, 'utf8')}${line}`, 'utf8');
}

describe('S59: a tracked upstream file with no marker block is dropped by name', () => {
	let fixture: CliFixture;
	let pristine: string;

	beforeAll(() => {
		fixture = makeCliFixture('discard-worktree');
		expect(fixture.run(['load']).status).toBe(0);
		pristine = readFileSync(fixture.treePath(PLAIN_UPSTREAM), 'utf8');
		append(fixture, PLAIN_UPSTREAM, BUILD_ARTIFACT);
	});

	it('is CK-E-DIRTY-TREE for load --fresh, which names the path and keeps the bytes', () => {
		const outcome = fixture.json(['load', '--fresh']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.data['dirtyFiles']).toContain(PLAIN_UPSTREAM);
		expect(readFileSync(fixture.treePath(PLAIN_UPSTREAM), 'utf8')).toBe(`${pristine}${BUILD_ARTIFACT}`);
	});

	it('--dry-run prints the same plan and writes nothing', () => {
		const outcome = fixture.json(['load', '--fresh', '--discard', '--dry-run']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.messages.some((message) => message.text === `discard ${PLAIN_UPSTREAM}`)).toBe(true);
		// A forecast discards nothing, so it reports nothing as discarded - and
		// the edit is still standing.
		expect(outcome.envelope.data['discardedPaths']).toEqual([]);
		expect(readFileSync(fixture.treePath(PLAIN_UPSTREAM), 'utf8')).toBe(`${pristine}${BUILD_ARTIFACT}`);
	});

	it('load --fresh --discard plans the path, drops it, and leaves own code alone', () => {
		const ownBefore = readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8');

		const outcome = fixture.json(['load', '--fresh', '--discard']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		// The plan, then the summary: what was announced is what happened (R14).
		expect(outcome.envelope.messages.some((message) => message.text === `discard ${PLAIN_UPSTREAM}`)).toBe(true);
		expect(outcome.envelope.messages.some((message) => message.text === 'discarded 1 working-tree edit(s)')).toBe(true);
		expect(outcome.envelope.data['discardedPaths']).toEqual([PLAIN_UPSTREAM]);
		// The file is back at the pin plus the delta, and nothing else moved.
		expect(readFileSync(fixture.treePath(PLAIN_UPSTREAM), 'utf8')).toBe(pristine);
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toBe(ownBefore);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toContain('codkit:begin');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
	});
});

describe('S59: a file that carries a marker block is never dropped', () => {
	let fixture: CliFixture;
	let edited: string;

	beforeAll(() => {
		fixture = makeCliFixture('discard-worktree-marker');
		expect(fixture.run(['load']).status).toBe(0);
		// Changed outside the block: the block itself is untouched, and the file
		// still carries it - which is exactly what makes the edit extractable.
		append(fixture, EXAMPLE_PART_PATH, '// a hand edit outside the codkit block\n');
		edited = readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8');
	});

	it('refuses with the path and the save recipe, and discards nothing', () => {
		const outcome = fixture.json(['load', '--fresh', '--discard']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toContain(EXAMPLE_PART_PATH);
		expect(outcome.envelope.errors[0]?.hint).toBe('this file carries a marker block: run codkit save to extract it, or move the edit out');
		// Nothing was planned and nothing was written.
		expect(outcome.envelope.messages.some((message) => message.text.startsWith('discard '))).toBe(false);
		expect(outcome.envelope.data['discardedPaths']).toEqual([]);
		expect(readFileSync(fixture.treePath(EXAMPLE_PART_PATH), 'utf8')).toBe(edited);
	});
});

describe('S59: without --fresh the flag still speaks about commits alone', () => {
	let fixture: CliFixture;
	let edited: string;

	beforeAll(() => {
		fixture = makeCliFixture('discard-worktree-no-fresh');
		expect(fixture.run(['load']).status).toBe(0);
		append(fixture, PLAIN_UPSTREAM, BUILD_ARTIFACT);
		edited = readFileSync(fixture.treePath(PLAIN_UPSTREAM), 'utf8');
	});

	it('load --discard over the same edit is CK-E-DIRTY-TREE', () => {
		const outcome = fixture.json(['load', '--discard']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.errors[0]?.message).toBe('1 path(s) in the fork tree carry changes that are not in patchset yet');
		expect(outcome.envelope.data['discardedPaths']).toEqual([]);
		expect(readFileSync(fixture.treePath(PLAIN_UPSTREAM), 'utf8')).toBe(edited);
	});
});

describe('own code is never what the flag gives up', () => {
	let fixture: CliFixture;
	let edited: string;

	beforeAll(() => {
		fixture = makeCliFixture('discard-worktree-own');
		expect(fixture.run(['load']).status).toBe(0);
		append(fixture, OWN_IN_TREE, '// edited in the tree, never extracted\n');
		edited = readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8');
	});

	it('load --fresh --discard refuses over it and preserves the bytes', () => {
		const outcome = fixture.json(['load', '--fresh', '--discard']);

		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(outcome.envelope.data['discardedPaths']).toEqual([]);
		expect(readFileSync(fixture.treePath(OWN_IN_TREE), 'utf8')).toBe(edited);
	});
});
