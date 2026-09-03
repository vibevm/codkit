// Pseudo-patchset fixture: a delta repository with one sample of every layer
// (PROP-013 ##FIXTURE-PATCHSET).
//
// The interesting part is the patch: it is not a hand-written string but a real
// unified diff, generated the way PROP-004 sec. 5 prescribes and verified with
// `git apply --cached --check` against the pin before the generator returns. A
// fixture that only looks like a patch would let a broken engine pass.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGit } from '../../src/lib/gitx.ts';
import { ckError } from '../../src/lib/messages.ts';
import { EXAMPLE_AREA_ANCHOR, EXAMPLE_PART_PATH, EXAMPLE_TOOLBAR_ANCHOR, fixtureCommit, fixtureGit, pinDate } from './makeUpstream.ts';
import type { UpstreamFixture } from './makeUpstream.ts';

export type PatchSetFixture = {
	/** Absolute path of the generated pseudo-patchset repository. */
	readonly dir: string;
};

/** Ids of the artifacts the fixture carries, one per layer. */
export const PATCH_ID = 'CK-workbench-901';
export const OWN_UNIT_ID = 'CK-workbench-902';
export const RULE_ID = 'CK-workbench-903';
export const REMOVED_ID = 'CK-workbench-904';
export const OVERLAY_ID = 'CK-product-901';
export const RESOURCE_ID = 'CK-product-902';

/** Name of the sample patch file (PROP-004 sec. 4, patch file name encoding). */
export const PATCH_FILE_NAME = `${encodePatchName(EXAMPLE_PART_PATH)}.ckpatch`;

const OWNER_WORKBENCH = 'workbench-core';
const OWNER_PRODUCT = 'product';

const FIRST_COMMIT_ISO = '2026-01-02T00:00:00Z';
const SECOND_COMMIT_ISO = '2026-01-02T00:01:00Z';

/**
 * Generate the pseudo-patchset into `dir`, with its pin at `upstream.t1` and pointing at
 * `upstream.dir` as its fork tree (so the resolver reports source "config").
 */
export function makePatchSet(dir: string, upstream: UpstreamFixture): PatchSetFixture {
	mkdirSync(dir, { recursive: true });

	writeJson(join(dir, 'codkit.json'), {
		codkitConfig: 1,
		pin: { tag: upstream.t1.tag, sha: upstream.t1.sha, date: pinDate(upstream.t1.dateIso) },
		upstreamAnchorCommit: upstream.anchorSha,
		ownDirName: 'patchset',
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	});

	writeJson(join(dir, 'delta', 'owners.json'), {
		codkitOwners: 1,
		owners: {
			[OWNER_WORKBENCH]: { contact: 'fixture', paths: ['src/vs/workbench/**'] },
			[OWNER_PRODUCT]: { contact: 'fixture', paths: ['product.json', 'resources/**'] }
		}
	});

	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureCommit(dir, 'fixture patchset: config and owners', FIRST_COMMIT_ISO);

	writeLayers(dir, upstream);
	fixtureCommit(dir, 'fixture patchset: one artifact per delta layer', SECOND_COMMIT_ISO);

	return { dir };
}

function writeLayers(dir: string, upstream: UpstreamFixture): void {
	// patch layer
	writeBytes(join(dir, 'delta', 'patches', PATCH_FILE_NAME), buildSamplePatch(dir, upstream));

	const pin = `${upstream.t1.tag}@${upstream.t1.sha}`;

	// own layer: the code patchset owns outright, plus the unit that declares it
	writeJson(join(dir, 'delta', 'own', 'patchset.delta.json'), {
		codkitOwnManifest: 2,
		units: [
			{
				id: OWN_UNIT_ID,
				layer: 'own',
				type: 'extend',
				category: 'own',
				owner: OWNER_WORKBENCH,
				reason: 'fixture own-code unit: proves the own layer is carried end to end',
				link: 'none',
				cause: 'none',
				pin,
				contractTests: ['fixture.unit.hello'],
				roots: ['hello.ts', 'test/']
			}
		],
		serviceOverrides: []
	});
	writeBytes(join(dir, 'delta', 'own', 'hello.ts'), OWN_HELLO_TS);
	// The guard tests the fixture artifacts name in contractTests. They are
	// declarations rather than runnable tests: coverage is resolved by finding
	// the id in an own test file (PROP-010 ##CONTRACT-TESTS-MANDATE), which is
	// what the inventory and `verify` look for.
	writeBytes(join(dir, 'delta', 'own', 'test', 'fixture.test.ts'), OWN_GUARD_TESTS);

	// config-overlay layer (PROP-005 sec. 5): operations over a parsed JSON target,
	// one of them carrying a $var so the variable substitution is exercised.
	writeJson(join(dir, 'delta', 'overlays', 'product.json.overlay.json'), {
		codkitOverlay: 2,
		id: OVERLAY_ID,
		target: 'product.json',
		type: 'modify',
		category: 'own',
		owner: OWNER_PRODUCT,
		reason: 'fixture product identity: the overlay layer with an upstream expectation',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.guard.product'],
		operations: [
			{ op: 'set', path: ['nameShort'], value: 'Fixture PatchSet', expectUpstream: 'Fixture - OSS' },
			{ op: 'set', path: ['patchsetUpstreamPin'], value: { $var: 'pin.tag' }, expectUpstream: { $absent: true } }
		]
	});

	// resource-file layer: a binary target has no marker, so it needs a guard test
	writeJson(join(dir, 'delta', 'resources', 'map.json'), {
		codkitResourceMap: 2,
		entries: [
			{
				id: RESOURCE_ID,
				target: 'resources/app-icon.bin',
				source: 'delta/resources/files/app-icon.bin',
				type: 'modify',
				category: 'own',
				owner: OWNER_PRODUCT,
				reason: 'fixture branded icon: the resource-file layer',
				link: 'none',
				cause: 'none',
				pin,
				contractTests: ['fixture.guard.icon']
			}
		]
	});
	// Deliberately different bytes from the upstream icon.
	writeBytes(
		join(dir, 'delta', 'resources', 'files', 'app-icon.bin'),
		new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0x00, 0x11, 0x22, 0x33, 0x7f, 0x80, 0x01, 0x02, 0xfe, 0xfd, 0x00, 0x0a])
	);

	// rewrite-rule layer: three ops that leave a correctly closed marker block
	writeJson(join(dir, 'delta', 'rules', 'example.ckrule.json'), {
		codkitRule: 2,
		id: RULE_ID,
		type: 'hook',
		category: 'follow',
		owner: OWNER_WORKBENCH,
		reason: 'fixture rewrite rule: the rule layer with an expected match count',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.guard.rule'],
		target: EXAMPLE_PART_PATH,
		engine: 'line-ops',
		expectedMatches: 1,
		ops: [
			{ match: EXAMPLE_TOOLBAR_ANCHOR, action: 'append-after', text: `\t\t// codkit:begin ${RULE_ID}` },
			{
				match: `\t\t// codkit:begin ${RULE_ID}`,
				action: 'append-after',
				text: '\t\t// (rule body lives in patchset own code; this block only delegates)'
			},
			{
				match: '\t\t// (rule body lives in patchset own code; this block only delegates)',
				action: 'append-after',
				text: `\t\t// codkit:end ${RULE_ID}`
			}
		]
	});

	// removed-registry: a blind zone, so a contract test is mandatory
	writeJson(join(dir, 'delta', 'removed.json'), {
		codkitRemoved: 1,
		entries: [
			{
				id: REMOVED_ID,
				kind: 'setting',
				target: 'fixture.telemetry.enabled',
				how: 'default flipped in own code, never registered by the fixture workbench',
				owner: OWNER_WORKBENCH,
				reason: 'fixture removed-registry entry: nothing must re-introduce this setting',
				link: 'none',
				pin,
				contractTests: ['fixture.guard.removed']
			}
		]
	});
}

const OWN_HELLO_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture own code: lives in patchset, is copied into src/vs/patchset/ of the tree.
 *--------------------------------------------------------------------------------------------*/

export function hello(name: string): string {
	return 'hello, ' + name;
}
`;

/**
 * The ids of `contractTests` are resolved by finding `suite('<id>'` in an own
 * test file, so the fixture carries one file that declares every guard its
 * artifacts name. Nothing here runs under vitest - the file is content of the
 * pseudo-patchset, read as text.
 */
const OWN_GUARD_TESTS = `/*---------------------------------------------------------------------------------------------
 *  Fixture own tests: the guards the fixture artifacts name in contractTests.
 *--------------------------------------------------------------------------------------------*/

import { hello } from '../hello.ts';

suite('fixture.unit.hello', () => {
	test('greets by name', () => {
		assert.strictEqual(hello('world'), 'hello, world');
	});
});

suite('fixture.guard.product', () => {
	test('the product name is the fixture one', () => {
		assert.strictEqual(product.nameShort, 'Fixture PatchSet');
	});
});

suite('fixture.guard.icon', () => {
	test('the branded icon is the one patchset ships', () => {
		assert.strictEqual(iconBytes()[0], 0xff);
	});
});

suite('fixture.guard.removed', () => {
	test('the removed setting did not come back', () => {
		assert.strictEqual(settings.has('fixture.telemetry.enabled'), false);
	});
});

suite('fixture.guard.rule', () => {
	test('the toolbar block is still generated', () => {
		assert.strictEqual(toolbarBlocks(), 1);
	});
});
`;

/**
 * Build the sample .ckpatch: header per PROP-004 sec. 4, body a normalized U3
 * diff of "the file at the pin" against "the file with the hook block".
 */
function buildSamplePatch(dir: string, upstream: UpstreamFixture): string {
	const scratch = join(dir, '.codkit', 'tmp');
	mkdirSync(scratch, { recursive: true });
	try {
		const atPin = showAtPin(upstream, EXAMPLE_PART_PATH);
		const withHook = insertHookBlock(atPin);
		const body = unifiedDiff(scratch, atPin, withHook, EXAMPLE_PART_PATH);
		const patch = patchHeader(upstream) + body;
		assertApplies(scratch, upstream, patch);
		return patch;
	} finally {
		rmSync(join(dir, '.codkit'), { recursive: true, force: true });
	}
}

function patchHeader(upstream: UpstreamFixture): string {
	return [
		'# codkit-patch: 2',
		`# id: ${PATCH_ID}`,
		'# type: hook',
		'# category: follow',
		`# owner: ${OWNER_WORKBENCH}`,
		'# reason: mount point for the fixture example area host',
		'# link: none',
		'# cause: none',
		`# pin: ${upstream.t1.tag}@${upstream.t1.sha}`,
		'# contract-tests: none',
		''
	].join('\n');
}

/** The file as of the pin, read from git objects - never from the work tree. */
function showAtPin(upstream: UpstreamFixture, path: string): string {
	const result = runGit({ args: ['show', `${upstream.t1.sha}:${path}`], cwd: upstream.dir });
	if (result.status !== 0) {
		throw ckError('INTERNAL', `fixture: cannot read ${path} at ${upstream.t1.tag}: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/** Put the three marker lines at the top of the create* method body. */
function insertHookBlock(source: string): string {
	const anchor = `${EXAMPLE_AREA_ANCHOR}\n`;
	if (!source.includes(anchor)) {
		throw ckError('INTERNAL', `fixture: anchor line not found in ${EXAMPLE_PART_PATH}`);
	}
	const block = [
		`\t\t// codkit:begin ${PATCH_ID}`,
		'\t\t// (hook body lives in patchset own code; this block only delegates)',
		`\t\t// codkit:end ${PATCH_ID}`,
		''
	].join('\n');
	return source.replace(anchor, anchor + block);
}

/**
 * `git diff --no-index` with the flags of PROP-004 ##GEN-DIFF-INVOCATION, then
 * the normalization: volatile headers dropped, --- / +++ rewritten to the
 * canonical upstream path.
 */
function unifiedDiff(scratch: string, before: string, after: string, path: string): string {
	writeFileSync(join(scratch, 'a'), before, 'utf8');
	writeFileSync(join(scratch, 'b'), after, 'utf8');
	const result = runGit({
		args: [
			'-c',
			'diff.algorithm=myers',
			'-c',
			'diff.renames=false',
			'-c',
			'diff.mnemonicPrefix=false',
			'-c',
			'diff.noprefix=false',
			'diff',
			'--no-index',
			'-U3',
			'--no-color',
			'--no-ext-diff',
			'--no-textconv',
			'--',
			'a',
			'b'
		],
		cwd: scratch
	});
	// 0 = identical, 1 = differences; anything else is a real failure.
	if (result.status !== 1) {
		throw ckError('INTERNAL', `fixture: diff generation failed (status ${result.status}): ${result.stderr.trim()}`);
	}
	return normalizeDiff(result.stdout, path);
}

function normalizeDiff(raw: string, path: string): string {
	const out: string[] = [];
	let sawMinus = false;
	let sawPlus = false;
	for (const line of raw.split('\n')) {
		if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ')) {
			continue;
		}
		if (!sawMinus && line.startsWith('--- ')) {
			out.push(`--- a/${path}`);
			sawMinus = true;
			continue;
		}
		if (!sawPlus && line.startsWith('+++ ')) {
			out.push(`+++ b/${path}`);
			sawPlus = true;
			continue;
		}
		out.push(line);
	}
	if (!sawMinus || !sawPlus) {
		throw ckError('INTERNAL', 'fixture: generated diff has no file headers');
	}
	return out.join('\n');
}

/**
 * The generator refuses to hand out a patch that does not apply at the pin:
 * checked against a temporary index holding the pin's tree, so the work tree
 * of the fixture (which sits at t2) is not involved.
 */
function assertApplies(scratch: string, upstream: UpstreamFixture, patch: string): void {
	const patchFile = join(scratch, 'candidate.ckpatch');
	writeFileSync(patchFile, patch, 'utf8');
	const indexFile = join(scratch, 'pin-index');
	const env = { GIT_INDEX_FILE: indexFile };

	const read = runGit({ args: ['read-tree', upstream.t1.sha], cwd: upstream.dir, env });
	if (read.status !== 0) {
		throw ckError('INTERNAL', `fixture: cannot read the pin tree into a temporary index: ${read.stderr.trim()}`);
	}
	const check = runGit({ args: ['apply', '--cached', '--check', patchFile], cwd: upstream.dir, env });
	if (check.status !== 0) {
		throw ckError(
			'INTERNAL',
			`fixture: the generated patch does not apply at ${upstream.t1.tag}: ${check.stderr.trim()}`,
			'the fixture patch generator and makeUpstream have drifted apart'
		);
	}
}

/** `src/a/b.ts` -> `src__a__b.ts` (PROP-004 sec. 4, patch file name encoding). */
function encodePatchName(path: string): string {
	if (path.includes('__')) {
		throw ckError('INTERNAL', `fixture: path ${path} cannot be encoded as a patch name`);
	}
	return path.split('/').join('__');
}

function writeJson(absolutePath: string, value: unknown): void {
	writeBytes(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeBytes(absolutePath: string, content: string | Uint8Array): void {
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content);
}
