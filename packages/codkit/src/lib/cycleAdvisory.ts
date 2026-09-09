/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// The frame of the upgrade advisory: what changed between two pins, what it
// means, and the acknowledgement that unblocks the cycle.
//
// The engine owns the frame and nothing else (PROP-016 ##TYPE-AREA-ADVISORY).
// It never names a file of an upstream: it takes the readers the project type
// declares, diffs exactly the files they asked for, hands each reader the text
// of its own files at each pin, and reports the readings that differ together
// with the sentence the reader gives them. A reader that has no meaning for a
// difference makes no line.
//
// Which files are listed as changed is the same question asked twice: a file a
// reader called news in its own right is listed whenever it changed, and any
// other file only when the reading over it actually moved.

import { createHash } from 'node:crypto';
import type { AdvisoryFiles, AdvisoryReader, AdvisoryValue, ProjectType } from '@codkit/type-api';
import { isBrokenArtifact } from '@codkit/type-api';
import { containsByte, decodeUtf8Strict, NUL_BYTE } from './bytes.ts';
import type { GitBytesResult, RunGitOptions } from './gitx.ts';
import { runGitBytes } from './gitx.ts';
import { ckError } from './messages.ts';

export type DependencyAdvisoryGitRunner = (options: RunGitOptions) => GitBytesResult;

export type DependencyAdvisoryFileChange = {
	readonly path: string;
	readonly change: 'added' | 'modified' | 'deleted';
};

/** One reading that moved between the pins, with what the type says it means. */
export type DependencyAdvisorySemanticChange = {
	/** The reader that saw it; its identifier names the change in the report. */
	readonly kind: string;
	/** The files that reader reads, in the order it declared them. */
	readonly paths: readonly string[];
	readonly before: AdvisoryValue;
	readonly after: AdvisoryValue;
	/** One sentence: what the change means for the patch set. */
	readonly meaning: string;
};

export type DependencyAdvisoryReport = {
	readonly version: 1;
	readonly oldPin: string;
	readonly newPin: string;
	readonly changedFiles: readonly DependencyAdvisoryFileChange[];
	readonly semanticChanges: readonly DependencyAdvisorySemanticChange[];
};

export type DependencyAdvisoryGate = {
	readonly ci: boolean;
	readonly acknowledgement?: string | null;
};

type Side = {
	readonly old: string;
	readonly next: string;
};

const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^(?!-)[^\u0000-\u0020\u007f]+$/;

export type DependencyAdvisoryOptions = {
	readonly cwd: string;
	readonly oldPin: string;
	readonly newPin: string;
	/** The project type of the patch set: the readers are its answer. */
	readonly type: ProjectType;
};

export function inspectDependencyAdvisory(
	options: DependencyAdvisoryOptions,
	git: DependencyAdvisoryGitRunner = runGitBytes
): DependencyAdvisoryReport {
	assertSafeRef(options.oldPin, 'old pin');
	assertSafeRef(options.newPin, 'new pin');
	const readers = options.type.advisory.readers;
	// The declared files, in reader order and without repeats: the diff, the
	// report and the file list all keep this one order.
	const paths = [...new Set(readers.flatMap((reader) => reader.paths))];
	const pins: Side = {
		old: resolveCommit(options.cwd, options.oldPin, 'old pin', git),
		next: resolveCommit(options.cwd, options.newPin, 'new pin', git)
	};
	const changed = changedPathSet(options.cwd, pins, paths, git);
	const cache = new Map<string, string | null>();
	const read = (pin: string, path: string): string | null => {
		const key = `${pin}\0${path}`;
		if (!cache.has(key)) {
			cache.set(key, readGitFile(options.cwd, pin, path, git));
		}
		return cache.get(key) ?? null;
	};
	const filesFor = (reader: AdvisoryReader, pin: string): AdvisoryFiles => new Map(reader.paths.map((path) => [path, read(pin, path)]));

	const semanticChanges: DependencyAdvisorySemanticChange[] = [];
	const included = new Set<string>();
	for (const reader of readers) {
		const touched = reader.paths.filter((path) => changed.has(path));
		if (touched.length === 0) {
			continue;
		}
		if (reader.changeIsNews) {
			for (const path of touched) {
				included.add(path);
			}
		}
		const before = reading(reader, filesFor(reader, pins.old), pins.old);
		const after = reading(reader, filesFor(reader, pins.next), pins.next);
		if (same(before, after)) {
			continue;
		}
		const meaning = reader.meaning(before, after);
		if (meaning === null) {
			continue;
		}
		for (const path of touched) {
			included.add(path);
		}
		semanticChanges.push({ kind: reader.id, paths: reader.paths, before, after, meaning });
	}

	const changedFiles = paths
		.filter((path) => included.has(path))
		.map((path) => ({ path, change: fileChange(read(pins.old, path), read(pins.next, path), path) }));
	return {
		version: 1,
		oldPin: pins.old,
		newPin: pins.next,
		changedFiles,
		semanticChanges
	};
}

/**
 * One reading of one reader, with a refusal of the type turned into the
 * diagnosed error of the tool. The pin belongs in that message and only the
 * engine knows it: a reader is handed text and never learns where it came from.
 */
function reading(reader: AdvisoryReader, files: AdvisoryFiles, pin: string): AdvisoryValue {
	try {
		return reader.read(files);
	} catch (error) {
		if (!isBrokenArtifact(error)) {
			throw error;
		}
		throw ckError('ARTIFACT-BROKEN', `${pin}: ${error.message}`, error.hint, reader.paths[0]);
	}
}

export function dependencyAdvisoryAcknowledgement(report: DependencyAdvisoryReport): string | null {
	if (report.changedFiles.length === 0) {
		return null;
	}
	const digest = createHash('sha256').update(JSON.stringify(report)).digest('hex');
	return `deps-advisory-v1:${report.newPin}:${digest}`;
}

export function isDependencyAdvisoryAcknowledged(report: DependencyAdvisoryReport, acknowledgement: string | null | undefined): boolean {
	const expected = dependencyAdvisoryAcknowledgement(report);
	return expected === null || acknowledgement === expected;
}

export function shouldStopForDependencyAdvisory(report: DependencyAdvisoryReport, gate: DependencyAdvisoryGate): boolean {
	return !gate.ci && !isDependencyAdvisoryAcknowledged(report, gate.acknowledgement);
}

function assertSafeRef(ref: string, label: string): void {
	if (!SAFE_REF.test(ref)) {
		throw ckError('CONFIG', `${label} is not a safe Git revision: ${JSON.stringify(ref)}`, 'use a tag or full commit sha');
	}
}

function resolveCommit(cwd: string, ref: string, label: string, git: DependencyAdvisoryGitRunner): string {
	const result = git({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd });
	if (result.status !== 0) {
		throw ckError(
			'PIN-UNREACHABLE',
			`cannot resolve dependency advisory ${label} ${ref}: ${diagnostic(result)}`,
			'restore the exact commit in the fork repository before continuing the cycle'
		);
	}
	const sha = decodeGitText(result.stdout, `${label} resolution`).trim();
	if (!FULL_SHA.test(sha)) {
		throw ckError('ARTIFACT-BROKEN', `git returned an invalid commit id for dependency advisory ${label}: ${JSON.stringify(sha)}`);
	}
	return sha;
}

function changedPathSet(cwd: string, pins: Side, paths: readonly string[], git: DependencyAdvisoryGitRunner): ReadonlySet<string> {
	if (paths.length === 0) {
		return new Set();
	}
	const result = git({
		args: ['diff', '--name-only', '-z', '--no-renames', pins.old, pins.next, '--', ...paths],
		cwd
	});
	if (result.status !== 0) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot diff dependency advisory paths: ${diagnostic(result)}`,
			'run git fsck in the fork repository and restore every required object'
		);
	}
	const output = decodeGitText(result.stdout, 'dependency advisory path list');
	if (output === '') {
		return new Set();
	}
	if (!output.endsWith('\0')) {
		throw ckError('ARTIFACT-BROKEN', 'dependency advisory path list is not NUL-terminated');
	}
	const known = new Set<string>(paths);
	const listed = output.slice(0, -1).split('\0');
	for (const path of listed) {
		if (!known.has(path)) {
			throw ckError('ARTIFACT-BROKEN', `git returned an unexpected dependency advisory path: ${JSON.stringify(path)}`);
		}
	}
	return new Set(listed);
}

function readGitFile(cwd: string, commit: string, path: string, git: DependencyAdvisoryGitRunner): string | null {
	const listed = git({ args: ['ls-tree', '-z', '--full-tree', commit, '--', path], cwd });
	if (listed.status !== 0) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot inspect ${path} at ${commit}: ${diagnostic(listed)}`,
			'run git fsck in the fork repository and restore the commit tree',
			path
		);
	}
	const record = decodeGitText(listed.stdout, `${commit}:${path} tree entry`);
	if (record === '') {
		return null;
	}
	const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/.exec(record);
	if (match === null || match[3] !== path) {
		throw ckError('ARTIFACT-BROKEN', `unexpected Git tree entry for ${path} at ${commit}`, undefined, path);
	}
	const objectId = match[2];
	if (objectId === undefined) {
		throw ckError('ARTIFACT-BROKEN', `Git tree entry for ${path} at ${commit} has no object id`, undefined, path);
	}
	const blob = git({ args: ['cat-file', 'blob', objectId], cwd });
	if (blob.status !== 0) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot read ${path} at ${commit}: ${diagnostic(blob)}`,
			'run git fsck in the fork repository and restore the missing blob',
			path
		);
	}
	if (containsByte(blob.stdout, NUL_BYTE)) {
		throw ckError('ENCODING', `dependency advisory input is binary at ${commit}: ${path}`, 'restore a UTF-8 text file', path);
	}
	const text = decodeUtf8Strict(blob.stdout);
	if (text === null) {
		throw ckError('ENCODING', `dependency advisory input is not valid UTF-8 at ${commit}: ${path}`, 'restore UTF-8 text', path);
	}
	return text;
}

function fileChange(before: string | null, after: string | null, path: string): DependencyAdvisoryFileChange['change'] {
	if (before === null && after !== null) {
		return 'added';
	}
	if (before !== null && after === null) {
		return 'deleted';
	}
	if (before !== null && after !== null) {
		return 'modified';
	}
	throw ckError('ARTIFACT-BROKEN', `git reported ${path} as changed, but it is absent at both dependency advisory pins`, undefined, path);
}

function same(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function decodeGitText(bytes: Uint8Array, description: string): string {
	const text = decodeUtf8Strict(bytes);
	if (text === null) {
		throw ckError('ENCODING', `git returned invalid UTF-8 for ${description}`);
	}
	return text;
}

function diagnostic(result: GitBytesResult): string {
	const detail = result.stderr.trim();
	return detail === '' ? `git exited ${result.status}` : detail;
}
