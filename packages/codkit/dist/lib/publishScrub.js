/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The text rules of `publish --scrub` (PROP-007 ##PUBLISH-SCRUB): what one
// delivered file loses on its way into a clean release - codkit's marker lines
// and the spec references of its comment lines - and nothing else. Pure: no
// git and no file system; publishRelease.ts applies it to the release tree.
//
// The reading is line based on purpose. A comment line is one whose first
// non-blank characters open a comment of the file's syntax, or one that
// continues a block comment opened that way; a code line is never touched, and
// whatever it carries is left to the fail-closed search of the release tree
// (##PUBLISH-SCRUB-FAIL-CLOSED).
import { escapeRegExp } from './bytes.js';
import { markerFormFor } from './markers.js';
/** What the fail-closed search of the release tree looks for, ignoring case. */
export const LEFTOVER_PATTERN = 'codkit:(begin|end)|spec://|vibevm';
const MARKER_KEYWORD = 'codkit:';
const SPEC_SCHEME = 'spec://';
const DOC_KEY_PREFIX = '_';
/** A comment line whose whole text is a tag and its spec references. */
const TAG_LINE = /^@[A-Za-z][\w-]*(?:[ \t]+spec:\/\/\S+)+$/;
/** A parenthetical that opens the text, the punctuation after it, and the blank after that. */
const LEADING_PARENTHETICAL = /^\(spec:\/\/[^()]*\)([.,;:])?[ \t]*/;
/** A parenthetical anywhere else, with its leading blank. */
const PARENTHETICAL = /[ \t]*\(spec:\/\/[^()]*\)/g;
/** A bare token with its leading blank: in backticks, or up to a blank or a bracket. */
const BARE_TOKEN = /[ \t]*(?:`spec:\/\/[^`\s]*`|spec:\/\/[^\s()`'"<>]*)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const ENDS_IN_PUNCTUATION = /[.,;:!?]$/;
const LEADING_BLANK = /^[ \t]/;
/**
 * Every marker form the effective conventions know (PROP-004 sec. 1): the
 * shipped ones and the ones a conventions extension adds, each once.
 */
export function markerFormsOf(conventions) {
    const forms = new Map();
    for (const key of Object.keys(conventions.markerComment)) {
        if (key.startsWith(DOC_KEY_PREFIX))
            continue;
        const form = markerFormFor(key, conventions);
        if (form !== null)
            forms.set(`${form.open}\0${form.close}`, form);
    }
    return [...forms.values()];
}
/** The comment syntax of a file, or null when its extension has no marker form. */
export function commentSyntaxOf(path, conventions) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot <= 0)
        return null;
    const form = markerFormFor(name.slice(dot), conventions);
    return form === null ? null : syntaxOfForm(form);
}
function syntaxOfForm(form) {
    const keyword = form.open.lastIndexOf(MARKER_KEYWORD);
    const leader = (keyword === -1 ? form.open : form.open.slice(0, keyword)).trim();
    if (leader === '')
        return null;
    const close = form.close.trim();
    if (close !== '')
        return { line: null, block: { open: leader, close } };
    // A language with `//` line comments writes `/* */` blocks as well.
    return { line: leader, block: leader === '//' ? { open: '/*', close: '*/' } : null };
}
/**
 * Scrub one file: drop every marker line in any known form, then take the spec
 * references out of its comment lines. A file without a comment syntax loses
 * its marker lines only.
 */
export function scrubText(text, syntax, forms) {
    const markerLines = forms.map(markerLinePattern);
    const out = [];
    let markers = 0;
    let specRefs = 0;
    let droppedLines = 0;
    let inBlock = false;
    // The last kept comment line with text, where a leading parenthetical's
    // punctuation goes; null as soon as anything else was kept after it.
    let lastText = null;
    for (const raw of text.split('\n')) {
        const eol = raw.endsWith('\r') ? '\r' : '';
        const line = eol === '' ? raw : raw.slice(0, -1);
        if (markerLines.some((pattern) => pattern.test(line))) {
            markers += 1;
            continue;
        }
        const comment = syntax === null ? null : readCommentLine(line, syntax, inBlock);
        if (comment === null) {
            out.push(raw);
            lastText = null;
            continue;
        }
        inBlock = comment.inBlockAfter;
        const scrubbed = scrubComment(comment.text);
        if (scrubbed.refs === 0) {
            out.push(raw);
            lastText = comment.text.trim() === '' ? null : { index: out.length - 1, end: comment.prefix.length + comment.text.trimEnd().length };
            continue;
        }
        specRefs += scrubbed.refs;
        if (scrubbed.carry !== null && lastText !== null) {
            const previous = out[lastText.index] ?? '';
            const head = previous.slice(0, lastText.end);
            if (!ENDS_IN_PUNCTUATION.test(head))
                out[lastText.index] = `${head}${scrubbed.carry}${previous.slice(lastText.end)}`;
        }
        if (scrubbed.text.trim() === '') {
            if (droppable(comment)) {
                droppedLines += 1;
                continue;
            }
            out.push(`${delimitersOnly(comment)}${eol}`);
            lastText = null;
            continue;
        }
        out.push(`${comment.prefix}${scrubbed.text}${comment.suffix}${eol}`);
        lastText = { index: out.length - 1, end: comment.prefix.length + scrubbed.text.trimEnd().length };
    }
    return { text: out.join('\n'), markers, specRefs, droppedLines };
}
/** `<indent><open>begin|end <name><close>` and nothing else on the line. */
function markerLinePattern(form) {
    return new RegExp(`^\\s*${escapeRegExp(form.open.trimEnd())}(?:begin|end)\\s+[A-Za-z0-9][A-Za-z0-9._-]*\\s*${escapeRegExp(form.close.trim())}\\s*$`);
}
export function readCommentLine(line, syntax, inBlock) {
    const block = syntax.block;
    if (inBlock && block !== null) {
        return blockLine('continue', line, continuationLead(line, block.open), block.close);
    }
    const indent = /^\s*/.exec(line)?.[0] ?? '';
    const rest = line.slice(indent.length);
    if (syntax.line !== null && rest.startsWith(syntax.line)) {
        const lead = indent + syntax.line + (/^[ \t]*/.exec(rest.slice(syntax.line.length))?.[0] ?? '');
        return { kind: 'line', prefix: lead, text: line.slice(lead.length), suffix: '', closes: false, codeAfter: false, inBlockAfter: false };
    }
    if (block !== null && rest.startsWith(block.open)) {
        const after = rest.slice(block.open.length);
        const stars = block.open === '/*' ? (/^\*+/.exec(after)?.[0] ?? '') : '';
        const blank = /^[ \t]*/.exec(after.slice(stars.length))?.[0] ?? '';
        return blockLine('open', line, indent + block.open + stars + blank, block.close);
    }
    return null;
}
/** A line of a block comment: its text runs from `lead` to the close, when the line has one. */
function blockLine(kind, line, lead, close) {
    const at = line.indexOf(close, lead.length);
    if (at === -1) {
        return { kind, prefix: lead, text: line.slice(lead.length), suffix: '', closes: false, codeAfter: false, inBlockAfter: true };
    }
    const body = line.slice(lead.length, at);
    const text = body.trimEnd();
    return {
        kind,
        prefix: lead,
        text,
        suffix: body.slice(text.length) + line.slice(at),
        closes: true,
        codeAfter: line.slice(at + close.length).trim() !== '',
        inBlockAfter: false
    };
}
/** The lead of a continuation line: its indentation and a JSDoc `*` that is not a close. */
function continuationLead(line, open) {
    return (open === '/*' ? /^\s*(?:\*(?!\/)[ \t]*)?/ : /^\s*/).exec(line)?.[0] ?? '';
}
/**
 * A line left without text can go when that loses no delimiter and no code: a
 * line comment, a line inside a block, or a whole block on one line.
 */
export function droppable(comment) {
    if (comment.kind === 'line')
        return true;
    if (comment.kind === 'continue')
        return !comment.closes;
    return comment.closes && !comment.codeAfter;
}
/** What a line that opens or closes a block keeps when its text is gone. */
export function delimitersOnly(comment) {
    const opening = comment.prefix.trimEnd();
    if (comment.kind === 'open')
        return comment.closes ? `${opening} ${comment.suffix.trimStart()}` : opening;
    const indent = /^\s*/.exec(comment.prefix)?.[0] ?? '';
    return `${indent}${comment.suffix.trimStart()}`;
}
function scrubComment(text) {
    if (!text.includes(SPEC_SCHEME))
        return { text, refs: 0, carry: null };
    if (TAG_LINE.test(text.trim()))
        return { text: '', refs: text.split(SPEC_SCHEME).length - 1, carry: null };
    let refs = 0;
    let carry = null;
    let rest = text;
    const leading = LEADING_PARENTHETICAL.exec(rest);
    if (leading !== null) {
        refs += 1;
        carry = leading[1] ?? null;
        rest = rest.slice(leading[0].length);
    }
    rest = rest.replace(PARENTHETICAL, () => {
        refs += 1;
        return '';
    });
    rest = rest.replace(BARE_TOKEN, (token) => {
        refs += 1;
        return token.trimEnd().endsWith('`') ? '' : (TRAILING_PUNCTUATION.exec(token)?.[0] ?? '');
    });
    // A reference that opened the text leaves no blank in front of what follows it.
    if (LEADING_BLANK.test(rest) && !LEADING_BLANK.test(text))
        rest = rest.trimStart();
    return { text: rest, refs, carry };
}
