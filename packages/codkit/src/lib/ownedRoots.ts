/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-OWN-ROOT */
// The directories the delta owns, and the build outputs inside them
// (PROP-016 ##TYPE-AREA-LAYOUT, amended 2026-09-09).
//
// The engine used to know exactly one own root, the string `typeConfig.ownRoot`,
// and treated everything under it as own code. Two facts measured on a real
// clone of the second family broke both halves of that (##DECISION-OWNED-DIRECTORIES-AND-BUILD-OUTPUTS):
//
//   * a family whose own code is a package compiles it **in place**, so the
//     output of a build sits inside the owned directory, next to the sources -
//     and the engine read a build as a change of own code and refused to load;
//   * a product's application is a second directory of the tree the delta owns,
//     and the engine mirrored nothing of it.
//
// So the type answers with a list, this module turns the answer into what the
// engine works with, and every own-code path takes the list instead of the one
// string. The order is the type's: the own root is first, and it is the one
// directory that keeps the historical delta location and the manifest of the
// own layer; the others live under `delta/own-roots/<role>/`
// (PROP-005 ##OWN-ROOTS-IN-THE-DELTA).

import type { OwnedRole, ProjectType } from '@codkit/type-api';
import { matchesPatternList } from './conventionsFile.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';

/**
 * Own code inside patchset, relative to the patchset root: the delta directory
 * of the own root, and the historical name of the whole layer.
 */
export const OWN_SOURCE_DIR = 'delta/own';

/** Where the owned directories other than the own root live in the delta. */
export const OWN_ROOTS_DIR = 'delta/own-roots';

/** One owned directory, as the engine works with it. */
export type OwnedRoot = {
	/** The directory in the fork tree, a path from its root. */
	readonly path: string;
	/** What the directory is for; also how it is addressed in the delta. */
	readonly role: OwnedRole;
	/** Globs of the build outputs inside it, relative to `path`. */
	readonly buildOutputs: readonly string[];
	/** Where its content lives in patchset, a path from the patchset root. */
	readonly deltaDir: string;
};

/**
 * ##OWN-ROOTS-IN-THE-DELTA: the own root keeps `delta/own/` - it is the layer
 * with the unit manifest, the licence notice and the runtime library, and
 * moving it would rewrite every patch set in existence for nothing. Every other
 * owned directory is addressed by its role, which is unique by the contract.
 */
export function deltaDirOfRole(role: OwnedRole): string {
	return role === 'own' ? OWN_SOURCE_DIR : `${OWN_ROOTS_DIR}/${role}`;
}

/**
 * The owned directories of this patch set.
 *
 * A caller without a project type - a command that runs before the type is
 * resolved, or a test of the engine's own paths - gets the own root alone,
 * which is what every type answers when it owns one directory.
 */
export function ownedRootsOf(type: ProjectType | null, typeConfig: { readonly ownRoot: string }): readonly OwnedRoot[] {
	if (type === null) {
		return [{ path: typeConfig.ownRoot, role: 'own', buildOutputs: [], deltaDir: OWN_SOURCE_DIR }];
	}
	const answer = type.layout.ownRoots({ ownRoot: typeConfig.ownRoot });
	const roots = answer.map((owned) => ({
		path: owned.path,
		role: owned.role,
		buildOutputs: [...owned.buildOutputs],
		deltaDir: deltaDirOfRole(owned.role)
	}));
	assertOwnedRoots(type, typeConfig.ownRoot, roots);
	return roots;
}

/**
 * The rules the engine cannot work around, checked over the real configuration
 * rather than over the probe of the contract's shape gate: the own root is the
 * first owned directory, the paths are inside the tree, and no two of them
 * overlap - otherwise a file inside the overlap would belong to two deltas and
 * the mirror would fight itself.
 */
function assertOwnedRoots(type: ProjectType, ownRoot: string, roots: readonly OwnedRoot[]): void {
	const first = roots[0];
	if (first === undefined || first.path !== ownRoot || first.role !== 'own') {
		throw ownedRootRefusal(type, `the first owned directory must be typeConfig.ownRoot (${ownRoot}) with the role own`);
	}
	const seenPaths = new Set<string>();
	const seenRoles = new Set<string>();
	for (const owned of roots) {
		const problem = repoRelativePathProblem(owned.path);
		if (problem !== null) {
			throw ownedRootRefusal(type, `the owned directory "${owned.path}" is unsafe: ${problem}`);
		}
		if (seenPaths.has(owned.path)) {
			throw ownedRootRefusal(type, `the owned directory ${owned.path} is named twice`);
		}
		if (seenRoles.has(owned.role)) {
			throw ownedRootRefusal(type, `the role ${owned.role} is used by two owned directories`);
		}
		seenPaths.add(owned.path);
		seenRoles.add(owned.role);
	}
	for (const owned of roots) {
		for (const other of roots) {
			if (other.path !== owned.path && `${other.path}/`.startsWith(`${owned.path}/`)) {
				throw ownedRootRefusal(type, `the owned directory ${other.path} sits inside the owned directory ${owned.path}`);
			}
		}
	}
}

function ownedRootRefusal(type: ProjectType, detail: string): Error {
	return ckError(
		'CONFIG',
		`the project type ${type.id} answered with owned directories the engine cannot use: ${detail}`,
		'correct typeConfig so that the type answers one own root and, if it owns more, directories beside it',
		'codkit.json'
	);
}

/** The owned directory of the tree path, or null when the path is upstream's. */
export function ownedRootOf(roots: readonly OwnedRoot[], treePath: string): OwnedRoot | null {
	return roots.find((owned) => treePath === owned.path || treePath.startsWith(`${owned.path}/`)) ?? null;
}

/** The tree prefixes of the owned directories, each with its trailing slash. */
export function ownedTreePrefixes(roots: readonly OwnedRoot[]): readonly string[] {
	return roots.map((owned) => `${owned.path}/`);
}

/**
 * Whether a path inside an owned directory is a build output rather than own
 * code (##TYPE-AREA-LAYOUT). `relative` is relative to the owned directory and
 * carries a trailing slash when it names a directory, which is what lets a
 * directory glob (`lib/**`) stop the walk before it descends.
 *
 * The globs are read with the same gitignore-style matcher as the cleanup
 * whitelist: one pattern language for the two questions a type answers about
 * build outputs.
 */
export function isBuildOutput(owned: OwnedRoot, relative: string): boolean {
	return owned.buildOutputs.length > 0 && matchesPatternList(relative, expandedGlobs(owned.buildOutputs));
}

/**
 * The globs as the matcher needs them: a glob that names everything under a
 * directory (`lib/**`) names the directory itself as well, so the walk can stop
 * at `lib/` instead of descending into it and asking about every file - which
 * is what keeps the listing out of an install's symlinks. The expansion is
 * cached per answer, because it is asked once per directory entry of a walk.
 */
const expanded = new WeakMap<readonly string[], readonly string[]>();

function expandedGlobs(globs: readonly string[]): readonly string[] {
	const cached = expanded.get(globs);
	if (cached !== undefined) {
		return cached;
	}
	const value = [...globs, ...globs.filter((glob) => glob.endsWith('/**')).map((glob) => `${glob.slice(0, -3)}/`)];
	expanded.set(globs, value);
	return value;
}

/**
 * The own-code filter of one owned directory: everything that is not a build
 * output. Passed to the listing so that a build output is never copied into the
 * delta, never counted as changed own code, and never removed by a load - only
 * a fresh pass removes it.
 */
export function ownCodeFilter(owned: OwnedRoot): ((relative: string) => boolean) | undefined {
	return owned.buildOutputs.length === 0 ? undefined : (relative) => !isBuildOutput(owned, relative);
}
