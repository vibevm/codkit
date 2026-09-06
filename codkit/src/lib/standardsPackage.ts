/** @scope spec://codkit/modules/codkit/PROP-014#STD-PACKAGE-LOCATION */
// Finding the standards package that ships with this codkit (PROP-014 sec. 1).
//
// ##STD-PACKAGE-LOCATION: exactly one `v*` directory lives under
// `toolRoot/vibevm/vibepacks/org.vibevm.codkit/standards/`, and its name is the
// version its manifest states. Anything else means the installation is damaged,
// which is `CK-E-INTERNAL` and not something a person can fix by rerunning.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { statIfPresent } from './containedPath.ts';
import { ckError } from './messages.ts';

/** Where the shipped package sits, relative to toolRoot. */
export const STANDARDS_PACKAGE_PARENT = 'vibevm/vibepacks/org.vibevm.codkit/standards';

/** Group and name of the package; its identity together with the version. */
export const STANDARDS_PACKAGE_GROUP = 'org.vibevm.codkit';
export const STANDARDS_PACKAGE_NAME = 'standards';

/** ##STD-PACKAGE-LOCATION: `[package] version` of the package manifest. */
const MANIFEST_VERSION = /^version = "([0-9]+\.[0-9]+\.[0-9]+)"$/mu;

/** Directories a run of `standards load` leaves behind when it is interrupted. */
export const SCRATCH_PREFIX = '.codkit-load-';

export type StandardsPackage = {
	/** Absolute path of the version directory. */
	readonly directory: string;
	/** Its name without the leading `v`, equal to the manifest version. */
	readonly version: string;
};

/**
 * The shipped package. `CODKIT_TEST_STANDARDS_SOURCE` replaces its location,
 * but only under the test build condition, the same seam
 * `CODKIT_TEST_SAVE_REPLAY_CRASH_AT` uses (##STD-LOAD-STEP-SOURCE).
 */
export function shippedStandardsPackage(toolRoot: string, override?: string | null): StandardsPackage {
	const parent = override ?? join(toolRoot, ...STANDARDS_PACKAGE_PARENT.split('/'));
	const shape = statIfPresent(parent);
	if (shape === null || !shape.isDirectory()) {
		throw ckError(
			'INTERNAL',
			`shipped standards package not found under ${STANDARDS_PACKAGE_PARENT}`,
			'restore the codkit installation from the approved supply',
			STANDARDS_PACKAGE_PARENT
		);
	}
	const versions = readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
		.map((entry) => entry.name)
		.sort();
	const only = versions[0];
	if (versions.length !== 1 || only === undefined) {
		throw ckError(
			'INTERNAL',
			`${versions.length} version directories under ${STANDARDS_PACKAGE_PARENT}, expected exactly one`,
			'restore the codkit installation from the approved supply',
			STANDARDS_PACKAGE_PARENT
		);
	}
	const directory = join(parent, only);
	const version = only.slice(1);
	const manifest = readManifest(directory);
	if (manifest !== version) {
		throw ckError(
			'INTERNAL',
			`the package directory says ${version} and its manifest says ${manifest}`,
			'restore the codkit installation from the approved supply',
			`${STANDARDS_PACKAGE_PARENT}/${only}/vibe.toml`
		);
	}
	return { directory, version };
}

function readManifest(directory: string): string {
	let text: string;
	try {
		text = readFileSync(join(directory, 'vibe.toml'), 'utf8');
	} catch (error) {
		throw ckError(
			'INTERNAL',
			`cannot read the package manifest: ${error instanceof Error ? error.message : String(error)}`,
			'restore the codkit installation from the approved supply',
			`${STANDARDS_PACKAGE_PARENT}/vibe.toml`
		);
	}
	const stated = MANIFEST_VERSION.exec(text);
	if (stated === null || stated[1] === undefined) {
		throw ckError(
			'INTERNAL',
			'the package manifest states no [package] version',
			'restore the codkit installation from the approved supply',
			`${STANDARDS_PACKAGE_PARENT}/vibe.toml`
		);
	}
	return stated[1];
}
