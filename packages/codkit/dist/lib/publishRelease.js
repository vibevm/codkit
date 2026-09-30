/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The clean release of `publish` (PROP-007 ##PUBLISH-SQUASH, ##PUBLISH-SCRUB,
// ##PUBLISH-SCRUB-GROUPS, ##PUBLISH-EXCLUDE, ##PUBLISH-SCRUB-FAIL-CLOSED): the
// release tree built from the unsquashed tip in a temporary index of the
// disposable fork, the fail-closed search of that tree, and the one squashed
// commit - on the pin, or without a parent (##PUBLISH-ORPHAN). Every object is
// written into the disposable fork; nothing here pushes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { messageOf } from './configFile.js';
import { gitOk, runGit, runGitBytes } from './gitx.js';
import { ckError } from './messages.js';
import { isMarkdownProse, scrubReferences } from './publishReferences.js';
import { LEFTOVER_PATTERN, commentSyntaxOf, markerFormsOf, scrubText } from './publishScrub.js';
import { EMPTY_SETTINGS, findTokens, learnVocabulary } from './publishVocabulary.js';
const AUTHOR = /^([^<>\r\n]*)<([^<>\s]+)>$/;
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const LEFTOVER_TEXT_LIMIT = 200;
const PATHS_PER_CALL = 50;
const BLOBS_PER_CALL = 500;
const BLOB_BUFFER = 1024 * 1024 * 1024;
const NO_SOURCES = { interventionIds: [], specDocuments: [], settings: EMPTY_SETTINGS };
/** `--author "<Name> <email>"`: the author and the committer of the squashed commit. */
export function parseAuthor(raw) {
    const match = AUTHOR.exec(raw.trim());
    const name = match?.[1]?.trim() ?? '';
    const email = match?.[2] ?? '';
    if (name === '' || email === '') {
        throw ckError('CONFIG', `--author expects "Name <email>", got: ${raw}`, 'example: --author "Jane Doe <jane@example.org>"');
    }
    return { name, email };
}
/**
 * `--message-file <path>`: strict UTF-8 without a byte order mark or NUL, CRLF
 * read as LF, blank lines cut at both ends, one final LF.
 */
export function readMessageFile(given) {
    const path = isAbsolute(given) ? given : resolve(process.cwd(), given);
    let bytes;
    try {
        bytes = readFileSync(path);
    }
    catch (error) {
        throw ckError('CONFIG', `--message-file cannot be read: ${messageOf(error)}`, 'name a UTF-8 file that holds the release message');
    }
    if (UTF8_BOM.every((byte, index) => bytes[index] === byte)) {
        throw ckError('CONFIG', `--message-file must be UTF-8 without a byte order mark: ${path}`, 're-save the file as UTF-8 without BOM');
    }
    const text = bytes.includes(0) ? null : decodeUtf8Strict(bytes);
    if (text === null) {
        throw ckError('CONFIG', `--message-file is not valid UTF-8 text: ${path}`, 're-save the file as UTF-8 without NUL bytes');
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    while (lines.length > 0 && (lines[0] ?? '').trim() === '')
        lines.shift();
    while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '')
        lines.pop();
    if (lines.length === 0) {
        throw ckError('CONFIG', `--message-file holds no message: ${path}`, 'write the release message into the file');
    }
    return `${lines.join('\n')}\n`;
}
/**
 * The scrubbed release tree: the unsquashed tip without the excluded files and
 * with the delivered files scrubbed, then searched for leftovers. The caller
 * refuses to publish when `leftovers` is not empty.
 */
export function scrubReleaseTree(options) {
    mkdirSync(options.scratchDir, { recursive: true });
    const env = { GIT_INDEX_FILE: join(options.scratchDir, 'release.index') };
    git(options.treeDir, ['read-tree', options.tip], env, 'cannot read the unsquashed release tree');
    const delivered = deliveredFiles(options.treeDir, options.pinSha, options.tip);
    const covered = (entry, path) => path === entry || path.startsWith(`${entry}/`);
    const excluded = delivered
        .filter((file) => file.added && options.exclude.some((entry) => covered(entry, file.path)))
        .map((file) => file.path);
    const unmatched = options.exclude.filter((entry) => !excluded.some((path) => covered(entry, path)));
    for (let index = 0; index < excluded.length; index += PATHS_PER_CALL) {
        const chunk = excluded.slice(index, index + PATHS_PER_CALL);
        git(options.treeDir, ['update-index', '--force-remove', '--', ...chunk], env, 'cannot leave an excluded file out of the release');
    }
    // Every delivered file is read once, in one git process per batch: the
    // vocabulary is learned from all of them before any is scrubbed.
    const skipped = new Set(excluded);
    const kept = delivered.filter((file) => file.regular && !skipped.has(file.path));
    const blobs = readBlobs(options.treeDir, kept.map((file) => file.sha));
    const texts = new Map();
    for (const file of kept) {
        const bytes = blobs.get(file.sha) ?? new Uint8Array();
        const text = bytes.includes(0) ? null : decodeUtf8Strict(bytes);
        if (text !== null)
            texts.set(file.path, text);
    }
    const vocabulary = learnVocabulary(options.references ?? NO_SOURCES, texts.values());
    const forms = markerFormsOf(options.conventions);
    const files = [];
    const found = [];
    const staged = [];
    for (const file of kept) {
        const text = texts.get(file.path);
        if (text === undefined) {
            found.push(...binaryLeftovers(file.path, blobs.get(file.sha) ?? new Uint8Array(), vocabulary));
            continue;
        }
        const syntax = commentSyntaxOf(file.path, options.conventions);
        const scrubbed = scrubText(text, syntax, forms);
        const references = scrubReferences(scrubbed.text, syntax, isMarkdownProse(file.path), vocabulary);
        found.push(...textLeftovers(file.path, references.text, vocabulary));
        if (references.text === text)
            continue;
        const bom = UTF8_BOM.every((byte, index) => blobs.get(file.sha)?.[index] === byte);
        const scratch = join(options.scratchDir, `blob-${files.length}`);
        const body = encodeUtf8(references.text);
        writeFileSync(scratch, bom ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body);
        staged.push({ mode: file.mode, path: file.path, scratch });
        files.push({
            path: file.path,
            markers: scrubbed.markers,
            specRefs: scrubbed.specRefs,
            droppedLines: scrubbed.droppedLines + references.droppedLines,
            groups: references.groups
        });
    }
    stageScrubbed(options.treeDir, env, staged);
    const tree = git(options.treeDir, ['write-tree'], env, 'cannot write the release tree');
    const tooling = leftoversOf(options.treeDir, tree);
    const listed = new Set(tooling.map((leftover) => `${leftover.path}\0${leftover.line ?? ''}`));
    const leftovers = [...tooling, ...found.filter((leftover) => !listed.has(`${leftover.path}\0${leftover.line ?? ''}`))].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : (left.line ?? 0) - (right.line ?? 0)));
    return { tree, report: { files, excluded, unmatched, leftovers, vocabulary: vocabulary.counts } };
}
/** Every changed file with its counts, every excluded file, the vocabulary, and the totals. */
export function reportScrub(out, report) {
    const total = { markers: 0, specRefs: 0, dropped: 0, parenthetical: 0, lead: 0, sentence: 0, preposition: 0 };
    for (const file of report.files) {
        const groups = file.groups.parenthetical + file.groups.lead + file.groups.sentence + file.groups.preposition;
        total.markers += file.markers;
        total.specRefs += file.specRefs;
        total.dropped += file.droppedLines;
        for (const rule of ['parenthetical', 'lead', 'sentence', 'preposition'])
            total[rule] += file.groups[rule];
        out.info(`scrub: ${file.path}: ${file.markers} marker line(s), ${file.specRefs} spec reference(s), ${groups} reference group(s), ` +
            `${file.droppedLines} emptied line(s) dropped`);
    }
    for (const path of report.excluded)
        out.info(`scrub: ${path}: left out of the release (publish.exclude)`);
    for (const entry of report.unmatched)
        out.warn(`publish.exclude entry ${entry} matches no file the release delivers`);
    const learned = report.vocabulary;
    out.info(`scrub: vocabulary: ${learned.interventions} intervention id(s), ${learned.documents} document id(s), ${learned.stems} document stem(s), ` +
        `${learned.facts} fact id(s), ${learned.modules} module name(s), ${learned.configured} configured; ${learned.allowed} allowed`);
    out.info(`scrub: reference groups removed: ${total.parenthetical} parenthetical, ${total.lead} leading with a colon, ` +
        `${total.sentence} sentence, ${total.preposition} after a preposition`);
    out.info(`scrub: ${report.files.length} file(s) changed: ${total.markers} marker line(s), ${total.specRefs} spec reference(s), ` +
        `${total.dropped} line(s) dropped; ${report.excluded.length} file(s) excluded; ${report.leftovers.length} leftover(s)`);
}
/** The tree of a commit, as a full object name. */
export function treeOf(treeDir, commit) {
    return git(treeDir, ['rev-parse', '--verify', `${commit}^{tree}`], {}, `cannot read the tree of ${commit}`);
}
/**
 * The one commit of `--squash`: the release tree on the pin - or without a
 * parent under `--orphan` - signed by the owner's author, dated with the
 * patchset commit so a repeat makes it again.
 */
export function squashCommit(options) {
    mkdirSync(options.scratchDir, { recursive: true });
    const messageFile = join(options.scratchDir, 'release-message.txt');
    writeFileSync(messageFile, options.request.message, 'utf8');
    const { name, email } = options.request.author;
    const env = {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: email,
        GIT_AUTHOR_DATE: options.date,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: email,
        GIT_COMMITTER_DATE: options.date
    };
    const parents = options.parent === null ? [] : ['-p', options.parent];
    return git(options.treeDir, ['commit-tree', options.tree, ...parents, '-F', messageFile], env, 'cannot write the squashed release commit');
}
/** The files in which the unsquashed tip differs from the pin; deletions deliver nothing. */
function deliveredFiles(treeDir, pinSha, tip) {
    const raw = gitOk({ args: ['diff-tree', '-r', '-z', '--no-renames', pinSha, tip], cwd: treeDir }, { code: 'CONFIG', message: 'cannot list the delivered files of the release' }).stdout;
    const fields = raw.split('\0');
    const files = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
        const [, mode, , sha, status] = (fields[index] ?? '').split(' ');
        const path = fields[index + 1] ?? '';
        if (mode === undefined || sha === undefined || status === undefined || status === 'D' || path === '')
            continue;
        files.push({ path, mode, sha, added: status === 'A', regular: mode === '100644' || mode === '100755' });
    }
    return files;
}
/** ##PUBLISH-SCRUB-FAIL-CLOSED: every hit in the whole tree, binary files included. */
function leftoversOf(treeDir, tree) {
    const result = runGit({ args: ['grep', '-n', '-z', '-i', '-E', '-e', LEFTOVER_PATTERN, tree], cwd: treeDir });
    if (result.status === 1)
        return [];
    if (result.status !== 0)
        throw ckError('CONFIG', `cannot search the release tree for leftovers: ${firstLine(result.stderr)}`);
    const prefix = `${tree}:`;
    const leftovers = [];
    for (const entry of result.stdout.split('\n')) {
        if (entry === '')
            continue;
        const binary = /^Binary file (.*) matches$/.exec(entry);
        if (binary !== null) {
            leftovers.push({ path: (binary[1] ?? '').slice(prefix.length), line: null, text: '', tokens: [] });
            continue;
        }
        const [where = '', line = '', ...rest] = entry.split('\0');
        leftovers.push({
            path: where.startsWith(prefix) ? where.slice(prefix.length) : where,
            line: Number.parseInt(line, 10) || null,
            text: rest.join('\0').trim().slice(0, LEFTOVER_TEXT_LIMIT),
            tokens: []
        });
    }
    return leftovers;
}
/** ##PUBLISH-SCRUB-FAIL-CLOSED: every line of a delivered text file that still carries vocabulary. */
function textLeftovers(path, text, vocabulary) {
    if (leftTokens(vocabulary, text).length === 0)
        return [];
    const leftovers = [];
    text.split('\n').forEach((line, index) => {
        const tokens = leftTokens(vocabulary, line);
        if (tokens.length > 0)
            leftovers.push({ path, line: index + 1, text: line.trim().slice(0, LEFTOVER_TEXT_LIMIT), tokens });
    });
    return leftovers;
}
/** A delivered binary file that carries vocabulary, read byte for character; it has no line. */
function binaryLeftovers(path, bytes, vocabulary) {
    const tokens = leftTokens(vocabulary, Buffer.from(bytes).toString('latin1'));
    return tokens.length === 0 ? [] : [{ path, line: null, text: '', tokens: [...new Set(tokens)] }];
}
/** The tokens of a text the release may not carry: all but the ones `publish.scrub.allow` names. */
function leftTokens(vocabulary, text) {
    return findTokens(vocabulary, text)
        .map((match) => match.token)
        .filter((token) => !vocabulary.allowed.has(token));
}
/** Store the scrubbed files and stage them in the temporary index: one git process for each step. */
function stageScrubbed(treeDir, env, staged) {
    if (staged.length === 0)
        return;
    const stored = gitOk({
        args: ['hash-object', '-w', '--no-filters', '--stdin-paths'],
        cwd: treeDir,
        env,
        input: staged.map((file) => `${file.scratch}\n`).join('')
    }, { code: 'CONFIG', message: 'cannot store the scrubbed files of the release' }).stdout.split('\n');
    const entries = staged.map((file, index) => `${file.mode} ${stored[index] ?? ''}\t${file.path}\0`).join('');
    gitOk({ args: ['update-index', '-z', '--index-info'], cwd: treeDir, env, input: entries }, { code: 'CONFIG', message: 'cannot stage the scrubbed files of the release' });
}
/** Blobs of the object database, read through `cat-file --batch`, a few hundred per git process. */
export function readBlobs(treeDir, shas) {
    const unique = [...new Set(shas)];
    const blobs = new Map();
    for (let index = 0; index < unique.length; index += BLOBS_PER_CALL) {
        const chunk = unique.slice(index, index + BLOBS_PER_CALL);
        const result = runGitBytes({ args: ['cat-file', '--batch'], cwd: treeDir, input: `${chunk.join('\n')}\n`, maxBuffer: BLOB_BUFFER });
        if (result.status !== 0)
            throw ckError('CONFIG', `cannot read the delivered blobs: ${firstLine(result.stderr)}`);
        const out = Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
        let at = 0;
        for (const sha of chunk) {
            const eol = out.indexOf(0x0a, at);
            const header = out.toString('utf8', at, eol === -1 ? out.length : eol).split(' ');
            const size = Number.parseInt(header[2] ?? '', 10);
            if (eol === -1 || header[0] !== sha || header[1] !== 'blob' || !Number.isInteger(size)) {
                throw ckError('CONFIG', `cannot read the delivered blob ${sha}: ${header.join(' ')}`);
            }
            blobs.set(sha, new Uint8Array(out.subarray(eol + 1, eol + 1 + size)));
            at = eol + 1 + size + 1;
        }
    }
    return blobs;
}
function git(cwd, args, env, message) {
    return gitOk({ args, cwd, env }, { code: 'CONFIG', message }).stdout.trim();
}
function firstLine(text) {
    return text.trim().split('\n')[0] ?? '';
}
