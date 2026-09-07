/** @scope spec://codkit/modules/codkit/PROP-014#STD-PACKAGE-LOCATION */
// Finding the standards package that ships with this codkit (PROP-014 sec. 1).
//
// ##STD-PACKAGE-LOCATION: exactly one `v*` directory lives under
// `toolRoot/vibevm/vibepacks/org.vibevm.codkit/standards/`, and its name is the
// version its manifest states. Anything else means the installation is damaged,
// which is `CK-E-INTERNAL` and not something a person can fix by rerunning.

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureAdminDirectory, lstatIfPresent, statIfPresent } from './containedPath.ts';
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

// ---------------------------------------------------------------------------
// The installed copy: classification, and writing through a scratch directory
// ---------------------------------------------------------------------------

export type TreeComparison =
	| { readonly state: 'absent' }
	| { readonly state: 'identical' }
	| {
			readonly state: 'drift';
			/** Present on both sides with different bytes. */
			readonly modified: readonly string[];
			/** Present in the target and not in the source. */
			readonly extra: readonly string[];
			/** Present in the source and not in the target. */
			readonly missing: readonly string[];
	  };

/** Every file under `dir`, POSIX-relative, sorted; a symlink is reported too. */
function listTree(dir: string): { readonly files: readonly string[]; readonly symlinks: readonly string[] } {
	const files: string[] = [];
	const symlinks: string[] = [];
	const visit = (absolute: string, prefix: string): void => {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
			const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isSymbolicLink()) {
				symlinks.push(relative);
				continue;
			}
			if (entry.isDirectory()) {
				visit(join(absolute, entry.name), relative);
				continue;
			}
			files.push(relative);
		}
	};
	visit(dir, '');
	return { files, symlinks };
}

export type CompareOptions = {
	/**
	 * Relative paths the target is allowed to carry without the source having
	 * them. The runtime library is delivered next to the licence notice, which
	 * belongs to another command (PROP-014 sec. 4a), so the notice must not read
	 * as an extra file (PROP-015 ##RT-LOAD-STEPS step 3).
	 */
	readonly ignoreInTarget?: readonly string[];
};

/**
 * ##STD-LOAD-STEP-TARGET-STATE: the same relative paths and the same bytes, or
 * the exact list of what differs. A symlink in the target is drift: codkit
 * wrote regular files, so a link is somebody's edit.
 */
export function compareTrees(source: string, target: string, options: CompareOptions = {}): TreeComparison {
	const shape = statIfPresent(target);
	if (shape === null) return { state: 'absent' };
	if (!shape.isDirectory()) return { state: 'drift', modified: [], extra: [''], missing: [] };

	const ignored = new Set(options.ignoreInTarget ?? []);
	const from = listTree(source);
	const listed = listTree(target);
	const to = { files: listed.files.filter((relative) => !ignored.has(relative)), symlinks: listed.symlinks };
	const targetFiles = new Set(to.files);
	const modified: string[] = [];
	const missing: string[] = [];
	for (const relative of from.files) {
		if (!targetFiles.has(relative)) {
			missing.push(relative);
			continue;
		}
		const left = readFileSync(join(source, ...relative.split('/')));
		const right = readFileSync(join(target, ...relative.split('/')));
		if (!left.equals(right)) modified.push(relative);
	}
	const sourceFiles = new Set(from.files);
	const extra = [...to.files.filter((relative) => !sourceFiles.has(relative)), ...to.symlinks].sort();
	if (modified.length === 0 && extra.length === 0 && missing.length === 0) return { state: 'identical' };
	return { state: 'drift', modified, extra, missing };
}

/** Every regular file under `dir`, POSIX-relative and sorted; empty when it does not exist. */
export function listTreeFiles(dir: string): readonly string[] {
	return statIfPresent(dir)?.isDirectory() === true ? listTree(dir).files : [];
}

/** Whether two files hold the same bytes; an absent target is not identical. */
export function fileIsIdentical(source: string, target: string): boolean {
	const shape = lstatIfPresent(target);
	if (shape === null || !shape.isFile()) return false;
	return readFileSync(source).equals(readFileSync(target));
}

/** Scratch directories a previous interrupted run left behind. */
export function listScratchDirs(parent: string): readonly string[] {
	const shape = statIfPresent(parent);
	if (shape === null || !shape.isDirectory()) return [];
	return readdirSync(parent, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
		.map((entry) => entry.name)
		.sort();
}

/**
 * ##DECISION-STD-TEMP-DIR-RENAME: write every file into a scratch directory and
 * rename it into place in one step, so the classification above never sees a
 * half-written version directory. Returns the scratch name that was renamed.
 *
 * `renameContainedFile` refuses a non-regular source, so the directory rename is
 * done here, with the same shape proof: the parent components are real
 * directories (a symlink component is refused by `ensureAdminDirectory`) and the
 * target must not exist.
 */
export type WriteTreeOptions = {
	readonly what: string;
	/**
	 * Replace a directory that is already there instead of refusing it: the
	 * runtime library is upgraded in place by `runtime load --upgrade`, which
	 * swaps the whole directory (PROP-015 ##RT-LOAD-UPGRADE). The old directory
	 * is moved aside and removed only after the new one is in place.
	 */
	readonly replace?: boolean;
	/**
	 * Relative paths carried over from the directory being replaced. The licence
	 * notice lives inside the runtime directory but belongs to another command,
	 * so a replacement must not drop it (PROP-015 ##RT-LOAD-STEPS step 5).
	 */
	readonly preserve?: readonly string[];
};

export function writeTreeViaScratch(
	source: string,
	root: string,
	parentSegments: readonly string[],
	versionDirName: string,
	options: WriteTreeOptions
): string {
	// The parent components are created here, each proven a real directory: a
	// symlink component is refused rather than followed (PROP-002, the rule for
	// administrative directories).
	const parent = ensureAdminDirectory(root, parentSegments, { what: options.what });
	const scratch = `${SCRATCH_PREFIX}${process.pid}-${randomBytes(4).toString('hex')}`;
	const scratchPath = join(parent, scratch);
	mkdirSync(scratchPath);
	for (const relative of listTree(source).files) {
		const segments = relative.split('/');
		const name = segments.pop() ?? '';
		const directory = ensureAdminDirectory(scratchPath, segments, { what: options.what });
		writeFileSync(join(directory, name), readFileSync(join(source, ...relative.split('/'))));
	}
	const target = join(parent, versionDirName);
	const standing = statIfPresent(target);
	if (standing !== null && options.replace !== true) {
		// The target appeared between the classification and the rename. Whoever
		// wrote it owns it now: identical means our work is already done, anything
		// else is drift for the caller to refuse.
		rmSync(scratchPath, { recursive: true, force: true });
		throw ckError(
			'STANDARDS-DRIFT',
			`${versionDirName} appeared while the package was being written`,
			'run codkit standards load again to classify the directory that is now there',
			versionDirName
		);
	}
	for (const relative of standing === null ? [] : (options.preserve ?? [])) {
		const from = join(target, ...relative.split('/'));
		if (statIfPresent(from) === null) continue;
		const segments = relative.split('/');
		const name = segments.pop() ?? '';
		writeFileSync(join(ensureAdminDirectory(scratchPath, segments, { what: options.what }), name), readFileSync(from));
	}
	if (standing === null) {
		renameSync(scratchPath, target);
		return scratch;
	}
	// Two renames rather than a delete and a rename: the old directory is only
	// unlinked after the new one is fully in place, so an interruption leaves
	// either the old library or the new one, never half of either.
	const retired = join(parent, `${SCRATCH_PREFIX}old-${process.pid}-${randomBytes(4).toString('hex')}`);
	renameSync(target, retired);
	renameSync(scratchPath, target);
	rmSync(retired, { recursive: true, force: true });
	return scratch;
}
