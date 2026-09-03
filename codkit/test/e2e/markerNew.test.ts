// e2e: `codkit marker new` - the checks it makes before it writes anything, and
// where it writes the block when it does.
// Contract: PROP-007 sec. 8 (##CMD-MARKER-NEW), marker forms PROP-004 sec. 1.

import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { writePendingHeader } from '../../src/lib/pendingHeader.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const UTIL_PATH = 'src/vs/base/common/util.ts';
const LIFECYCLE_PATH = 'src/vs/base/common/lifecycle.ts';
const CSS_PATH = 'src/vs/workbench/browser/parts/example/examplePart.css';

let fixture: CliFixture;

beforeAll(() => {
	fixture = makeCliFixture('marker-new');
	expect(fixture.run(['sync']).status).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

/** `marker new` with the four mandatory flags filled in. */
function markerNew(target: string, id: string, extra: readonly string[] = []): ReturnType<CliFixture['json']> {
	return fixture.json([
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
		'a reason',
		...extra
	]);
}

describe('codkit marker new: where the block goes', () => {
	it('inserts before --line, with the indentation of its neighbour', () => {
		const target = fixture.treePath(LIFECYCLE_PATH);
		const before = readFileSync(target, 'utf8').split('\n');
		const line = before.findIndex((text) => text === '\tprivate readonly toDispose: IDisposable[] = [];') + 1;
		expect(line).toBeGreaterThan(0);

		const outcome = markerNew(LIFECYCLE_PATH, 'CK-workbench-911', ['--line', String(line)]);

		expect(outcome.run.status).toBe(0);
		const after = readFileSync(target, 'utf8').split('\n');
		expect(after[line - 1]).toBe('\t// codkit:begin CK-workbench-911');
		expect(after[line]).toBe('\t// codkit:end CK-workbench-911');
		// Inserted before that line, not over it.
		expect(after[line + 1]).toBe('\tprivate readonly toDispose: IDisposable[] = [];');
		expect(after.length).toBe(before.length + 2);
		expect(outcome.envelope.data['line']).toBe(line);
	});

	it('uses the marker form of the file extension', () => {
		const outcome = markerNew(CSS_PATH, 'CK-workbench-912');

		expect(outcome.run.status).toBe(0);
		const text = readFileSync(fixture.treePath(CSS_PATH), 'utf8');
		expect(text).toContain('/* codkit:begin CK-workbench-912 */');
		expect(text).toContain('/* codkit:end CK-workbench-912 */');
		// Appended at the end, and the final newline of the file is preserved.
		expect(text.endsWith('/* codkit:end CK-workbench-912 */\n')).toBe(true);
	});

	it('refuses a --line past the end of the file and writes nothing', () => {
		const target = fixture.treePath(UTIL_PATH);
		const before = readFileSync(target, 'utf8');

		const outcome = markerNew(UTIL_PATH, 'CK-base-921', ['--line', '9999']);

		// What was typed is wrong, not the state of the tree: a startup failure.
		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.message).toContain('past the end');
		expect(readFileSync(target, 'utf8')).toBe(before);
	});
});

describe('codkit marker new: what it refuses', () => {
	function refusal(target: string, id: string, extra: readonly string[] = []): { code: string; message: string } {
		const outcome = markerNew(target, id, extra);
		expect(outcome.run.status).toBe(1);
		const [error] = outcome.envelope.errors;
		return { code: error?.code ?? '', message: error?.message ?? '' };
	}

	it('refuses a file that is not in the tree', () => {
		expect(refusal('src/vs/base/common/nothing.ts', 'CK-base-922').code).toBe('CK-E-FORBIDDEN-TARGET');
	});

	it('refuses a traversal to an existing file outside the tree and leaves it untouched', () => {
		const outside = join(makeTempRoot('marker-new-outside'), 'victim.ts');
		writeFileSync(outside, 'outside bytes\n', 'utf8');
		const given = relative(fixture.treeDir, outside);

		const failure = refusal(given, 'CK-base-932');
		expect(failure.code).toBe('CK-E-FORBIDDEN-TARGET');
		expect(failure.message).toContain('outside');
		expect(readFileSync(outside, 'utf8')).toBe('outside bytes\n');
	});

	it('refuses a symlink target and leaves both the tree path and external file untouched', () => {
		const target = fixture.treePath(UTIL_PATH);
		const original = readFileSync(target);
		const outside = join(makeTempRoot('marker-new-symlink-target'), 'victim.ts');
		writeFileSync(outside, 'outside bytes\n', 'utf8');
		rmSync(target);
		symlinkSync(outside, target);
		try {
			const failure = refusal(UTIL_PATH, 'CK-base-933');
			expect(failure.code).toBe('CK-E-FORBIDDEN-TARGET');
			expect(failure.message).toContain('symlink');
			expect(readFileSync(outside, 'utf8')).toBe('outside bytes\n');
		} finally {
			rmSync(target, { force: true });
			writeFileSync(target, original);
		}
	});

	it('refuses own code', () => {
		const failure = refusal('src/vs/patchset/hello.ts', 'CK-base-923');
		expect(failure.code).toBe('CK-E-FORBIDDEN-TARGET');
		expect(failure.message).toContain('own code');
	});

	it('refuses a file whose extension has no marker form', () => {
		const failure = refusal('product.json', 'CK-product-921');
		expect(failure.code).toBe('CK-E-FORBIDDEN-TARGET');
		expect(failure.message).toContain('no marker form');
	});

	it('refuses an id that does not match the pattern', () => {
		expect(refusal(UTIL_PATH, 'CK-unknownsubsystem-001').code).toBe('CK-E-MARKER-BAD-ID');
	});

	it('refuses an owner nobody declared', () => {
		const outcome = fixture.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-924',
			'--type',
			'hook',
			'--owner',
			'nobody',
			'--reason',
			'a reason'
		]);
		expect(outcome.run.status).toBe(1);
		expect(outcome.envelope.errors[0]?.code).toBe('CK-E-OWNER-UNKNOWN');
		expect(outcome.envelope.errors[0]?.hint).toContain('workbench-core');
	});

	it('refuses a type outside the vocabulary', () => {
		const outcome = fixture.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-925',
			'--type',
			'sprinkle',
			'--owner',
			'workbench-core',
			'--reason',
			'a reason'
		]);
		// A vocabulary of conventions.json, so a value outside it is a startup
		// failure like any other configuration problem.
		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.message).toContain('intervention types');
	});

	it('refuses an id that a pending draft already holds', () => {
		expect(markerNew(UTIL_PATH, 'CK-base-926').run.status).toBe(0);
		const second = refusal(CSS_PATH, 'CK-base-926');
		expect(second.code).toBe('CK-E-MARKER-DUP-ID');
		expect(second.message).toContain('pending');
	});

	it('refuses a second intervention for the same pending target without changing either file', () => {
		const current = makeCliFixture('marker-new-pending-target');
		expect(current.run(['sync']).status).toBe(0);
		const firstArgs = [
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-942',
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'first target intent'
		] as const;
		const first = current.json(firstArgs);
		expect(first.run.status, first.run.stderr).toBe(0);
		const treeBefore = readFileSync(current.treePath(UTIL_PATH));
		const pendingPath = current.patchesPath('.codkit/pending/src__vs__base__common__util.ts.json');
		const pendingBefore = readFileSync(pendingPath);
		const exactRetry = current.json(firstArgs);
		expect(exactRetry.run.status, exactRetry.run.stderr).toBe(0);
		expect(readFileSync(current.treePath(UTIL_PATH))).toEqual(treeBefore);
		expect(readFileSync(pendingPath)).toEqual(pendingBefore);

		const second = current.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-943',
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'second target intent'
		]);
		expect(second.run.status).toBe(1);
		expect(second.envelope.errors[0]?.code).toBe('CK-E-MARKER-ARTIFACT-MISMATCH');
		expect(readFileSync(current.treePath(UTIL_PATH))).toEqual(treeBefore);
		expect(readFileSync(pendingPath)).toEqual(pendingBefore);
	});

	it('refuses an id a patch in patchset already carries', () => {
		const failure = refusal(UTIL_PATH, 'CK-workbench-901');
		expect(failure.code).toBe('CK-E-MARKER-DUP-ID');
		expect(failure.message).toContain('delta/patches/');
	});

	it('refuses a different id when the target already has a patch artifact', () => {
		const failure = refusal(EXAMPLE_PART_PATH, 'CK-workbench-944');
		expect(failure.code).toBe('CK-E-MARKER-ARTIFACT-MISMATCH');
		expect(failure.message).toContain('already has patch artifact');
	});

	it('refuses an id the target file already carries', () => {
		// A block nobody recorded anywhere else: neither a patch nor a draft can
		// answer this one, only the file itself.
		const target = fixture.treePath(UTIL_PATH);
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}\n// codkit:begin CK-base-931\n// codkit:end CK-base-931\n`, 'utf8');
		try {
			const failure = refusal(UTIL_PATH, 'CK-base-931');
			expect(failure.code).toBe('CK-E-MARKER-DUP-ID');
			expect(failure.message).toContain('already carries');
		} finally {
			writeFileSync(target, before, 'utf8');
		}
	});

	it('reports a missing mandatory flag as a startup failure', () => {
		const outcome = fixture.json(['marker', 'new', UTIL_PATH, '--id', 'CK-base-927']);
		expect(outcome.run.status).toBe(2);
		expect(outcome.envelope.errors[0]?.message).toContain('--type');
	});
});

describe('--verbose diagnostics', () => {
	it('go to stderr, never to stdout (PROP-007 ##CLI-GLOBAL-FLAGS)', () => {
		const outcome = fixture.run(['status', '--verbose']);
		expect(outcome.status === 0 || outcome.status === 1).toBe(true);

		const noisy = fixture.run(['sync', '--verbose']);
		expect(noisy.stderr).toContain('git repository');
		expect(noisy.stdout).not.toContain('git repository');
		// A pending draft with no patch keeps this tree dirty, so the sync above
		// may refuse; either way its diagnostics never landed on stdout.
		expect(noisy.stdout).not.toContain('full apply');
	});

	it('keeps stdout to a single JSON document in --json mode', () => {
		const outcome = fixture.run(['where', '--json', '--verbose']);
		expect(outcome.status).toBe(0);
		expect(() => JSON.parse(outcome.stdout) as unknown).not.toThrow();
	});
});

describe('codkit marker new: the pending draft', () => {
	it('names the draft after the target and keeps it until save consumes it', () => {
		expect(existsSync(fixture.patchesPath('.codkit/pending/src__vs__base__common__util.ts.json'))).toBe(true);
		expect(existsSync(fixture.patchesPath('.codkit/pending/src__vs__workbench__browser__parts__example__examplePart.css.json'))).toBe(true);
	});

	it('records entry-module and rejects the generated-only rewrite-rule layer', () => {
		const current = makeCliFixture('marker-new-layer');
		expect(current.run(['sync']).status).toBe(0);
		const entry = current.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-940',
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'entry graft',
			'--layer',
			'entry-module'
		]);
		expect(entry.run.status, entry.run.stderr).toBe(0);
		expect(entry.envelope.data['layer']).toBe('entry-module');
		const pending = JSON.parse(readFileSync(current.patchesPath('.codkit/pending/src__vs__base__common__util.ts.json'), 'utf8')) as Record<
			string,
			unknown
		>;
		expect(pending['layer']).toBe('entry-module');

		const rejected = makeCliFixture('marker-new-rule-layer').json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-941',
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'generated only',
			'--layer',
			'rewrite-rule'
		]);
		expect(rejected.run.status).toBe(2);
		expect(rejected.envelope.errors[0]?.message).toContain('patch or entry-module');
	});

	it('finishes an exact pending intent left before the tree marker write', () => {
		const current = makeCliFixture('marker-new-resume-intent');
		expect(current.run(['sync']).status).toBe(0);
		writePendingHeader(current.patchesDir, UTIL_PATH, {
			id: 'CK-base-945',
			layer: 'patch',
			type: 'hook',
			category: 'follow',
			owner: 'workbench-core',
			reason: 'resume exact intent',
			link: 'none'
		});
		const resumed = current.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-945',
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'resume exact intent'
		]);
		expect(resumed.run.status, resumed.run.stderr).toBe(0);
		const text = readFileSync(current.treePath(UTIL_PATH), 'utf8');
		expect(text.match(/codkit:begin CK-base-945/g)).toHaveLength(1);
		expect(text.match(/codkit:end CK-base-945/g)).toHaveLength(1);
	});

	it('resumes an exact atomic tree temp left after the pending intent', () => {
		const current = makeCliFixture('marker-new-resume-temp');
		expect(current.run(['sync']).status).toBe(0);
		const target = current.treePath(UTIL_PATH);
		const before = readFileSync(target, 'utf8');
		const after = `${before}// codkit:begin CK-base-946\n// codkit:end CK-base-946\n`;
		writePendingHeader(current.patchesDir, UTIL_PATH, {
			id: 'CK-base-946',
			layer: 'patch',
			type: 'hook',
			category: 'follow',
			owner: 'workbench-core',
			reason: 'resume exact temp',
			link: 'none'
		});
		writeFileSync(`${target}.codkit-marker-new.tmp`, after, 'utf8');

		const resumed = current.json([
			'marker',
			'new',
			UTIL_PATH,
			'--id',
			'CK-base-946',
			'--type',
			'hook',
			'--owner',
			'workbench-core',
			'--reason',
			'resume exact temp'
		]);
		expect(resumed.run.status, resumed.run.stderr).toBe(0);
		expect(readFileSync(target, 'utf8')).toBe(after);
		expect(existsSync(`${target}.codkit-marker-new.tmp`)).toBe(false);
	});
});
