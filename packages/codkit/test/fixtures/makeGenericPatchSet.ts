// The patch set of the second polygon: one sample of every layer a plain git
// upstream can have (FEAT-001 ##POLYGON-GENERIC-COVERAGE).
//
// It carries `own`, `patch`, `resource-file`, `rewrite-rule` and a
// `config-overlay` over the one JSON file the upstream has - and nothing else,
// because a type with no product model has no other layer to offer. Everything
// the type answers is declared here, in `typeConfig`: the own root, the lint and
// test commands, the overlay target, the cleanup whitelist and the manifest
// that proves the tree.
//
// The patch is a real unified diff, generated the way PROP-004 sec. 5
// prescribes and checked with `git apply` against the pin before the generator
// returns.

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ckError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit, pinDate } from './makeUpstream.ts';
import { APP_MANIFEST_PATH, LOGO_PATH, PANEL_PATH, PANEL_RENDER_ANCHOR, PANEL_TOOLBAR_ANCHOR } from './makeGenericUpstream.ts';
import type { GenericUpstreamFixture } from './makeGenericUpstream.ts';
import { assertApplies, encodePatchName, showAtPin, unifiedDiff, writeBytes, writeJson } from './patchText.ts';

export type GenericPatchSetFixture = {
	/** Absolute path of the generated pseudo-patchset repository. */
	readonly dir: string;
};

/** Ids of the artifacts the fixture carries, one per layer. */
export const PATCH_ID = 'CK-app-901';
export const OWN_UNIT_ID = 'CK-app-902';
export const RULE_ID = 'CK-app-903';
export const OVERLAY_ID = 'CK-config-901';
export const RESOURCE_ID = 'CK-config-902';

/** Name of the sample patch file (PROP-004 sec. 4, patch file name encoding). */
export const PATCH_FILE_NAME = `${encodePatchName(PANEL_PATH)}.ckpatch`;

/** The own root this patch set declares; the tree mirrors it at this path. */
export const OWN_ROOT = 'src/own';

const OWNER_APP = 'app-core';
const OWNER_CONFIG = 'config';

const FIRST_COMMIT_ISO = '2026-03-02T00:00:00Z';
const SECOND_COMMIT_ISO = '2026-03-02T00:01:00Z';

/**
 * Generate the pseudo-patchset into `dir`, pinned at `upstream.v1` and pointing
 * at `upstream.dir` as its fork tree.
 */
export function makeGenericPatchSet(dir: string, upstream: GenericUpstreamFixture): GenericPatchSetFixture {
	mkdirSync(dir, { recursive: true });

	writeJson(join(dir, 'codkit.json'), {
		codkitConfig: 2,
		pin: { tag: upstream.v1.tag, sha: upstream.v1.sha, date: pinDate(upstream.v1.dateIso) },
		upstreamAnchorCommit: upstream.anchorSha,
		type: 'generic',
		typeConfig: {
			ownRoot: OWN_ROOT,
			commands: {
				lint: ['npm run lint', 'npm run typecheck'],
				test: { command: 'npm test', ownGlobArg: '--' }
			},
			overlayTargets: [APP_MANIFEST_PATH],
			cleanupWhitelist: ['node_modules/', 'build/out/'],
			identity: { manifest: { path: APP_MANIFEST_PATH, nameField: 'name' } }
		},
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
			[OWNER_APP]: { contact: 'fixture', paths: ['src/**'] },
			[OWNER_CONFIG]: { contact: 'fixture', paths: [APP_MANIFEST_PATH, 'assets/**'] }
		}
	});

	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureCommit(dir, 'fixture patchset: config and owners', FIRST_COMMIT_ISO);

	writeLayers(dir, upstream);
	fixtureCommit(dir, 'fixture patchset: one artifact per layer a plain upstream has', SECOND_COMMIT_ISO);

	return { dir };
}

function writeLayers(dir: string, upstream: GenericUpstreamFixture): void {
	const pin = `${upstream.v1.tag}@${upstream.v1.sha}`;

	// patch layer
	writeBytes(join(dir, 'delta', 'patches', PATCH_FILE_NAME), buildSamplePatch(dir, upstream));

	// own layer: the code the patch set owns outright, plus the unit that declares it
	writeJson(join(dir, 'delta', 'own', 'patchset.delta.json'), {
		codkitOwnManifest: 2,
		units: [
			{
				id: OWN_UNIT_ID,
				layer: 'own',
				type: 'extend',
				category: 'own',
				owner: OWNER_APP,
				reason: 'fixture own-code unit: proves the own layer over an upstream with no product model',
				link: 'none',
				cause: 'none',
				pin,
				contractTests: ['fixture.generic.badge'],
				roots: ['badge.ts', 'test/']
			}
		],
		serviceOverrides: []
	});
	writeBytes(join(dir, 'delta', 'own', 'badge.ts'), OWN_BADGE_TS);
	writeBytes(join(dir, 'delta', 'own', 'test', 'badge.test.ts'), OWN_GUARD_TESTS);

	// config-overlay layer: operations over the one JSON document the upstream has
	writeJson(join(dir, 'delta', 'overlays', `${APP_MANIFEST_PATH}.overlay.json`), {
		codkitOverlay: 2,
		id: OVERLAY_ID,
		target: APP_MANIFEST_PATH,
		type: 'modify',
		category: 'own',
		owner: OWNER_CONFIG,
		reason: 'fixture identity of the patch set: the overlay layer with an upstream expectation',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.generic.manifest'],
		operations: [
			{ op: 'set', path: ['displayName'], value: 'Fixture PatchSet', expectUpstream: 'Fixture App' },
			{ op: 'set', path: ['patchsetPin'], value: { $var: 'pin.tag' }, expectUpstream: { $absent: true } }
		]
	});

	// resource-file layer: a binary target has no marker, so it needs a guard test
	writeJson(join(dir, 'delta', 'resources', 'map.json'), {
		codkitResourceMap: 2,
		entries: [
			{
				id: RESOURCE_ID,
				target: LOGO_PATH,
				source: 'delta/resources/files/logo.bin',
				type: 'modify',
				category: 'own',
				owner: OWNER_CONFIG,
				reason: 'fixture branded logo: the resource-file layer',
				link: 'none',
				cause: 'none',
				pin,
				contractTests: ['fixture.generic.logo']
			}
		]
	});
	writeBytes(
		join(dir, 'delta', 'resources', 'files', 'logo.bin'),
		new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x00, 0x01, 0x02, 0x03, 0x7f, 0x80, 0xfe, 0xff])
	);

	// rewrite-rule layer: three ops that leave a correctly closed marker block
	writeJson(join(dir, 'delta', 'rules', 'toolbar.ckrule.json'), {
		codkitRule: 2,
		id: RULE_ID,
		type: 'hook',
		category: 'follow',
		owner: OWNER_APP,
		reason: 'fixture rewrite rule: the rule layer with an expected match count',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.generic.toolbar'],
		target: PANEL_PATH,
		engine: 'line-ops',
		expectedMatches: 1,
		ops: [
			{ match: PANEL_TOOLBAR_ANCHOR, action: 'append-after', text: `\t\t// codkit:begin ${RULE_ID}` },
			{
				match: `\t\t// codkit:begin ${RULE_ID}`,
				action: 'append-after',
				text: '\t\t// (rule body lives in own/badge.ts; this block only delegates)'
			},
			{
				match: '\t\t// (rule body lives in own/badge.ts; this block only delegates)',
				action: 'append-after',
				text: `\t\t// codkit:end ${RULE_ID}`
			}
		]
	});
}

const OWN_BADGE_TS = `// Own code of the fixture patch set, mirrored into ${OWN_ROOT}/ of the tree.

export function badge(area: string): string {
	return '[' + area + ']';
}
`;

/**
 * The ids of `contractTests` are resolved by finding `suite('<id>'` in an own
 * test file. Nothing here runs under vitest - the file is content of the
 * pseudo-patchset, read as text.
 */
const OWN_GUARD_TESTS = `// The guards the fixture artifacts name in contractTests.

import { badge } from '../badge.ts';

suite('fixture.generic.badge', () => {
	test('wraps the area', () => {
		assert.strictEqual(badge('panel'), '[panel]');
	});
});

suite('fixture.generic.manifest', () => {
	test('the manifest carries the name of the patch set', () => {
		assert.strictEqual(manifest.displayName, 'Fixture PatchSet');
	});
});

suite('fixture.generic.logo', () => {
	test('the branded logo is the one the patch set ships', () => {
		assert.strictEqual(logoBytes()[0], 0xaa);
	});
});

suite('fixture.generic.toolbar', () => {
	test('the toolbar block is still generated', () => {
		assert.strictEqual(toolbarBlocks(), 1);
	});
});
`;

/**
 * Build the sample .ckpatch: header per PROP-004 sec. 4, body a normalized U3
 * diff of "the file at the pin" against "the file with the hook block".
 */
function buildSamplePatch(dir: string, upstream: GenericUpstreamFixture): string {
	const scratch = join(dir, '.codkit', 'tmp');
	mkdirSync(scratch, { recursive: true });
	try {
		const atPin = showAtPin(upstream.dir, upstream.v1.sha, PANEL_PATH);
		const withHook = insertHookBlock(atPin);
		const body = unifiedDiff(scratch, atPin, withHook, PANEL_PATH);
		const patch = patchHeader(upstream) + body;
		assertApplies(scratch, upstream.dir, upstream.v1, patch);
		return patch;
	} finally {
		rmSync(join(dir, '.codkit'), { recursive: true, force: true });
	}
}

function patchHeader(upstream: GenericUpstreamFixture): string {
	return [
		'# codkit-patch: 2',
		`# id: ${PATCH_ID}`,
		'# type: hook',
		'# category: follow',
		`# owner: ${OWNER_APP}`,
		'# reason: mount point for the fixture badge of the patch set',
		'# link: none',
		'# cause: none',
		`# pin: ${upstream.v1.tag}@${upstream.v1.sha}`,
		'# contract-tests: none',
		''
	].join('\n');
}

/** Put the three marker lines at the top of the render method's body. */
function insertHookBlock(source: string): string {
	const anchor = `${PANEL_RENDER_ANCHOR}\n`;
	if (!source.includes(anchor)) {
		throw ckError('INTERNAL', `fixture: anchor line not found in ${PANEL_PATH}`);
	}
	const block = [
		`\t\t// codkit:begin ${PATCH_ID}`,
		'\t\t// (hook body lives in own/badge.ts; this block only delegates)',
		`\t\t// codkit:end ${PATCH_ID}`,
		''
	].join('\n');
	return source.replace(anchor, anchor + block);
}
