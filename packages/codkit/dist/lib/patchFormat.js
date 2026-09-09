/** @scope spec://codkit/modules/codkit/PROP-004#root */
// The .ckpatch format: file name encoding, header, normalized unified diff
// (PROP-004 sec. 4).
//
// Two properties of this module are load-bearing:
//   * it is strict - every shape the spec does not name is refused, because a
//     patch that parses loosely is a patch that applies differently on another
//     machine;
//   * it is lossless - serializeCkpatch(parseCkpatch(x)) === x byte for byte, so
//     regeneration can preserve a header it did not write (##GEN-HEADER-PRESERVED)
//     and the byte comparison of ##GEN-BYTE-COMPARE means what it says.
import { decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { ckError } from './messages.js';
/** Schema version this tool reads and writes (`# codkit-patch: 2`). */
export const PATCH_SCHEMA_VERSION = 2;
export const PATCH_FILE_SUFFIX = '.ckpatch';
/** Path separator encoding of the patch file name (PROP-004 sec. 4). */
const PATH_SEPARATOR = '/';
const NAME_SEPARATOR = '__';
/**
 * The layer a patch carries (PROP-004 ##PH-LAYER). `patch` is the default and
 * the only value a header written before the field existed can mean;
 * `entry-module` marks the patches that graft or fork an upstream entry module
 * (PROP-005 sec. 4), which are the same file format but a different layer in the
 * inventory. `rewrite-rule` is carried only by a patch a rule engine generated
 * (PROP-005 sec. 7): the file is an ordinary patch, but the inventory attributes
 * it to the rule that produced it, and nobody edits it by hand.
 */
export const PATCH_LAYERS = ['patch', 'entry-module', 'rewrite-rule'];
export const DEFAULT_PATCH_LAYER = 'patch';
/**
 * Header fields, in the order PROP-004 sec. 4 fixes. All are mandatory except
 * `layer`, which was added after the first patches were written and therefore
 * has to be readable in both its presence and its absence.
 */
const HEADER_FIELDS = [
    { key: 'codkit-patch' },
    { key: 'id' },
    { key: 'layer', optional: true },
    { key: 'type' },
    { key: 'category' },
    { key: 'owner' },
    { key: 'reason' },
    { key: 'link' },
    { key: 'cause' },
    { key: 'pin' },
    { key: 'contract-tests' }
];
/** The field list as it is quoted in every header diagnostic. */
const HEADER_FIELD_LIST = HEADER_FIELDS.map((field) => (field.optional === true ? `[${field.key}]` : field.key)).join(', ');
const MANDATORY_FIELD_COUNT = HEADER_FIELDS.filter((field) => field.optional !== true).length;
/** Generator noise that normalization removes (##PB-NO-VOLATILE-HEADERS). */
const VOLATILE_PREFIXES = [
    'diff --git ',
    'index ',
    'old mode ',
    'new mode ',
    'new file mode ',
    'deleted file mode ',
    'similarity index ',
    'rename from ',
    'rename to '
];
const DEV_NULL = '/dev/null';
const NO_NEWLINE_TEXT = ' No newline at end of file';
const HEADER_LINE = /^# ([a-z][a-z-]*):(?: (.*))?$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const SHA40 = /^[0-9a-f]{40}$/;
const PIN_VALUE = /^[^@\s]+@[0-9a-f]{40}$/;
/**
 * `a/b/c.ts` -> `a__b__c.ts.ckpatch` (PROP-004 sec. 4, name encoding).
 *
 * A path that already contains `__` would decode back to something else; the
 * upstream tree at the pin has none, and the check is there for the day one
 * appears. The registry has no code for "the encoder cannot represent this", so
 * it is reported as an internal failure with the reason spelled out.
 */
export function encodePatchName(upstreamPath) {
    if (upstreamPath === '') {
        throw ckError('INTERNAL', 'cannot encode a patch name for an empty upstream path');
    }
    if (upstreamPath.includes(NAME_SEPARATOR)) {
        throw ckError('INTERNAL', `upstream path contains "${NAME_SEPARATOR}", cannot encode patch name: ${upstreamPath}`, 'the patch file name encodes "/" as "__"; a path that already contains "__" would not decode back');
    }
    return `${upstreamPath.split(PATH_SEPARATOR).join(NAME_SEPARATOR)}${PATCH_FILE_SUFFIX}`;
}
/** Inverse of encodePatchName. */
export function decodePatchName(fileName) {
    if (!fileName.endsWith(PATCH_FILE_SUFFIX)) {
        throw ckError('ARTIFACT-BROKEN', `patch file name does not end with ${PATCH_FILE_SUFFIX}`, `rename it to <encoded-path>${PATCH_FILE_SUFFIX} or move it out of delta/patches/`, fileName);
    }
    const encoded = fileName.slice(0, -PATCH_FILE_SUFFIX.length);
    if (encoded === '') {
        throw ckError('ARTIFACT-BROKEN', 'patch file name has no encoded path', 'the name is <encoded-path>.ckpatch', fileName);
    }
    return encoded.split(NAME_SEPARATOR).join(PATH_SEPARATOR);
}
/**
 * Read a .ckpatch. `file` is the artifact path used in every diagnostic; it is
 * required because a patch error without a file name is unusable in review.
 */
export function parseCkpatch(bytes, conventions, file) {
    const text = decodeUtf8Strict(bytes);
    if (text === null) {
        throw ckError('ENCODING', 'patch file is not valid UTF-8', 'codkit reads and writes UTF-8 only', file);
    }
    const lines = splitPatchLines(text, file);
    const header = parseHeader(lines, conventions, file);
    return parseBody(lines, header, file);
}
/**
 * Write a parsed patch back out. The result is byte-identical to what
 * parseCkpatch read, which is what makes "the header is preserved verbatim"
 * checkable rather than merely intended.
 */
export function serializeCkpatch(patch) {
    const out = [...patch.header.lines];
    out.push(patch.isAddFile ? `--- ${DEV_NULL}` : `--- a/${patch.targetPath}`);
    out.push(`+++ b/${patch.targetPath}`);
    for (const hunk of patch.hunks) {
        out.push(hunk.header);
        for (const line of hunk.lines) {
            out.push(line.bare ? '' : `${line.kind}${line.text}`);
        }
    }
    return encodeUtf8(`${out.join('\n')}\n`);
}
/**
 * Build the header lines of a new patch, in the order the spec fixes.
 *
 * `layer` is written only when it is given and only when it is not the default:
 * a plain patch carries no `# layer:` line, so the headers this tool writes look
 * like the headers it already reads.
 */
export function formatPatchHeader(fields) {
    const lines = [
        `# codkit-patch: ${PATCH_SCHEMA_VERSION}`,
        `# id: ${fields.id}`,
        ...(fields.layer === undefined || fields.layer === DEFAULT_PATCH_LAYER ? [] : [`# layer: ${fields.layer}`]),
        `# type: ${fields.type}`,
        `# category: ${fields.category}`,
        `# owner: ${fields.owner}`,
        `# reason: ${fields.reason}`,
        `# link: ${fields.link}`,
        `# cause: ${fields.cause}`,
        `# pin: ${fields.pin}`,
        `# contract-tests: ${fields.contractTests.length === 0 ? 'none' : fields.contractTests.join(',')}`
    ];
    return `${lines.join('\n')}\n`;
}
/** The header of an existing patch, byte-for-byte, terminator included. */
export function extractHeaderText(patch) {
    return `${patch.header.lines.join('\n')}\n`;
}
function splitPatchLines(text, file) {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
        if ((lines[index] ?? '').includes('\r')) {
            throw ckError('CRLF', 'patch file has CRLF line endings', 'codkit artifacts are LF-only; set core.autocrlf=false and re-check out the file', file, index + 1);
        }
    }
    // A file that ends with LF splits into a trailing empty element; the format
    // requires that terminator, so its absence is an error of its own.
    const last = lines[lines.length - 1];
    if (last !== '') {
        throw ckError('ARTIFACT-BROKEN', 'patch file does not end with a line feed', 'every codkit artifact ends with LF (PROP-003 ##FILE-BYTE-RULES)', file, lines.length);
    }
    lines.pop();
    return lines;
}
/**
 * The header is read in two steps: first its shape (the ten fields, in order,
 * one "# key: value" line each), then the values against the conventions. The
 * raw lines are kept so the artifact can be written back untouched.
 */
function parseHeader(lines, conventions, file) {
    const header = collectHeaderLines(lines, file);
    return validateHeaderValues(header, conventions, file);
}
function collectHeaderLines(lines, file) {
    const raw = [];
    const values = new Map();
    const at = new Map();
    // Where in HEADER_FIELDS the next line is expected. An optional field that
    // the header does not carry is stepped over, so the order of the fields that
    // are present is still fixed.
    let field = 0;
    let index = 0;
    for (; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.startsWith('# ')) {
            break;
        }
        const match = HEADER_LINE.exec(line);
        if (match === null) {
            throw ckError('ARTIFACT-BROKEN', `header line is not "# <key>: <value>": ${line}`, `the header fields are, in this order: ${HEADER_FIELD_LIST}`, file, index + 1);
        }
        const key = match[1] ?? '';
        while (field < HEADER_FIELDS.length && HEADER_FIELDS[field]?.optional === true && HEADER_FIELDS[field]?.key !== key) {
            field += 1;
        }
        const expected = HEADER_FIELDS[field];
        if (expected === undefined) {
            throw ckError('ARTIFACT-BROKEN', `unexpected header line "${key}" after the fields of the schema`, `the header carries exactly: ${HEADER_FIELD_LIST}`, file, index + 1);
        }
        if (key !== expected.key) {
            throw ckError('ARTIFACT-BROKEN', `header field "${key}" is out of order: field ${raw.length + 1} must be "${expected.key}"`, `the field order is fixed: ${HEADER_FIELD_LIST}`, file, index + 1);
        }
        values.set(key, match[2] ?? '');
        at.set(key, index + 1);
        raw.push(line);
        field += 1;
        // The schema version decides whether the rest is readable at all, so it
        // is checked as soon as it is seen (PROP-003 ##SCHEMA-MIGRATION-RULE).
        if (key === 'codkit-patch') {
            checkSchemaVersion(values.get(key) ?? '', file, index + 1);
        }
    }
    const missing = HEADER_FIELDS.find((candidate) => candidate.optional !== true && !values.has(candidate.key));
    if (missing !== undefined) {
        throw ckError('ARTIFACT-BROKEN', `header field "${missing.key}" is missing`, `the header carries all ${MANDATORY_FIELD_COUNT} mandatory fields in order: ${HEADER_FIELD_LIST}`, file, index + 1);
    }
    return { raw, values, lines: at };
}
function validateHeaderValues(header, conventions, file) {
    const values = header.values;
    const lineOf = (key) => header.lines.get(key);
    const id = requireValue(values, 'id', file);
    if (!new RegExp(conventions.idPattern).test(id)) {
        throw ckError('ARTIFACT-BROKEN', `header id "${id}" does not match the id pattern of conventions.json`, `use an id of the form CK-<subsystem>-<NNN> (pattern: ${conventions.idPattern})`, file, lineOf('id'));
    }
    const layerExplicit = values.has('layer');
    const layer = readLayer(values.get('layer'), file, lineOf('layer'));
    const type = requireValue(values, 'type', file);
    if (!conventions.interventionTypes.includes(type)) {
        throw ckError('ARTIFACT-BROKEN', `header type "${type}" is not one of the intervention types`, `use one of: ${conventions.interventionTypes.join(', ')}`, file, lineOf('type'));
    }
    const category = requireValue(values, 'category', file);
    if (!conventions.categories.includes(category)) {
        throw ckError('ARTIFACT-BROKEN', `header category "${category}" is not one of the categories`, `use one of: ${conventions.categories.join(', ')}`, file, lineOf('category'));
    }
    const cause = requireValue(values, 'cause', file);
    if (cause !== 'none' && !SHA40.test(cause)) {
        throw ckError('ARTIFACT-BROKEN', `header cause "${cause}" is neither "none" nor a full 40-hex commit sha`, 'set "# cause: none" until an upstream commit forces an adaptation', file, lineOf('cause'));
    }
    const pin = requireValue(values, 'pin', file);
    if (!PIN_VALUE.test(pin)) {
        throw ckError('ARTIFACT-BROKEN', `header pin "${pin}" is not "<tag>@<40-hex sha>"`, 'write the pin the patch was regenerated against, e.g. "# pin: 1.135.0@08d4889f..."', file, lineOf('pin'));
    }
    return {
        schema: PATCH_SCHEMA_VERSION,
        id,
        layer,
        layerExplicit,
        type,
        category,
        owner: requireValue(values, 'owner', file),
        reason: requireValue(values, 'reason', file),
        link: requireValue(values, 'link', file),
        cause,
        pin,
        contractTests: parseContractTests(requireValue(values, 'contract-tests', file), file),
        lines: header.raw
    };
}
/**
 * `# layer:` is optional and carries exactly one of the patch layers. An absent
 * field means `patch`, which is what every header written before the field
 * existed describes (##PH-LAYER).
 */
function readLayer(value, file, line) {
    if (value === undefined) {
        return DEFAULT_PATCH_LAYER;
    }
    const known = PATCH_LAYERS.find((candidate) => candidate === value);
    if (known === undefined) {
        throw ckError('ARTIFACT-BROKEN', `header layer "${value}" is not one of the patch layers`, `write one of: ${PATCH_LAYERS.join(', ')}   (or omit the line: it defaults to ${DEFAULT_PATCH_LAYER})`, file, line);
    }
    return known;
}
function checkSchemaVersion(value, file, line) {
    if (!/^\d+$/.test(value)) {
        throw ckError('ARTIFACT-BROKEN', `codkit-patch must be an integer schema version, got "${value}"`, `write "# codkit-patch: ${PATCH_SCHEMA_VERSION}" as the first line`, file, line);
    }
    const declared = Number.parseInt(value, 10);
    if (declared > PATCH_SCHEMA_VERSION) {
        throw ckError('ARTIFACT-BROKEN', `schema version ${declared} is newer than this tool understands (supported: ${PATCH_SCHEMA_VERSION}); ` +
            'the format is newer than the tool, update codkit', 'update codkit to a version that reads this format, then re-run', file, line);
    }
    if (declared < PATCH_SCHEMA_VERSION) {
        throw ckError('ARTIFACT-BROKEN', `schema version ${declared} is obsolete; this pre-user hard break supports only ${PATCH_SCHEMA_VERSION}`, `rewrite the artifact as schema ${PATCH_SCHEMA_VERSION}; no legacy reader is shipped`, file, line);
    }
}
function requireValue(values, key, file) {
    const value = values.get(key) ?? '';
    if (value === '') {
        throw ckError('ARTIFACT-BROKEN', `header field "${key}" has no value`, `every header field carries a value; use "none" where there is nothing to say`, file);
    }
    return value;
}
function parseContractTests(value, file) {
    if (value === 'none') {
        return [];
    }
    const parts = value.split(',').map((part) => part.trim());
    for (const part of parts) {
        if (part === '') {
            throw ckError('ARTIFACT-BROKEN', `contract-tests has an empty entry: "${value}"`, 'list the covering test ids separated by commas, or write "none"', file, 10);
        }
    }
    return parts;
}
function parseBody(lines, header, file) {
    const cursor = { index: header.lines.length };
    const minus = takeFileHeader(lines, cursor, '--- ', file);
    const plus = takeFileHeader(lines, cursor, '+++ ', file);
    if (plus === DEV_NULL) {
        throw ckError('DELETES-UPSTREAM-FILE', 'patch deletes an upstream file', 'a patch never removes an upstream file; hide it from the product and record it in delta/removed.json', file, cursor.index);
    }
    const isAddFile = minus === DEV_NULL;
    const targetPath = stripSidePrefix(plus, 'b/', file, cursor.index);
    if (!isAddFile) {
        const minusPath = stripSidePrefix(minus, 'a/', file, cursor.index - 1);
        if (minusPath !== targetPath) {
            throw ckError('ARTIFACT-BROKEN', `the two diff headers name different files: "${minusPath}" and "${targetPath}"`, 'a .ckpatch describes exactly one file: --- a/<path> and +++ b/<path> with the same path', file, cursor.index);
        }
    }
    const hunks = [];
    while (cursor.index < lines.length) {
        hunks.push(takeHunk(lines, cursor, targetPath, file));
    }
    if (hunks.length === 0) {
        throw ckError('ARTIFACT-BROKEN', 'patch has no hunks', 'a patch with an empty body is not written at all (PROP-004 ##GEN-EMPTY-DIFF); delete the file', file, cursor.index);
    }
    if (isAddFile) {
        checkAddFileShape(hunks, file);
    }
    return { header, hunks, targetPath, isAddFile };
}
function takeFileHeader(lines, cursor, prefix, file) {
    const line = lines[cursor.index];
    if (line === undefined) {
        throw ckError('ARTIFACT-BROKEN', `patch body ends before the "${prefix.trim()}" header`, 'the body is a unified diff of one file: --- a/<path>, +++ b/<path>, then the hunks', file, cursor.index + 1);
    }
    for (const volatile of VOLATILE_PREFIXES) {
        if (line.startsWith(volatile)) {
            throw ckError('ARTIFACT-BROKEN', `patch body carries a generator header line: ${line}`, 'normalization removes "diff --git", "index", mode and rename lines; regenerate the patch with codkit save', file, cursor.index + 1);
        }
    }
    if (!line.startsWith(prefix)) {
        throw ckError('ARTIFACT-BROKEN', `expected the patch body to continue with "${prefix}", got: ${line}`, 'the header is "# key: value" lines, then a unified diff starting at "--- "', file, cursor.index + 1);
    }
    const value = line.slice(prefix.length);
    if (value === '' || /[\s"']/.test(value)) {
        throw ckError('ARTIFACT-BROKEN', `diff header path "${value}" carries whitespace or quotes`, 'upstream paths have no spaces, tabs or quotes; a path that does is an encoder error', file, cursor.index + 1);
    }
    cursor.index += 1;
    return value;
}
function stripSidePrefix(value, prefix, file, line) {
    if (!value.startsWith(prefix)) {
        throw ckError('ARTIFACT-BROKEN', `diff header path "${value}" does not start with "${prefix}"`, 'the body uses the default git prefixes: --- a/<path> and +++ b/<path>', file, line);
    }
    return value.slice(prefix.length);
}
function takeHunk(lines, cursor, targetPath, file) {
    const headerLine = cursor.index + 1;
    const raw = lines[cursor.index] ?? '';
    const match = HUNK_HEADER.exec(raw);
    if (match === null) {
        for (const volatile of VOLATILE_PREFIXES) {
            if (raw.startsWith(volatile)) {
                throw ckError('ARTIFACT-BROKEN', `patch body carries a generator header line: ${raw}`, 'normalization removes "diff --git", "index", mode and rename lines; regenerate the patch with codkit save', file, headerLine);
            }
        }
        if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
            throw ckError('ARTIFACT-BROKEN', `patch describes a second file: ${raw}`, `one target, one patch: split the change into delta/patches/<encoded path>.ckpatch files (this one targets ${targetPath})`, file, headerLine);
        }
        throw ckError('ARTIFACT-BROKEN', `expected a hunk header "@@ -l,c +l,c @@", got: ${raw}`, 'hunks are produced by codkit save; do not hand-edit the body of a .ckpatch', file, headerLine);
    }
    cursor.index += 1;
    const startOld = Number.parseInt(match[1] ?? '0', 10);
    const countOld = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    const startNew = Number.parseInt(match[3] ?? '0', 10);
    const countNew = match[4] === undefined ? 1 : Number.parseInt(match[4], 10);
    const body = [];
    let seenOld = 0;
    let seenNew = 0;
    while (seenOld < countOld || seenNew < countNew) {
        const line = lines[cursor.index];
        if (line === undefined) {
            throw ckError('ARTIFACT-BROKEN', `hunk "${raw}" ends after ${seenOld} of ${countOld} old and ${seenNew} of ${countNew} new lines`, 'the hunk header counts and the hunk body disagree; regenerate the patch with codkit save', file, cursor.index + 1);
        }
        const parsed = readHunkLine(line, file, cursor.index + 1);
        cursor.index += 1;
        if (parsed.kind === '\\') {
            body.push(parsed);
            continue;
        }
        if (parsed.kind !== '+') {
            seenOld += 1;
        }
        if (parsed.kind !== '-') {
            seenNew += 1;
        }
        body.push(parsed);
    }
    // A "\ No newline at end of file" belonging to the last body line sits after
    // the counted lines and still belongs to this hunk.
    while (cursor.index < lines.length && (lines[cursor.index] ?? '').startsWith('\\')) {
        body.push(readHunkLine(lines[cursor.index] ?? '', file, cursor.index + 1));
        cursor.index += 1;
    }
    if (seenOld !== countOld || seenNew !== countNew) {
        throw ckError('ARTIFACT-BROKEN', `hunk "${raw}" declares ${countOld}/${countNew} lines but carries ${seenOld}/${seenNew}`, 'the hunk header counts and the hunk body disagree; regenerate the patch with codkit save', file, headerLine);
    }
    return { startOld, countOld, startNew, countNew, lines: body, header: raw, headerLine };
}
function readHunkLine(line, file, lineNumber) {
    if (line === '') {
        // An empty line is a context line whose trailing space was stripped.
        return { kind: ' ', text: '', bare: true };
    }
    const marker = line.charAt(0);
    if (marker === ' ' || marker === '+' || marker === '-') {
        return { kind: marker, text: line.slice(1), bare: false };
    }
    if (marker === '\\') {
        const text = line.slice(1);
        if (text !== NO_NEWLINE_TEXT) {
            throw ckError('ARTIFACT-BROKEN', `unknown backslash directive in the hunk body: ${line}`, `the only directive unified diff carries is "\\${NO_NEWLINE_TEXT}"`, file, lineNumber);
        }
        return { kind: '\\', text, bare: false };
    }
    throw ckError('ARTIFACT-BROKEN', `hunk body line starts with "${marker}", which is not one of " ", "+", "-" or "\\": ${line}`, 'do not hand-edit the body of a .ckpatch; regenerate it with codkit save', file, lineNumber);
}
function checkAddFileShape(hunks, file) {
    const first = hunks[0];
    if (hunks.length !== 1 || first === undefined) {
        throw ckError('ARTIFACT-BROKEN', `an add-file patch carries exactly one hunk, this one has ${hunks.length}`, 'the shape is: --- /dev/null, +++ b/<path>, @@ -0,0 +1,N @@', file, hunks[1]?.headerLine);
    }
    if (first.startOld !== 0 || first.countOld !== 0) {
        throw ckError('ARTIFACT-BROKEN', `an add-file patch has the hunk header "@@ -0,0 +1,N @@", got "${first.header}"`, 'the minus side of a new file is empty, so its start and count are both 0', file, first.headerLine);
    }
    for (const line of first.lines) {
        if (line.kind === ' ' || line.kind === '-') {
            throw ckError('ARTIFACT-BROKEN', 'an add-file patch has only added lines, but this hunk carries context or removed lines', 'regenerate the patch with codkit save', file, first.headerLine);
        }
    }
}
