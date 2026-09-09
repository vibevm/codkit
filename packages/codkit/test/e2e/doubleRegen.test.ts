// The normative "double regeneration yields an empty diff" test
// (PROP-013 sec. 7 ##DOUBLE-REGEN-STEPS, invariant PROP-004 ##DOUBLE-REGEN-INVARIANT).
//
// The steps of the spec: fixture -> load -> a deterministic edit in the tree ->
// save -> record the bytes of delta/patches/* -> put the file back -> make the
// same edit again -> save -> `git diff --exit-code -- delta/` is empty and the
// mtime of the patches that did not change has not moved.
//
// "Put the file back" is a real intermediate state here, not a no-op: the first
// save rebuilds the generated branch, so a file restored to exactly what the
// branch holds would leave nothing for the second save to regenerate. The file
// is taken back to the state without the edited line (its block stays, so the
// artifact is not deleted), saved, and then edited again - which makes the
// second save regenerate the very same patch from the very same inputs. Byte
// equality with the recording is then the invariant, not a coincidence.
//
// The second half of the test does the same cycle in a completely independent
// fixture pair, on unrelated paths, and requires the same bytes: that is the
// cross-machine half of the invariant, reduced to what one machine can check.

import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const UTIL_PATH = 'source/base/common/util.ts';
const UTIL_PATCH = 'delta/patches/source__base__common__util.ts.ckpatch';
const EXAMPLE_PATCH = 'delta/patches/source__app__browser__parts__example__examplePart.ts.ckpatch';

const PROBE_ID = 'CK-base-906';
/** The deterministic line the test adds inside the block, twice. */
const PROBE_LINE = '\t// deterministic probe line for the double regeneration test';

afterAll(() => {
	cleanupTempRoots();
});

/** load, scaffold the block, and return the file content without the probe. */
function prepare(label: string): { fixture: CliFixture; withoutProbe: string } {
	const fixture = makeCliFixture(label);
	expect(fixture.run(['load']).status).toBe(0);
	const scaffold = fixture.run([
		'marker',
		'new',
		UTIL_PATH,
		'--id',
		PROBE_ID,
		'--type',
		'hook',
		'--owner',
		'shell-core',
		'--reason',
		'double regeneration probe'
	]);
	expect(scaffold.status).toBe(0);
	return { fixture, withoutProbe: readFileSync(fixture.treePath(UTIL_PATH), 'utf8') };
}

/** Put the probe line inside the block. */
function withProbe(text: string): string {
	const begin = `// codkit:begin ${PROBE_ID}`;
	const at = text.indexOf(begin);
	expect(at).toBeGreaterThan(-1);
	const endOfBegin = text.indexOf('\n', at) + 1;
	return `${text.slice(0, endOfBegin)}${PROBE_LINE}\n${text.slice(endOfBegin)}`;
}

describe('double regeneration (S16)', () => {
	it('produces the same patch bytes and leaves untouched artifacts alone', () => {
		const { fixture, withoutProbe } = prepare('double-regen');
		const target = fixture.treePath(UTIL_PATH);
		const probePatch = fixture.patchesPath(UTIL_PATCH);
		const otherPatch = fixture.patchesPath(EXAMPLE_PATCH);

		// 1. The edit, and the first save.
		writeFileSync(target, withProbe(withoutProbe), 'utf8');
		expect(fixture.run(['save', '--commit']).status).toBe(0);

		// 2. Record the artifacts.
		const recorded = readFileSync(probePatch);
		const otherBefore = statSync(otherPatch).mtimeMs;
		expect(fixture.patchGit(['diff', '--exit-code', '--', 'delta']).status).toBe(0);

		// 3. Put the file back (the block stays, so the artifact stays too).
		writeFileSync(target, withoutProbe, 'utf8');
		expect(fixture.run(['save', '--commit']).status).toBe(0);
		expect(readFileSync(probePatch).equals(recorded)).toBe(false);

		// 4. Make the same edit again.
		writeFileSync(target, withProbe(withoutProbe), 'utf8');
		expect(fixture.run(['save', '--commit']).status).toBe(0);

		// 5. The invariant: the same inputs produced the same bytes, the working
		// tree of patchset has nothing left over, and the artifact nobody touched
		// still carries its original mtime.
		expect(readFileSync(probePatch).equals(recorded)).toBe(true);
		expect(fixture.patchGit(['diff', '--exit-code', '--', 'delta']).status).toBe(0);
		expect(fixture.patchGit(['status', '--porcelain', '--', 'delta']).stdout.trim()).toBe('');
		expect(statSync(otherPatch).mtimeMs).toBe(otherBefore);
		// And the tree is exactly the branch again.
		expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
	});

	it('produces the same bytes in an unrelated fixture pair', () => {
		const first = prepare('double-regen-a');
		writeFileSync(first.fixture.treePath(UTIL_PATH), withProbe(first.withoutProbe), 'utf8');
		expect(first.fixture.run(['save']).status).toBe(0);

		const second = prepare('double-regen-b');
		writeFileSync(second.fixture.treePath(UTIL_PATH), withProbe(second.withoutProbe), 'utf8');
		expect(second.fixture.run(['save']).status).toBe(0);

		const left = readFileSync(first.fixture.patchesPath(UTIL_PATCH));
		const right = readFileSync(second.fixture.patchesPath(UTIL_PATCH));
		expect(left.equals(right)).toBe(true);
		// Not vacuously equal: the patch really carries the probe.
		expect(left.toString('utf8')).toContain(PROBE_LINE.trim());
	});
});
