/** @scope spec://codkit/modules/codkit/PROP-015#RT-SHIPPED-LOCATION */
// Finding the runtime library that ships with this codkit (PROP-015 sec. 1).
//
// ##RT-SHIPPED-LOCATION: exactly one `v*` directory lives under
// `toolRoot/runtime/`; ##RT-VERSION-LITERAL: its name is the version the
// literal `CODKIT_RUNTIME_VERSION` in `common/version.ts` states. Anything else
// is a damaged installation (`CK-E-RUNTIME-PACKAGE`), not something a rerun fixes.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statIfPresent } from './containedPath.ts';
import { ckError } from './messages.ts';

/** Where the shipped library sits, relative to toolRoot. */
export const RUNTIME_PACKAGE_PARENT = 'runtime';

/**
 * The immutable Codkit root, derived from this module the way main.ts derives
 * it from its own location. `verify` needs the shipped library to compare the
 * installed copy against it (##RT-DELIVERED-NOT-OWN) and is reached through
 * call paths that carry no root of their own, so the derivation lives here
 * rather than being threaded through five option types - the same rule
 * `loadLicensePolicy` follows for the shipped policy.
 */
export const CODKIT_TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The file that carries the version literal, relative to the version directory. */
export const RUNTIME_VERSION_FILE = 'common/version.ts';

/** ##RT-VERSION-LITERAL */
const VERSION_LITERAL = /^export const CODKIT_RUNTIME_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)';$/mu;

/** ##RT-COMPAT-DECLARATION */
const VERIFIED_UPSTREAM_LITERAL = /^export const CODKIT_RUNTIME_VERIFIED_UPSTREAM: readonly string\[\] = \[([^\]]*)\];$/mu;

export type RuntimePackage = {
	/** Absolute path of the version directory. */
	readonly directory: string;
	/** Its name without the leading `v`, equal to the version literal. */
	readonly version: string;
	/** Upstream tags the library was verified on. */
	readonly verifiedUpstream: readonly string[];
};

/**
 * The shipped runtime library. `override` replaces its location for tests,
 * the way `CODKIT_TEST_STANDARDS_SOURCE` does for the standards package.
 */
export function shippedRuntime(toolRoot: string, override?: string | null): RuntimePackage {
	const parent = override ?? join(toolRoot, ...RUNTIME_PACKAGE_PARENT.split('/'));
	const shape = statIfPresent(parent);
	if (shape === null || !shape.isDirectory()) {
		throw ckError(
			'RUNTIME-PACKAGE',
			`shipped runtime not found under ${RUNTIME_PACKAGE_PARENT}`,
			'restore the codkit installation from the approved supply',
			RUNTIME_PACKAGE_PARENT
		);
	}
	const versions = readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith('v'))
		.map((entry) => entry.name)
		.sort();
	const only = versions[0];
	if (versions.length !== 1 || only === undefined) {
		throw ckError(
			'RUNTIME-PACKAGE',
			`${versions.length} version directories under ${RUNTIME_PACKAGE_PARENT}, expected exactly one`,
			'restore the codkit installation from the approved supply',
			RUNTIME_PACKAGE_PARENT
		);
	}
	const directory = join(parent, only);
	const version = only.slice(1);
	const literal = readVersionLiteral(directory);
	if (literal.version !== version) {
		throw ckError(
			'RUNTIME-PACKAGE',
			`the runtime directory says ${version} and ${RUNTIME_VERSION_FILE} says ${literal.version}`,
			'restore the codkit installation from the approved supply',
			`${RUNTIME_PACKAGE_PARENT}/${only}/${RUNTIME_VERSION_FILE}`
		);
	}
	return { directory, version, verifiedUpstream: literal.verifiedUpstream };
}

/** Reads the two literals of `common/version.ts` without executing it. */
export function readVersionLiteral(directory: string): { readonly version: string; readonly verifiedUpstream: readonly string[] } {
	const file = join(directory, ...RUNTIME_VERSION_FILE.split('/'));
	let text: string;
	try {
		text = readFileSync(file, 'utf8');
	} catch (error) {
		throw ckError(
			'RUNTIME-PACKAGE',
			`cannot read ${RUNTIME_VERSION_FILE}: ${(error as NodeJS.ErrnoException).code ?? 'unreadable'}`,
			'restore the codkit installation from the approved supply',
			file
		);
	}
	const version = VERSION_LITERAL.exec(text)?.[1];
	if (version === undefined) {
		throw ckError(
			'RUNTIME-PACKAGE',
			`${RUNTIME_VERSION_FILE} states no CODKIT_RUNTIME_VERSION literal`,
			'restore the codkit installation from the approved supply',
			file
		);
	}
	const verified = VERIFIED_UPSTREAM_LITERAL.exec(text)?.[1] ?? '';
	const verifiedUpstream = [...verified.matchAll(/'([^']+)'/gu)].map((match) => match[1]!);
	return { version, verifiedUpstream };
}
