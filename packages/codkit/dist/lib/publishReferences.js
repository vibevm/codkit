/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The reference groups of `publish --scrub` (PROP-007 ##PUBLISH-SCRUB-GROUPS):
// the bare references of comment text and of Markdown prose, taken out as whole
// groups where the sentence reads the same without them, and left everywhere
// else for the fail-closed search (##PUBLISH-SCRUB-FAIL-CLOSED). Pure: no git
// and no file system.
//
// The text is read in runs - the consecutive lines of one comment paragraph or
// of one Markdown paragraph, joined with their line breaks - so that a group,
// and the parenthetical around it, may continue onto the next line. A removal
// never takes a line break: every line keeps its place, and a line left
// without text goes the way ##PUBLISH-SCRUB drops an emptied comment line.
import { delimitersOnly, droppable, readCommentLine } from './publishScrub.js';
import { findTokens, isIdShaped } from './publishVocabulary.js';
export const NO_GROUPS = { parenthetical: 0, lead: 0, sentence: 0, preposition: 0 };
const MARKDOWN = /\.(?:md|markdown)$/i;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BLANK = /[ \t]/;
const ENDS_IN_PUNCTUATION = /[.,;:!?]$/;
const TIDY_BEFORE = /[.,;:!?)]/;
const DOUBLED = /[,;]/;
const SEPARATOR = /^(?:[ \t\n]*[,;][ \t\n]*(?:and[ \t\n]+)?|[ \t\n]+and[ \t\n]+|[ \t\n]+)$/;
const QUALIFIER_BEFORE = /(\p{L}[\p{L}\p{N}_-]*)[ \t\n]+$/u;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const SECTION = /^[ \t\n]+section[ \t\n]+\d+[a-z]?(?:\.\d+[a-z]?)*(?![\p{L}\p{N}_])/u;
const DECISION = /^(?:[ \t\n]*[,;])?[ \t\n]+decision[ \t\n]+(`?)([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)\1(?![\p{L}\p{N}_])/u;
const OPEN_PARENTHESIS = /\([ \t\n]*$/;
const CLOSE_PARENTHESIS = /^[ \t\n]*\)/;
const COLON = /^[ \t]*:[ \t\n]*/;
const SEE = /(?:^|[^\p{L}\p{N}_])([Ss]ee[ \t\n]+)$/u;
const SENTENCE_STOP = /^[ \t\n]*[.!?](?=[ \t\n]|$)/;
const RUN_END = /^[ \t\n]*$/;
const PREPOSITION = /[ \t\n]+(?:of|in|by|per|from)[ \t\n]+$/;
const TRAILING_BLANKS = /[ \t\n]+$/;
const LEADING_BLANKS = /^[ \t\n]*/;
const LEADING_PUNCTUATION = /^[ \t]*([.,;:])/;
/** Markdown prose files: the group rules read their prose lines as well as their comments. */
export function isMarkdownProse(path) {
    return MARKDOWN.test(path);
}
/**
 * Take the reference groups out of the comment text of one file, and out of
 * its prose when it is Markdown. Code lines and fenced code are never altered.
 */
export function scrubReferences(text, syntax, prose, vocabulary) {
    if ((syntax === null && !prose) || findTokens(vocabulary, text, prose).length === 0) {
        return { text, groups: NO_GROUPS, droppedLines: 0 };
    }
    const slots = slotsOf(text, syntax, prose);
    const counts = { parenthetical: 0, lead: 0, sentence: 0, preposition: 0 };
    const rewritten = new Map();
    for (const run of runsOf(slots)) {
        const lines = run.map((index) => slots[index].text);
        const scrubbed = scrubRun(lines, vocabulary, prose, counts);
        if (scrubbed === null)
            continue;
        scrubbed.forEach((line, at) => {
            if (line !== null)
                rewritten.set(run[at] ?? -1, line);
        });
    }
    if (rewritten.size === 0)
        return { text, groups: NO_GROUPS, droppedLines: 0 };
    const out = [];
    let droppedLines = 0;
    slots.forEach((slot, index) => {
        const line = rewritten.get(index);
        if ('raw' in slot || line === undefined) {
            out.push('raw' in slot ? slot.raw : `${slot.prefix}${slot.text}${slot.suffix}${slot.eol}`);
            return;
        }
        if (line.trim() !== '') {
            out.push(`${slot.prefix}${line}${slot.suffix}${slot.eol}`);
        }
        else if (slot.comment === null || droppable(slot.comment)) {
            droppedLines += 1;
        }
        else {
            out.push(`${delimitersOnly(slot.comment)}${slot.eol}`);
        }
    });
    return { text: out.join('\n'), groups: counts, droppedLines };
}
/** Every line of the file: raw code, or a line of comment or prose text. */
function slotsOf(text, syntax, prose) {
    const slots = [];
    let inBlock = false;
    let fence = null;
    for (const raw of text.split('\n')) {
        const eol = raw.endsWith('\r') ? '\r' : '';
        const line = eol === '' ? raw : raw.slice(0, -1);
        if (prose && !inBlock) {
            // Fenced code is code: a fence opens with three backticks or tildes and closes with as many.
            const marker = FENCE.exec(line)?.[1] ?? null;
            if (fence !== null || marker !== null) {
                if (fence === null)
                    fence = marker;
                else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length)
                    fence = null;
                slots.push({ raw });
                continue;
            }
        }
        const comment = syntax === null ? null : readCommentLine(line, syntax, inBlock);
        if (comment !== null) {
            inBlock = comment.inBlockAfter;
            const channel = comment.kind === 'line' ? 'line' : 'block';
            slots.push({ channel, prefix: comment.prefix, text: comment.text, suffix: comment.suffix, eol, comment, closes: comment.closes });
        }
        else if (prose) {
            const indent = /^[ \t]*/.exec(line)?.[0] ?? '';
            slots.push({ channel: 'prose', prefix: indent, text: line.slice(indent.length), suffix: '', eol, comment: null, closes: false });
        }
        else {
            slots.push({ raw });
        }
    }
    return slots;
}
/** Paragraphs: consecutive lines with text of one channel; a blank line, code or a closed block ends one. */
function runsOf(slots) {
    const runs = [];
    let current = [];
    let channel = null;
    const flush = () => {
        if (current.length > 0)
            runs.push(current);
        current = [];
        channel = null;
    };
    slots.forEach((slot, index) => {
        if ('raw' in slot || slot.text.trim() === '') {
            flush();
            return;
        }
        if (channel !== null && channel !== slot.channel)
            flush();
        current.push(index);
        channel = slot.channel;
        if (slot.closes)
            flush();
    });
    flush();
    return runs;
}
/** The lines of one run with its groups taken out; null for a line the run left alone. */
function scrubRun(lines, vocabulary, prose, counts) {
    const text = lines.join('\n');
    const matches = findTokens(vocabulary, text, prose);
    if (matches.length === 0)
        return null;
    const spans = [];
    for (const group of groupsOf(text, matches, vocabulary)) {
        const span = removalOf(text, group);
        if (span === null)
            continue;
        spans.push(span);
        counts[span.rule] += 1;
    }
    return spans.length === 0 ? null : applySpans(text, spans);
}
/** Maximal runs of tokens with their qualifiers, joined by commas, semicolons, `and` or blanks. */
function groupsOf(text, matches, vocabulary) {
    const groups = [];
    let index = 0;
    while (index < matches.length) {
        const first = matches[index];
        if (first === undefined)
            break;
        const start = qualifiedStart(text, first, vocabulary);
        let end = qualifiedEnd(text, matches, index);
        index += 1;
        for (let next = matches[index]; next !== undefined; next = matches[index]) {
            const nextStart = qualifiedStart(text, next, vocabulary);
            if (nextStart < end || !SEPARATOR.test(text.slice(end, nextStart)))
                break;
            end = qualifiedEnd(text, matches, index);
            index += 1;
        }
        groups.push({ start, end });
    }
    return groups;
}
/**
 * Where a token begins with what stands before it: its backtick, and a module
 * name, `decision`, or - before an intervention id - `intervention(s)`.
 */
function qualifiedStart(text, match, vocabulary) {
    const start = text[match.start - 1] === '`' && text[match.end] === '`' ? match.start - 1 : match.start;
    const qualifier = QUALIFIER_BEFORE.exec(text.slice(0, start));
    if (qualifier === null || isWordCharacter(text[qualifier.index - 1]))
        return start;
    const word = qualifier[1] ?? '';
    const intervention = match.kind === 'intervention' && (word === 'intervention' || word === 'interventions');
    return vocabulary.modules.has(word) || word === 'decision' || intervention ? qualifier.index : start;
}
/** Where a token ends with what follows it: its backtick, `section <n>`, and `decision <id>`. */
function qualifiedEnd(text, matches, index) {
    const match = matches[index];
    if (match === undefined)
        return text.length;
    const nextStart = matches[index + 1]?.start ?? text.length;
    let end = text[match.start - 1] === '`' && text[match.end] === '`' ? match.end + 1 : match.end;
    for (;;) {
        const rest = text.slice(end);
        const section = SECTION.exec(rest);
        if (section !== null) {
            end += section[0].length;
            continue;
        }
        const decision = DECISION.exec(rest);
        if (decision !== null && isIdShaped(decision[2] ?? '') && end + decision[0].length <= nextStart) {
            end += decision[0].length;
            continue;
        }
        return end;
    }
}
/** The rule that takes a group out, and the exact span it takes; null leaves the group in place. */
function removalOf(text, group) {
    const head = text.slice(0, group.start);
    const tail = text.slice(group.end);
    const open = OPEN_PARENTHESIS.exec(head);
    const close = CLOSE_PARENTHESIS.exec(tail);
    if (open !== null && close !== null) {
        const blank = /[ \t]*$/.exec(head.slice(0, open.index))?.[0].length ?? 0;
        return { start: open.index - blank, end: group.end + close[0].length, rule: 'parenthetical' };
    }
    const colon = COLON.exec(tail);
    if (colon !== null && opensSentence(text, group.start)) {
        return { start: group.start, end: group.end + colon[0].length, rule: 'lead' };
    }
    const see = SEE.exec(head);
    const opening = see === null ? group.start : group.start - (see[1]?.length ?? 0);
    const stop = SENTENCE_STOP.exec(tail) ?? RUN_END.exec(tail);
    if (stop !== null && opensSentence(text, opening)) {
        const end = group.end + stop[0].length;
        const before = text.slice(0, opening);
        if (before.trim() === '')
            return { start: opening, end: end + (LEADING_BLANKS.exec(text.slice(end))?.[0].length ?? 0), rule: 'sentence' };
        return { start: before.replace(TRAILING_BLANKS, '').length, end, rule: 'sentence' };
    }
    const preposition = PREPOSITION.exec(head);
    if (preposition !== null)
        return { start: preposition.index, end: group.end, rule: 'preposition' };
    return null;
}
/** At the start of the run, or after the stop of a sentence and a blank. */
function opensSentence(text, at) {
    const before = text.slice(0, at);
    const trimmed = before.replace(TRAILING_BLANKS, '');
    return trimmed === '' || (/[.!?]$/.test(trimmed) && trimmed.length < before.length);
}
/**
 * The run without its spans, line by line, tidied only where something went:
 * a blank before `.`, `,`, `:`, `;` or `)` goes, a double blank becomes one, a
 * comma or semicolon doubled across the gap is one, and a line whose start went
 * gives its leading punctuation to the previous line of the run - unless that
 * line already ends in punctuation.
 */
function applySpans(text, spans) {
    const removed = new Uint8Array(text.length);
    for (const span of spans) {
        for (let at = span.start; at < span.end; at += 1)
            if (text[at] !== '\n')
                removed[at] = 1;
    }
    const lines = [];
    let current = { text: '', seams: [], touched: false };
    let pending = false;
    for (let at = 0; at <= text.length; at += 1) {
        if (at === text.length || text[at] === '\n') {
            if (pending)
                current.seams.push(current.text.length);
            lines.push(current);
            current = { text: '', seams: [], touched: false };
            pending = false;
        }
        else if (removed[at] === 1) {
            pending = true;
            current.touched = true;
        }
        else {
            if (pending)
                current.seams.push(current.text.length);
            pending = false;
            current.text += text[at];
        }
    }
    const values = lines.map((line) => line.text);
    const changed = lines.map((line) => line.touched);
    lines.forEach((line, index) => {
        let value = line.text;
        for (const seam of [...line.seams].sort((left, right) => right - left))
            value = tidy(value, seam);
        if (line.seams.includes(0)) {
            const punctuation = LEADING_PUNCTUATION.exec(value);
            if (punctuation !== null) {
                carry(values, changed, index, punctuation[1] ?? '');
                value = value.slice(punctuation[0].length);
            }
            value = value.replace(/^[ \t]+/, '');
        }
        values[index] = value;
    });
    return values.map((value, index) => (changed[index] === true ? value : null));
}
/** Tidy the blanks around one seam of a line. */
function tidy(line, seam) {
    if (seam === 0)
        return line;
    let from = seam;
    while (from > 0 && BLANK.test(line[from - 1] ?? ''))
        from -= 1;
    let to = seam;
    while (to < line.length && BLANK.test(line[to] ?? ''))
        to += 1;
    if (to === line.length)
        return line.slice(0, from);
    if (from === 0)
        return line;
    const previous = line[from - 1] ?? '';
    if (DOUBLED.test(previous) && line[to] === previous)
        return line.slice(0, from) + line.slice(to + 1);
    if (TIDY_BEFORE.test(line[to] ?? ''))
        return line.slice(0, from) + line.slice(to);
    return to - from > 1 ? `${line.slice(0, from)} ${line.slice(to)}` : line;
}
/** Leading punctuation goes to the end of the nearest earlier line with text, when that line has none. */
function carry(values, changed, index, punctuation) {
    for (let at = index - 1; at >= 0; at -= 1) {
        const shown = (values[at] ?? '').trimEnd();
        if (shown === '')
            continue;
        if (!ENDS_IN_PUNCTUATION.test(shown)) {
            values[at] = `${shown}${punctuation}`;
            changed[at] = true;
        }
        return;
    }
}
function isWordCharacter(character) {
    return character !== undefined && WORD_CHARACTER.test(character);
}
