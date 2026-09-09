/** @scope spec://codkit/modules/codkit/PROP-002#root */
// Shared filesystem boundary checks for paths carried by codkit configuration
// and delta artifacts. Paths in formats are POSIX, repository-relative names;
// writes additionally refuse symlink components so an apparently contained path
// cannot redirect an operation outside its repository root.

import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export type ContainedPathResult = { readonly ok: true; readonly absolute: string } | { readonly ok: false; readonly reason: string };

export type ContainedPathOptions = {
	/** A missing leaf (and therefore its missing descendants) may be created. */
	readonly allowMissing?: boolean;
};

/** Why a format path is not a canonical repository-relative POSIX path. */
export function repoRelativePathProblem(value: string): string | null {
	if (value === '') {
		return 'must not be empty';
	}
	if (value.includes('\0')) {
		return 'must not contain a NUL byte';
	}
	if (hasUnpairedSurrogate(value)) {
		return 'must not contain an unpaired UTF-16 surrogate';
	}
	if (value.includes('\\')) {
		return 'must use POSIX separators, not backslashes';
	}
	if (isAbsolute(value) || win32.isAbsolute(value)) {
		return 'must be relative to the repository root';
	}
	const segments = value.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return 'must not contain empty, ".", or ".." path components';
	}
	if (segments.some((segment) => /[<>:"|?*\u0000-\u001f\u007f\ufffd]/.test(segment) || segment.endsWith(' ') || segment.endsWith('.'))) {
		return 'contains a path component that is not portable to Windows';
	}
	const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
	if (segments.some((segment) => windowsDevice.test(segment))) {
		return 'contains a path component reserved as a Windows device name';
	}
	return null;
}

function hasUnpairedSurrogate(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return true;
			}
			index += 1;
			continue;
		}
		if (unit >= 0xdc00 && unit <= 0xdfff) {
			return true;
		}
	}
	return false;
}

/** Why a configured directory name is not one portable basename. */
export function safeBasenameProblem(value: string): string | null {
	const portableShape = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/;
	const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
	if (!portableShape.test(value) || windowsDevice.test(value)) {
		return 'must be one portable directory basename (letters, digits, dot, underscore, or dash; no separators)';
	}
	return null;
}

/**
 * Resolve a repository-relative path and prove that every existing component is
 * a real directory/file rather than a symlink. The realpath comparison is a
 * second containment check, independent of the lexical one.
 */
export function resolveContainedPath(root: string, repositoryPath: string, options: ContainedPathOptions = {}): ContainedPathResult {
	const formatProblem = repoRelativePathProblem(repositoryPath);
	if (formatProblem !== null) {
		return { ok: false, reason: formatProblem };
	}

	const rootAbsolute = resolve(root);
	const absolute = resolve(rootAbsolute, ...repositoryPath.split('/'));
	if (!isWithin(rootAbsolute, absolute)) {
		return { ok: false, reason: 'resolves outside the repository root' };
	}

	let rootReal: string;
	try {
		rootReal = realpathSync(rootAbsolute);
	} catch (error) {
		return { ok: false, reason: `cannot resolve the repository root: ${messageOf(error)}` };
	}

	let current = rootAbsolute;
	for (const segment of repositoryPath.split('/')) {
		current = join(current, segment);
		try {
			if (lstatSync(current).isSymbolicLink()) {
				return { ok: false, reason: `contains a symlink component at ${relative(rootAbsolute, current)}` };
			}
		} catch (error) {
			if (options.allowMissing === true && (error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { ok: true, absolute };
			}
			return { ok: false, reason: `cannot inspect ${relative(rootAbsolute, current)}: ${messageOf(error)}` };
		}
	}

	let actual: string;
	try {
		actual = realpathSync(absolute);
	} catch (error) {
		return { ok: false, reason: `cannot resolve the path: ${messageOf(error)}` };
	}
	if (!isWithin(rootReal, actual)) {
		return { ok: false, reason: 'resolves outside the repository root' };
	}
	return { ok: true, absolute };
}

function isWithin(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
