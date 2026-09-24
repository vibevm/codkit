// A fork tree whose checkout writes CRLF, and a delta that writes every kind of
// file a load materializes (PROP-002 ##GIT-ENV-EOL, PROP-008
// ##WORKTREE-DELTA-BYTES).
//
// The pseudo-upstream declares its text files the way upstream VS Code does -
// `* text=auto`, and CRLF for `*.cmd` - and ships the templates a Linux package
// is built from. The fork tree is one where a checkout writes CRLF: on Windows
// by the platform's own `core.eol` (`native`), on every other OS by the tree's
// configuration saying what `native` says there, so the fixture reproduces the
// reported tree wherever it runs. The patch set replaces the Linux templates
// and a Windows launcher, patches a source file and overlays the manifest, all
// with LF bytes.

import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { loadConfig } from '../../src/lib/configFile.ts';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import { runGit, runGitBytes } from '../../src/lib/gitx.ts';
import type { GitResult } from '../../src/lib/gitx.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import { formatPatchHeader } from '../../src/lib/patchFormat.ts';
import { runSync } from '../../src/lib/syncEngine.ts';
import type { SyncResult } from '../../src/lib/syncEngine.ts';
import { fixtureCommit, fixtureGit, pinDate, writeFingerprintFiles } from '../fixtures/makeUpstream.ts';
import { encodePatchName, unifiedDiff, writeBytes, writeJson } from '../fixtures/patchText.ts';
import { STUB_OWN_ROOT, STUB_TYPE_ID, projectType as stubProjectType } from '../fixtures/stubType.ts';
import { runCli, withStubType } from './cliFixture.ts';
import type { Run } from './cliFixture.ts';
import { makeTempRoot } from './tmp.ts';

/** The templates a Linux package of this layout is built from. */
export const LINUX_INPUTS: readonly string[] = [
	'resources/linux/app.desktop',
	'resources/linux/debian/control.template',
	'resources/linux/rpm/app.spec.template'
];
/** A launcher upstream wants CRLF for (`*.cmd eol=crlf`); the patch set ships it with LF. */
export const LAUNCHER = 'resources/win32/bin/app.cmd';
/** The source file the patch of the delta changes. */
export const PATCHED = 'source/app/main.ts';
/** The overlay target: a development tree keeps the pin's file there. */
export const MANIFEST = 'manifest.json';
/** Every file the delta writes, in path order. */
export const DELTA_FILES: readonly string[] = [...LINUX_INPUTS, LAUNCHER, MANIFEST, PATCHED].sort();

const PATCH_ID = 'CK-shell-911';
const OWNER = 'product';
const MAIN_AT_PIN = 'export function main(): void {\n\tstart();\n}\n\nfunction start(): void {}\n';

const UPSTREAM_FILES: Readonly<Record<string, string>> = {
	'.gitattributes': '* text=auto\n*.cmd eol=crlf\n',
	'.gitignore': 'manifest.overrides.json\n',
	[PATCHED]: MAIN_AT_PIN,
	'resources/linux/app.desktop': '[Desktop Entry]\nName=Upstream\nExec=/usr/share/upstream/upstream %F\n',
	'resources/linux/debian/control.template': 'Package: @@NAME@@\nVersion: @@VERSION@@\nDescription: upstream\n',
	'resources/linux/rpm/app.spec.template': 'Name: @@NAME@@\nVersion: @@VERSION@@\nSummary: upstream\n',
	[LAUNCHER]: '@echo off\nupstream.exe %*\n'
};

/** What the patch set ships for each resource target: LF throughout. */
const RESOURCE_FILES: Readonly<Record<string, string>> = {
	'resources/linux/app.desktop': '[Desktop Entry]\nName=Fixture Product\nExec=/usr/share/fixture/fixture %F\nIcon=fixture\n',
	'resources/linux/debian/control.template': 'Package: @@NAME@@\nVersion: @@VERSION@@\nMaintainer: fixture\nDescription: fixture product\n',
	'resources/linux/rpm/app.spec.template': 'Name: @@NAME@@\nVersion: @@VERSION@@\nLicense: fixture\nSummary: fixture product\n',
	[LAUNCHER]: '@echo off\nfixture.exe %*\n'
};

export type EolFixture = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly config: CodkitConfig;
	/** One in-process `load`; its output lands in `messages`. */
	readonly sync: () => SyncResult;
	readonly messages: string[];
	/** The real CLI against this pair, --patches-dir and --fork-dir given. */
	readonly cli: (args: readonly string[]) => Run;
	/** git in the fork tree, through the wrapper. */
	readonly git: (args: readonly string[]) => GitResult;
	/** The bytes of a file in the working copy of the fork tree. */
	readonly treeBytes: (path: string) => Buffer;
	/** The blob of a path at HEAD of the fork tree: what codkit stored there. */
	readonly tipBytes: (path: string) => Buffer;
	/** The bytes the patch set holds for a resource target. */
	readonly resourceBytes: (path: string) => Buffer;
	readonly treePath: (path: string) => string;
};

export function makeEolFixture(label: string): EolFixture {
	const upstreamDir = makeTempRoot(`${label}-upstream`);
	fixtureGit(upstreamDir, ['init', '--quiet', '--initial-branch=main', '.']);
	writeFingerprintFiles(upstreamDir);
	for (const [path, text] of Object.entries(UPSTREAM_FILES)) {
		writeBytes(join(upstreamDir, ...path.split('/')), text);
	}
	const pinDateIso = '2026-01-01T00:00:00Z';
	const pinSha = fixtureCommit(upstreamDir, 'fixture: an upstream that declares its text files', pinDateIso);
	fixtureGit(upstreamDir, ['tag', 't1']);

	const patchesDir = makeTempRoot(`${label}-patchset`);
	writePatchSet(patchesDir, pinSha, pinDate(pinDateIso));

	const treeDir = join(makeTempRoot(`${label}-tree`), 'fork-tree');
	mkdirSync(dirname(treeDir), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', upstreamDir, treeDir], cwd: dirname(treeDir), netAllowed: true });
	if (process.platform !== 'win32') {
		// What `native` means on Windows: a checkout writes CRLF for a text file.
		runGit({ args: ['config', '--local', 'core.eol', 'crlf'], cwd: treeDir });
	}
	// The tree as git on Windows checked it out, whoever made it: every text file
	// CRLF over its LF blob. The flag after the wrapper's own `core.eol` wins.
	runGit({ args: ['-c', 'core.eol=crlf', 'checkout', '--quiet', '--detach', pinSha], cwd: treeDir });

	const config = loadConfig(patchesDir);
	if (config === null) {
		throw new Error('the line-ending fixture patch set has no codkit.json');
	}
	const resolution: ForkDirResolution = { path: treeDir, source: 'flag', exists: true, warning: null };
	const messages: string[] = [];
	const out = new Output({
		command: 'load',
		version: '0.0.0',
		jsonMode: false,
		streams: {
			writeOut: (chunk) => messages.push(chunk.trimEnd()),
			writeErr: (chunk) => messages.push(chunk.trimEnd())
		}
	});
	const treePath = (path: string): string => join(treeDir, ...path.split('/'));

	return {
		patchesDir,
		treeDir,
		config,
		messages,
		sync: () => runSync({ patchesDir, resolution, config, type: stubProjectType, out, fresh: false, dryRun: false, verbose: false }),
		cli: (args) => runCli(patchesDir, ['--patches-dir', patchesDir, '--fork-dir', treeDir, ...args], withStubType()),
		git: (args) => runGit({ args, cwd: treeDir }),
		treeBytes: (path) => readFileSync(treePath(path)),
		tipBytes: (path) => {
			const blob = runGitBytes({ args: ['cat-file', 'blob', `HEAD:${path}`], cwd: treeDir });
			if (blob.status !== 0) {
				throw new Error(`no blob for ${path} at HEAD: ${blob.stderr}`);
			}
			return Buffer.from(blob.stdout);
		},
		resourceBytes: (path) => Buffer.from(RESOURCE_FILES[path] ?? '', 'utf8'),
		treePath
	};
}

/**
 * Write the given files of the fork tree the way a checkout wrote them before
 * codkit pinned the line ending: CRLF over the LF blob of a text file. Git
 * itself calls every such file unchanged.
 */
export function convertLikeAnOldCheckout(fixture: EolFixture, paths: readonly string[]): void {
	for (const path of paths) {
		rmSync(fixture.treePath(path));
	}
	// The flag after the wrapper's own `core.eol=lf` wins, as `native` did on Windows.
	const checkout = fixture.git(['-c', 'core.eol=crlf', 'checkout', 'HEAD', '--', ...paths]);
	if (checkout.status !== 0) {
		throw new Error(`cannot check out ${paths.join(', ')} with CRLF: ${checkout.stderr}`);
	}
}

function writePatchSet(patchesDir: string, pinSha: string, date: string): void {
	const pin = `t1@${pinSha}`;
	writeJson(join(patchesDir, 'codkit.json'), {
		codkitConfig: 2,
		pin: { tag: 't1', sha: pinSha, date },
		upstreamAnchorCommit: pinSha,
		type: STUB_TYPE_ID,
		typeConfig: { ownRoot: STUB_OWN_ROOT },
		generatedBranchPrefix: 'codkit/applied/',
		cycleBranchPrefix: 'codkit/cycle/',
		releaseRefPrefix: 'codkit/release/',
		publishRemoteUrl: null,
		buildWatchFile: null,
		conventionsExtensionFile: null
	});
	writeJson(join(patchesDir, 'delta', 'owners.json'), {
		codkitOwners: 1,
		owners: { [OWNER]: { contact: 'fixture', paths: [MANIFEST, 'resources/**', 'source/**'] } }
	});

	const scratch = makeTempRoot('eol-fixture-diff');
	const hooked = MAIN_AT_PIN.replace(
		'\tstart();\n',
		`\t// codkit:begin ${PATCH_ID}\n\t// (hook body lives in own code; this block only delegates)\n\t// codkit:end ${PATCH_ID}\n\tstart();\n`
	);
	const header = formatPatchHeader({
		id: PATCH_ID,
		type: 'hook',
		category: 'follow',
		owner: OWNER,
		reason: 'fixture: a patched text file of the line-ending fixture',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: []
	});
	writeBytes(
		join(patchesDir, 'delta', 'patches', `${encodePatchName(PATCHED)}.ckpatch`),
		header + unifiedDiff(scratch, MAIN_AT_PIN, hooked, PATCHED)
	);

	writeJson(join(patchesDir, 'delta', 'overlays', 'manifest.json.overlay.json'), {
		codkitOverlay: 2,
		id: 'CK-product-915',
		target: MANIFEST,
		type: 'modify',
		category: 'own',
		owner: OWNER,
		reason: 'fixture: the product name through the dev channel',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.guard.product'],
		operations: [{ op: 'set', path: ['displayName'], value: 'Fixture PatchSet', expectUpstream: 'Fixture' }]
	});

	const targets = Object.keys(RESOURCE_FILES).sort();
	writeJson(join(patchesDir, 'delta', 'resources', 'map.json'), {
		codkitResourceMap: 2,
		entries: targets.map((target, index) => ({
			id: `CK-product-${911 + index}`,
			target,
			source: `delta/resources/files/${target}`,
			type: 'modify',
			category: 'own',
			owner: OWNER,
			reason: 'fixture: a text resource the product ships with LF',
			link: 'none',
			cause: 'none',
			pin,
			contractTests: ['fixture.guard.product']
		}))
	});
	for (const target of targets) {
		writeBytes(join(patchesDir, 'delta', 'resources', 'files', ...target.split('/')), RESOURCE_FILES[target] ?? '');
	}

	fixtureGit(patchesDir, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureCommit(patchesDir, 'fixture patchset: the line-ending delta', '2026-01-02T00:00:00Z');
}
