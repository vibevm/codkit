// The patch set of the third polygon: a product built on the synthetic Theia
// monorepo (FEAT-001 ##POLYGON-THEIA-COVERAGE).
//
// It carries what a patch set of this family actually is, and nothing more:
// an **own package** - a workspace package with its own manifest,
// `theiaExtensions`, a dependency on the framework package and a container
// module - a **service override** proved by a `rebind` plus that dependency
// edge, and a **config-overlay** over the application's `package.json`, which is
// the whole product model of the family. There is no entry-module artifact and
// no own extension, because this family has neither: own code reaches the
// application by one line in its dependency list (##THEIA-OWN-IS-INCLUDED-BY-DEPENDENCY).

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ckError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit, pinDate } from './makeUpstream.ts';
import { APPLICATION_MANIFEST, CORE_MODULE_PATH, CORE_SERVICE_PATH, OLD_VERSION } from './makeTheiaUpstream.ts';
import type { TheiaUpstreamFixture } from './makeTheiaUpstream.ts';
import { assertApplies, encodePatchName, showAtPin, unifiedDiff, writeBytes, writeJson } from './patchText.ts';

export type TheiaPatchSetFixture = {
	/** Absolute path of the generated pseudo-patchset repository. */
	readonly dir: string;
};

/** Ids of the artifacts the fixture carries. */
export const PATCH_ID = 'CK-core-901';
export const OWN_UNIT_ID = 'CK-frontend-901';
export const OVERRIDE_ID = 'CK-frontend-902';
export const OVERLAY_ID = 'CK-app-901';

/** ##THEIA-OWN-ROOT: the own package is a workspace package directory. */
export const OWN_ROOT = 'packages/acme';
/** ##THEIA-LINT: what `lerna --scope` selects the own package by. */
export const OWN_PACKAGE_NAME = '@acme/theia-product';
/** The module of the own package that the override declares, inside delta/own. */
export const OVERRIDE_MODULE = 'src/browser/acme-frontend-module.ts';
/** The service the own package rebinds, and the package that binds it. */
export const OVERRIDDEN_SERVICE = 'EditorManager';
export const SERVICE_OWNER_PACKAGE = '@theia/core';

/** The name the overlay gives the application. */
export const APPLICATION_NAME = 'Acme Studio';

/** Name of the sample patch file (PROP-004 sec. 4, patch file name encoding). */
export const PATCH_FILE_NAME = `${encodePatchName(CORE_MODULE_PATH)}.ckpatch`;

const OWNER = 'acme-frontend';
const FIRST_COMMIT_ISO = '2026-04-02T00:00:00Z';
const SECOND_COMMIT_ISO = '2026-04-02T00:01:00Z';

export function makeTheiaPatchSet(dir: string, upstream: TheiaUpstreamFixture): TheiaPatchSetFixture {
	mkdirSync(dir, { recursive: true });

	writeJson(join(dir, 'codkit.json'), {
		codkitConfig: 2,
		pin: { tag: upstream.v1.tag, sha: upstream.v1.sha, date: pinDate(upstream.v1.dateIso) },
		upstreamAnchorCommit: upstream.anchorSha,
		type: 'theia',
		typeConfig: {
			ownRoot: OWN_ROOT,
			ownPackageName: OWN_PACKAGE_NAME,
			applicationRoot: 'examples/electron'
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
		owners: { [OWNER]: { contact: 'fixture', paths: ['packages/**', 'examples/**'] } }
	});

	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);
	fixtureCommit(dir, 'fixture patchset: config and owners', FIRST_COMMIT_ISO);

	writeLayers(dir, upstream);
	fixtureCommit(dir, 'fixture patchset: the own package, its override and the application overlay', SECOND_COMMIT_ISO);

	return { dir };
}

function writeLayers(dir: string, upstream: TheiaUpstreamFixture): void {
	const pin = `${upstream.v1.tag}@${upstream.v1.sha}`;

	// patch layer: the rare event of this family. Additions need no upstream
	// edit at all, so a patch here is what tier 4 of the seam catalogue calls a
	// hook with a named reason - and it is what the cycle has to carry over a
	// pin where the file around it moved.
	writeBytes(join(dir, 'delta', 'patches', PATCH_FILE_NAME), buildSamplePatch(dir, upstream));

	// own layer: the whole own package, manifest first - it is what declares the
	// entry the application's generator loads and the dependency edge the
	// override needs (##THEIA-OWN-PACKAGE-SHAPE).
	writeJson(join(dir, 'delta', 'own', 'package.json'), ownPackageManifest());
	writeJson(join(dir, 'delta', 'own', 'tsconfig.json'), {
		extends: '../../configs/base.tsconfig',
		compilerOptions: { composite: true, rootDir: 'src', outDir: 'lib' },
		include: ['src']
	});
	writeBytes(join(dir, 'delta', 'own', '.eslintrc.js'), ESLINTRC_JS);
	writeBytes(join(dir, 'delta', 'own', OVERRIDE_MODULE), FRONTEND_MODULE_TS);
	writeBytes(join(dir, 'delta', 'own', 'src', 'browser', 'acme-editor-manager.ts'), EDITOR_MANAGER_TS);
	writeBytes(join(dir, 'delta', 'own', 'src', 'browser', 'test', 'acme.spec.ts'), OWN_GUARD_TESTS);

	writeJson(join(dir, 'delta', 'own', 'patchset.delta.json'), {
		codkitOwnManifest: 2,
		units: [
			{
				id: OWN_UNIT_ID,
				layer: 'own',
				type: 'extend',
				category: 'own',
				owner: OWNER,
				reason: 'the own package of this product: a workspace package with theiaExtensions, which is how own code reaches the application',
				link: 'none',
				cause: 'none',
				pin,
				contractTests: ['fixture.theia.editor'],
				roots: ['package.json', 'tsconfig.json', '.eslintrc.js', 'src/']
			}
		],
		serviceOverrides: [
			{
				id: OVERRIDE_ID,
				serviceId: OVERRIDDEN_SERVICE,
				module: OVERRIDE_MODULE,
				owner: OWNER,
				reason: 'the editor manager of the product replaces the one of the framework, through the rebind of this family',
				link: 'none',
				cause: 'none',
				pin,
				contractTests: ['fixture.theia.editor']
			}
		]
	});

	// config-overlay layer: the application manifest, which is where the product
	// model of this family lives (##THEIA-OVERLAY-TARGET).
	writeJson(join(dir, 'delta', 'overlays', 'examples-electron-package.json.overlay.json'), {
		codkitOverlay: 2,
		id: OVERLAY_ID,
		target: APPLICATION_MANIFEST,
		type: 'modify',
		category: 'own',
		owner: OWNER,
		reason: 'the identity of the product: one key of the application manifest, which is the whole brand funnel of this family',
		link: 'none',
		cause: 'none',
		pin,
		contractTests: ['fixture.theia.application'],
		operations: [
			{
				op: 'set',
				path: ['theia', 'frontend', 'config', 'applicationName'],
				value: APPLICATION_NAME,
				expectUpstream: 'Theia Electron Example'
			},
			{ op: 'set', path: ['productName'], value: APPLICATION_NAME, expectUpstream: 'Theia Electron Example' },
			{
				op: 'set',
				path: ['dependencies', OWN_PACKAGE_NAME],
				value: OLD_VERSION,
				expectUpstream: { $absent: true }
			}
		]
	});
}

/**
 * ##THEIA-OWN-PACKAGE-SHAPE: the manifest of the own package. `theiaExtensions`
 * is what makes it a Theia extension at all, and the dependency on the package
 * that binds the service is what puts it later in the load order - which is the
 * whole mechanism of the override (##THEIA-OVERRIDE-IS-REBIND).
 */
function ownPackageManifest(): unknown {
	return {
		private: true,
		name: OWN_PACKAGE_NAME,
		version: OLD_VERSION,
		dependencies: { [SERVICE_OWNER_PACKAGE]: OLD_VERSION },
		theiaExtensions: [{ frontend: 'lib/browser/acme-frontend-module' }],
		scripts: { lint: 'theiaext lint', compile: 'theiaext compile', test: 'theiaext test' },
		devDependencies: { '@theia/ext-scripts': OLD_VERSION }
	};
}

const ESLINTRC_JS = `/** @type {import('eslint').Linter.Config} */
module.exports = {
	extends: ['../../configs/build.eslintrc.json'],
	parserOptions: { tsconfigRootDir: __dirname, project: 'tsconfig.json' }
};
`;

/** The container module of the own package: `rebind` plus the root container. */
const FRONTEND_MODULE_TS = `// The frontend module of the own package.

import { ContainerModule } from '@theia/core/shared/inversify';
import { EditorManager } from '@theia/core/lib/browser/editor-manager';
import { AcmeEditorManager } from './acme-editor-manager';

export default new ContainerModule(({ bind, rebind }) => {
	bind(AcmeEditorManager).toSelf().inSingletonScope();
	rebind(EditorManager).toService(AcmeEditorManager);
});
`;

const EDITOR_MANAGER_TS = `// The editor manager of the product.

import { EditorManager } from '@theia/core/lib/browser/editor-manager';

export class AcmeEditorManager extends EditorManager {
	override open(uri: string): string {
		return 'acme:' + uri;
	}
}
`;

/**
 * The guards the artifacts name in `contractTests`. This family writes its specs
 * in the BDD interface of the runner, and the tool reads both (PROP-010
 * ##CONTRACT-TESTS-MANDATE). Nothing here runs under vitest: the file is content
 * of the pseudo-patchset, read as text.
 */
const OWN_GUARD_TESTS = `import * as assert from 'assert';

import { AcmeEditorManager } from '../acme-editor-manager';

describe('fixture.theia.editor', () => {
	it('answers instead of the editor manager of the framework', () => {
		assert.strictEqual(new AcmeEditorManager().open('file'), 'acme:file');
	});
});

describe('fixture.theia.application', () => {
	it('names the product in the application manifest', () => {
		assert.strictEqual(manifest.theia.frontend.config.applicationName, 'Acme Studio');
	});
});
`;

/** Id of the entry-module artifact a test writes to prove the refusal. */
export const ENTRY_MODULE_ID = 'CK-frontend-903';

/** Name of the entry-module patch file (PROP-004 sec. 4, patch file name encoding). */
export const ENTRY_MODULE_PATCH_NAME = `${encodePatchName(CORE_SERVICE_PATH)}.ckpatch`;

/**
 * Write an artifact of the `entry-module` layer into the patch set. This family
 * has no entry module at all - own code reaches the application by a dependency
 * line - so the only correct answer to such an artifact is a refusal
 * (##THEIA-NO-ENTRY-MODULE), and this is what a test hands `verify` to prove it.
 */
export function writeEntryModulePatch(dir: string, upstream: TheiaUpstreamFixture): void {
	const scratch = join(dir, '.codkit', 'tmp');
	mkdirSync(scratch, { recursive: true });
	try {
		const atPin = showAtPin(upstream.dir, upstream.v1.sha, CORE_SERVICE_PATH);
		const anchor = 'export class EditorManager {\n';
		if (!atPin.includes(anchor)) {
			throw ckError('INTERNAL', `fixture: anchor line not found in ${CORE_SERVICE_PATH}`);
		}
		const block = [
			`\t// codkit:begin ${ENTRY_MODULE_ID}`,
			'\t// (a graft into an entry module, which this family does not have)',
			`\t// codkit:end ${ENTRY_MODULE_ID}`,
			''
		].join('\n');
		const body = unifiedDiff(scratch, atPin, atPin.replace(anchor, anchor + block), CORE_SERVICE_PATH);
		const patch = `${[
			'# codkit-patch: 2',
			`# id: ${ENTRY_MODULE_ID}`,
			'# layer: entry-module',
			'# type: hook',
			'# category: follow',
			`# owner: ${OWNER}`,
			'# reason: a graft of an entry module, to prove that this family refuses one',
			'# link: none',
			'# cause: none',
			`# pin: ${upstream.v1.tag}@${upstream.v1.sha}`,
			'# contract-tests: none',
			''
		].join('\n')}${body}`;
		assertApplies(scratch, upstream.dir, upstream.v1, patch);
		writeBytes(join(dir, 'delta', 'patches', ENTRY_MODULE_PATCH_NAME), patch);
	} finally {
		rmSync(join(dir, '.codkit'), { recursive: true, force: true });
	}
}

/**
 * The sample patch of the fixture: a marker block at the top of the framework's
 * container module, generated as a real unified diff and checked with
 * `git apply` against the pin before the generator returns.
 */
function buildSamplePatch(dir: string, upstream: TheiaUpstreamFixture): string {
	const scratch = join(dir, '.codkit', 'tmp');
	mkdirSync(scratch, { recursive: true });
	try {
		const atPin = showAtPin(upstream.dir, upstream.v1.sha, CORE_MODULE_PATH);
		const anchor = 'export default new ContainerModule(bind => {\n';
		if (!atPin.includes(anchor)) {
			throw ckError('INTERNAL', `fixture: anchor line not found in ${CORE_MODULE_PATH}`);
		}
		const block = [
			`\t// codkit:begin ${PATCH_ID}`,
			`\t// (the body lives in ${OWN_ROOT.split('/').at(-1) ?? OWN_ROOT}/src/browser/; this block only delegates)`,
			`\t// codkit:end ${PATCH_ID}`,
			''
		].join('\n');
		const body = unifiedDiff(scratch, atPin, atPin.replace(anchor, anchor + block), CORE_MODULE_PATH);
		const patch = `${[
			'# codkit-patch: 2',
			`# id: ${PATCH_ID}`,
			'# type: hook',
			'# category: follow',
			`# owner: ${OWNER}`,
			'# reason: the one upstream edit this product needs: a behaviour with no service identifier and no contribution point behind it',
			'# link: none',
			'# cause: none',
			`# pin: ${upstream.v1.tag}@${upstream.v1.sha}`,
			'# contract-tests: none',
			''
		].join('\n')}${body}`;
		assertApplies(scratch, upstream.dir, upstream.v1, patch);
		return patch;
	} finally {
		rmSync(join(dir, '.codkit'), { recursive: true, force: true });
	}
}
