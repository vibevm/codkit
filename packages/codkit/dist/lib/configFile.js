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
import { configFieldDocs, schemaError, expectObject, isPlainObject } from './configDiagnostics.js';
import { z } from 'zod';
import { CR_BYTE, decodeUtf8Strict, LF_BYTE } from './bytes.js';
import { readContainedFile } from './containedFile.js';
import { inputsSchema, localInputContentField, localInputsSchema, locateInputs } from './inputsDeclaration.js';
import { ckError } from './messages.js';
import { repoRelativePathProblem, safeBasenameProblem } from './pathSafety.js';
import { MINIMAL_DISCIPLINE } from './discipline.js';
export const CONFIG_FILE_NAME = 'codkit.json';
export const LOCAL_CONFIG_FILE_NAME = 'codkit.local.json';
/** Schema version this tool reads and writes (##CFG-TYPE-AND-TYPECONFIG). */
export const CONFIG_SCHEMA_VERSION = 3;
export const LEGACY_CONFIG_SCHEMA_VERSION = 2;
const { base: FIELD_DOCS, local: LOCAL_FIELD_DOCS } = configFieldDocs(CONFIG_SCHEMA_VERSION);
/**
 * The two fields schema 2 adds and schema 1 lacks. A file without them is
 * refused naming exactly these and nothing else (##CFG-SCHEMA-1-IS-REFUSED):
 * there is no compatibility layer, and no code path infers a type.
 */
export const SCHEMA_2_FIELDS = 'type, typeConfig.ownRoot';
/** Where a patch set keeps its spec documents unless `publish.scrub.specRoots` says otherwise. */
export const DEFAULT_SPEC_ROOTS = ['vibevm/vibespecs'];
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
function usablePattern(source) {
    try {
        return !new RegExp(`^(?:${source})$`, 'u').test('');
    }
    catch {
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
    z.object({ codkitConfig: z.literal(CONFIG_SCHEMA_VERSION), discipline: z.literal(MINIMAL_DISCIPLINE), ...configFields })
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
const CONFIG_KEYS = [
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
const PIN_KEYS = ['tag', 'sha', 'date'];
/** Fields codkit.local.json may carry; the rest are pin-bearing and refused. */
const LOCAL_ALLOWED_KEYS = [
    'typeConfig',
    'generatedBranchPrefix',
    'cycleBranchPrefix',
    'releaseRefPrefix',
    'publishRemoteUrl',
    'inputs',
    'publish'
];
/** Fields that exist in the base config but must never be overridden locally. */
const LOCAL_REFUSED_KEYS = [
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
export function loadConfig(patchesDir) {
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
export function loadLocalConfig(patchesDir) {
    const bytes = readConfigBytes(patchesDir, LOCAL_CONFIG_FILE_NAME);
    return bytes === null ? null : parseLocalConfig(parseJsonText(bytes, LOCAL_CONFIG_FILE_NAME), LOCAL_CONFIG_FILE_NAME);
}
/** Read only the shared base config, before any personal local overrides. */
export function loadBaseConfig(patchesDir) {
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
function readConfigBytes(patchesDir, name) {
    return configReadResult(patchesDir, name);
}
function configReadResult(patchesDir, name) {
    const read = readContainedFile(patchesDir, name, { what: name });
    return read.state === 'ok' ? read.bytes : null;
}
/** Decode config bytes with the config family's BOM discipline (PROP-003 sec. 1). */
function parseJsonText(bytes, fileLabel) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        throw ckError('CONFIG', 'must be UTF-8 without BOM', 're-save the file as UTF-8 without a byte order mark', fileLabel);
    }
    const text = decodeUtf8Strict(bytes);
    if (text === null) {
        throw ckError('CONFIG', 'must contain valid UTF-8', 're-save the file as UTF-8 without replacement bytes', fileLabel);
    }
    try {
        return JSON.parse(text);
    }
    catch (error) {
        throw ckError('CONFIG', `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'fix the JSON syntax; codkit config files are plain JSON without comments', fileLabel);
    }
}
/** Validate an already-decoded codkit.json body. Exposed for tests. */
export function parseBaseConfig(raw, fileLabel) {
    const object = expectObject(raw, fileLabel);
    assertSchemaVersion(object, fileLabel);
    assertSchemaTwo(object, fileLabel);
    if (object['codkitConfig'] === LEGACY_CONFIG_SCHEMA_VERSION && Object.prototype.hasOwnProperty.call(object, 'discipline'))
        throw ckError('CONFIG', 'discipline requires codkitConfig: 3', 'explicitly migrate the configuration before declaring a profile', fileLabel);
    assertKnownKeys(object, CONFIG_KEYS, fileLabel, '');
    const pin = object['pin'];
    if (isPlainObject(pin)) {
        assertKnownKeys(pin, PIN_KEYS, fileLabel, 'pin.');
    }
    const parsed = configSchema.safeParse(object);
    if (!parsed.success) {
        throw schemaError(parsed.error.issues, object, fileLabel, FIELD_DOCS);
    }
    return parsed.data;
}
/** Validate an already-decoded codkit.local.json body. Exposed for tests. */
export function parseLocalConfig(raw, fileLabel) {
    const object = expectObject(raw, fileLabel);
    for (const key of LOCAL_REFUSED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
            throw ckError('CONFIG', `${key} cannot be overridden locally: the pin is a shared invariant of the repository, ` +
                `it changes only through the upgrade cycle commit`, `remove "${key}" from ${LOCAL_CONFIG_FILE_NAME}; keep it in ${CONFIG_FILE_NAME}`, fileLabel);
        }
    }
    assertKnownKeys(object, LOCAL_ALLOWED_KEYS, fileLabel, '');
    const publish = object['publish'];
    const scrub = isPlainObject(publish) ? publish['scrub'] : undefined;
    if (isPlainObject(scrub) && Object.prototype.hasOwnProperty.call(scrub, 'allow')) {
        throw ckError('CONFIG', 'publish.scrub.allow cannot be set locally: a local file can scrub and check more of a release, never less', `remove "allow" from ${LOCAL_CONFIG_FILE_NAME}; keep the list in ${CONFIG_FILE_NAME}, where it is reviewed`, fileLabel);
    }
    refuseLocalInputContent(object['inputs'], fileLabel);
    const parsed = localConfigSchema.safeParse(object);
    if (!parsed.success) {
        throw schemaError(parsed.error.issues, object, fileLabel, LOCAL_FIELD_DOCS);
    }
    return parsed.data;
}
/** ##LOCAL-CONFIG-RULE: a local entry of `inputs` names the location of an input and nothing it takes. */
function refuseLocalInputContent(inputs, fileLabel) {
    const field = localInputContentField(inputs);
    if (field === null)
        return;
    throw ckError('CONFIG', `inputs.${field} cannot be set locally: ${LOCAL_CONFIG_FILE_NAME} may name only the repository of an input on this machine`, `remove "${field}" from ${LOCAL_CONFIG_FILE_NAME}; what an input takes is declared in ${CONFIG_FILE_NAME}, where it is reviewed`, fileLabel);
}
/** Apply the non-empty fields of codkit.local.json on top of the base config. */
export function mergeLocal(base, local) {
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
function joinPublish(base, local) {
    if (local === undefined)
        return base;
    const scrub = joinScrub(base?.scrub, local.scrub);
    return { exclude: union(base?.exclude ?? [], local.exclude), ...(scrub === undefined ? {} : { scrub }) };
}
/** A local file adds spec roots and vocabulary; `allow` is the base file's alone. */
function joinScrub(base, local) {
    if (local === undefined)
        return base;
    const specRoots = local.specRoots === undefined ? base?.specRoots : union(base?.specRoots ?? DEFAULT_SPEC_ROOTS, local.specRoots);
    return {
        ...(specRoots === undefined ? {} : { specRoots }),
        vocabulary: [...(base?.vocabulary ?? []), ...local.vocabulary],
        allow: base?.allow ?? []
    };
}
function union(base, local) {
    return [...new Set([...base, ...local])];
}
/** Canonical base config bytes; local overrides are never serialized here. */
export function serializeBaseConfig(config) {
    const parsed = parseBaseConfig(config, CONFIG_FILE_NAME);
    const canonical = {
        codkitConfig: parsed.codkitConfig,
        pin: { tag: parsed.pin.tag, sha: parsed.pin.sha, date: parsed.pin.date },
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
export function parseConfigBytes(bytes) {
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
        return JSON.parse(text);
    }
    catch (error) {
        throw ckError('CONFIG', `${CONFIG_FILE_NAME} is not valid JSON: ${messageOf(error)}`, 'fix the JSON syntax', CONFIG_FILE_NAME);
    }
}
export function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * "Non-empty wins": absent, null and empty-string local values leave the base
 * value in place, so a half-filled personal file cannot blank out the config.
 */
function overrideOrKeep(base, local) {
    if (local === undefined || local === null || local === '') {
        return base;
    }
    return local;
}
function assertSchemaVersion(object, fileLabel) {
    const declared = object['codkitConfig'];
    if (typeof declared === 'number' && Number.isInteger(declared) && declared > CONFIG_SCHEMA_VERSION) {
        throw ckError('CONFIG', `schema version ${declared} is newer than this tool understands (supported: ${CONFIG_SCHEMA_VERSION}); ` +
            `the format is newer than the tool, update codkit`, 'update codkit to a version that reads this format, then re-run', fileLabel);
    }
}
/**
 * ##CFG-SCHEMA-1-IS-REFUSED: a file that declares schema 1, or carries no
 * `type` at all, is schema 1 and is refused naming the two fields to add and
 * nothing else. There is no compatibility layer and no inference of a type from
 * the schema-1 field it replaces.
 */
function assertSchemaTwo(object, fileLabel) {
    const declared = object['codkitConfig'];
    const isSchemaOne = declared === 1 || !Object.prototype.hasOwnProperty.call(object, 'type');
    if (!isSchemaOne) {
        return;
    }
    throw ckError('CONFIG', `is schema 1: schema 2 adds ${SCHEMA_2_FIELDS}, and this tool reads schema 2 or 3`, `set "codkitConfig": 2, add "type": "<identifier>" and "typeConfig": { "ownRoot": "<path from the tree root>" }, ` +
        'and remove "ownDirName"', fileLabel);
}
function assertKnownKeys(object, known, fileLabel, prefix) {
    const unknownKeys = Object.keys(object).filter((key) => !known.includes(key));
    if (unknownKeys.length === 0) {
        return;
    }
    const rendered = unknownKeys.map((key) => `${prefix}${key}`).join(', ');
    throw ckError('CONFIG', `unknown field(s): ${rendered}`, `remove them; the allowed fields are: ${known.map((key) => `${prefix}${key}`).join(', ')}`, fileLabel);
}
