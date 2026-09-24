/** @scope spec://codkit/modules/codkit/PROP-007#root */
// The clean release of `publish` (PROP-007 ##PUBLISH-SQUASH, ##PUBLISH-SCRUB,
// ##PUBLISH-EXCLUDE, ##PUBLISH-SCRUB-FAIL-CLOSED): the release tree built from
// the unsquashed tip in a temporary index of the disposable fork, the
// fail-closed search of that tree, and the one squashed commit on the pin.
// Every object is written into the disposable fork; nothing here pushes.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { messageOf } from './configFile.js';
import { gitOk, runGit, runGitBytes } from './gitx.js';
import { ckError } from './messages.js';
import { LEFTOVER_PATTERN, SCRUB_CANDIDATE_PATTERN, commentSyntaxOf, markerFormsOf, scrubText } from './publishScrub.js';
const AUTHOR = /^([^<>\r\n]*)<([^<>\s]+)>$/;
const UTF8_BOM = [0xef, 0xbb, 0xbf];
const LEFTOVER_TEXT_LIMIT = 200;
const PATHS_PER_CALL = 50;
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
    const skipped = new Set(excluded);
    const candidates = matchingPaths(options.treeDir, options.tip);
    const forms = markerFormsOf(options.conventions);
    const files = [];
    for (const file of delivered) {
        if (!file.regular || skipped.has(file.path) || !candidates.has(file.path))
            continue;
        const bytes = blobBytes(options.treeDir, file.sha);
        const bom = UTF8_BOM.every((byte, index) => bytes[index] === byte);
        const text = bytes.includes(0) ? null : decodeUtf8Strict(bytes);
        if (text === null)
            continue;
        const scrubbed = scrubText(text, commentSyntaxOf(file.path, options.conventions), forms);
        if (scrubbed.text === text)
            continue;
        const scratch = join(options.scratchDir, `blob-${files.length}`);
        const body = encodeUtf8(scrubbed.text);
        writeFileSync(scratch, bom ? Buffer.concat([Buffer.from(UTF8_BOM), body]) : body);
        const blob = git(options.treeDir, ['hash-object', '-w', '--no-filters', '--', scratch], env, `cannot store the scrubbed ${file.path}`);
        git(options.treeDir, ['update-index', '--cacheinfo', file.mode, blob, file.path], env, `cannot stage the scrubbed ${file.path}`);
        files.push({ path: file.path, markers: scrubbed.markers, specRefs: scrubbed.specRefs, droppedLines: scrubbed.droppedLines });
    }
    const tree = git(options.treeDir, ['write-tree'], env, 'cannot write the release tree');
    return { tree, report: { files, excluded, unmatched, leftovers: leftoversOf(options.treeDir, tree) } };
}
/** The tree of a commit, as a full object name. */
export function treeOf(treeDir, commit) {
    return git(treeDir, ['rev-parse', '--verify', `${commit}^{tree}`], {}, `cannot read the tree of ${commit}`);
}
/**
 * The one commit of `--squash`: the release tree on the pin, signed by the
 * owner's author, dated with the patchset commit so a repeat makes it again.
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
    return git(options.treeDir, ['commit-tree', options.tree, '-p', options.parent, '-F', messageFile], env, 'cannot write the squashed release commit');
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
/** The text files of the tip that carry something the scrub removes. */
function matchingPaths(treeDir, tip) {
    const result = runGit({ args: ['grep', '-l', '-z', '-I', '-E', '-e', SCRUB_CANDIDATE_PATTERN, tip], cwd: treeDir });
    if (result.status === 1)
        return new Set();
    if (result.status !== 0)
        throw ckError('CONFIG', `cannot search the release for markers: ${firstLine(result.stderr)}`);
    const prefix = `${tip}:`;
    return new Set(result.stdout
        .split('\0')
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => entry.slice(prefix.length)));
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
            leftovers.push({ path: (binary[1] ?? '').slice(prefix.length), line: null, text: '' });
            continue;
        }
        const [where = '', line = '', ...rest] = entry.split('\0');
        leftovers.push({
            path: where.startsWith(prefix) ? where.slice(prefix.length) : where,
            line: Number.parseInt(line, 10) || null,
            text: rest.join('\0').trim().slice(0, LEFTOVER_TEXT_LIMIT)
        });
    }
    return leftovers;
}
function blobBytes(treeDir, sha) {
    const result = runGitBytes({ args: ['cat-file', 'blob', sha], cwd: treeDir });
    if (result.status !== 0)
        throw ckError('CONFIG', `cannot read the delivered blob ${sha}: ${firstLine(result.stderr)}`);
    return result.stdout;
}
function git(cwd, args, env, message) {
    return gitOk({ args, cwd, env }, { code: 'CONFIG', message }).stdout.trim();
}
function firstLine(text) {
    return text.trim().split('\n')[0] ?? '';
}
