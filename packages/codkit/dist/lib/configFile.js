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
import { z } from 'zod';
import { CR_BYTE, decodeUtf8Strict, LF_BYTE } from './bytes.js';
import { readContainedFile } from './containedFile.js';
import { ckError } from './messages.js';
import { repoRelativePathProblem, safeBasenameProblem } from './pathSafety.js';
export const CONFIG_FILE_NAME = 'codkit.json';
export const LOCAL_CONFIG_FILE_NAME = 'codkit.local.json';
/** Schema version this tool reads and writes (##CFG-TYPE-AND-TYPECONFIG). */
export const CONFIG_SCHEMA_VERSION = 2;
/**
 * The two fields schema 2 adds and schema 1 lacks. A file without them is
 * refused naming exactly these and nothing else (##CFG-SCHEMA-1-IS-REFUSED):
 * there is no compatibility layer, and no code path infers a type.
 */
export const SCHEMA_2_FIELDS = 'type, typeConfig.ownRoot';
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
const configSchema = z.object({
    codkitConfig: z.literal(CONFIG_SCHEMA_VERSION),
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
    conventionsExtensionFile: repositoryFilePath.nullable().default(null)
});
/** codkit.local.json: same field vocabulary, everything optional. */
const localConfigSchema = z.object({
    typeConfig: typeConfigSchema.optional(),
    generatedBranchPrefix: z.string().min(1).optional(),
    cycleBranchPrefix: z.string().min(1).optional(),
    releaseRefPrefix: z.string().min(1).optional(),
    publishRemoteUrl: z.string().nullable().optional()
});
const CONFIG_KEYS = [
    'codkitConfig',
    'pin',
    'upstreamAnchorCommit',
    'type',
    'typeConfig',
    'generatedBranchPrefix',
    'cycleBranchPrefix',
    'releaseRefPrefix',
    'publishRemoteUrl',
    'buildWatchFile',
    'conventionsExtensionFile'
];
const PIN_KEYS = ['tag', 'sha', 'date'];
/** Fields codkit.local.json may carry; the rest are pin-bearing and refused. */
const LOCAL_ALLOWED_KEYS = [
    'typeConfig',
    'generatedBranchPrefix',
    'cycleBranchPrefix',
    'releaseRefPrefix',
    'publishRemoteUrl'
];
/** Fields that exist in the base config but must never be overridden locally. */
const LOCAL_REFUSED_KEYS = [
    'codkitConfig',
    'pin',
    'upstreamAnchorCommit',
    'type',
    'buildWatchFile',
    'conventionsExtensionFile'
];
/**
 * Per-field diagnostics. `required` is used when the field is absent from the
 * file, `invalid` when it is present but malformed. The text for pin.sha is
 * fixed by PROP-003 ##CONFIG-INVALID-SAMPLE and covered by a test.
 */
const FIELD_DOCS = {
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
    type: {
        required: 'type is required (the identifier of the project type this patch set declares)',
        invalid: 'type must be one safe identifier without path separators',
        hint: 'set "type": "vscode"   (run: codkit types   for the registered identifiers)'
    },
    typeConfig: {
        required: 'typeConfig is required (the section the project type validates, starting with ownRoot)',
        invalid: 'typeConfig must be an object whose ownRoot is a path from the tree root',
        hint: 'set "typeConfig": { "ownRoot": "<path from the tree root>" }'
    },
    'typeConfig.ownRoot': {
        required: 'typeConfig.ownRoot is required (the own root, a full path from the tree root)',
        invalid: 'typeConfig.ownRoot must be a safe path from the tree root, without a leading slash or a dot-dot segment',
        hint: 'set "typeConfig": { "ownRoot": "<path from the tree root>" }'
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
const FALLBACK_DOC = {
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
export function parseLocalConfig(raw, fileLabel) {
    const object = expectObject(raw, fileLabel);
    for (const key of LOCAL_REFUSED_KEYS) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
            throw ckError('CONFIG', `${key} cannot be overridden locally: the pin is a shared invariant of the repository, ` +
                `it changes only through the upgrade cycle commit`, `remove "${key}" from ${LOCAL_CONFIG_FILE_NAME}; keep it in ${CONFIG_FILE_NAME}`, fileLabel);
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
export function mergeLocal(base, local) {
    return {
        codkitConfig: base.codkitConfig,
        pin: base.pin,
        upstreamAnchorCommit: base.upstreamAnchorCommit,
        type: base.type,
        typeConfig: local.typeConfig ?? base.typeConfig,
        generatedBranchPrefix: overrideOrKeep(base.generatedBranchPrefix, local.generatedBranchPrefix),
        cycleBranchPrefix: overrideOrKeep(base.cycleBranchPrefix, local.cycleBranchPrefix),
        releaseRefPrefix: overrideOrKeep(base.releaseRefPrefix, local.releaseRefPrefix),
        publishRemoteUrl: overrideOrKeep(base.publishRemoteUrl, local.publishRemoteUrl),
        buildWatchFile: base.buildWatchFile,
        conventionsExtensionFile: base.conventionsExtensionFile
    };
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
        generatedBranchPrefix: parsed.generatedBranchPrefix,
        cycleBranchPrefix: parsed.cycleBranchPrefix,
        releaseRefPrefix: parsed.releaseRefPrefix,
        publishRemoteUrl: parsed.publishRemoteUrl,
        buildWatchFile: parsed.buildWatchFile,
        conventionsExtensionFile: parsed.conventionsExtensionFile
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
    throw ckError('CONFIG', `is schema 1: schema ${CONFIG_SCHEMA_VERSION} adds ${SCHEMA_2_FIELDS}, and this tool reads schema ${CONFIG_SCHEMA_VERSION} only`, `set "codkitConfig": ${CONFIG_SCHEMA_VERSION}, add "type": "<identifier>" and "typeConfig": { "ownRoot": "<path from the tree root>" }, ` +
        'and remove "ownRoot"', fileLabel);
}
function assertKnownKeys(object, known, fileLabel, prefix) {
    const unknownKeys = Object.keys(object).filter((key) => !known.includes(key));
    if (unknownKeys.length === 0) {
        return;
    }
    const rendered = unknownKeys.map((key) => `${prefix}${key}`).join(', ');
    throw ckError('CONFIG', `unknown field(s): ${rendered}`, `remove them; the allowed fields are: ${known.map((key) => `${prefix}${key}`).join(', ')}`, fileLabel);
}
function schemaError(issues, raw, fileLabel) {
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
function withFieldPath(path, text) {
    if (path === '' || text.startsWith(path)) {
        return text;
    }
    return `${path} ${text}`;
}
function valueAtPath(raw, path) {
    let current = raw;
    for (const segment of path) {
        if (!isPlainObject(current)) {
            return undefined;
        }
        current = current[String(segment)];
    }
    return current;
}
function expectObject(raw, fileLabel) {
    if (!isPlainObject(raw)) {
        throw ckError('CONFIG', 'must contain a JSON object', 'see PROP-003 sec. 2 for the field list', fileLabel);
    }
    return raw;
}
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
