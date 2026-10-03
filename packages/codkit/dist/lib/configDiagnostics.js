/** @scope spec://codkit/modules/codkit/PROP-003#root */
// Configuration diagnostic vocabulary and unknown-data narrowing.
import { ckError } from './messages.js';
import { INPUT_FIELD_DOCS, LOCAL_INPUT_FIELD_DOCS } from './inputsDeclaration.js';
import { MINIMAL_DISCIPLINE } from './discipline.js';
/**
 * Per-field diagnostics. `required` is used when the field is absent from the
 * file, `invalid` when it is present but malformed. The text for pin.sha is
 * fixed by PROP-003 ##CONFIG-INVALID-SAMPLE and covered by a test.
 */
export function configFieldDocs(version) {
    const FIELD_DOCS = {
        codkitConfig: {
            required: `codkitConfig is required (schema version, must be 2, 3 or ${version})`,
            invalid: `codkitConfig must be 2, 3 or ${version}`,
            hint: `set "codkitConfig": ${version}`
        },
        discipline: {
            required: `discipline is required in schema 3 (use ${MINIMAL_DISCIPLINE})`,
            invalid: `discipline must be the supported profile ${MINIMAL_DISCIPLINE}`,
            hint: `set "discipline": "${MINIMAL_DISCIPLINE}"`
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
        },
        publish: {
            required: 'publish is optional',
            invalid: 'publish must be an object whose fields are exclude and scrub',
            hint: 'set "publish": { "exclude": ["<path from the tree root>"] }'
        },
        'publish.exclude': {
            required: 'publish.exclude is optional',
            invalid: 'publish.exclude must be a list of safe paths from the tree root',
            hint: 'set "publish": { "exclude": ["<path from the tree root>"] }'
        },
        'publish.scrub': {
            required: 'publish.scrub is optional',
            invalid: 'publish.scrub must be an object whose fields are specRoots, vocabulary and allow',
            hint: 'set "publish": { "scrub": { "specRoots": ["vibevm/vibespecs"], "vocabulary": [], "allow": [] } }'
        },
        'publish.scrub.specRoots': {
            required: 'publish.scrub.specRoots is optional',
            invalid: 'publish.scrub.specRoots must be a list of safe paths from the patch-set root',
            hint: 'set "specRoots": ["vibevm/vibespecs"]'
        },
        'publish.scrub.vocabulary': {
            required: 'publish.scrub.vocabulary is optional',
            invalid: 'publish.scrub.vocabulary must be a list of literal tokens that start and end with a letter or a digit, ' +
                'or of { "regex": "<pattern>" } objects whose pattern compiles with the u flag and never matches the empty string',
            hint: 'set "vocabulary": ["RISK-018", { "regex": "RISK-[0-9]+" }]'
        },
        'publish.scrub.allow': {
            required: 'publish.scrub.allow is optional',
            invalid: 'publish.scrub.allow must be a list of non-empty tokens',
            hint: 'set "allow": ["<a token the release may carry where the scrub leaves it>"]'
        },
        ...INPUT_FIELD_DOCS
    };
    /** codkit.local.json reads the same table, with its own words for an input entry. */
    return { base: FIELD_DOCS, local: { ...FIELD_DOCS, ...LOCAL_INPUT_FIELD_DOCS } };
}
const FALLBACK_DOC = {
    required: 'is required',
    invalid: 'has an invalid value',
    hint: 'see PROP-003 sec. 2 for the field list of codkit.json'
};
export function schemaError(issues, raw, fileLabel, docs) {
    const issue = issues[0];
    if (issue === undefined) {
        return ckError('CONFIG', 'failed validation', FALLBACK_DOC.hint, fileLabel);
    }
    const path = issue.path.map((segment) => String(segment)).join('.');
    // An issue inside a list is documented by the list: `publish.exclude.0` is
    // `publish.exclude`; a field of a list entry by its name without the index:
    // `inputs.1.ref` is `inputs.ref`.
    const index = issue.path.findIndex((segment) => typeof segment === 'number');
    const list = index === -1 ? path : issue.path.slice(0, index).map(String).join('.');
    // The deepest documented field on the way, list indexes left out: a key of
    // `inputs.0.env` is documented by `inputs.env`.
    const segments = issue.path.filter((segment) => typeof segment !== 'number').map(String);
    const field = segments
        .map((_, count) => segments.slice(0, segments.length - count).join('.'))
        .find((candidate) => candidate !== '' && docs[candidate] !== undefined) ?? '';
    const documented = docs[path] !== undefined ? path : field !== '' ? field : docs[list] !== undefined ? list : path;
    const doc = docs[documented] ?? FALLBACK_DOC;
    // Distinguish "absent" from "present but wrong" by looking at the raw input
    // rather than at validator-specific issue codes.
    const absent = valueAtPath(raw, issue.path) === undefined;
    return ckError('CONFIG', `${withFieldPath(documented, absent ? doc.required : doc.invalid)}${inputEntryOf(raw, issue.path)}`, doc.hint, fileLabel);
}
/** Which entry of `inputs` an issue is about: its position, and its name when it has one. */
function inputEntryOf(raw, path) {
    const position = path[1];
    if (path[0] !== 'inputs' || typeof position !== 'number')
        return '';
    const name = valueAtPath(raw, ['inputs', position, 'name']);
    return ` (input ${position + 1}${typeof name === 'string' && name !== '' ? `, ${name}` : ''})`;
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
        if (Array.isArray(current) && typeof segment === 'number') {
            current = current[segment];
            continue;
        }
        if (!isPlainObject(current)) {
            return undefined;
        }
        current = current[String(segment)];
    }
    return current;
}
export function expectObject(raw, fileLabel) {
    if (!isPlainObject(raw)) {
        throw ckError('CONFIG', 'must contain a JSON object', 'see PROP-003 sec. 2 for the field list', fileLabel);
    }
    return raw;
}
export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
