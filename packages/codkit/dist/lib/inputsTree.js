/** @scope spec://codkit/modules/codkit/PROP-008#INPUTS-LOAD */
// The inputs in a fork tree (PROP-008 ##INPUTS-LOAD, PROP-007 ##INPUTS-GENERATED):
// delivered by `load` as untracked files under `to`, hidden by the managed
// exclude block and mirrored by content like own code; committed by `ci` and
// `publish` as one commit each on top of the generated history.
//
// The directory of an input belongs to its repository. An edit made in it is
// named - by `load`, which puts the input's bytes back over it, by `save`,
// which refuses to take it, and by `status` - and never goes into the patch
// set (##INPUTS-EDITS).
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitOk, runGit, runGitBytes } from './gitx.js';
import { ckError } from './messages.js';
import { resolveContainedPath } from './pathSafety.js';
import { produceInput } from './inputsBuild.js';
import { readInputStore, writeInputStore } from './inputsStore.js';
import { workspaceInputMatches, recordWorkspaceInput } from './workspaceInput.js';
const BLOBS_PER_CALL = 500;
const BLOB_BUFFER = 1024 * 1024 * 1024;
/**
 * Every directory the exclude block must hide: the `to` of each declared input,
 * and of each one the tree still carries from an earlier declaration until a
 * load takes it away.
 */
export function inputTreePaths(treeDir, inputs, onWarn) {
    const paths = inputs.map((input) => input.to);
    for (const recorded of readInputStore(treeDir, onWarn))
        if (!paths.includes(recorded.to))
            paths.push(recorded.to);
    return paths;
}
/**
 * Every declared input built from its source, or taken from what the tree
 * recorded for the same content stamp unless `rebuild` says otherwise. The
 * blobs land in the tree's object database; no file of the tree is touched, so
 * a failing build stops a run before its first write.
 */
export function produceInputs(options) {
    const recorded = readInputStore(options.treeDir, (text) => options.out.warn(text));
    return options.inputs.map((input) => {
        const candidate = options.rebuild ? null : (recorded.find((entry) => entry.name === input.name) ?? null);
        const trusted = candidate === null || options.workspace === undefined || workspaceInputMatches(options.treeDir, candidate, options.workspace);
        return produceInput({
            input,
            mode: options.mode,
            treeDir: options.treeDir,
            recorded: trusted ? candidate : null,
            out: options.out,
            verbose: options.verbose
        });
    });
}
/**
 * ##INPUTS-EDITS: before a load writes anything, every path of an input's
 * directory that differs from what codkit delivered there is named, with where
 * the change belongs - `--fresh` included, whose cleanup takes these
 * directories away with the rest of the untracked files.
 */
export function warnInputEdits(treeDir, inputs, out) {
    const recorded = readInputStore(treeDir, (text) => out.warn(text));
    for (const entry of recorded) {
        const declared = inputs.find((input) => input.name === entry.name);
        const edits = copyEdits(treeDir, entry.to, entry.files);
        if (declared !== undefined && declared.to === entry.to) {
            warnEdits(out, entry.name, entry.to, edits, `the load puts back the bytes of ${declared.repository}; make the change there`);
            continue;
        }
        const added = edits.filter((edit) => edit.kind === 'added');
        warnEdits(out, entry.name, entry.to, added, 'the input is withdrawn from there, and the file stays where it is');
        const delivered = edits.filter((edit) => edit.kind !== 'added');
        warnEdits(out, entry.name, entry.to, delivered, 'the input is withdrawn from there, and its files go with it');
    }
    for (const input of inputs) {
        if (recorded.some((entry) => entry.name === input.name && entry.to === input.to))
            continue;
        warnEdits(out, input.name, input.to, copyEdits(treeDir, input.to, {}), 'nothing was delivered there, and the load replaces it');
    }
}
/**
 * `load`: every produced input mirrored into its directory; every input the
 * tree carries and the configuration no longer declares - or declares
 * elsewhere - taken away.
 */
export function deliverInputs(options) {
    const { treeDir, out } = options;
    const recorded = readInputStore(treeDir, (text) => out.warn(text));
    for (const entry of recorded) {
        const declared = options.produced.find((produced) => produced.input.name === entry.name);
        if (declared !== undefined && declared.input.to === entry.to)
            continue;
        const removed = withdraw(treeDir, entry);
        out.info(`input ${entry.name}: ${entry.to} withdrawn, ${removed} file(s) removed`);
    }
    const deliveries = [];
    const stored = [];
    for (const produced of options.produced) {
        const { input } = produced;
        const mirrored = mirror(treeDir, input.to, produced.files);
        deliveries.push({
            name: input.name,
            to: input.to,
            mode: produced.mode,
            commit: produced.commit,
            files: produced.files.length,
            written: mirrored.written,
            removed: mirrored.removed,
            built: produced.built
        });
        const snapshot = storedOf(produced);
        if (options.workspace !== undefined)
            recordWorkspaceInput(treeDir, snapshot, options.workspace);
        stored.push(snapshot);
        const source = produced.commit === null ? 'the working tree' : produced.commit.slice(0, 12);
        out.info(`input ${input.name}: ${source} -> ${input.to}: ${produced.files.length} file(s), ${mirrored.written} written, ` +
            `${mirrored.removed} removed (${produced.built ? 'built' : 'unchanged since the last build'})`);
    }
    writeInputStore(treeDir, stored);
    return deliveries;
}
/** The copy of every declared input as the tree has it, against what codkit delivered. */
export function inspectInputCopies(treeDir, inputs, onWarn) {
    const recorded = readInputStore(treeDir, onWarn);
    return inputs.map((input) => {
        const entry = recorded.find((stored) => stored.name === input.name && stored.to === input.to) ?? null;
        return { input, recorded: entry, edits: entry === null ? [] : copyEdits(treeDir, input.to, entry.files) };
    });
}
/**
 * `save` (##INPUTS-EDITS): the refusal over the directories of the inputs - a
 * path the command line names inside one, or an edit found in one - with the
 * repositories they belong to; null when there is nothing to refuse.
 */
export function inputSaveRefusal(treeDir, inputs, filters, onWarn) {
    const named = inputs.filter((input) => filters.some((filter) => filter === input.to || filter.startsWith(`${input.to}/`)));
    if (named.length > 0) {
        return {
            message: `save takes nothing from the directory of an input: ${named.map((input) => `${input.to} (input ${input.name})`).join(', ')}`,
            hint: `make the change in ${named.map((input) => input.repository).join(', ')}; codkit load delivers it`,
            lines: []
        };
    }
    const edited = inspectInputCopies(treeDir, inputs, onWarn).filter((copy) => copy.edits.length > 0);
    if (edited.length === 0)
        return null;
    const lines = edited.flatMap((copy) => copy.edits.map((edit) => `${edit.kind.padEnd(8)} ${copy.input.to}/${edit.path} (input ${copy.input.name})`));
    return {
        message: `${lines.length} path(s) in the directories of inputs were changed in the fork tree; they belong to other repositories, and save never takes them into the patch set`,
        hint: `make the changes in ${edited.map((copy) => copy.input.repository).join(', ')} - codkit load delivers them and puts the input's bytes back here - then run save again`,
        lines
    };
}
/**
 * `ci` and `publish`: one commit per input on top of `parent`, its files at `to`
 * as regular files (mode 100644 on every platform, so the tree does not depend
 * on where it was built), with the trailers of the generated history and the
 * input's name and commit.
 */
export function appendInputCommits(options) {
    let parent = options.parent;
    for (const produced of options.produced) {
        const { input } = produced;
        const entries = produced.files.map((file) => `100644 ${file.blob}\t${input.to}/${file.path}\0`).join('');
        gitOk({ args: ['update-index', '-z', '--add', '--index-info'], cwd: options.treeDir, env: options.indexEnv, input: entries }, { code: 'CONFIG', message: `input ${input.name}: cannot stage its files at ${input.to}` });
        const tree = gitOk({ args: ['write-tree'], cwd: options.treeDir, env: options.indexEnv }, { code: 'CONFIG', message: `input ${input.name}: cannot write the tree of its commit` }).stdout.trim();
        const message = [
            `codkit: input ${input.name} ${input.to}`,
            '',
            `Codkit-Input: ${input.name}@${produced.commit ?? ''}`,
            `Codkit-Patchset-Commit: ${options.patchSetCommit}`,
            `Codkit-Upstream-Pin: ${options.pinTag}@${options.pinSha}`
        ].join('\n');
        parent = gitOk({ args: ['commit-tree', tree, '-p', parent, '-m', message], cwd: options.treeDir, env: options.commitEnv }, { code: 'CONFIG', message: `input ${input.name}: cannot create its commit` }).stdout.trim();
    }
    return parent;
}
/**
 * The fingerprint of a generated history that ends with the inputs: the
 * history's own, and what each input takes - its name, pinned commit, build,
 * roots, variables, `from` and `to`. The location is this machine's and is not
 * part of it.
 */
export function inputsHistoryFingerprint(fingerprint, inputs) {
    const declared = inputs.map((input) => ({
        name: input.name,
        ref: input.ref,
        build: input.build,
        dependencyRoots: input.dependencyRoots,
        env: Object.entries(input.env).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
        from: input.from,
        to: input.to
    }));
    return createHash('sha256')
        .update(`${fingerprint}\0codkit-inputs\0${JSON.stringify(declared)}`, 'utf8')
        .digest('hex');
}
/** What `publish` reports for each input of the published commit (##INPUTS-GENERATED). */
export function releasedInputs(treeDir, treeish, inputs) {
    return inputs.map((input) => {
        const listed = runGit({ args: ['ls-tree', '-r', '--name-only', '-z', treeish, '--', input.to], cwd: treeDir });
        const files = listed.status === 0 ? listed.stdout.split('\0').filter((path) => path !== '').length : 0;
        return { name: input.name, commit: input.ref, to: input.to, files };
    });
}
function storedOf(produced) {
    const files = {};
    for (const file of produced.files)
        files[file.path] = file.blob;
    return { name: produced.input.name, to: produced.input.to, mode: produced.mode, commit: produced.commit, stamp: produced.stamp, files };
}
function warnEdits(out, name, to, edits, consequence) {
    for (const edit of edits)
        out.warn(`input ${name}: ${to}/${edit.path} was ${edit.kind} in the fork tree; ${consequence}`);
}
/** The directory of an input in the tree, proven free of links on the way. */
function inputDirectory(treeDir, to) {
    const resolved = resolveContainedPath(treeDir, to, { allowMissing: true });
    if (!resolved.ok) {
        throw ckError('CONFIG', `the input directory ${to} of the tree is unsafe: ${resolved.reason}`, 'remove the link and run codkit load again');
    }
    return resolved.absolute;
}
/** How the tree's copy differs from the delivered files: edited, added, removed. */
function copyEdits(treeDir, to, delivered) {
    const present = listCopy(inputDirectory(treeDir, to));
    const blobs = hashCopy(treeDir, present);
    const edits = [];
    const seen = new Set();
    present.forEach((file, index) => {
        seen.add(file.path);
        const expected = delivered[file.path];
        if (expected === undefined)
            edits.push({ path: file.path, kind: 'added' });
        else if (expected !== blobs[index])
            edits.push({ path: file.path, kind: 'edited' });
    });
    for (const path of Object.keys(delivered))
        if (!seen.has(path))
            edits.push({ path, kind: 'removed' });
    return edits.sort((left, right) => Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8')));
}
/** Everything under the directory, a link counted as an entry to replace and never followed. */
function listCopy(root) {
    const out = [];
    const walk = (absoluteDir, relativeDir) => {
        let entries;
        try {
            entries = readdirSync(absoluteDir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const relative = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
            const absolute = join(absoluteDir, entry.name);
            if (entry.isDirectory())
                walk(absolute, relative);
            else
                out.push({ path: relative, absolute });
        }
    };
    walk(root, '');
    return out.sort((left, right) => Buffer.from(left.path, 'utf8').compare(Buffer.from(right.path, 'utf8')));
}
function hashCopy(treeDir, entries) {
    if (entries.length === 0)
        return [];
    const hashed = runGit({
        args: ['hash-object', '--no-filters', '--stdin-paths'],
        cwd: treeDir,
        input: `${entries.map((entry) => entry.absolute).join('\n')}\n`
    });
    if (hashed.status !== 0)
        throw ckError('CONFIG', `cannot read an input directory of the tree: ${hashed.stderr.trim().split('\n')[0] ?? ''}`);
    return hashed.stdout.split('\n').filter((line) => line !== '');
}
/**
 * The directory made exactly the files given: what differs is written from the
 * tree's object database, what is not there is removed, and a file whose bytes
 * already match is not touched, so its mtime stays (##MTIME-DISCIPLINE).
 */
function mirror(treeDir, to, files) {
    const root = inputDirectory(treeDir, to);
    const present = listCopy(root);
    const blobs = hashCopy(treeDir, present);
    const current = new Map(present.map((entry, index) => [entry.path, blobs[index] ?? '']));
    const wanted = new Map(files.map((file) => [file.path, file.blob]));
    let removed = 0;
    for (const entry of present) {
        if (wanted.has(entry.path))
            continue;
        rmSync(entry.absolute, { force: true });
        removed += 1;
    }
    pruneEmptyDirectories(root, files.length === 0);
    const changed = files.filter((file) => current.get(file.path) !== file.blob);
    const bytes = readBlobs(treeDir, changed.map((file) => file.blob));
    for (const file of changed) {
        const target = join(root, ...file.path.split('/'));
        rmSync(target, { recursive: true, force: true });
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes.get(file.blob) ?? new Uint8Array());
    }
    return { written: changed.length, removed };
}
/**
 * An input the configuration no longer delivers at `to`: exactly the files
 * codkit wrote there are removed, edited or not, and the directories they
 * emptied with them; a file somebody else put there stays.
 */
function withdraw(treeDir, entry) {
    const root = inputDirectory(treeDir, entry.to);
    let removed = 0;
    for (const path of Object.keys(entry.files)) {
        const target = join(root, ...path.split('/'));
        const stat = lstatSync(target, { throwIfNoEntry: false });
        if (stat === undefined || stat.isDirectory())
            continue;
        rmSync(target, { force: true });
        removed += 1;
    }
    pruneEmptyDirectories(root, true);
    return removed;
}
/** Deepest first; the directory itself goes too when it was emptied on purpose. */
function pruneEmptyDirectories(root, includeRoot) {
    const directories = [];
    const walk = (absolute) => {
        let entries;
        try {
            entries = readdirSync(absolute, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const child = join(absolute, entry.name);
            walk(child);
            directories.push(child);
        }
    };
    walk(root);
    if (includeRoot)
        directories.push(root);
    for (const directory of directories) {
        try {
            if (readdirSync(directory).length === 0)
                rmdirSync(directory);
        }
        catch {
            // Already gone, or not empty: nothing to report.
        }
    }
}
/** Blobs of the tree's object database, a few hundred per git process. */
function readBlobs(treeDir, shas) {
    const unique = [...new Set(shas)];
    const blobs = new Map();
    for (let index = 0; index < unique.length; index += BLOBS_PER_CALL) {
        const chunk = unique.slice(index, index + BLOBS_PER_CALL);
        const result = runGitBytes({ args: ['cat-file', '--batch'], cwd: treeDir, input: `${chunk.join('\n')}\n`, maxBuffer: BLOB_BUFFER });
        if (result.status !== 0)
            throw ckError('CONFIG', `cannot read the blobs of an input: ${result.stderr.trim().split('\n')[0] ?? ''}`);
        const out = Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
        let at = 0;
        for (const sha of chunk) {
            const eol = out.indexOf(0x0a, at);
            const header = out.toString('utf8', at, eol === -1 ? out.length : eol).split(' ');
            const size = Number.parseInt(header[2] ?? '', 10);
            if (eol === -1 || header[0] !== sha || header[1] !== 'blob' || !Number.isInteger(size)) {
                throw ckError('CONFIG', `cannot read the input blob ${sha}: ${header.join(' ')}`, 'run codkit load --fresh to build the input again');
            }
            blobs.set(sha, new Uint8Array(out.subarray(eol + 1, eol + 1 + size)));
            at = eol + 1 + size + 1;
        }
    }
    return blobs;
}
