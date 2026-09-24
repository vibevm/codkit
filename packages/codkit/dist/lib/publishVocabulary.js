/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The vocabulary of `publish --scrub` (PROP-007 ##PUBLISH-SCRUB-VOCABULARY): the
// bare references a clean release loses, learned from the patch set itself - the
// intervention ids it declares, the ids of the spec documents it carries, the
// `spec://` references of its delivered files - and completed by the owner's
// configuration (PROP-003 ##CFG-PUBLISH-SCRUB-VOCABULARY). No naming pattern of
// any project is written here: a learned word is vocabulary only when it has the
// shape of an id (##PUBLISH-SCRUB-ID-SHAPE), whatever the project calls its
// documents.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SPEC_ROOTS } from './configFile.js';
import { buildInventory } from './inventory.js';
import { BEGIN_TOKEN, END_TOKEN } from './markers.js';
export const EMPTY_SETTINGS = { specRoots: [], vocabulary: [], allow: [] };
/** ##PUBLISH-SCRUB-ID-SHAPE: the shortest word that can be an id. */
const MIN_ID_LENGTH = 4;
const ID_CHARACTERS = /^[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?$/u;
const UPPER_CASE = /\p{Lu}/u;
const HYPHEN_OR_DIGIT = /[-\p{N}]/u;
const WORD = /[\p{L}\p{N}_]+/gu;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const MODULE_NAME = /^\p{L}[\p{L}\p{N}_-]*$/u;
const SPEC_DOCUMENT_SUFFIX = '.xml';
const XML_COMMENT = /<!--[\s\S]*?-->/g;
const START_TAG = /<([A-Za-z_][\w.:-]*)((?:\s[^<>]*?)?)\/?>/g;
const FACT_ATTRIBUTE = /(?:^|\s)fact\s*=\s*["']true["']/;
const ID_ATTRIBUTE = /(?:^|\s)id\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ROOT_TITLE = /<title\b[^>]*>([\s\S]*?)<\/title>/;
const MARKUP = /<[^>]*>/g;
const TITLE_WORD = /[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?/gu;
const SPEC_URI = /spec:\/\/([^\s#()'"<>`]+)(?:#([^\s()'"<>`,;]+))?/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const MARKER_NAME = new RegExp(`(?:${BEGIN_TOKEN}|${END_TOKEN})[ \\t]+([A-Za-z0-9][A-Za-z0-9._-]*)`, 'g');
/**
 * ##PUBLISH-SCRUB-ID-SHAPE: at least four characters of letters, digits, `_`,
 * `.` and `-`, opening and closing with a letter, a digit or `_`, with an
 * upper-case letter and a hyphen or a digit in it.
 */
export function isIdShaped(word) {
    return word.length >= MIN_ID_LENGTH && ID_CHARACTERS.test(word) && UPPER_CASE.test(word) && HYPHEN_OR_DIGIT.test(word);
}
/** The effective settings: the configured roots, or the default one. */
export function scrubSettingsOf(scrub) {
    return {
        specRoots: scrub?.specRoots ?? DEFAULT_SPEC_ROOTS,
        vocabulary: scrub?.vocabulary ?? [],
        allow: scrub?.allow ?? []
    };
}
/**
 * The sources of the published commit, read from its snapshot: the ids of its
 * inventory and the spec documents under the spec roots. `missing` names a
 * configured root the commit does not carry.
 */
export function vocabularySources(options) {
    const inventory = buildInventory(options.snapshotDir, options.type, { config: options.config, patchSetCommit: options.patchSetSha });
    const documents = [];
    const missing = [];
    for (const root of options.settings.specRoots) {
        if (!collectSpecDocuments(options.snapshotDir, root, documents))
            missing.push(root);
    }
    return {
        sources: { interventionIds: inventory.entries.map((entry) => entry.id), specDocuments: documents, settings: options.settings },
        missing
    };
}
/** Every `*.xml` file under one root of the snapshot; false when the root is not a directory. */
function collectSpecDocuments(snapshotDir, root, into) {
    const walk = (relative) => {
        let entries;
        try {
            entries = readdirSync(join(snapshotDir, ...relative.split('/')), { withFileTypes: true });
        }
        catch {
            return false;
        }
        for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
            const path = `${relative}/${entry.name}`;
            if (entry.isDirectory())
                walk(path);
            else if (entry.isFile() && entry.name.toLowerCase().endsWith(SPEC_DOCUMENT_SUFFIX)) {
                into.push({ path, text: readFileSync(join(snapshotDir, ...path.split('/')), 'utf8') });
            }
        }
        return true;
    };
    return walk(root.replace(/\/+$/, ''));
}
/**
 * The vocabulary of one release: the sources, plus what the delivered files
 * say themselves - the names of their marker lines and their `spec://`
 * references - and the tokens the owner allows the release to carry.
 */
export function learnVocabulary(sources, deliveredTexts) {
    const tokens = new Map();
    const seen = { interventions: new Set(), documents: new Set(), stems: new Set(), facts: new Set() };
    const modules = new Set();
    const learn = (word, kind, bucket) => {
        if (!isIdShaped(word))
            return;
        bucket.add(word);
        if (kind === 'intervention' || !tokens.has(word))
            tokens.set(word, kind);
    };
    for (const id of sources.interventionIds)
        learn(id, 'intervention', seen.interventions);
    for (const document of sources.specDocuments) {
        const learned = readSpecDocument(document);
        learn(learned.stem, 'spec', seen.stems);
        if (learned.documentId !== null)
            learn(learned.documentId, 'spec', seen.documents);
        if (learned.module !== null)
            modules.add(learned.module);
        for (const fact of learned.facts)
            learn(fact, 'spec', seen.facts);
    }
    for (const text of deliveredTexts) {
        if (text.includes(BEGIN_TOKEN) || text.includes(END_TOKEN)) {
            for (const match of text.matchAll(MARKER_NAME))
                learn(match[1] ?? '', 'intervention', seen.interventions);
        }
        if (!text.includes('spec://'))
            continue;
        for (const match of text.matchAll(SPEC_URI)) {
            const segments = (match[1] ?? '').split('/').filter((segment) => segment !== '');
            const namespace = segments[0] ?? '';
            if (MODULE_NAME.test(namespace))
                modules.add(namespace);
            if (segments.length > 1)
                learn((segments[segments.length - 1] ?? '').replace(TRAILING_PUNCTUATION, ''), 'spec', seen.stems);
            learn((match[2] ?? '').replace(TRAILING_PUNCTUATION, ''), 'spec', seen.facts);
        }
    }
    const configured = new Set();
    const patterns = [];
    for (const entry of sources.settings.vocabulary) {
        if (typeof entry === 'string') {
            configured.add(entry);
            if (!tokens.has(entry))
                tokens.set(entry, 'configured');
        }
        else {
            patterns.push(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${entry.regex})(?![\\p{L}\\p{N}_])`, 'gu'));
        }
    }
    const allowed = new Set(sources.settings.allow);
    return {
        tokens,
        patterns,
        modules,
        allowed,
        counts: {
            interventions: seen.interventions.size,
            documents: seen.documents.size,
            stems: seen.stems.size,
            facts: seen.facts.size,
            modules: modules.size,
            configured: configured.size + patterns.length,
            allowed: allowed.size
        }
    };
}
/**
 * One spec document: its file stem; its document id - the part of the stem, cut
 * at a hyphen, that its root title names as a word (`FEAT-004` of
 * `FEAT-004-center-surfaces`, titled `nimbus FEAT-004: ...`); the module, the
 * title's word before that id; and its fact ids - the names of the elements
 * that carry `fact="true"` and the values of the `id` attributes.
 */
export function readSpecDocument(document) {
    const name = document.path.slice(document.path.lastIndexOf('/') + 1);
    const stem = name.slice(0, name.length - SPEC_DOCUMENT_SUFFIX.length);
    const text = document.text.replace(XML_COMMENT, ' ');
    const facts = [];
    for (const tag of text.matchAll(START_TAG)) {
        const attributes = tag[2] ?? '';
        if (FACT_ATTRIBUTE.test(attributes))
            facts.push(tag[1] ?? '');
        for (const id of attributes.matchAll(ID_ATTRIBUTE))
            facts.push(id[1] ?? id[2] ?? '');
    }
    const title = (ROOT_TITLE.exec(text)?.[1] ?? '').replace(MARKUP, ' ');
    const words = [...title.matchAll(TITLE_WORD)].map((match) => match[0]);
    const named = new Set(words);
    let documentId = named.has(stem) ? stem : null;
    for (let at = stem.lastIndexOf('-'); documentId === null && at > 0; at = stem.lastIndexOf('-', at - 1)) {
        if (named.has(stem.slice(0, at)))
            documentId = stem.slice(0, at);
    }
    const module = documentId !== null && words[1] === documentId && MODULE_NAME.test(words[0] ?? '') ? (words[0] ?? null) : null;
    return { stem, documentId, module, facts };
}
/**
 * Every token of the vocabulary in `text`, in order and without overlaps: a
 * literal token where neither the character before it nor the one after it is
 * a letter, a digit or `_`, the longest first; then the configured patterns.
 * `specUris` also takes `spec://` references as tokens (Markdown prose, where
 * the comment rules of ##PUBLISH-SCRUB do not reach).
 */
export function findTokens(vocabulary, text, specUris = false) {
    const found = [];
    const byLead = leadIndex(vocabulary);
    const words = new RegExp(WORD.source, WORD.flags);
    for (let match = words.exec(text); match !== null; match = words.exec(text)) {
        for (const token of byLead.get(match[0]) ?? []) {
            const end = match.index + token.length;
            if (text.startsWith(token, match.index) && !isWordCharacterAt(text, end)) {
                found.push({ start: match.index, end, token, kind: vocabulary.tokens.get(token) ?? 'configured' });
                words.lastIndex = end;
                break;
            }
        }
    }
    for (const pattern of vocabulary.patterns) {
        for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
            if (match[0] !== '')
                found.push({ start: match.index, end: match.index + match[0].length, token: match[0], kind: 'configured' });
        }
    }
    if (specUris && text.includes('spec://')) {
        for (const match of text.matchAll(SPEC_URI)) {
            const token = match[0].replace(TRAILING_PUNCTUATION, '');
            found.push({ start: match.index, end: match.index + token.length, token, kind: 'spec' });
        }
    }
    found.sort((left, right) => left.start - right.start || right.end - left.end);
    const ordered = [];
    for (const match of found) {
        const last = ordered[ordered.length - 1];
        if (last === undefined || match.start >= last.end)
            ordered.push(match);
    }
    return ordered;
}
const LEAD_INDEXES = new WeakMap();
/** The literal tokens by their first word, longest first. */
function leadIndex(vocabulary) {
    const cached = LEAD_INDEXES.get(vocabulary);
    if (cached !== undefined)
        return cached;
    const index = new Map();
    for (const token of vocabulary.tokens.keys()) {
        const lead = /^[\p{L}\p{N}_]+/u.exec(token)?.[0];
        if (lead === undefined)
            continue;
        index.set(lead, [...(index.get(lead) ?? []), token]);
    }
    for (const list of index.values())
        list.sort((left, right) => right.length - left.length);
    LEAD_INDEXES.set(vocabulary, index);
    return index;
}
function isWordCharacterAt(text, index) {
    const point = text.codePointAt(index);
    return point !== undefined && WORD_CHARACTER.test(String.fromCodePoint(point));
}
