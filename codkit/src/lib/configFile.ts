/** @scope spec://codkit/modules/codkit/PROP-003#root */
// codkit.json + codkit.local.json: schema, diagnostics, merge (PROP-003 sec. 1-2).
//
// Two rules shape this module:
//   * schema versioning (##SCHEMA-MIGRATION-RULE): a file declaring a version
//     newer than this tool is a hard stop, checked before anything else;
//   * the pin is not locally overridable (##LOCAL-CONFIG-RULE): pin.*,
//     upstreamAnchorCommit and codkitConfig in codkit.local.json are refused.
//
// Diagnostics are written here, in the vocabulary of PROP-012 sec. 2 - never the
// raw validator output (##SCHEMAS-ARE-ZOD).

import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { bytesEqual, CR_BYTE, decodeUtf8Strict, encodeUtf8, LF_BYTE } from './bytes.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem, resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';

export const CONFIG_FILE_NAME = 'codkit.json';
export const LOCAL_CONFIG_FILE_NAME = 'codkit.local.json';

/** Schema version this tool reads and writes. */
export const CONFIG_SCHEMA_VERSION = 1;

export type PinConfig = {
	readonly tag: string;
	readonly sha: string;
	readonly date: string;
};

export type CodkitConfig = {
	readonly codkitConfig: number;
	readonly pin: PinConfig;
	readonly upstreamAnchorCommit: string;
	readonly ownDirName: string;
	readonly generatedBranchPrefix: string;
	readonly cycleBranchPrefix: string;
	readonly releaseRefPrefix: string;
	readonly publishRemoteUrl: string | null;
	readonly buildWatchFile: string | null;
	readonly conventionsExtensionFile: string | null;
};

const SHA40 = /^[0-9a-f]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const repositoryFilePath = z
	.string()
	.min(1)
	.refine((value) => repoRelativePathProblem(value) === null);

const pinSchema = z.object({
	tag: z
		.string()
		.min(1)
		.refine((value) => safeBasenameProblem(value) === null),
	sha: z.string().regex(SHA40),
	date: z.string().regex(ISO_DATE)
});

const configSchema = z.object({
	codkitConfig: z.literal(CONFIG_SCHEMA_VERSION),
	pin: pinSchema,
	upstreamAnchorCommit: z.string().regex(SHA40),
	ownDirName: z
		.string()
		.min(1)
		.refine((value) => safeBasenameProblem(value) === null),
	generatedBranchPrefix: z.string().min(1),
	cycleBranchPrefix: z.string().min(1),
	releaseRefPrefix: z.string().min(1),
	publishRemoteUrl: z.string().nullable().default(null),
	buildWatchFile: repositoryFilePath.nullable().default(null),
	conventionsExtensionFile: repositoryFilePath.nullable().default(null)
});

/** codkit.local.json: same field vocabulary, everything optional. */
const localConfigSchema = z.object({
	ownDirName: z
		.string()
		.min(1)
		.refine((value) => safeBasenameProblem(value) === null)
		.optional(),
	generatedBranchPrefix: z.string().min(1).optional(),
	cycleBranchPrefix: z.string().min(1).optional(),
	releaseRefPrefix: z.string().min(1).optional(),
	publishRemoteUrl: z.string().nullable().optional()
});

type LocalConfig = z.infer<typeof localConfigSchema>;

const CONFIG_KEYS: readonly string[] = [
	'codkitConfig',
	'pin',
	'upstreamAnchorCommit',
	'ownDirName',
	'generatedBranchPrefix',
	'cycleBranchPrefix',
	'releaseRefPrefix',
	'publishRemoteUrl',
	'buildWatchFile',
	'conventionsExtensionFile'
];

const PIN_KEYS: readonly string[] = ['tag', 'sha', 'date'];

/** Fields codkit.local.json may carry; the rest are pin-bearing and refused. */
const LOCAL_ALLOWED_KEYS: readonly string[] = [
	'ownDirName',
	'generatedBranchPrefix',
	'cycleBranchPrefix',
	'releaseRefPrefix',
	'publishRemoteUrl'
];

/** Fields that exist in the base config but must never be overridden locally. */
const LOCAL_REFUSED_KEYS: readonly string[] = ['codkitConfig', 'pin', 'upstreamAnchorCommit', 'buildWatchFile', 'conventionsExtensionFile'];

type FieldDoc = { readonly required: string; readonly invalid: string; readonly hint: string };

/**
 * Per-field diagnostics. `required` is used when the field is absent from the
 * file, `invalid` when it is present but malformed. The text for pin.sha is
 * fixed by PROP-003 ##CONFIG-INVALID-SAMPLE and covered by a test.
 */
const FIELD_DOCS: Readonly<Record<string, FieldDoc>> = {
	codkitConfig: {
		required: `codkitConfig is required (schema version, must be ${CONFIG_SCHEMA_VERSION})`,
		invalid: `codkitConfig must be exactly ${CONFIG_SCHEMA_VERSION}`,
		hint: `set "codkitConfig": ${CONFIG_SCHEMA_VERSION}`
	},
	pin: {
		required: 'pin is required (object with tag, sha and date of the upstream pin)',
		invalid: 'pin must be an object with tag, sha and date',
		hint: 'set "pin": { "tag": "1.135.0", "sha": "<40 hex>", "date": "YYYY-MM-DD" }'
	},
	'pin.tag': {
		required: 'pin.tag is required (name of the upstream tag, e.g. "1.135.0")',
		invalid: 'pin.tag must be a non-empty upstream tag name, e.g. "1.135.0"',
		hint: 'set "pin": { "tag": "1.135.0", ... }'
	},
	'pin.sha': {
		required: 'pin.sha is required (full 40-hex commit sha of the pin tag)',
		invalid: 'pin.sha must be a full 40-hex commit sha of the pin tag',
		hint: 'run: git rev-parse <pin.tag>^{commit} in the fork tree and put the result in codkit.json'
	},
	'pin.date': {
		required: 'pin.date is required (commit date of the pin, YYYY-MM-DD)',
		invalid: 'pin.date must be a date in YYYY-MM-DD form',
		hint: 'run: git show -s --format=%cs <pin.sha> in the fork tree'
	},
	upstreamAnchorCommit: {
		required: 'upstreamAnchorCommit is required (40-hex root commit of the upstream history)',
		invalid: 'upstreamAnchorCommit must be a full 40-hex commit sha',
		hint: 'run: git rev-list --max-parents=0 <pin.sha> in the fork tree (lowest sha if several)'
	},
	ownDirName: {
		required: 'ownDirName is required (directory name of own code under src/vs/)',
		invalid: 'ownDirName must be one safe directory basename without path separators',
		hint: 'set "ownDirName": "patchset"'
	},
	generatedBranchPrefix: {
		required: 'generatedBranchPrefix is required (branch namespace of generated branches)',
		invalid: 'generatedBranchPrefix must be a non-empty string',
		hint: 'set "generatedBranchPrefix": "codkit/applied/"'
	},
	cycleBranchPrefix: {
		required: 'cycleBranchPrefix is required (branch namespace of upgrade cycles)',
		invalid: 'cycleBranchPrefix must be a non-empty string',
		hint: 'set "cycleBranchPrefix": "codkit/cycle/"'
	},
	releaseRefPrefix: {
		required: 'releaseRefPrefix is required (ref namespace of published releases)',
		invalid: 'releaseRefPrefix must be a non-empty string',
		hint: 'set "releaseRefPrefix": "codkit/release/"'
	},
	publishRemoteUrl: {
		required: 'publishRemoteUrl is required',
		invalid: 'publishRemoteUrl must be a URL string or null',
		hint: 'set "publishRemoteUrl": null until a publishing remote exists'
	},
	buildWatchFile: {
		required: 'buildWatchFile is required',
		invalid: 'buildWatchFile must be a safe repository-relative path or null',
		hint: 'set "buildWatchFile": null or name a versioned JSON file inside the patch-set repository'
	},
	conventionsExtensionFile: {
		required: 'conventionsExtensionFile is required',
		invalid: 'conventionsExtensionFile must be a safe repository-relative path or null',
		hint: 'set "conventionsExtensionFile": null or name a versioned JSON file inside the patch-set repository'
	}
};

const FALLBACK_DOC: FieldDoc = {
	required: 'is required',
	invalid: 'has an invalid value',
	hint: 'see PROP-003 sec. 2 for the field list of codkit.json'
};

/**
 * Read codkit.json (and codkit.local.json on top of it) from the patchset root.
 * Returns null when codkit.json does not exist - an absent config is not an
 * error for commands that tolerate it (PROP-007 sec. 2). Throws CkError CONFIG for
 * anything present but unusable.
 */
export function loadConfig(patchesDir: string): CodkitConfig | null {
	const base = loadBaseConfig(patchesDir);
	if (base === null) {
		return null;
	}

	const localPath = containedReadableConfigPath(patchesDir, LOCAL_CONFIG_FILE_NAME);
	if (localPath === null) {
		return base;
	}
	const local = parseLocalConfig(readJsonFile(localPath, LOCAL_CONFIG_FILE_NAME), LOCAL_CONFIG_FILE_NAME);
	return mergeLocal(base, local);
}

/** Read only the shared base config, before any personal local overrides. */
export function loadBaseConfig(patchesDir: string): CodkitConfig | null {
	const basePath = containedReadableConfigPath(patchesDir, CONFIG_FILE_NAME);
	if (basePath === null) {
		return null;
	}
	return parseBaseConfig(readJsonFile(basePath, CONFIG_FILE_NAME), CONFIG_FILE_NAME);
}

/** Validate an already-decoded codkit.json body. Exposed for tests. */
export function parseBaseConfig(raw: unknown, fileLabel: string): CodkitConfig {
	const object = expectObject(raw, fileLabel);
	assertSchemaVersion(object, fileLabel);
	assertKnownKeys(object, CONFIG_KEYS, fileLabel, '');
	const pin = object['pin'];
	if (isPlainObject(pin)) {
		assertKnownKeys(pin, PIN_KEYS, fileLabel, 'pin.');
	}

	const parsed = configSchema.safeParse(object);
	if (!parsed.success) {
		throw schemaError(parsed.error.issues, object, fileLabel);
	}
	return parsed.data;
}

/** Validate an already-decoded codkit.local.json body. Exposed for tests. */
export function parseLocalConfig(raw: unknown, fileLabel: string): LocalConfig {
	const object = expectObject(raw, fileLabel);

	for (const key of LOCAL_REFUSED_KEYS) {
		if (Object.prototype.hasOwnProperty.call(object, key)) {
			throw ckError(
				'CONFIG',
				`${key} cannot be overridden locally: the pin is a shared invariant of the repository, ` +
					`it changes only through the upgrade cycle commit`,
				`remove "${key}" from ${LOCAL_CONFIG_FILE_NAME}; keep it in ${CONFIG_FILE_NAME}`,
				fileLabel
			);
		}
	}
	assertKnownKeys(object, LOCAL_ALLOWED_KEYS, fileLabel, '');

	const parsed = localConfigSchema.safeParse(object);
	if (!parsed.success) {
		throw schemaError(parsed.error.issues, object, fileLabel);
	}
	return parsed.data;
}

/** Apply the non-empty fields of codkit.local.json on top of the base config. */
export function mergeLocal(base: CodkitConfig, local: LocalConfig): CodkitConfig {
	return {
		codkitConfig: base.codkitConfig,
		pin: base.pin,
		upstreamAnchorCommit: base.upstreamAnchorCommit,
		ownDirName: overrideOrKeep(base.ownDirName, local.ownDirName),
		generatedBranchPrefix: overrideOrKeep(base.generatedBranchPrefix, local.generatedBranchPrefix),
		cycleBranchPrefix: overrideOrKeep(base.cycleBranchPrefix, local.cycleBranchPrefix),
		releaseRefPrefix: overrideOrKeep(base.releaseRefPrefix, local.releaseRefPrefix),
		publishRemoteUrl: overrideOrKeep(base.publishRemoteUrl, local.publishRemoteUrl),
		buildWatchFile: base.buildWatchFile,
		conventionsExtensionFile: base.conventionsExtensionFile
	};
}

/** Canonical base config bytes; local overrides are never serialized here. */
export function serializeBaseConfig(config: CodkitConfig): string {
	const parsed = parseBaseConfig(config, CONFIG_FILE_NAME);
	const canonical: CodkitConfig = {
		codkitConfig: parsed.codkitConfig,
		pin: { tag: parsed.pin.tag, sha: parsed.pin.sha, date: parsed.pin.date },
		upstreamAnchorCommit: parsed.upstreamAnchorCommit,
		ownDirName: parsed.ownDirName,
		generatedBranchPrefix: parsed.generatedBranchPrefix,
		cycleBranchPrefix: parsed.cycleBranchPrefix,
		releaseRefPrefix: parsed.releaseRefPrefix,
		publishRemoteUrl: parsed.publishRemoteUrl,
		buildWatchFile: parsed.buildWatchFile,
		conventionsExtensionFile: parsed.conventionsExtensionFile
	};
	return `${JSON.stringify(canonical, null, 2)}\n`;
}

export type ConfigFileSystem = {
	readonly readBytes: (path: string) => Uint8Array | null;
	readonly makeDirectory: (path: string) => void;
	readonly writeBytes: (path: string, bytes: Uint8Array) => void;
	readonly rename: (from: string, to: string) => void;
	readonly remove: (path: string) => void;
};

export const nodeConfigFileSystem: ConfigFileSystem = {
	readBytes(path) {
		try {
			return readFileSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
	},
	makeDirectory(path) {
		mkdirSync(path, { recursive: true });
	},
	writeBytes(path, bytes) {
		writeFileSync(path, bytes, { flag: 'wx' });
	},
	rename(from, to) {
		renameSync(from, to);
	},
	remove(path) {
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}
};

export type WriteConfigPinOptions = {
	readonly fileSystem?: ConfigFileSystem;
	readonly temporarySuffix?: () => string;
};

/** Atomically change only the shared base pin; local overrides remain local. */
export function writeConfigPin(patchesDir: string, pin: PinConfig, options: WriteConfigPinOptions = {}): boolean {
	const fileSystem = options.fileSystem ?? nodeConfigFileSystem;
	let path = containedConfigPath(patchesDir);
	let existing: Uint8Array | null;
	try {
		existing = fileSystem.readBytes(path);
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot read ${CONFIG_FILE_NAME} before updating its pin: ${messageOf(error)}`,
			'make the file readable',
			CONFIG_FILE_NAME
		);
	}
	if (existing === null) {
		throw ckError(
			'CONFIG',
			`${CONFIG_FILE_NAME} does not exist`,
			'start a cycle only from a configured patchset checkout',
			CONFIG_FILE_NAME
		);
	}
	const base = parseBaseConfig(parseConfigBytes(existing), CONFIG_FILE_NAME);
	const next = encodeUtf8(serializeBaseConfig({ ...base, pin }));
	if (bytesEqual(existing, next)) {
		return false;
	}

	try {
		fileSystem.makeDirectory(dirname(path));
		path = containedConfigPath(patchesDir);
	} catch (error) {
		throw ckError('CONFIG', `cannot prepare ${CONFIG_FILE_NAME}: ${messageOf(error)}`, 'make the patchset root writable', CONFIG_FILE_NAME);
	}
	const suffix = (options.temporarySuffix ?? randomUUID)();
	if (safeBasenameProblem(suffix) !== null) {
		throw ckError('INTERNAL', 'config temporary suffix must be one portable non-empty basename');
	}
	const temporary = `${path}.${suffix}.tmp`;
	let renamed = false;
	try {
		fileSystem.writeBytes(temporary, next);
		fileSystem.rename(temporary, path);
		renamed = true;
		return true;
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot atomically update ${CONFIG_FILE_NAME}: ${messageOf(error)}`,
			'make the patchset root writable and retry',
			CONFIG_FILE_NAME
		);
	} finally {
		if (!renamed) {
			try {
				fileSystem.remove(temporary);
			} catch {
				// Preserve the primary error; complete unique temp files are ignored.
			}
		}
	}
}

function containedConfigPath(patchesDir: string): string {
	const resolved = resolveContainedPath(patchesDir, CONFIG_FILE_NAME, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`unsafe ${CONFIG_FILE_NAME} path: ${resolved.reason}`,
			'replace symlinks with a real file inside patchset',
			CONFIG_FILE_NAME
		);
	}
	return resolved.absolute;
}

function containedReadableConfigPath(patchesDir: string, name: typeof CONFIG_FILE_NAME | typeof LOCAL_CONFIG_FILE_NAME): string | null {
	const candidate = join(patchesDir, name);
	let stat;
	try {
		stat = lstatSync(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw ckError('CONFIG', `cannot inspect ${name}: ${messageOf(error)}`, 'make the file readable', name);
	}
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw ckError('CONFIG', `${name} must be a regular non-symlink file`, 'replace it with a real file inside the patch-set root', name);
	}
	const resolved = resolveContainedPath(patchesDir, name);
	if (!resolved.ok) {
		throw ckError('CONFIG', `unsafe ${name} path: ${resolved.reason}`, 'replace symlinks with a real file inside the patch-set root', name);
	}
	return resolved.absolute;
}

function parseConfigBytes(bytes: Uint8Array): unknown {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw ckError('ENCODING', `${CONFIG_FILE_NAME} must not have a UTF-8 BOM`, 'write UTF-8 without BOM', CONFIG_FILE_NAME);
	}
	const text = decodeUtf8Strict(bytes);
	if (text === null) {
		throw ckError('ENCODING', `${CONFIG_FILE_NAME} is not valid UTF-8`, 'write UTF-8 without BOM', CONFIG_FILE_NAME);
	}
	if (bytes.indexOf(CR_BYTE) !== -1) {
		throw ckError('CRLF', `${CONFIG_FILE_NAME} contains a carriage return`, 'use LF line endings', CONFIG_FILE_NAME);
	}
	if (bytes.length === 0 || bytes[bytes.length - 1] !== LF_BYTE || (bytes.length > 1 && bytes[bytes.length - 2] === LF_BYTE)) {
		throw ckError('EOF-NEWLINE', `${CONFIG_FILE_NAME} must end with exactly one LF`, 'add one final LF', CONFIG_FILE_NAME);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw ckError('CONFIG', `${CONFIG_FILE_NAME} is not valid JSON: ${messageOf(error)}`, 'fix the JSON syntax', CONFIG_FILE_NAME);
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * "Non-empty wins": absent, null and empty-string local values leave the base
 * value in place, so a half-filled personal file cannot blank out the config.
 */
function overrideOrKeep<T extends string | null>(base: T, local: string | null | undefined): T | string {
	if (local === undefined || local === null || local === '') {
		return base;
	}
	return local;
}

function assertSchemaVersion(object: Readonly<Record<string, unknown>>, fileLabel: string): void {
	const declared = object['codkitConfig'];
	if (typeof declared === 'number' && Number.isInteger(declared) && declared > CONFIG_SCHEMA_VERSION) {
		throw ckError(
			'CONFIG',
			`schema version ${declared} is newer than this tool understands (supported: ${CONFIG_SCHEMA_VERSION}); ` +
				`the format is newer than the tool, update codkit`,
			'update codkit to a version that reads this format, then re-run',
			fileLabel
		);
	}
}

function assertKnownKeys(object: Readonly<Record<string, unknown>>, known: readonly string[], fileLabel: string, prefix: string): void {
	const unknownKeys = Object.keys(object).filter((key) => !known.includes(key));
	if (unknownKeys.length === 0) {
		return;
	}
	const rendered = unknownKeys.map((key) => `${prefix}${key}`).join(', ');
	throw ckError(
		'CONFIG',
		`unknown field(s): ${rendered}`,
		`remove them; the allowed fields are: ${known.map((key) => `${prefix}${key}`).join(', ')}`,
		fileLabel
	);
}

type SchemaIssue = { readonly path: ReadonlyArray<PropertyKey>; readonly message: string };

function schemaError(issues: readonly SchemaIssue[], raw: unknown, fileLabel: string): Error {
	const issue = issues[0];
	if (issue === undefined) {
		return ckError('CONFIG', 'failed validation', FALLBACK_DOC.hint, fileLabel);
	}
	const path = issue.path.map((segment) => String(segment)).join('.');
	const doc = FIELD_DOCS[path] ?? FALLBACK_DOC;
	// Distinguish "absent" from "present but wrong" by looking at the raw input
	// rather than at validator-specific issue codes.
	const absent = valueAtPath(raw, issue.path) === undefined;
	return ckError('CONFIG', withFieldPath(path, absent ? doc.required : doc.invalid), doc.hint, fileLabel);
}

/** Field texts already name their field; only generic fallbacks need the prefix. */
function withFieldPath(path: string, text: string): string {
	if (path === '' || text.startsWith(path)) {
		return text;
	}
	return `${path} ${text}`;
}

function valueAtPath(raw: unknown, path: ReadonlyArray<PropertyKey>): unknown {
	let current: unknown = raw;
	for (const segment of path) {
		if (!isPlainObject(current)) {
			return undefined;
		}
		current = current[String(segment)];
	}
	return current;
}

function readJsonFile(absolutePath: string, fileLabel: string): unknown {
	let text: string;
	try {
		text = readFileSync(absolutePath, 'utf8');
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			'check file permissions',
			fileLabel
		);
	}
	if (text.charCodeAt(0) === 0xfeff) {
		throw ckError('CONFIG', 'must be UTF-8 without BOM', 're-save the file as UTF-8 without a byte order mark', fileLabel);
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw ckError(
			'CONFIG',
			`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			'fix the JSON syntax; codkit config files are plain JSON without comments',
			fileLabel
		);
	}
}

function expectObject(raw: unknown, fileLabel: string): Readonly<Record<string, unknown>> {
	if (!isPlainObject(raw)) {
		throw ckError('CONFIG', 'must contain a JSON object', 'see PROP-003 sec. 2 for the field list', fileLabel);
	}
	return raw;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
