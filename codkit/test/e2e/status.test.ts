// e2e: `codkit status` through the real launcher.
// Contract: PROP-007 sec. 6 (##CMD-STATUS).
//
// `status` is the command a developer runs when something looks wrong, so the
// two properties tested here matter more than its wording: it never writes and
// never waits (it works while another command holds the lock), and its exit code
// says whether there is unextracted work.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { treeId } from '../../src/lib/fingerprint.ts';
import { EXAMPLE_PART_PATH } from '../fixtures/makeUpstream.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const OWN_IN_TREE = 'src/vs/patchset/hello.ts';

afterAll(() => {
	cleanupTempRoots();
});

type Section = Record<string, unknown>;

function section(data: Record<string, unknown>, name: string): Section {
	return data[name] as Section;
}

describe('codkit status: a tree that is up to date', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('status-clean');
		expect(fixture.run(['load']).status).toBe(0);
	});

	it('exits 0 and reports the branch as up to date', () => {
		const outcome = fixture.json(['status']);

		expect(outcome.run.status).toBe(0);
		expect(outcome.envelope.errors).toEqual([]);
		const branch = section(outcome.envelope.data, 'branch');
		expect(branch['name']).toBe(fixture.branch);
		expect(branch['upToDate']).toBe(true);
		expect(branch['conditionsMet']).toBe(branch['conditionsTotal']);
		expect(outcome.envelope.messages.some((message) => message.text.startsWith('branch up to date'))).toBe(true);
		expect(section(outcome.envelope.data, 'upstream')['changed']).toBe(0);
		expect(section(outcome.envelope.data, 'own')['changed']).toBe(0);
		const pin = section(outcome.envelope.data, 'pin');
		expect(pin['tag']).toBe(fixture.upstream.t1.tag);
		expect(pin['sha']).toBe(fixture.upstream.t1.sha);
	});

	it('works while another command holds the lock, and writes nothing', () => {
		const lock = fixture.patchesPath(join('.codkit', 'locks', `${treeId(fixture.treeDir)}.lock`));
		mkdirSync(dirname(lock), { recursive: true });
		writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command: 'sync' }), 'utf8');
		try {
			const outcome = fixture.json(['status']);

			expect(outcome.run.status).toBe(0);
			expect(outcome.envelope.errors).toEqual([]);
			expect(fixture.git(['status', '--porcelain']).stdout.trim()).toBe('');
		} finally {
			rmSync(lock, { force: true });
		}
	});
});

describe('codkit status: a tree with work in it', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('status-dirty');
		expect(fixture.run(['load']).status).toBe(0);
		// One upstream file changed inside its block, one own file changed in the
		// tree: the two halves of the drift guard, seen from the other side.
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		const text = readFileSync(target, 'utf8');
		const at = text.indexOf('// (hook body lives in patchset/ own code; this block only delegates)');
		writeFileSync(target, `${text.slice(0, at)}// one more line of the hook\n\t\t${text.slice(at)}`, 'utf8');
		writeFileSync(fixture.treePath(OWN_IN_TREE), '// edited in the tree\n', 'utf8');
	});

	it('exits 1 and counts what is not extracted yet', () => {
		const outcome = fixture.json(['status']);

		expect(outcome.run.status).toBe(1);
		const upstream = section(outcome.envelope.data, 'upstream');
		expect(upstream['changed']).toBe(1);
		// The file carries the block of the fixture patch, and it still parses.
		expect(upstream['markerBlocks']).toBe(1);
		expect(upstream['markerErrors']).toBe(0);
		const files = upstream['files'] as { path: string }[];
		expect(files[0]?.path).toBe(EXAMPLE_PART_PATH);

		const own = section(outcome.envelope.data, 'own');
		expect(own['changed']).toBe(1);
		expect(own['treeEdited']).toBe(1);
		expect(own['patchsetEdited']).toBe(0);
		expect(own['bothEdited']).toBe(0);

		expect(outcome.envelope.messages.some((message) => message.text.includes('codkit save'))).toBe(true);
	});

	it('counts marker errors of the changed files', () => {
		const target = fixture.treePath(EXAMPLE_PART_PATH);
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}\n// codkit:begin CK-workbench-908\n`, 'utf8');
		try {
			const outcome = fixture.json(['status']);

			expect(outcome.run.status).toBe(1);
			expect(section(outcome.envelope.data, 'upstream')['markerErrors']).toBe(1);
		} finally {
			writeFileSync(target, before, 'utf8');
		}
	});

	it('says a reload is needed when the tree is not where the cache says', () => {
		// The branch is still at the applied tip here; what moved is the delta:
		// a new pending draft does not, but an edited artifact does.
		const own = fixture.patchesPath('delta/own/hello.ts');
		const saved = readFileSync(own);
		writeFileSync(own, '// the delta moved under the tree\n', 'utf8');
		try {
			const outcome = fixture.json(['status']);

			const branch = section(outcome.envelope.data, 'branch');
			expect(branch['upToDate']).toBe(false);
			expect(Number(branch['conditionsMet'])).toBeLessThan(Number(branch['conditionsTotal']));
			expect(outcome.envelope.messages.some((message) => message.text.startsWith('reload needed'))).toBe(true);
		} finally {
			writeFileSync(own, saved);
		}
	});
});

describe('codkit status: the other direction of truth', () => {
	it('warns when delta/ is edited in patchset while the tree is clean', () => {
		const fixture = makeCliFixture('status-patchset-side');
		expect(fixture.run(['load']).status).toBe(0);
		const patch = fixture.patchesPath('delta/patches/src__vs__workbench__browser__parts__example__examplePart.ts.ckpatch');
		writeFileSync(patch, `${readFileSync(patch, 'utf8').replace('# reason: ', '# reason: edited in patchset - ')}`, 'utf8');

		const outcome = fixture.json(['status']);

		const uncommitted = section(outcome.envelope.data, 'patchset')['uncommittedDelta'] as string[];
		expect(uncommitted.length).toBeGreaterThan(0);
		expect(outcome.envelope.messages.some((message) => message.level === 'warn' && message.text.includes('direction of truth'))).toBe(true);
	});
});
