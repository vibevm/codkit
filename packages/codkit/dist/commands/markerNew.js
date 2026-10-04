/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit marker new - scaffold a marker block in an upstream file.
// Contract: PROP-007 sec. 8 (##CMD-MARKER-NEW, ##PENDING-HEADER-MECHANISM);
// marker forms and rules: PROP-004 sec. 1-2.
//
// The command writes two things: the pair of marker lines, in the file of the
// tree, and a draft of the future patch header in `.codkit/pending/`. It does
// not create a patch - `save` does that, from the block the developer fills in
// and from the draft left here.
//
// Everything it refuses, it refuses before writing anything: a target that may
// not carry a patch, an owner nobody declared, an id that is already taken.
import { chmodSync, existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative as relativePath, resolve, sep } from 'node:path';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.js';
import { loadConventions, matchesPatternList } from '../lib/conventionsFile.js';
import { treeId } from '../lib/fingerprint.js';
import { withLock } from '../lib/lock.js';
import { markerFormFor, parseMarkers } from '../lib/markers.js';
import { ckError, isCkError } from '../lib/messages.js';
import { OWNERS_PATH, loadOwnerKeys } from '../lib/owners.js';
import { DEFAULT_PATCH_LAYER, PATCH_FILE_SUFFIX, encodePatchName } from '../lib/patchFormat.js';
import { formatForkTreeLine } from '../lib/paths.js';
import { PENDING_DIR, listPendingHeaders, pendingFileName, readPendingHeader, removePendingHeader, writePendingHeader } from '../lib/pendingHeader.js';
import { resolveContainedPath } from '../lib/pathSafety.js';
import { PATCHES_DIR, toPosix } from '../lib/syncEngine.js';
import { checkTree } from '../lib/treeIdentity.js';
const ID = '--id';
const TYPE = '--type';
const OWNER = '--owner';
const REASON = '--reason';
const CATEGORY = '--category';
const LAYER = '--layer';
const LINE = '--line';
const ADD_BLOCK = '--add-block';
const BODY_FILE = '--body-file';
const REPLACE_LINES = '--replace-lines';
const MOVE_BLOCK_FROM = '--move-block-from';
/** PROP-007 sec. 8: `--category` defaults to `follow`. */
const DEFAULT_CATEGORY = 'follow';
/** Owners live here, relative to the patchset root (PROP-003 sec. 4). */
const OWNERS_FILE = OWNERS_PATH;
async function run(ctx) {
    const resolution = forkResolution(ctx);
    ctx.out.setForkTree(resolution.path, resolution.source);
    ctx.out.info(formatForkTreeLine(resolution));
    const config = requireConfig(ctx.config);
    const given = ctx.args[0];
    if (given === undefined || given === '') {
        throw ckError('CONFIG', 'marker new needs the file to scaffold the block in', 'usage: codkit marker new <file> --id CK-<subsystem>-<NNN> --type <type> --owner <owner> --reason <why> [--category <c>] [--line <n>]');
    }
    // ##CMD-MARKER-NEW-ADD-BLOCK: a second block of an intervention this file
    // already carries needs the id and the line, and nothing else - the header
    // is the one the first block has.
    const addBlock = commandFlagGiven(ctx.commandFlags, ADD_BLOCK);
    if (!addBlock && commandFlagValue(ctx.commandFlags, MOVE_BLOCK_FROM) !== null)
        throw ckError('CONFIG', '--move-block-from requires --add-block and an existing owned block');
    const fields = addBlock ? readAddBlockFields(ctx) : readFields(ctx);
    const identity = checkTree(resolution, config, { mode: 'write', type: requireProjectType(ctx) });
    if (identity.fatal !== null) {
        ctx.out.addError(identity.fatal.toPayload());
        return EXIT_ENVIRONMENT;
    }
    return withLock(ctx.patchesDir, treeId(resolution.path), 'marker new', () => {
        try {
            return addBlock ? addBlockTo(ctx, resolution.path, config, given, fields) : scaffold(ctx, resolution.path, config, given, fields);
        }
        catch (error) {
            if (!isCkError(error)) {
                throw error;
            }
            // PROP-007 ##CLI-EXIT-CODES: a problem with what was typed or with
            // the configuration is a startup failure (2); a problem with the
            // state of the tree or of the delta is a check that did not pass (1).
            ctx.out.addError(error.toPayload());
            return error.code === 'CONFIG' ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED;
        }
    }, (text) => {
        ctx.out.warn(text);
    });
}
/** Step 1 of both forms: the target exists, is upstream and can carry a marker. */
function locateTarget(treeDir, config, given, conventions) {
    const target = treeRelativePath(given, treeDir);
    const absolute = join(treeDir, ...target.split('/'));
    // 1. The target: it exists, it is upstream, and it can carry a marker.
    if (!existsSync(absolute)) {
        throw ckError('FORBIDDEN-TARGET', 'does not exist in the fork tree', `create the file first, or check the path; paths are relative to ${treeDir}`, target);
    }
    const ownPrefix = `${config.typeConfig.ownRoot}/`;
    if (target === ownPrefix.slice(0, -1) || target.startsWith(ownPrefix)) {
        throw ckError('FORBIDDEN-TARGET', 'is own code, not an upstream file', `own code lives in patchset under delta/own/ and needs no marker; edit it there and run codkit save`, target);
    }
    if (matchesPatternList(target, conventions.forbiddenPatchTargets)) {
        throw ckError('FORBIDDEN-TARGET', 'is a forbidden patch target', `conventions.json forbids patching it (forbiddenPatchTargets: ${conventions.forbiddenPatchTargets.join(', ')})`, target);
    }
    const form = markerFormFor(extname(target), conventions);
    if (form === null) {
        throw ckError('FORBIDDEN-TARGET', `no marker form is defined for "${extname(target)}" files, so this file cannot carry a codkit marker`, 'a target without a comment syntax belongs to the config-overlay or resource-file layer, not to a patch', target);
    }
    return { target, absolute, form };
}
function scaffold(ctx, treeDir, config, given, fields) {
    const conventions = loadConventions(requireProjectType(ctx), ctx.patchesDir);
    const { target, absolute, form } = locateTarget(treeDir, config, given, conventions);
    // 2. The metadata: id shape, owner, type and category vocabularies.
    validateFields(ctx.patchesDir, fields, conventions);
    const header = {
        id: fields.id,
        layer: fields.layer,
        type: fields.type,
        category: fields.category,
        owner: fields.owner,
        reason: fields.reason,
        link: 'none'
    };
    const pending = readPendingHeader(ctx.patchesDir, target);
    // 3. The id is not taken by a patch, a draft or a block of this file.
    const content = readFileSync(absolute, 'utf8');
    const parsed = parseMarkers(Buffer.from(content, 'utf8'), extname(target), conventions, target);
    const parseError = parsed.errors[0];
    if (parseError !== undefined)
        throw parseError;
    const pendingMatches = pending !== null && JSON.stringify(pending) === JSON.stringify(header);
    const resumedBlock = pendingMatches ? parsed.blocks.find((block) => block.id === fields.id) : undefined;
    if (resumedBlock !== undefined && fields.body !== undefined)
        throw ckError('CONFIG', 'body authoring already created this marker; inspect the retained block and continue with save instead of silently replaying another body');
    if (resumedBlock === undefined) {
        assertIdIsFree(ctx.patchesDir, fields.id, content, target, conventions, pendingMatches ? pendingFileName(target) : null);
    }
    const artifact = `${PATCHES_DIR}/${encodePatchName(target)}`;
    if (existsSync(join(ctx.patchesDir, ...artifact.split('/')))) {
        throw ckError('MARKER-ARTIFACT-MISMATCH', `${target} already has patch artifact ${artifact}`, 'edit inside the existing marker block, or remove the obsolete patch deliberately before scaffolding a replacement', artifact);
    }
    if (pending !== null && !pendingMatches) {
        throw ckError('MARKER-ARTIFACT-MISMATCH', `${target} already has a pending patch header for ${pending.id}`, 'finish it with codkit save, or remove only that draft before scaffolding another intervention', `${PENDING_DIR}/${pendingFileName(target)}`);
    }
    // 4. Persist the exact intent before touching the tree. A retry may finish an
    // interrupted matching intent, but another id can never overwrite the draft.
    const updated = resumedBlock === undefined ? insertBlock(content, form, fields, target) : { text: content, at: resumedBlock.beginLine };
    const draft = writePendingHeader(ctx.patchesDir, target, header);
    if (resumedBlock === undefined) {
        try {
            writeMarkerFileAtomic(absolute, content, updated.text, target);
        }
        catch (error) {
            if (pending === null)
                removePendingHeader(ctx.patchesDir, target);
            throw error;
        }
    }
    ctx.out.info(`${target}: inserted ${fields.id} at line ${updated.at}`);
    ctx.out.info(`pending patch header: ${relativePath(ctx.patchesDir, draft)}`);
    ctx.out.info('now edit inside the block, then: codkit save');
    ctx.out.setData(buildData(target, fields, updated.at, draft, ctx.patchesDir));
    return EXIT_OK;
}
function writeMarkerFileAtomic(absolute, before, after, target) {
    const temporary = `${absolute}.codkit-marker-new.tmp`;
    if (existsSync(temporary)) {
        const stat = lstatSync(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(temporary, 'utf8') !== after) {
            throw ckError('ARTIFACT-BROKEN', `${target}: marker transaction temp is not the exact intended file`, 'remove only the mismatched .codkit-marker-new.tmp file after inspecting it', target);
        }
    }
    else {
        const mode = lstatSync(absolute).mode & 0o777;
        try {
            writeFileSync(temporary, after, { encoding: 'utf8', flag: 'wx', mode });
            chmodSync(temporary, mode);
        }
        catch (error) {
            rmSync(temporary, { force: true });
            throw error;
        }
    }
    const current = readFileSync(absolute, 'utf8');
    if (current === after) {
        rmSync(temporary, { force: true });
        return;
    }
    if (current !== before) {
        throw ckError('ARTIFACT-BROKEN', `${target}: changed after marker transaction preflight`, 'preserve the file and retry after reconciling the concurrent edit', target);
    }
    renameSync(temporary, absolute);
}
function buildData(target, fields, at, draft, patchesDir) {
    return {
        target,
        id: fields.id,
        type: fields.type,
        category: fields.category,
        layer: fields.layer,
        owner: fields.owner,
        reason: fields.reason,
        line: at,
        pendingHeader: toPosix(relativePath(patchesDir, draft))
    };
}
// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------
/**
 * ##CMD-MARKER-NEW-ADD-BLOCK: another block of an intervention the file already
 * carries (PROP-004 ##MR-SEVERAL-BLOCKS-ONE-ID). The id must be this file's own -
 * the header of its patch artifact, or the draft waiting for it - so a block
 * of a foreign intervention can never be opened here by mistake.
 */
function addBlockTo(ctx, treeDir, config, given, fields) {
    const conventions = loadConventions(requireProjectType(ctx), ctx.patchesDir);
    const { target, absolute, form } = locateTarget(treeDir, config, given, conventions);
    const artifact = `${PATCHES_DIR}/${encodePatchName(target)}`;
    const pending = readPendingHeader(ctx.patchesDir, target);
    const ownedByArtifact = patchIdOwner(ctx.patchesDir, fields.id) === artifact;
    const ownedByDraft = pending !== null && pending.id === fields.id;
    if (!ownedByArtifact && !ownedByDraft) {
        throw ckError('MARKER-DUP-ID', `${fields.id} is not the intervention of ${target}: no patch artifact or pending draft of this file carries it`, 'scaffold the first block with codkit marker new (without --add-block), or name the id this file already has', target);
    }
    const content = readFileSync(absolute, 'utf8');
    const parsed = parseMarkers(Buffer.from(content, 'utf8'), extname(target), conventions, target);
    const parseError = parsed.errors[0];
    if (parseError !== undefined)
        throw parseError;
    if (!parsed.blocks.some((block) => block.id === fields.id)) {
        throw ckError('MARKER-ARTIFACT-MISMATCH', `${target} carries no block ${fields.id} yet`, 'run codkit load to materialize the intervention first, then add its second block', target);
    }
    const updated = fields.moveBlockFrom === undefined
        ? insertBlock(content, form, fields, target)
        : moveMarkerBlock(content, parsed.blocks, fields.id, fields.moveBlockFrom, fields.line, target);
    writeMarkerFileAtomic(absolute, content, updated.text, target);
    ctx.out.info(`${target}: ${fields.moveBlockFrom === undefined ? 'inserted another' : 'moved existing'} block of ${fields.id} at line ${updated.at}`);
    ctx.out.info('now edit inside the block, then: codkit save');
    ctx.out.setData({
        target,
        id: fields.id,
        line: updated.at,
        block: fields.moveBlockFrom === undefined ? 'added' : 'moved'
    });
    return EXIT_OK;
}
function readAddBlockFields(ctx) {
    const id = requireFlag(ctx, ID);
    for (const name of [TYPE, OWNER, REASON, CATEGORY, LAYER]) {
        if (commandFlagValue(ctx.commandFlags, name) !== null) {
            throw ckError('CONFIG', `${ADD_BLOCK} takes ${ID}, ${LINE} and optional body authoring flags; ${name} belongs to the first block`, 'the header of the intervention is the one its first block already has');
        }
    }
    const line = readLine(ctx);
    const move = commandFlagValue(ctx.commandFlags, MOVE_BLOCK_FROM);
    if (move !== null) {
        if (!/^[1-9]\d*$/.test(move) ||
            line === null ||
            commandFlagValue(ctx.commandFlags, BODY_FILE) !== null ||
            commandFlagValue(ctx.commandFlags, REPLACE_LINES) !== null)
            throw ckError('CONFIG', '--move-block-from needs positive begin line, explicit --line and no body/replacement flags');
        return { id, type: '', owner: '', reason: '', category: DEFAULT_CATEGORY, layer: 'patch', line, moveBlockFrom: Number(move) };
    }
    return { id, type: '', owner: '', reason: '', category: DEFAULT_CATEGORY, layer: 'patch', line, ...readBody(ctx, line) };
}
/** Relocate one exact owned block intact, retaining all unrelated bytes and the final-newline property. */
export function moveMarkerBlock(content, blocks, id, from, to, target) {
    const block = blocks.find((one) => one.id === id && one.beginLine === from);
    if (!block)
        throw ckError('CONFIG', 'the exact owned block begin line was not found', undefined, target);
    const newline = content.endsWith('\n');
    const lines = content.split('\n');
    if (newline)
        lines.pop();
    if (to < 1 || to > lines.length + 1 || blocks.some((one) => to >= one.beginLine && to <= one.endLine))
        throw ckError('CONFIG', 'block destination is outside the file or inside marker ownership', undefined, target);
    const moving = lines.splice(block.beginLine - 1, block.endLine - block.beginLine + 1);
    const at = to > block.endLine ? to - moving.length : to;
    lines.splice(at - 1, 0, ...moving);
    return { text: lines.join('\n') + (newline ? '\n' : ''), at };
}
function readFields(ctx) {
    const id = requireFlag(ctx, ID);
    const type = requireFlag(ctx, TYPE);
    const owner = requireFlag(ctx, OWNER);
    const reason = requireFlag(ctx, REASON);
    const category = commandFlagValue(ctx.commandFlags, CATEGORY) ?? DEFAULT_CATEGORY;
    const rawLayer = commandFlagValue(ctx.commandFlags, LAYER) ?? DEFAULT_PATCH_LAYER;
    if (rawLayer !== 'patch' && rawLayer !== 'entry-module') {
        throw ckError('CONFIG', `--layer must be patch or entry-module, got ${JSON.stringify(rawLayer)}`, 'rewrite-rule patches are generated by rule tooling and cannot be scaffolded by a person');
    }
    const line = readLine(ctx);
    return { id, type, owner, reason, category, layer: rawLayer, line, ...readBody(ctx, line) };
}
/** CMD-MARKER-BODY: author a bounded body through the same locked marker transaction. */
function readBody(ctx, line) {
    const path = commandFlagValue(ctx.commandFlags, BODY_FILE);
    const replace = commandFlagValue(ctx.commandFlags, REPLACE_LINES);
    if (path === null) {
        if (replace !== null)
            throw ckError('CONFIG', '--replace-lines requires --body-file');
        return {};
    }
    const absolute = resolve(ctx.patchesDir, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
        throw ckError('CONFIG', '--body-file must be a bounded regular non-symlink file');
    let body;
    try {
        body = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(absolute));
    }
    catch {
        throw ckError('CONFIG', '--body-file must be valid UTF-8');
    }
    if (!body.trim() || body.includes('codkit:begin') || body.includes('codkit:end'))
        throw ckError('CONFIG', '--body-file must contain code without marker ownership tokens');
    if (replace !== null && (line === null || !/^[1-9][0-9]*$/.test(replace) || Number(replace) > 1000))
        throw ckError('CONFIG', '--replace-lines requires an explicit --line and a count from 1 to 1000');
    return { body: body.replace(/\r\n/g, '\n'), replaceLines: replace === null ? 0 : Number(replace) };
}
function readLine(ctx) {
    const rawLine = commandFlagValue(ctx.commandFlags, LINE);
    if (rawLine === null) {
        return null;
    }
    if (!/^[1-9][0-9]*$/.test(rawLine)) {
        throw ckError('CONFIG', `--line must be a positive line number, got "${rawLine}"`, 'lines are 1-based; omit --line to append at the end of the file');
    }
    return Number.parseInt(rawLine, 10);
}
function requireFlag(ctx, name) {
    const value = commandFlagValue(ctx.commandFlags, name);
    if (value === null || value === '') {
        throw ckError('CONFIG', `marker new needs ${name}`, `usage: codkit marker new <file> ${ID} CK-<subsystem>-<NNN> ${TYPE} <type> ${OWNER} <owner> ${REASON} <why>`);
    }
    return value;
}
function requireConfig(config) {
    if (config === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patchset root: marker new needs the fork tree and the conventions of this repository', 'run marker new from a patchset checkout that carries codkit.json');
    }
    return config;
}
/** A path given on the command line, as a tree-relative POSIX path. */
function treeRelativePath(given, treeDir) {
    const absolute = isAbsolute(given) ? resolve(given) : resolve(treeDir, given);
    const inside = relativePath(treeDir, absolute);
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
        throw ckError('FORBIDDEN-TARGET', `the target ${given} is outside the fork tree ${treeDir}`, 'choose an upstream file below the fork-tree root', given);
    }
    const target = toPosix(inside);
    const checked = resolveContainedPath(treeDir, target);
    if (!checked.ok) {
        throw ckError('FORBIDDEN-TARGET', `the target ${given} is unsafe: ${checked.reason}`, 'choose a regular upstream file below the fork-tree root; symlinks are not patch targets', target);
    }
    return target;
}
// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validateFields(patchesDir, fields, conventions) {
    if (!new RegExp(conventions.idPattern).test(fields.id)) {
        throw ckError('MARKER-BAD-ID', `id "${fields.id}" does not match the id pattern of conventions.json`, `use an id of the form CK-<subsystem>-<NNN> with a subsystem from conventions.json (pattern: ${conventions.idPattern})`);
    }
    if (!conventions.interventionTypes.includes(fields.type)) {
        throw ckError('CONFIG', `type "${fields.type}" is not one of the intervention types`, `use one of: ${conventions.interventionTypes.join(', ')}`);
    }
    if (!conventions.categories.includes(fields.category)) {
        throw ckError('CONFIG', `category "${fields.category}" is not one of the categories`, `use one of: ${conventions.categories.join(', ')}`);
    }
    const owners = loadOwnerKeys(patchesDir);
    if (owners !== null && !owners.includes(fields.owner)) {
        throw ckError('OWNER-UNKNOWN', `owner "${fields.owner}" is not declared in ${OWNERS_FILE}`, `use one of: ${owners.join(', ')}   (or add the owner to ${OWNERS_FILE} first)`, OWNERS_FILE);
    }
}
/**
 * An id names exactly one intervention, so it must be free everywhere it could
 * already be recorded: in the header of a patch, in a draft waiting for `save`,
 * and in the blocks of the file about to be edited.
 */
function assertIdIsFree(patchesDir, id, content, target, conventions, allowedPendingFile = null) {
    const inPatch = patchIdOwner(patchesDir, id);
    if (inPatch !== null) {
        throw ckError('MARKER-DUP-ID', `id already used: ${id} is the id of ${inPatch}`, 'give this intervention its own id', inPatch);
    }
    for (const entry of listPendingHeaders(patchesDir)) {
        if (entry.fileName === allowedPendingFile)
            continue;
        if (entry.header.id === id) {
            throw ckError('MARKER-DUP-ID', `id already used: ${id} is waiting in a pending patch header`, 'give this intervention its own id, or run codkit save to turn the pending header into a patch', `.codkit/pending/${entry.fileName}`);
        }
    }
    const parsed = parseMarkers(Buffer.from(content, 'utf8'), extname(target), conventions, target);
    if (parsed.blocks.some((block) => block.id === id)) {
        throw ckError('MARKER-DUP-ID', `id already used: ${target} already carries a block ${id}`, 'give this intervention its own id', target);
    }
}
/** The artifact whose header carries `id`, or null when no patch does. */
function patchIdOwner(patchesDir, id) {
    const dir = join(patchesDir, ...PATCHES_DIR.split('/'));
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return null;
    }
    const idLine = `# id: ${id}`;
    for (const name of names.filter((candidate) => candidate.endsWith(PATCH_FILE_SUFFIX)).sort()) {
        // Only the header is read: a patch body that is broken elsewhere must not
        // stop somebody from scaffolding an unrelated block.
        const text = readFileSync(join(dir, name), 'utf8');
        for (const line of text.split('\n')) {
            if (!line.startsWith('# ')) {
                break;
            }
            if (line === idLine) {
                return `${PATCHES_DIR}/${name}`;
            }
        }
    }
    return null;
}
/**
 * Insert the marker pair before `--line` (1-based), or at the end of the file
 * when no line was given. The indentation is taken from the neighbouring line,
 * so the block sits where the code around it sits.
 */
export function insertBlock(content, form, fields, target) {
    const endsWithNewline = content === '' || content.endsWith('\n');
    const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
    const at = fields.line ?? lines.length + 1;
    if (at > lines.length + 1) {
        throw ckError('CONFIG', `--line ${at} is past the end of ${target}, which has ${lines.length} line(s)`, 'omit --line to put the block at the end of the file', target);
    }
    const neighbour = lines[at - 1] ?? lines[at - 2] ?? '';
    const indent = /^[\t ]*/.exec(neighbour)?.[0] ?? '';
    const replace = fields.replaceLines ?? 0;
    if (replace > 0 && (!form.open.startsWith('//') || at - 1 + replace > lines.length))
        throw ckError('CONFIG', 'bounded replacement requires an existing line-comment target range');
    const originals = lines.slice(at - 1, at - 1 + replace);
    if (originals.some((line) => line.includes('codkit:')))
        throw ckError('CONFIG', 'replacement cannot neutralize existing marker ownership');
    const body = fields.body === undefined
        ? []
        : fields.body
            .replace(/\n$/, '')
            .split('\n')
            .map((line) => indent + line);
    const followingIndent = /^[\t ]*/.exec(lines[at - 1 + replace] ?? '')?.[0] ?? indent;
    const endIndent = replace > 0 && followingIndent.length > indent.length ? followingIndent : indent;
    const block = [
        `${indent}${form.open}begin ${fields.id}${form.close}`,
        ...originals.map((line) => `${indent}// ${line.slice(indent.length)}`),
        ...body,
        `${endIndent}${form.open}end ${fields.id}${form.close}`
    ];
    lines.splice(at - 1, replace, ...block);
    // The final newline of the file is a property codkit refuses to change
    // (PROP-004 ##GEN-BYTE-PREDICATES); the block never introduces or removes one.
    return { text: `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`, at };
}
export const markerNewCommand = {
    name: 'marker new',
    summary: 'scaffold a codkit marker block in an upstream file of the tree',
    configMode: 'load',
    maxArgs: 1,
    commandFlags: [ID, TYPE, OWNER, REASON, CATEGORY, LAYER, LINE, ADD_BLOCK, BODY_FILE, REPLACE_LINES, MOVE_BLOCK_FROM],
    run
};
