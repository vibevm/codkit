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

import { configFieldDocs, schemaError, expectObject, isPlainObject } from './configDiagnostics.ts';
import { z } from 'zod';
import { CR_BYTE, decodeUtf8Strict, LF_BYTE } from './bytes.ts';
import { readContainedFile } from './containedFile.ts';
import { inputsSchema, localInputContentField, localInputsSchema, locateInputs } from './inputsDeclaration.ts';
import type { InputConfig } from './inputsDeclaration.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem, safeBasenameProblem } from './pathSafety.ts';
import { MINIMAL_DISCIPLINE } from './discipline.ts';
import type { DisciplineId } from './discipline.ts';
import type { WorkspaceRecord } from './workspaceRegistry.ts';
import { declaredWorkspaceConfig } from './workspaceConfig.ts';
export const CONFIG_FILE_NAME = 'codkit.json';
export const LOCAL_CONFIG_FILE_NAME = 'codkit.local.json';

/** Schema version this tool reads and writes (##CFG-TYPE-AND-TYPECONFIG). */
export const CONFIG_SCHEMA_VERSION = 4;
export const LEGACY_CONFIG_SCHEMA_VERSION = 2;
const { base: FIELD_DOCS, local: LOCAL_FIELD_DOCS } = configFieldDocs(CONFIG_SCHEMA_VERSION);

/**
 * The two fields schema 2 adds and schema 1 lacks. A file without them is
 * refused naming exactly these and nothing else (##CFG-SCHEMA-1-IS-REFUSED):
 * there is no compatibility layer, and no code path infers a type.
 */
export const SCHEMA_2_FIELDS = 'type, typeConfig.ownRoot';

export type { PinConfig } from './pinIdentity.ts';
import type { PinConfig } from './pinIdentity.ts';
import { legacyPinSchema as pinSchema, revisionPinSchema } from './pinIdentity.ts';

/**
 * The section the project type validates with its own schema. `ownRoot` is the
 * one field the engine reads by itself - the own root is a full path from the
 * tree root and every engine that mirrors, excludes or names the own layer
 * needs it (##CFG-TYPE-AND-TYPECONFIG, PROP-016 ##TYPE-OWN-ROOT). Everything
 * else in the section belongs to the type and reaches the engine as opaque.
 */
export type TypeConfig = {
	readonly ownRoot: string;
	readonly [field: string]: unknown;
};

/** One entry of `publish.scrub.vocabulary`: a literal token, or a regular expression. */
export type VocabularyEntry = string | { readonly regex: string };

/**
 * `publish.scrub` (##CFG-PUBLISH-SCRUB-SPEC-ROOTS, ##CFG-PUBLISH-SCRUB-VOCABULARY,
 * ##CFG-PUBLISH-SCRUB-ALLOW): where the vocabulary of a scrubbed release comes
 * from beyond the intervention ids, what the owner adds to it, and which tokens
 * the release may still carry.
 */
export type ScrubConfig = {
	/** Absent means DEFAULT_SPEC_ROOTS. */
	readonly specRoots?: readonly string[] | undefined;
	readonly vocabulary: readonly VocabularyEntry[];
	readonly allow: readonly string[];
};

/** The `publish` section (##CFG-PUBLISH-EXCLUDE): what a scrubbed release leaves out. */
export type PublishConfig = {
	readonly exclude: readonly string[];
	readonly scrub?: ScrubConfig | undefined;
};

export type { InputConfig } from './inputsDeclaration.ts';

/** Where a patch set keeps its spec documents unless `publish.scrub.specRoots` says otherwise. */
export const DEFAULT_SPEC_ROOTS: readonly string[] = ['vibevm/vibespecs'];

export type CodkitConfig = {
	/** Composition-only context; never accepted from or written into config JSON. */
	readonly workspace?: {
		readonly registryRoot: string;
		readonly record: WorkspaceRecord;
		readonly declared: {
			readonly generatedBranchPrefix: string;
			readonly cycleBranchPrefix: string;
			readonly releaseRefPrefix: string;
		};
	};
	readonly codkitConfig: number;
	readonly pin: PinConfig;
	readonly upstreamAnchorCommit: string;
	/** The identifier of the project type this patch set declares. */
	readonly type: string;
	readonly typeConfig: TypeConfig;
	readonly discipline?: DisciplineId | undefined;
	readonly generatedBranchPrefix: string;
	readonly cycleBranchPrefix: string;
	readonly releaseRefPrefix: string;
	readonly publishRemoteUrl: string | null;
	readonly buildWatchFile: string | null;
	readonly conventionsExtensionFile: string | null;
	/** Absent unless the file carries it; written before `publish` (##CFG-INPUTS). */
	readonly inputs?: readonly InputConfig[] | undefined;
	/** Absent unless the file carries it; written last (##CFG-PUBLISH-EXCLUDE). */
	readonly publish?: PublishConfig | undefined;
};

const SHA40 = /^[0-9a-f]{40}$/;
const repositoryFilePath = z
	.string()
	.min(1)
	.refine((value) => repoRelativePathProblem(value) === null);

const typeConfigSchema = z
	.object({
		ownRoot: z
			.string()
			.min(1)
			.refine((value) => repoRelativePathProblem(value) === null)
	})
	.loose();

/** A literal token of the vocabulary starts and ends with a letter, a digit or `_`. */
const WORD_BOUNDED = /^[\p{L}\p{N}_](?:.*[\p{L}\p{N}_])?$/su;

/** A pattern of the vocabulary compiles as a `u` regular expression and never matches nothing. */
function usablePattern(source: string): boolean {
	try {
		return !new RegExp(`^(?:${source})$`, 'u').test('');
	} catch {
		return false;
	}
}

const scrubSchema = z.strictObject({
	specRoots: z.array(repositoryFilePath).optional(),
	vocabulary: z
		.array(z.union([z.string().regex(WORD_BOUNDED), z.strictObject({ regex: z.string().min(1).refine(usablePattern) })]))
		.default([]),
	allow: z.array(z.string().min(1)).default([])
});

const publishSchema = z.strictObject({ exclude: z.array(repositoryFilePath).default([]), scrub: scrubSchema.optional() });

const configFields = {
	pin: pinSchema,
	upstreamAnchorCommit: z.string().regex(SHA40),
	type: z
		.string()
		.min(1)
		.refine((value) => safeBasenameProblem(value) === null),
	typeConfig: typeConfigSchema,
	generatedBranchPrefix: z.string().min(1),
	cycleBranchPrefix: z.string().min(1),
	releaseRefPrefix: z.string().min(1),
	publishRemoteUrl: z.string().nullable().default(null),
	buildWatchFile: repositoryFilePath.nullable().default(null),
	conventionsExtensionFile: repositoryFilePath.nullable().default(null),
	inputs: inputsSchema.optional(),
	publish: publishSchema.optional()
};

const configSchema = z.discriminatedUnion('codkitConfig', [
	z.object({ codkitConfig: z.literal(LEGACY_CONFIG_SCHEMA_VERSION), ...configFields }),
	z.object({ codkitConfig: z.literal(3), discipline: z.literal(MINIMAL_DISCIPLINE), ...configFields }),
	z.object({
		codkitConfig: z.literal(CONFIG_SCHEMA_VERSION),
		discipline: z.literal(MINIMAL_DISCIPLINE),
		...configFields,
		pin: revisionPinSchema
	})
]);

/** codkit.local.json: same field vocabulary, everything optional; an input carries only its location. */
const localConfigSchema = z.object({
	typeConfig: typeConfigSchema.optional(),
	generatedBranchPrefix: z.string().min(1).optional(),
	cycleBranchPrefix: z.string().min(1).optional(),
	releaseRefPrefix: z.string().min(1).optional(),
	publishRemoteUrl: z.string().nullable().optional(),
	inputs: localInputsSchema.optional(),
	publish: publishSchema.optional()
});

export type LocalConfig = z.infer<typeof localConfigSchema>;

const CONFIG_KEYS: readonly string[] = [
	'codkitConfig',
	'discipline',
	'pin',
	'upstreamAnchorCommit',
	'type',
	'typeConfig',
	'generatedBranchPrefix',
	'cycleBranchPrefix',
	'releaseRefPrefix',
	'publishRemoteUrl',
	'buildWatchFile',
	'conventionsExtensionFile',
	'inputs',
	'publish'
];

const PIN_KEYS: readonly string[] = ['tag', 'sha', 'date'];
const REVISION_PIN_KEYS: readonly string[] = [...PIN_KEYS, 'resolvedAt', 'provenance'];

/** Fields codkit.local.json may carry; the rest are pin-bearing and refused. */
const LOCAL_ALLOWED_KEYS: readonly string[] = [
	'typeConfig',
	'generatedBranchPrefix',
	'cycleBranchPrefix',
	'releaseRefPrefix',
	'publishRemoteUrl',
	'inputs',
	'publish'
];

/** Fields that exist in the base config but must never be overridden locally. */
const LOCAL_REFUSED_KEYS: readonly string[] = [
	'codkitConfig',
	'discipline',
	'pin',
	'upstreamAnchorCommit',
	'type',
	'buildWatchFile',
	'conventionsExtensionFile'
];

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

	const localBytes = readConfigBytes(patchesDir, LOCAL_CONFIG_FILE_NAME);
	if (localBytes === null) {
		return base;
	}
	const local = parseLocalConfig(parseJsonText(localBytes, LOCAL_CONFIG_FILE_NAME), LOCAL_CONFIG_FILE_NAME);
	return mergeLocal(base, local);
}

/** Read only codkit.local.json; null when the patch set has none. */
export function loadLocalConfig(patchesDir: string): LocalConfig | null {
	const bytes = readConfigBytes(patchesDir, LOCAL_CONFIG_FILE_NAME);
	return bytes === null ? null : parseLocalConfig(parseJsonText(bytes, LOCAL_CONFIG_FILE_NAME), LOCAL_CONFIG_FILE_NAME);
}

/** Read only the shared base config, before any personal local overrides. */
export function loadBaseConfig(patchesDir: string): CodkitConfig | null {
	const bytes = readConfigBytes(patchesDir, CONFIG_FILE_NAME);
	if (bytes === null) {
		return null;
	}
	return parseBaseConfig(parseJsonText(bytes, CONFIG_FILE_NAME), CONFIG_FILE_NAME);
}

/**
 * The one contained reader for the config files (PROP-002
 * ##CONTAINED-FILE-IO): parents proven real directories, the leaf opened
 * without following a symlink, the descriptor proven inside the patch-set
 * root. No check-then-open window on the leaf.
 */
function readConfigBytes(patchesDir: string, name: typeof CONFIG_FILE_NAME | typeof LOCAL_CONFIG_FILE_NAME): Uint8Array | null {
	return configReadResult(patchesDir, name);
}

function configReadResult(patchesDir: string, name: string): Uint8Array | null {
	const read = readContainedFile(patchesDir, name, { what: name });
	return read.state === 'ok' ? read.bytes : null;
}

/** Decode config bytes with the config family's BOM discipline (PROP-003 sec. 1). */
function parseJsonText(bytes: Uint8Array, fileLabel: string): unknown {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw ckError('CONFIG', 'must be UTF-8 without BOM', 're-save the file as UTF-8 without a byte order mark', fileLabel);
	}
	const text = decodeUtf8Strict(bytes);
	if (text === null) {
		throw ckError('CONFIG', 'must contain valid UTF-8', 're-save the file as UTF-8 without replacement bytes', fileLabel);
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

/** Validate an already-decoded codkit.json body. Exposed for tests. */
export function parseBaseConfig(raw: unknown, fileLabel: string): CodkitConfig {
	const object = expectObject(raw, fileLabel);
	assertSchemaVersion(object, fileLabel);
	assertSchemaTwo(object, fileLabel);
	if (object['codkitConfig'] === LEGACY_CONFIG_SCHEMA_VERSION && Object.prototype.hasOwnProperty.call(object, 'discipline'))
		throw ckError(
			'CONFIG',
			'discipline requires codkitConfig: 3',
			'explicitly migrate the configuration before declaring a profile',
			fileLabel
		);
	assertKnownKeys(object, CONFIG_KEYS, fileLabel, '');
	const pin = object['pin'];
	if (object['codkitConfig'] === 4 && isPlainObject(pin) && typeof pin['tag'] === 'string' && /^sha-[0-9a-f]{40}$/.test(pin['tag']))
		throw ckError(
			'CONFIG',
			'pin.tag uses the reserved revision-key namespace',
			'omit the label or choose a different portable label',
			fileLabel
		);
	if (isPlainObject(pin)) {
		assertKnownKeys(pin, object['codkitConfig'] === 4 ? REVISION_PIN_KEYS : PIN_KEYS, fileLabel, 'pin.');
	}

	const parsed = configSchema.safeParse(object);
	if (!parsed.success) {
		throw schemaError(parsed.error.issues, object, fileLabel, FIELD_DOCS);
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
	const publish = object['publish'];
	const scrub = isPlainObject(publish) ? publish['scrub'] : undefined;
	if (isPlainObject(scrub) && Object.prototype.hasOwnProperty.call(scrub, 'allow')) {
		throw ckError(
			'CONFIG',
			'publish.scrub.allow cannot be set locally: a local file can scrub and check more of a release, never less',
			`remove "allow" from ${LOCAL_CONFIG_FILE_NAME}; keep the list in ${CONFIG_FILE_NAME}, where it is reviewed`,
			fileLabel
		);
	}
	refuseLocalInputContent(object['inputs'], fileLabel);

	const parsed = localConfigSchema.safeParse(object);
	if (!parsed.success) {
		throw schemaError(parsed.error.issues, object, fileLabel, LOCAL_FIELD_DOCS);
	}
	return parsed.data;
}

/** ##LOCAL-CONFIG-RULE: a local entry of `inputs` names the location of an input and nothing it takes. */
function refuseLocalInputContent(inputs: unknown, fileLabel: string): void {
	const field = localInputContentField(inputs);
	if (field === null) return;
	throw ckError(
		'CONFIG',
		`inputs.${field} cannot be set locally: ${LOCAL_CONFIG_FILE_NAME} may name only the repository of an input on this machine`,
		`remove "${field}" from ${LOCAL_CONFIG_FILE_NAME}; what an input takes is declared in ${CONFIG_FILE_NAME}, where it is reviewed`,
		fileLabel
	);
}

/** Apply the non-empty fields of codkit.local.json on top of the base config. */
export function mergeLocal(base: CodkitConfig, local: LocalConfig): CodkitConfig {
	return {
		codkitConfig: base.codkitConfig,
		pin: base.pin,
		upstreamAnchorCommit: base.upstreamAnchorCommit,
		type: base.type,
		typeConfig: local.typeConfig ?? base.typeConfig,
		...(base.discipline === undefined ? {} : { discipline: base.discipline }),
		generatedBranchPrefix: overrideOrKeep(base.generatedBranchPrefix, local.generatedBranchPrefix),
		cycleBranchPrefix: overrideOrKeep(base.cycleBranchPrefix, local.cycleBranchPrefix),
		releaseRefPrefix: overrideOrKeep(base.releaseRefPrefix, local.releaseRefPrefix),
		publishRemoteUrl: overrideOrKeep(base.publishRemoteUrl, local.publishRemoteUrl),
		buildWatchFile: base.buildWatchFile,
		conventionsExtensionFile: base.conventionsExtensionFile,
		...(base.inputs === undefined ? {} : { inputs: locateInputs(base.inputs, local.inputs) }),
		publish: joinPublish(base.publish, local.publish)
	};
}

/** ##LOCAL-CONFIG-RULE: a local file can leave more out of a release, never less. */
function joinPublish(base: PublishConfig | undefined, local: PublishConfig | undefined): PublishConfig | undefined {
	if (local === undefined) return base;
	const scrub = joinScrub(base?.scrub, local.scrub);
	return { exclude: union(base?.exclude ?? [], local.exclude), ...(scrub === undefined ? {} : { scrub }) };
}

/** A local file adds spec roots and vocabulary; `allow` is the base file's alone. */
function joinScrub(base: ScrubConfig | undefined, local: ScrubConfig | undefined): ScrubConfig | undefined {
	if (local === undefined) return base;
	const specRoots = local.specRoots === undefined ? base?.specRoots : union(base?.specRoots ?? DEFAULT_SPEC_ROOTS, local.specRoots);
	return {
		...(specRoots === undefined ? {} : { specRoots }),
		vocabulary: [...(base?.vocabulary ?? []), ...local.vocabulary],
		allow: base?.allow ?? []
	};
}

function union(base: readonly string[], local: readonly string[]): readonly string[] {
	return [...new Set([...base, ...local])];
}

/** Canonical base config bytes; local overrides are never serialized here. */
export function serializeBaseConfig(config: CodkitConfig): string {
	const wirePin =
		config.codkitConfig === 4
			? {
					...(config.pin.tag === null ? {} : { tag: config.pin.tag }),
					sha: config.pin.sha,
					date: config.pin.date,
					...(config.pin.resolvedAt === undefined ? {} : { resolvedAt: config.pin.resolvedAt }),
					...(config.pin.provenance === undefined ? {} : { provenance: config.pin.provenance })
				}
			: config.pin;
	const parsed = parseBaseConfig({ ...declaredWorkspaceConfig(config), pin: wirePin }, CONFIG_FILE_NAME);
	const canonical = {
		codkitConfig: parsed.codkitConfig,
		pin: {
			...(parsed.pin.tag === null ? {} : { tag: parsed.pin.tag }),
			sha: parsed.pin.sha,
			date: parsed.pin.date,
			...(parsed.pin.resolvedAt === undefined ? {} : { resolvedAt: parsed.pin.resolvedAt }),
			...(parsed.pin.provenance === undefined ? {} : { provenance: parsed.pin.provenance })
		},
		upstreamAnchorCommit: parsed.upstreamAnchorCommit,
		type: parsed.type,
		typeConfig: parsed.typeConfig,
		...(parsed.discipline === undefined ? {} : { discipline: parsed.discipline }),
		generatedBranchPrefix: parsed.generatedBranchPrefix,
		cycleBranchPrefix: parsed.cycleBranchPrefix,
		releaseRefPrefix: parsed.releaseRefPrefix,
		publishRemoteUrl: parsed.publishRemoteUrl,
		buildWatchFile: parsed.buildWatchFile,
		conventionsExtensionFile: parsed.conventionsExtensionFile,
		// Absent stays absent: JSON.stringify drops an undefined member.
		inputs: parsed.inputs,
		publish: parsed.publish
	};
	return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function parseConfigBytes(bytes: Uint8Array): unknown {
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

export function messageOf(error: unknown): string {
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

/**
 * ##CFG-SCHEMA-1-IS-REFUSED: a file that declares schema 1, or carries no
 * `type` at all, is schema 1 and is refused naming the two fields to add and
 * nothing else. There is no compatibility layer and no inference of a type from
 * the schema-1 field it replaces.
 */
function assertSchemaTwo(object: Readonly<Record<string, unknown>>, fileLabel: string): void {
	const declared = object['codkitConfig'];
	const isSchemaOne = declared === 1 || !Object.prototype.hasOwnProperty.call(object, 'type');
	if (!isSchemaOne) {
		return;
	}
	throw ckError(
		'CONFIG',
		`is schema 1: schema 2 adds ${SCHEMA_2_FIELDS}, and this tool reads schema 2 or 3`,
		`set "codkitConfig": 2, add "type": "<identifier>" and "typeConfig": { "ownRoot": "<path from the tree root>" }, ` +
			'and remove "ownDirName"',
		fileLabel
	);
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
