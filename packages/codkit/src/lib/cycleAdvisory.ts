/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { createHash } from 'node:crypto';
import { containsByte, decodeUtf8Strict, NUL_BYTE } from './bytes.ts';
import type { GitBytesResult, RunGitOptions } from './gitx.ts';
import { runGitBytes } from './gitx.ts';
import { extractNpmDirectories } from './cycleAdvisoryAst.ts';
import { ckError } from './messages.ts';
export const DEPENDENCY_ADVISORY_PATHS = [
	'.nvmrc',
	'package.json',
	'package-lock.json',
	'build/npm/dirs.ts',
	'product.json',
	'build/lib/electron.ts'
] as const;
export type DependencyAdvisoryPath = (typeof DEPENDENCY_ADVISORY_PATHS)[number];
export type DependencyAdvisoryGitRunner = (options: RunGitOptions) => GitBytesResult;
export type DependencyAdvisoryFileChange = {
	readonly path: DependencyAdvisoryPath;
	readonly change: 'added' | 'modified' | 'deleted';
};
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type DependencyAdvisorySemanticChange =
	| {
			readonly kind: 'node-version';
			readonly path: '.nvmrc';
			readonly before: string | null;
			readonly after: string | null;
	  }
	| {
			readonly kind: 'package-manifest';
			readonly path: 'package.json';
			readonly before: JsonValue;
			readonly after: JsonValue;
	  }
	| {
			readonly kind: 'package-lock';
			readonly path: 'package-lock.json';
			readonly before: JsonValue;
			readonly after: JsonValue;
	  }
	| {
			readonly kind: 'npm-directories';
			readonly path: 'build/npm/dirs.ts';
			readonly before: readonly string[] | null;
			readonly after: readonly string[] | null;
	  }
	| {
			readonly kind: 'built-in-extensions';
			readonly path: 'product.json';
			readonly before: JsonValue;
			readonly after: JsonValue;
	  }
	| {
			readonly kind: 'electron-versions';
			readonly paths: readonly ['package.json', 'build/lib/electron.ts'];
			readonly before: readonly ElectronVersionValue[];
			readonly after: readonly ElectronVersionValue[];
	  };

export type ElectronVersionValue = {
	readonly path: 'package.json' | 'build/lib/electron.ts';
	readonly locator: string;
	readonly value: string;
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

type GitFile = {
	readonly text: string;
};

type ParsedJson = { readonly [key: string]: JsonValue };

const PRIMARY_PATHS: ReadonlySet<DependencyAdvisoryPath> = new Set(['.nvmrc', 'package.json', 'package-lock.json', 'build/npm/dirs.ts']);

const PACKAGE_SUMMARY_KEYS = [
	'packageManager',
	'engines',
	'dependencies',
	'devDependencies',
	'optionalDependencies',
	'peerDependencies',
	'overrides',
	'resolutions'
] as const;

const LOCK_ROOT_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines'] as const;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SAFE_REF = /^(?!-)[^\u0000-\u0020\u007f]+$/;
const SEMVERISH = /^(?:[~^]|[<>]=?)?v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

export function inspectDependencyAdvisory(
	options: { readonly cwd: string; readonly oldPin: string; readonly newPin: string },
	git: DependencyAdvisoryGitRunner = runGitBytes
): DependencyAdvisoryReport {
	assertSafeRef(options.oldPin, 'old pin');
	assertSafeRef(options.newPin, 'new pin');
	const pins: Side = {
		old: resolveCommit(options.cwd, options.oldPin, 'old pin', git),
		next: resolveCommit(options.cwd, options.newPin, 'new pin', git)
	};
	const changed = changedPathSet(options.cwd, pins, git);
	const files = new Map<string, GitFile | null>();
	const read = (pin: string, path: DependencyAdvisoryPath): GitFile | null => {
		const key = `${pin}\0${path}`;
		if (!files.has(key)) {
			files.set(key, readGitFile(options.cwd, pin, path, git));
		}
		return files.get(key) ?? null;
	};
	const pair = (path: DependencyAdvisoryPath): readonly [GitFile | null, GitFile | null] => [read(pins.old, path), read(pins.next, path)];

	const semanticChanges: DependencyAdvisorySemanticChange[] = [];
	const included = new Set<DependencyAdvisoryPath>();
	for (const path of DEPENDENCY_ADVISORY_PATHS) {
		if (changed.has(path) && PRIMARY_PATHS.has(path)) {
			included.add(path);
		}
	}

	if (changed.has('.nvmrc')) {
		const [beforeFile, afterFile] = pair('.nvmrc');
		const before = nodeVersion(beforeFile, pins.old);
		const after = nodeVersion(afterFile, pins.next);
		if (!same(before, after)) {
			semanticChanges.push({ kind: 'node-version', path: '.nvmrc', before, after });
		}
	}

	let packagePair: readonly [ParsedJson | null, ParsedJson | null] | null = null;
	if (changed.has('package.json')) {
		const [beforeFile, afterFile] = pair('package.json');
		packagePair = [parseJsonObject(beforeFile, 'package.json', pins.old), parseJsonObject(afterFile, 'package.json', pins.next)];
		const before = packageSummary(packagePair[0]);
		const after = packageSummary(packagePair[1]);
		if (!same(before, after)) {
			semanticChanges.push({ kind: 'package-manifest', path: 'package.json', before, after });
		}
	}

	if (changed.has('package-lock.json')) {
		const [beforeFile, afterFile] = pair('package-lock.json');
		const before = packageLockSummary(parseJsonObject(beforeFile, 'package-lock.json', pins.old));
		const after = packageLockSummary(parseJsonObject(afterFile, 'package-lock.json', pins.next));
		if (!same(before, after)) {
			semanticChanges.push({ kind: 'package-lock', path: 'package-lock.json', before, after });
		}
	}

	if (changed.has('build/npm/dirs.ts')) {
		const [beforeFile, afterFile] = pair('build/npm/dirs.ts');
		const before = npmDirectories(beforeFile, pins.old);
		const after = npmDirectories(afterFile, pins.next);
		if (!same(before, after)) {
			semanticChanges.push({ kind: 'npm-directories', path: 'build/npm/dirs.ts', before, after });
		}
	}

	if (changed.has('product.json')) {
		const [beforeFile, afterFile] = pair('product.json');
		const before = builtInExtensions(parseJsonObject(beforeFile, 'product.json', pins.old), pins.old);
		const after = builtInExtensions(parseJsonObject(afterFile, 'product.json', pins.next), pins.next);
		if (!same(before, after)) {
			included.add('product.json');
			semanticChanges.push({ kind: 'built-in-extensions', path: 'product.json', before, after });
		}
	}

	if (changed.has('package.json') || changed.has('build/lib/electron.ts')) {
		if (packagePair === null) {
			const [beforeFile, afterFile] = pair('package.json');
			packagePair = [parseJsonObject(beforeFile, 'package.json', pins.old), parseJsonObject(afterFile, 'package.json', pins.next)];
		}
		const [beforeSource, afterSource] = pair('build/lib/electron.ts');
		const before = electronVersions(packagePair[0], beforeSource);
		const after = electronVersions(packagePair[1], afterSource);
		if (!same(before, after)) {
			if (changed.has('build/lib/electron.ts')) {
				included.add('build/lib/electron.ts');
			}
			semanticChanges.push({
				kind: 'electron-versions',
				paths: ['package.json', 'build/lib/electron.ts'],
				before,
				after
			});
		}
	}

	const changedFiles = DEPENDENCY_ADVISORY_PATHS.filter((path) => included.has(path)).map((path) => ({
		path,
		change: fileChange(read(pins.old, path), read(pins.next, path), path)
	}));
	return {
		version: 1,
		oldPin: pins.old,
		newPin: pins.next,
		changedFiles,
		semanticChanges
	};
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

function changedPathSet(cwd: string, pins: Side, git: DependencyAdvisoryGitRunner): ReadonlySet<DependencyAdvisoryPath> {
	const result = git({
		args: ['diff', '--name-only', '-z', '--no-renames', pins.old, pins.next, '--', ...DEPENDENCY_ADVISORY_PATHS],
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
	const known = new Set<string>(DEPENDENCY_ADVISORY_PATHS);
	const paths = output.slice(0, -1).split('\0');
	for (const path of paths) {
		if (!known.has(path)) {
			throw ckError('ARTIFACT-BROKEN', `git returned an unexpected dependency advisory path: ${JSON.stringify(path)}`);
		}
	}
	return new Set(paths as DependencyAdvisoryPath[]);
}

function readGitFile(cwd: string, commit: string, path: DependencyAdvisoryPath, git: DependencyAdvisoryGitRunner): GitFile | null {
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
	return { text };
}

function fileChange(before: GitFile | null, after: GitFile | null, path: DependencyAdvisoryPath): DependencyAdvisoryFileChange['change'] {
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

function nodeVersion(file: GitFile | null, pin: string): string | null {
	if (file === null) {
		return null;
	}
	const value = file.text.trim();
	if (value === '' || /\s/.test(value)) {
		throw ckError('ARTIFACT-BROKEN', `.nvmrc at ${pin} must contain exactly one nonempty version`, undefined, '.nvmrc');
	}
	return value;
}

function parseJsonObject(file: GitFile | null, path: DependencyAdvisoryPath, pin: string): ParsedJson | null {
	if (file === null) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(file.text) as unknown;
	} catch (error) {
		throw ckError('ARTIFACT-BROKEN', `invalid JSON in ${path} at ${pin}: ${messageOf(error)}`, 'repair the upstream object', path);
	}
	if (!isRecord(parsed)) {
		throw ckError('ARTIFACT-BROKEN', `${path} at ${pin} must contain one JSON object`, 'repair the upstream object', path);
	}
	return normalizeObject(parsed);
}

function packageSummary(value: ParsedJson | null): JsonValue {
	if (value === null) {
		return null;
	}
	const selected: Record<string, JsonValue> = {};
	for (const key of PACKAGE_SUMMARY_KEYS) {
		const field = value[key];
		if (field !== undefined) {
			selected[key] = field;
		}
	}
	return selected;
}

function packageLockSummary(value: ParsedJson | null): JsonValue {
	if (value === null) {
		return null;
	}
	const selected: Record<string, JsonValue> = {};
	if (value['lockfileVersion'] !== undefined) {
		selected['lockfileVersion'] = value['lockfileVersion'];
	}
	const packages = value['packages'];
	if (isJsonObject(packages)) {
		const root = packages[''];
		if (isJsonObject(root)) {
			const rootSelected: Record<string, JsonValue> = {};
			for (const key of LOCK_ROOT_KEYS) {
				const field = root[key];
				if (field !== undefined) {
					rootSelected[key] = field;
				}
			}
			selected['root'] = rootSelected;
		}
	}
	return selected;
}

function builtInExtensions(value: ParsedJson | null, pin: string): JsonValue {
	if (value === null || value['builtInExtensions'] === undefined) {
		return null;
	}
	const extensions = value['builtInExtensions'];
	if (!Array.isArray(extensions)) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`builtInExtensions in product.json at ${pin} must be an array`,
			'repair the upstream product manifest',
			'product.json'
		);
	}
	return extensions;
}

function npmDirectories(file: GitFile | null, pin: string): readonly string[] | null {
	return file === null ? null : extractNpmDirectories(file.text, pin);
}

function electronVersions(packageJson: ParsedJson | null, source: GitFile | null): readonly ElectronVersionValue[] {
	const values: ElectronVersionValue[] = [];
	if (packageJson !== null) {
		collectElectronJson(packageJson, '', values);
	}
	if (source !== null) {
		for (const value of source.text.match(/(?:[~^]|[<>]=?)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g) ?? []) {
			if (SEMVERISH.test(value)) values.push({ path: 'build/lib/electron.ts', locator: 'version-literal', value });
		}
	}
	return dedupeElectron(values).sort(compareElectron);
}

function collectElectronJson(value: JsonValue, pointer: string, output: ElectronVersionValue[]): void {
	if (Array.isArray(value)) {
		value.forEach((item, index) => collectElectronJson(item, `${pointer}/${index}`, output));
		return;
	}
	if (!isJsonObject(value)) {
		return;
	}
	for (const key of Object.keys(value).sort()) {
		const child = value[key];
		if (child === undefined) {
			continue;
		}
		const childPointer = `${pointer}/${escapePointer(key)}`;
		if (key.toLowerCase().includes('electron') && (typeof child === 'string' || typeof child === 'number')) {
			output.push({ path: 'package.json', locator: childPointer, value: String(child) });
		}
		collectElectronJson(child, childPointer, output);
	}
}

function normalizeObject(value: Record<string, unknown>): ParsedJson {
	const normalized: Record<string, JsonValue> = {};
	for (const key of Object.keys(value).sort()) {
		normalized[key] = normalizeJson(value[key]);
	}
	return normalized;
}

function normalizeJson(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(normalizeJson);
	}
	if (isRecord(value)) {
		return normalizeObject(value);
	}
	throw ckError('ARTIFACT-BROKEN', 'JSON contains a value outside the portable data model');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function dedupeElectron(values: readonly ElectronVersionValue[]): ElectronVersionValue[] {
	const seen = new Set<string>();
	return values.filter((value) => {
		const key = `${value.path}\0${value.locator}\0${value.value}`;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function compareElectron(left: ElectronVersionValue, right: ElectronVersionValue): number {
	const a = `${left.path}\0${left.locator}\0${left.value}`;
	const b = `${right.path}\0${right.locator}\0${right.value}`;
	return a < b ? -1 : a > b ? 1 : 0;
}
function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
