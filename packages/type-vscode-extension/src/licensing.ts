/** @scope spec://codkit/modules/vscode-extension/PROP-006#VSX-LICENSING-AREA */
// Area 12: where this family states a licence, as a function of the
// configuration like every answer of the family (##VSX-CONFIGURED-TYPE).
//
// The profile - who the rights holders are, which licence, which text - is the
// organization's and is selected by the patch set (modules/codkit/PROP-019); the
// engine lays the headers out, writes the overlay, the add-file patches, the
// exclusion patch and the guard, and checks them back. What is this family's:
// own files carry the four-line header the family's sources would carry if
// they carried one; the licence file lives in the extension root, because the
// archive is packed from there and the packager finds the licence file there;
// `licenses/` under the extension root travels into the archive, so component
// licences gather there; the manifest's `license` key names the licence; the
// upstream's own licence file is left out of the archive through one line of
// the extension's ignore file, because the packager would otherwise take it as
// the licence of the archive (##VSX-DISTRIBUTABLE-EXCLUSION); and the guard
// runs where the own tests run, which for a workspace package is the extension
// root (##VSX-LICENCE-GUARD).

import type { DistributableExclusion, LicenceField, LicenceGuard, LicensingArea, UpstreamLicenceFile } from '@codkit/type-api';
import type { VsxTypeConfig } from './configSchema.ts';
import { testWordsOf } from './generators.ts';
import { manifestPathOf } from './identity.ts';
import { treePath } from './layout.ts';

/** ##VSX-LICENCE-GUARD: beside the brand guard, under the own tests. */
export const LICENCE_GUARD_PATH = 'delta/own/test/licence.leftovers.test.ts';

/** ##VSX-COMPONENT-LICENCES: the upstream's licence file in the extension root, when the configuration names none. */
export const DEFAULT_UPSTREAM_LICENCE_FILE = 'LICENSE';

/** ##VSX-COMPONENT-LICENCES: the component the upstream's text ships under, when the configuration names none. */
export const DEFAULT_UPSTREAM_COMPONENT = 'upstream';

/** ##VSX-DISTRIBUTABLE-EXCLUSION: the ignore file the family's packager reads, in the extension root. */
export const IGNORE_FILE = '.vscodeignore';

/** ##VSX-COMPONENT-LICENCES: the directory under the extension root that component licences gather in. */
export const COMPONENT_LICENCE_DIRECTORY = 'licenses';

/** ##VSX-LICENSING-AREA: the subsystem the licensing interventions are numbered in - the manifest and the files beside it. */
export const LICENSING_SUBSYSTEM = 'config';

/** ##VSX-LICENCE-FIELD: the `license` key of the extension manifest carries the own expression. */
export function licenceFieldsOf(config: VsxTypeConfig): readonly LicenceField[] {
	return [{ target: manifestPathOf(config.extensionRoot), path: ['license'], role: 'expression' }];
}

/** The name of the upstream's licence file in the extension root, as the configuration names it. */
export function upstreamLicenceFileOf(config: VsxTypeConfig): string {
	return config.licensing?.upstreamLicenceFile ?? DEFAULT_UPSTREAM_LICENCE_FILE;
}

/** The component the upstream's text ships under, as the configuration names it. */
export function upstreamComponentOf(config: VsxTypeConfig): string {
	return config.licensing?.upstreamComponent ?? DEFAULT_UPSTREAM_COMPONENT;
}

/** ##VSX-COMPONENT-LICENCES: the upstream's own terms, shipped as a component licence under `<extensionRoot>/licenses/`. */
export function upstreamLicenceFilesOf(config: VsxTypeConfig): readonly UpstreamLicenceFile[] {
	return [{ path: treePath(config.extensionRoot, upstreamLicenceFileOf(config)), component: upstreamComponentOf(config) }];
}

/** ##VSX-DISTRIBUTABLE-EXCLUSION: the upstream's licence file is left out of the archive through one line of the ignore file. */
export function distributableExclusionsOf(config: VsxTypeConfig): readonly DistributableExclusion[] {
	return [{ ignoreFile: treePath(config.extensionRoot, IGNORE_FILE), entry: upstreamLicenceFileOf(config) }];
}

/** The directory of the extension root as the contract spells it: the empty string for the tree root. */
function directoryOf(extensionRoot: string): string {
	return extensionRoot === '.' ? '' : extensionRoot;
}

/**
 * ##VSX-LICENCE-GUARD: the guard beside the brand guard, in the words of the
 * declared own-test runner, with no preamble, and the runner starting in the
 * extension root - the engine's template resolves the tree root from there.
 */
export function licenceGuardOf(config: VsxTypeConfig): (ownRoot: string) => LicenceGuard {
	const words = testWordsOf(config);
	const runnerDirectory = directoryOf(config.extensionRoot);
	return () => ({ path: LICENCE_GUARD_PATH, suite: words.suite, test: words.test, runnerDirectory });
}

/** ##VSX-LICENSING-AREA: the answer, as a function of the configuration. */
export function makeLicensing(config: VsxTypeConfig): LicensingArea {
	return {
		headerStyle: 'line',
		licenceFileDirectory: directoryOf(config.extensionRoot),
		componentLicenceDirectory: treePath(config.extensionRoot, COMPONENT_LICENCE_DIRECTORY),
		subsystem: LICENSING_SUBSYSTEM,
		fields: licenceFieldsOf(config),
		upstreamLicenceFiles: upstreamLicenceFilesOf(config),
		renderings: [],
		distributableExclusions: distributableExclusionsOf(config),
		guard: licenceGuardOf(config)
	};
}
