/** @scope spec://codkit/modules/codkit/PROP-005#root */
// rewrite-rule layer: the artifact format and the match counter
// (PROP-005 sec. 7).
//
// A rule is a declarative operation over the text of an upstream file as it
// stands at the pin; what it produces is an ordinary .ckpatch, so the layer adds
// no new way of applying anything. The engine that generates that patch is not
// part of this milestone. What is implemented here is the artifact itself: the
// schema, the marker discipline every rule has to obey, and the counter.
//
// The counter is the point of the layer. A rule declares how many lines of the
// file at the pin its operations expect to match; when upstream rewrites those
// lines, the count moves and the mismatch is a loud failure (CK-E-RULE-DRIFT,
// raised by `verify`) rather than a contribution that quietly stops being
// generated. Counting is done here; comparing the count with `expectedMatches`
// belongs to `verify`.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LF_BYTE } from '../bytes.js';
import { BEGIN_TOKEN, END_TOKEN } from '../markers.js';
import { ckError } from '../messages.js';
export const RULE_SCHEMA_VERSION = 2;
/** Rules live here, one file per rule, relative to the patchset root. */
export const RULES_DIR = 'delta/rules';
export const RULE_FILE_SUFFIX = '.ckrule.json';
/** The only engine of the MVP: line operations, no regular expressions. */
export const RULE_ENGINE = 'line-ops';
export const RULE_ACTIONS = ['comment-out', 'append-after', 'insert-before'];
/** Actions that put a line of our own into the file. */
const INSERTING_ACTIONS = ['append-after', 'insert-before'];
const operationSchema = z.object({
    match: z.string().min(1),
    action: z.enum(RULE_ACTIONS),
    text: z.string().optional()
});
const ruleSchema = z.object({
    codkitRule: z.literal(RULE_SCHEMA_VERSION),
    id: z.string().min(1),
    type: z.string().min(1),
    category: z.string().min(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    link: z.string().min(1),
    cause: z.string().min(1),
    pin: z.string().min(1),
    contractTests: z.array(z.string().min(1)),
    target: z.string().min(1),
    engine: z.literal(RULE_ENGINE),
    expectedMatches: z.int().min(0),
    ops: z.array(operationSchema).min(1)
});
/**
 * What each field must be, in the words a reviewer can act on. The registry has
 * no rule-schema code of its own: a rule that does not parse is a broken
 * artifact (CK-E-ARTIFACT-BROKEN), while CK-E-RULE-DRIFT is reserved for the one
 * thing it means - the counter no longer agrees with the file at the pin.
 */
const FIELD_EXPECTATION = {
    codkitRule: `must be exactly ${RULE_SCHEMA_VERSION}`,
    id: 'must be a non-empty artifact id',
    type: 'must be a non-empty intervention type',
    category: 'must be a non-empty category',
    owner: 'must be a non-empty owner name',
    reason: 'must be a non-empty reason',
    link: 'must be an issue reference or the literal "none"',
    cause: 'must be an upstream sha or the literal "none"',
    pin: 'must be "<tag>@<sha>" of the pin the rule was written against',
    contractTests: 'must be a list of contract test names',
    target: 'must be the path of the upstream file from the tree root',
    engine: `must be "${RULE_ENGINE}", the only rule engine of this version`,
    expectedMatches: 'must be a whole number of expected matches, zero or more',
    ops: 'must be a non-empty list of line operations',
    match: 'must be the exact upstream line the operation looks for',
    action: `must be one of ${RULE_ACTIONS.join(', ')}`,
    text: 'must be the line to insert'
};
const HINT = 'see PROP-005 sec. 7 for the rewrite-rule format';
/** Read every rule in the repository, in path order. */
export function loadRules(patchesDir) {
    const dir = join(patchesDir, ...RULES_DIR.split('/'));
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return [];
    }
    const files = names
        .filter((name) => name.endsWith(RULE_FILE_SUFFIX))
        .sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    return files.map((name) => parseRuleFile(join(dir, name), `${RULES_DIR}/${name}`));
}
export function parseRuleFile(absolutePath, artifactPath) {
    let raw;
    try {
        raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
    }
    catch (error) {
        throw broken(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'a rule is plain JSON without comments', artifactPath);
    }
    return parseRule(raw, artifactPath);
}
/** Validate a decoded rule document. Exposed so tests need no file. */
export function parseRule(raw, artifactPath) {
    const parsed = ruleSchema.safeParse(raw);
    if (!parsed.success) {
        throw schemaError(parsed.error.issues, raw, artifactPath);
    }
    assertInsertionsHaveText(parsed.data.ops, artifactPath);
    assertMarkerEnvelope(parsed.data.ops, parsed.data.id, artifactPath);
    return { ...parsed.data, artifactPath };
}
/** Canonical artifact bytes: schema key order, two spaces, exactly one final LF. */
export function serializeRule(rule) {
    const ops = rule.ops.map((operation) => {
        const canonical = {
            match: operation.match,
            action: operation.action
        };
        if (operation.text !== undefined)
            canonical.text = operation.text;
        return canonical;
    });
    const canonical = {
        codkitRule: rule.codkitRule,
        id: rule.id,
        type: rule.type,
        category: rule.category,
        owner: rule.owner,
        reason: rule.reason,
        link: rule.link,
        cause: rule.cause,
        pin: rule.pin,
        contractTests: [...rule.contractTests],
        target: rule.target,
        engine: rule.engine,
        expectedMatches: rule.expectedMatches,
        ops
    };
    return `${JSON.stringify(canonical, null, 2)}\n`;
}
/**
 * How many lines of the file at the pin each operation matches, and the total.
 *
 * The comparison is byte-for-byte over the whole line (##RULE-LINE-OPS: an exact
 * line, no regular expressions in this version), so a line that differs by one
 * space does not count - which is exactly what makes the counter able to see
 * upstream drift.
 *
 * The final line feed of a file terminates its last line; it does not open an
 * empty one, so a file of N lines has N candidates and not N+1.
 */
export function countRuleMatches(rule, pinBytes) {
    const lines = splitLines(pinBytes);
    const perOp = [];
    let total = 0;
    for (const operation of rule.ops) {
        const needle = Buffer.from(operation.match, 'utf8');
        let count = 0;
        for (const line of lines) {
            if (line.equals(needle)) {
                count += 1;
            }
        }
        perOp.push(count);
        total += count;
    }
    return { perOp, total };
}
/** The bytes of every line of a file, terminators excluded. */
function splitLines(bytes) {
    const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lines = [];
    let start = 0;
    for (let index = 0; index < buffer.length; index += 1) {
        if (buffer[index] === LF_BYTE) {
            lines.push(buffer.subarray(start, index));
            start = index + 1;
        }
    }
    if (start < buffer.length) {
        lines.push(buffer.subarray(start));
    }
    return lines;
}
function assertInsertionsHaveText(operations, artifactPath) {
    for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        if (operation === undefined) {
            continue;
        }
        const inserts = INSERTING_ACTIONS.includes(operation.action);
        if (inserts && (operation.text === undefined || operation.text === '')) {
            throw broken(`ops[${index}].text is required for action "${operation.action}", got nothing`, 'an operation that inserts a line has to say which line', artifactPath);
        }
        if (!inserts && operation.text !== undefined) {
            throw broken(`ops[${index}].text has no meaning for action "${operation.action}"`, 'comment-out neutralizes the matched upstream line; it inserts nothing', artifactPath);
        }
    }
}
/**
 * ##RULE-LINE-OPS: every line a rule inserts has to lie inside a marker block
 * that the rule opens and closes itself - the first insertion carries the begin
 * marker of the rule id, the last one the end marker. Without that, the
 * generated patch would add lines outside any block and `verify` would refuse
 * it (CK-E-HUNK-OUTSIDE-MARKER) long after the rule was written.
 */
function assertMarkerEnvelope(operations, id, artifactPath) {
    const insertions = [];
    for (let index = 0; index < operations.length; index += 1) {
        const operation = operations[index];
        if (operation !== undefined && INSERTING_ACTIONS.includes(operation.action) && operation.text !== undefined) {
            insertions.push({ index, text: operation.text });
        }
    }
    const begin = `${BEGIN_TOKEN} ${id}`;
    const end = `${END_TOKEN} ${id}`;
    const first = insertions[0];
    const last = insertions[insertions.length - 1];
    if (first === undefined || last === undefined) {
        throw broken(`inserts no lines, so it opens no marker block for ${id}`, `a rule writes its own block: the first inserted line carries "${begin}" and the last one "${end}"`, artifactPath);
    }
    if (!first.text.includes(begin)) {
        throw broken(`ops[${first.index}].text is the first inserted line and does not open the marker block: it must contain "${begin}"`, 'a rule wraps everything it inserts in a block of its own id', artifactPath);
    }
    if (!last.text.includes(end)) {
        throw broken(`ops[${last.index}].text is the last inserted line and does not close the marker block: it must contain "${end}"`, 'a rule wraps everything it inserts in a block of its own id', artifactPath);
    }
}
function schemaError(issues, raw, artifactPath) {
    const issue = issues[0];
    if (issue === undefined) {
        return broken('failed validation', HINT, artifactPath);
    }
    const label = renderIssuePath(issue.path);
    const field = String(issue.path[issue.path.length - 1] ?? '');
    const expectation = FIELD_EXPECTATION[field] ?? issue.message;
    const actual = valueAtPath(raw, issue.path);
    const got = actual === undefined ? 'nothing' : renderValue(actual);
    return broken(label === '' ? `${expectation}, got ${got}` : `${label} ${expectation}, got ${got}`, HINT, artifactPath);
}
function renderIssuePath(path) {
    let out = '';
    for (const segment of path) {
        if (typeof segment === 'number') {
            out += `[${segment}]`;
            continue;
        }
        out = out === '' ? String(segment) : `${out}.${String(segment)}`;
    }
    return out;
}
function renderValue(value) {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function valueAtPath(raw, path) {
    let current = raw;
    for (const segment of path) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = current[String(segment)];
    }
    return current;
}
function broken(message, hint, artifactPath) {
    return ckError('ARTIFACT-BROKEN', message, hint, artifactPath);
}
