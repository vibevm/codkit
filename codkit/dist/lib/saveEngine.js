/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The save engine: take the work out of the fork tree and put it into patchset.
// The pseudocode of PROP-008 sec. 4 is normative and this file follows its order.
//
// `save` is the inverse of `load`, and the asymmetry between them is the point:
//
//   * `load` writes the tree from patchset, so it refuses to run over work that is
//     not in patchset yet (the drift guard);
//   * `save` reads the tree into patchset, so it must never lose what only patchset
//     has. Own code is mirrored back file by file, and only for the files the
//     *tree* moved (PROP-008 ##PATCHSET-SIDE-EDIT-RULE); a file both sides moved has
//     no direction of truth and stops the command.
//
// Every upstream file is validated before anything is written: markers parse,
// the target is allowed to carry a patch, no upstream file is deleted, no new
// file appears without being asked for, and every hunk lands inside a marker
// block. Only then are the artifacts written, and only when their bytes differ
// (##GEN-BYTE-COMPARE, so mtimes stay put and watch daemons stay asleep).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative as relativePath } from 'node:path';
import { bytesEqual, encodeUtf8 } from './bytes.js';
import { applyUnified } from './applyUnified.js';
import { loadConventions, matchesPatternList } from './conventionsFile.js';
import { porcelainZEntries } from './driftGuard.js';
import { gitLocal, runGit } from './gitx.js';
import { checkHunksInsideMarkers, checkMarkerArtifactConsistency } from './hunksInMarkers.js';
import { parseMarkers } from './markers.js';
import { ckError, isCkError } from './messages.js';
import { classifyOwn, mirrorOwnBack, ownTargetRelativeDir } from './ownCopy.js';
import { encodePatchName, extractHeaderText, formatPatchHeader, parseCkpatch, serializeCkpatch } from './patchFormat.js';
import { regeneratePatch } from './patchGenerate.js';
import { repoRelativePathProblem } from './pathSafety.js';
import { readPendingHeader, removePendingHeader } from './pendingHeader.js';
import { listRebasePendingRecords, readRebasePending, rebaseHeaderMetadataSha256, removeRebasePending } from './rebaseOntoPinPending.js';
import { sha256 } from './renameFileState.js';
import { advanceCompletedRebaseMove, assertRebasePendingMoveBinding } from './rebaseOntoPinMove.js';
import { PATCHES_DIR, bothSidesError, runSync, toPosix } from './syncEngine.js';
import { readTreeMark } from './treeCache.js';
import { foreignCommits, treeHeadError } from './treeCommits.js';
import { checkTree, formatCheckLine } from './treeIdentity.js';
import { assertGeneratedRefExclusive } from './worktrees.js';
const NO_OWN = { copied: 0, removed: 0, kept: 0, total: 0 };
/** Identity used for a patchset commit when git has no configured user. */
const FALLBACK_COMMIT_NAME = 'codkit';
const FALLBACK_COMMIT_EMAIL = 'codkit@patchset.invalid';
/** How many tree commits the Phase-2 refusal lists before summarizing the rest. */
const DIRTY_LIST_LIMIT = 20;
/**
 * One `save`. The caller holds the lock and owns the output envelope.
 */
export function runSave(options) {
    const { patchesDir, resolution, config, out } = options;
    const tree = resolution.path;
    const branch = `${config.generatedBranchPrefix}${config.pin.tag}`;
    // 1. Is this the tree we think it is, and may we write to it?
    const identity = checkTree(resolution, config, { mode: 'write' });
    if (options.verbose) {
        for (const check of identity.checks) {
            out.diag(formatCheckLine(check));
        }
    }
    if (identity.fatal !== null) {
        out.addError(identity.fatal.toPayload());
        return result('unfit', 2, { branch });
    }
    // 1b. The shared-ref preflight precedes everything below (the D7 ruling of
    // 2026-09-06; PROP-008 §4): while a sibling worktree holds the generated
    // branch, nothing here may extract - the neighbour can move the shared ref
    // under the extraction.
    try {
        assertGeneratedRefExclusive(tree, `refs/heads/${branch}`);
    }
    catch (error) {
        if (isCkError(error) && error.code === 'WORKTREE-REF-SHARED') {
            out.addError(error.toPayload());
            return result('unfit', 2, { branch });
        }
        throw error;
    }
    // 1c. Commits made in the fork tree are work (##TREE-COMMITS-ARE-WORK), and
    // this build of the campaign does not extract them yet - Phase 3 teaches
    // `save` to, and doing it half-way here would make both phases unreviewable.
    // The refusal therefore comes before the own mirror and before every
    // artifact write. A HEAD outside the generated branch while carrying work
    // refuses first (D8).
    const treeState = foreignCommits(tree, config.pin.sha, branch);
    const head = treeHeadError(treeState, branch);
    if (head !== null) {
        out.addError(head.toPayload());
        return result('blocked', 1, { branch });
    }
    if (treeState.commits.length > 0) {
        for (const commit of treeState.commits.slice(0, DIRTY_LIST_LIMIT)) {
            out.info(`  commit: ${commit.sha.slice(0, 8)} "${commit.subject}" (not in patchset)`);
        }
        if (treeState.commits.length > DIRTY_LIST_LIMIT) {
            out.info(`  ... and ${treeState.commits.length - DIRTY_LIST_LIMIT} more`);
        }
        out.addError({
            code: 'DIRTY-TREE',
            message: 'save does not extract tree commits yet; see campaign TREE-COMMITS-SAVE',
            hint: `${treeState.commits.length} commit(s) in the fork tree are not in patchset; nothing was written, and the commits stay in the tree`
        });
        return result('blocked', 1, { branch });
    }
    const conventions = loadConventions(patchesDir);
    const entryModuleIds = loadEntryModuleIds(patchesDir, conventions);
    const headerOverrides = validateHeaderOverrides(options);
    // Paths on the command line name files of the tree; they are read the same
    // way whether they were typed relative, absolute or with a trailing slash.
    const filters = normalizeFilters(options.paths, tree);
    const allowNewFile = normalizeFilters(options.allowNewFile, tree);
    const forcedPaths = [
        ...new Set([...(options.forcedPaths ?? []), ...listRebasePendingRecords(patchesDir).map((entry) => entry.targetPath)])
    ];
    if (headerOverrides.size > 0) {
        const addressed = new Set(upstreamChanges(tree, config.ownDirName, forcedPaths)
            .filter((entry) => matchesFilters(entry.path, filters))
            .map((entry) => entry.path));
        const unused = [...headerOverrides.keys()].filter((target) => !addressed.has(target));
        if (unused.length > 0)
            throw ckError('CONFIG', `cycle patch header override target is not an addressed dirty file: ${unused.join(', ')}`);
    }
    // 2. Own code: tree -> patchset, file by file, and only where the tree moved.
    const mark = readTreeMark(tree, (text) => {
        out.warn(text);
    });
    const classes = classifyOwn(patchesDir, tree, config.ownDirName, mark?.ownFiles ?? null).filter((entry) => entry.kind !== 'same');
    const conflict = classes.find((entry) => entry.kind === 'both-edited');
    if (conflict !== undefined) {
        out.addError(bothSidesError(conflict.relative).toPayload());
        return result('blocked', 1, { branch });
    }
    const ownInScope = filterOwn(classes, filters, config.ownDirName);
    const own = mirrorOwnBack(patchesDir, tree, config.ownDirName, ownInScope);
    reportOwn(out, own);
    // 3. Upstream files: everything git sees outside the own directory.
    const changed = upstreamChanges(tree, config.ownDirName, forcedPaths);
    const dirty = changed.filter((entry) => matchesFilters(entry.path, filters));
    if (options.verbose) {
        out.diag(`changed upstream file(s): ${dirty.length === 0 ? 'none' : dirty.map((entry) => entry.path).join(', ')}`);
    }
    // An addressed save leaves the rest of the tree as it is - including the
    // branch, which may not be rebuilt while work outside the given paths is
    // still only in the tree: the rebuild rewrites every file that differs from
    // the new tip, and that work would be exactly what it overwrites.
    const leftOut = changed.length - dirty.length + (classes.length - ownInScope.length);
    const planned = [];
    const errors = [];
    for (const entry of dirty) {
        try {
            const plan = planFile(entry, options, conventions, allowNewFile, out, headerOverrides.get(entry.path), entryModuleIds);
            if (plan !== null) {
                planned.push(plan);
            }
        }
        catch (error) {
            if (!isCkError(error)) {
                throw error;
            }
            errors.push(error);
        }
    }
    // Nothing is written while a single file is still in doubt: a half-extracted
    // delta is worse than one the developer has to fix and re-run.
    if (errors.length > 0) {
        for (const error of errors) {
            out.addError(error.toPayload());
        }
        return result('blocked', 1, { branch, files: planned.map(toReport), own });
    }
    // 4. Write the artifacts.
    const written = commitArtifacts(patchesDir, tree, planned, out, options.rebasePendingCheckpoint);
    // Nothing moved in patchset *and* nothing is out of place in the tree: there is
    // no work to extract and no branch to rebuild. A tree that is dirty while
    // every artifact stays byte-identical is not this case - the branch is then
    // behind the artifacts and step 5 has to put it back on top of them.
    if (written === 0 && own.copied === 0 && own.removed === 0 && dirty.length === 0) {
        out.info('nothing to save');
        return result('nothing', 0, { branch, files: planned.map(toReport), own });
    }
    // 5. Rebuild the generated branch by re-running the sync engine. Everything
    // the tree carries is in patchset now, so the guard has nothing left to protect
    // and the rebuild must not touch a single work-tree file (PROP-008 sec. 4).
    let branchTip = null;
    if (leftOut > 0) {
        out.warn(`${leftOut} changed path(s) are outside the paths given to save, so the generated branch is left where it is; ` +
            'run codkit save without paths to extract the rest and rebuild the branch');
    }
    else if (options.deferSync === true) {
        out.info('saved addressed rebase artifacts without moving the generated branch');
    }
    else {
        const rebuilt = runSync({
            patchesDir,
            resolution,
            config,
            out,
            fresh: false,
            dryRun: false,
            verbose: options.verbose,
            skipDriftGuard: true,
            ...(options.syncCheckpoint === undefined ? {} : { checkpoint: options.syncCheckpoint })
        });
        if (rebuilt.exitCode !== 0) {
            return result(rebuilt.status === 'unfit' ? 'unfit' : 'blocked', rebuilt.exitCode, {
                branch,
                branchTip: rebuilt.branchTip,
                files: planned.map(toReport),
                own
            });
        }
        assertNothingMoved(rebuilt.changedPaths, rebuilt.nonPatchTargets, out);
        branchTip = rebuilt.branchTip;
    }
    // 6. --commit: the delta paths this run touched, and only those.
    const commitSha = options.commit ? commitDelta(options, planned, own, out) : null;
    out.info(`saved ${planned.filter((plan) => plan.action !== 'unchanged').length} file(s)`);
    return result('saved', 0, {
        branch,
        branchTip,
        files: planned.map(toReport),
        own,
        commit: commitSha
    });
}
function loadEntryModuleIds(patchesDir, conventions) {
    const directory = join(patchesDir, ...PATCHES_DIR.split('/'));
    let names;
    try {
        names = readdirSync(directory);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => name.endsWith('.ckpatch'))
        .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)))
        .flatMap((name) => {
        const artifact = `${PATCHES_DIR}/${name}`;
        const patch = parseCkpatch(readFileSync(join(directory, name)), conventions, artifact);
        return patch.header.layer === 'entry-module' ? [patch.header.id] : [];
    });
}
/**
 * `git status --porcelain -z`, minus the own directory (git may see it in CI
 * mode, and it is not an upstream file in any mode).
 */
function upstreamChanges(treeDir, ownDirName, forcedPaths = []) {
    const status = runGit({ args: ['status', '--porcelain', '-z'], cwd: treeDir });
    if (status.status !== 0) {
        throw ckError('NOT-A-REPO', `git status failed in ${treeDir}: ${status.stderr.trim()}`, 'check that the fork tree is a healthy git work tree');
    }
    const ownPrefix = `${ownTargetRelativeDir(ownDirName)}/`;
    const changes = porcelainZEntries(status.stdout)
        .filter((entry) => !entry.path.startsWith(ownPrefix))
        .map((entry) => ({ status: entry.status, path: entry.path }));
    const present = new Set(changes.map((entry) => entry.path));
    for (const path of forcedPaths) {
        const problem = repoRelativePathProblem(path);
        if (problem !== null || path.startsWith(ownPrefix))
            throw ckError('CONFIG', `invalid forced save path ${JSON.stringify(path)}`);
        if (!present.has(path))
            changes.push({ status: ' M', path });
    }
    return changes.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
}
/** Positional paths, as tree-relative POSIX paths. */
function normalizeFilters(paths, treeDir) {
    return paths.map((given) => {
        const absolute = isAbsolute(given) ? given : join(treeDir, given);
        const inside = relativePath(treeDir, absolute);
        const chosen = inside === '' || inside.startsWith('..') ? given : inside;
        return toPosix(chosen).replace(/^\.\//, '').replace(/\/+$/, '');
    });
}
function matchesFilters(path, filters) {
    if (filters.length === 0) {
        return true;
    }
    return filters.some((filter) => path === filter || path.startsWith(`${filter}/`));
}
/** Own divergences narrowed by the positional paths, which name tree paths. */
function filterOwn(classes, filters, ownDirName) {
    if (filters.length === 0) {
        return classes;
    }
    const prefix = ownTargetRelativeDir(ownDirName);
    return classes.filter((entry) => matchesFilters(`${prefix}/${entry.relative}`, filters));
}
// ---------------------------------------------------------------------------
// One file
// ---------------------------------------------------------------------------
/**
 * Validate one changed upstream file and compute the artifact it produces.
 * Throws the first diagnosed condition of that file; returns null when the file
 * has nothing to contribute (its patch stays exactly as it is on disk).
 */
function planFile(entry, options, conventions, allowNewFile, out, headerOverride, entryModuleIds) {
    const { patchesDir, config } = options;
    const tree = options.resolution.path;
    const target = entry.path;
    const artifactName = encodePatchName(target);
    const artifact = `${PATCHES_DIR}/${artifactName}`;
    const artifactAbsolute = join(patchesDir, ...PATCHES_DIR.split('/'), artifactName);
    if (isDeletion(entry.status)) {
        throw ckError('DELETES-UPSTREAM-FILE', 'was deleted from the fork tree; a patch never removes an upstream file', 'restore the file and hide it from the product instead (PROP-005 sec. 8), then record the removal in delta/removed.json', target);
    }
    if (matchesPatternList(target, conventions.forbiddenPatchTargets)) {
        throw ckError('FORBIDDEN-TARGET', 'is a forbidden patch target', `conventions.json forbids patching it (forbiddenPatchTargets: ${conventions.forbiddenPatchTargets.join(', ')}); ` +
            'revert the change in the tree', target);
    }
    const existingBytes = existsSync(artifactAbsolute) ? readFileSync(artifactAbsolute) : null;
    const existing = existingBytes === null ? null : parseCkpatch(existingBytes, conventions, artifact);
    // Whether the file is new is decided by the pin, not by the index: a file an
    // earlier add-file patch introduced is tracked in the tree and still absent
    // from the pin, and it must keep producing an add-file patch.
    const pinBytes = bytesAtPin(tree, config.pin.sha, target);
    const isAddFile = pinBytes === null;
    if (isAddFile && !allowNewFile.includes(target) && existing?.isAddFile !== true) {
        throw ckError('NEW-FILE-IN-UPSTREAM-ZONE', 'is a new file in the upstream zone: the pin does not carry it', `new files belong to own code (delta/own/, materialized as src/vs/${config.ownDirName}/); ` +
            `if this one has to live at this exact path, say so: codkit save --allow-new-file ${target}`, target);
    }
    const absolute = join(tree, ...target.split('/'));
    const curBytes = readFileSync(absolute);
    const ext = extname(target);
    // Markers of the working file: a block that is not closed, nested or
    // duplicated must be fixed by a human before any patch is generated.
    const markers = parseMarkers(curBytes, ext, conventions, target);
    const markerError = markers.errors[0];
    if (markerError !== undefined) {
        throw markerError;
    }
    const base = pinBytes ?? new Uint8Array(0);
    const missingArtifactPending = existing === null ? readRebasePending(patchesDir, target) : null;
    if (missingArtifactPending !== null && !isAddFile && bytesEqual(base, curBytes)) {
        validateHeaderOverride(missingArtifactPending, config);
        if (missingArtifactPending.artifactPath !== artifact || missingArtifactPending.targetPath !== target) {
            throw ckError('ARTIFACT-BROKEN', `${artifact}: removed conflict pending identity does not match addressed target`);
        }
        assertRebasePendingMoveBinding(patchesDir, tree, missingArtifactPending, true);
        return { target, artifact, artifactAbsolute, action: 'removed', bytes: null, consumesPending: true };
    }
    const header = headerFor(patchesDir, tree, target, artifact, existing, config, headerOverride);
    const regenerated = regeneratePatch({
        targetPath: target,
        pinBytes: base,
        pinExists: !isAddFile,
        curBytes,
        header: header.text,
        existingBytes,
        tmpDir: join(patchesDir, '.codkit', 'tmp')
    });
    if (regenerated.unchanged && regenerated.empty) {
        // The file is back at the pin: the artifact has nothing left to describe.
        if (existingBytes === null) {
            return null;
        }
        return { target, artifact, artifactAbsolute, action: 'removed', bytes: null, consumesPending: false };
    }
    const bytes = regenerated.unchanged ? (existingBytes ?? new Uint8Array(0)) : regenerated.bytes;
    checkPatchAgainstMarkers(bytes, base, curBytes, ext, conventions, artifact, isAddFile, out, entryModuleIds);
    if (regenerated.unchanged) {
        return { target, artifact, artifactAbsolute, action: 'unchanged', bytes: null, consumesPending: header.fromPending };
    }
    return {
        target,
        artifact,
        artifactAbsolute,
        action: existingBytes === null ? 'created' : 'updated',
        bytes,
        consumesPending: header.fromPending
    };
}
/** ` D`, `D `, `AD`, ...: the file is gone from the work tree or from the index. */
function isDeletion(status) {
    return status.includes('D');
}
/** The file at the pin, or null when the pin does not carry it at all. */
function bytesAtPin(treeDir, pinSha, target) {
    const shown = runGit({ args: ['show', `${pinSha}:${toPosix(target)}`], cwd: treeDir });
    return shown.status === 0 ? encodeUtf8(shown.stdout) : null;
}
/**
 * ##GEN-HEADER-PRESERVED and ##PENDING-HEADER-MECHANISM: an existing artifact
 * keeps its header byte for byte, a new one takes it from the draft `marker new`
 * left behind, and a target with neither is a target nobody described yet.
 */
function headerFor(patchesDir, treeDir, target, artifact, existing, config, override) {
    const localOverride = override === undefined && existing !== null ? readRebasePending(patchesDir, target) : null;
    if (localOverride !== null && existing !== null) {
        const advanced = sha256(serializeCkpatch(existing)) !== localOverride.artifactSha256;
        assertRebasePendingMoveBinding(patchesDir, treeDir, localOverride, advanced);
        if (advanced)
            assertAdvancedPendingArtifact(treeDir, target, existing, localOverride, config);
    }
    const selectedOverride = override ?? localOverride ?? undefined;
    if (selectedOverride !== undefined) {
        if (existing === null) {
            throw ckError('ARTIFACT-BROKEN', `${artifact}: cycle header override requires the existing patch artifact`);
        }
        validateHeaderOverride(selectedOverride, config);
        if (selectedOverride.artifactPath !== artifact ||
            selectedOverride.artifactId !== existing.header.id ||
            existing.targetPath !== target) {
            throw ckError('ARTIFACT-BROKEN', `${artifact}: cycle header override does not match the exact patch identity`);
        }
        return {
            text: formatPatchHeader({
                id: existing.header.id,
                ...(existing.header.layerExplicit ? { layer: existing.header.layer } : {}),
                type: existing.header.type,
                category: existing.header.category,
                owner: existing.header.owner,
                reason: existing.header.reason,
                link: existing.header.link,
                cause: selectedOverride.cause,
                pin: `${selectedOverride.pin.tag}@${selectedOverride.pin.sha}`,
                contractTests: existing.header.contractTests
            }),
            fromPending: localOverride !== null
        };
    }
    if (existing !== null) {
        return { text: extractHeaderText(existing), fromPending: false };
    }
    const pending = readPendingHeader(patchesDir, target);
    if (pending === null) {
        throw ckError('HEADER-MISSING', 'changed, but no patch describes it and no pending header says what a new one would carry', `run codkit marker new ${target} --id CK-<subsystem>-<NNN> --type <type> --owner <owner> --reason <why> first`, target);
    }
    return {
        text: formatPatchHeader({
            id: pending.id,
            layer: pending.layer,
            type: pending.type,
            category: pending.category,
            owner: pending.owner,
            reason: pending.reason,
            link: pending.link,
            cause: 'none',
            pin: `${config.pin.tag}@${config.pin.sha}`,
            contractTests: []
        }),
        fromPending: true
    };
}
function validateHeaderOverrides(options) {
    const overrides = new Map();
    for (const override of options.patchHeaderOverrides ?? []) {
        const problem = repoRelativePathProblem(override.targetPath);
        const expectedArtifact = `${PATCHES_DIR}/${encodePatchName(override.targetPath)}`;
        if (problem !== null || override.artifactPath !== expectedArtifact) {
            throw ckError('CONFIG', `invalid cycle patch header override target ${JSON.stringify(override.targetPath)}`);
        }
        validateHeaderOverride(override, options.config);
        if (override.artifactId.trim() === '' || /[\r\n]/.test(override.artifactId)) {
            throw ckError('CONFIG', `${override.artifactPath}: cycle patch header override has an invalid artifact id`);
        }
        if (overrides.has(override.targetPath))
            throw ckError('CONFIG', `duplicate cycle patch header override for ${override.targetPath}`);
        overrides.set(override.targetPath, override);
    }
    return overrides;
}
function assertAdvancedPendingArtifact(treeDir, target, patch, pending, config) {
    if (rebaseHeaderMetadataSha256(patch.header) !== pending.headerMetadataSha256 ||
        patch.header.cause !== pending.cause ||
        patch.header.pin !== `${pending.pin.tag}@${pending.pin.sha}`) {
        throw ckError('ARTIFACT-BROKEN', `${pending.artifactPath}: transitioned conflict artifact header is not exact`);
    }
    const pinBytes = bytesAtPin(treeDir, config.pin.sha, target);
    if ((pinBytes === null) !== patch.isAddFile) {
        throw ckError('ARTIFACT-BROKEN', `${pending.artifactPath}: transitioned conflict artifact has wrong add-file semantics`);
    }
    const applied = applyUnified(pinBytes ?? new Uint8Array(0), patch);
    const current = readFileSync(join(treeDir, ...target.split('/')));
    if (!bytesEqual(applied, current)) {
        throw ckError('ARTIFACT-BROKEN', `${pending.artifactPath}: transitioned conflict artifact body is not the resolved tree state`);
    }
}
function validateHeaderOverride(override, config) {
    if (override.cause !== 'none' && !/^[0-9a-f]{40}$/.test(override.cause)) {
        throw ckError('CONFIG', `invalid cycle patch cause ${JSON.stringify(override.cause)}`);
    }
    if (override.pin.tag !== config.pin.tag || override.pin.sha !== config.pin.sha) {
        throw ckError('CONFIG', `${override.artifactPath}: cycle patch header override does not match the configured pin`);
    }
}
/**
 * "Every hunk inside a marker" (PROP-006 sec. 5), run before the artifact is
 * written so that a violation leaves the previous patch untouched.
 *
 * An add-file patch is checked differently on purpose: every line of a new file
 * is an added line, and the rule that protects upstream lines has nothing to
 * protect there (PROP-005 ##NEW-FILES-LIVE-IN-OWN - the whole file is ours). What
 * still holds is the marker/artifact correspondence: the block that carries the
 * id of the patch has to exist.
 */
function checkPatchAgainstMarkers(bytes, pinBytes, curBytes, ext, conventions, artifact, isAddFile, out, entryModuleIds) {
    const parsed = parseCkpatch(bytes, conventions, artifact);
    const allowIds = parsed.header.layer === 'entry-module' ? entryModuleIds : [];
    if (isAddFile) {
        // The target state of an add-file patch is the working file itself.
        const markers = parseMarkers(curBytes, ext, conventions, parsed.targetPath);
        const errors = [...markers.errors, ...checkMarkerArtifactConsistency(markers.blocks, parsed.header.id, allowIds, artifact)];
        const first = errors[0];
        if (first !== undefined) {
            throw first;
        }
        return;
    }
    const outcome = checkHunksInsideMarkers(parsed, pinBytes, ext, conventions, { patchFile: artifact, allowIds });
    const first = outcome.errors[0];
    if (first !== undefined) {
        throw first;
    }
    for (const warning of outcome.warnings) {
        // A block that adds nothing but its own markers is legal and almost
        // always a half-finished edit, so it is said out loud (CK-W-EMPTY-BLOCK).
        out.warn(`${warning.file}: ${warning.message}`, warning.code);
    }
}
// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
/** Write what the plan says and drop the drafts it consumed. Returns the count. */
function commitArtifacts(patchesDir, treeDir, planned, out, checkpoint) {
    let touched = 0;
    for (const plan of planned) {
        const rebasePending = readRebasePending(patchesDir, plan.target);
        if (plan.action === 'removed') {
            rmSync(plan.artifactAbsolute, { force: true });
            if (rebasePending !== null) {
                checkpoint?.('artifact-written', plan.target);
                advanceCompletedRebaseMove(patchesDir, treeDir, plan.target);
                checkpoint?.('receipt-updated', plan.target);
                checkpoint?.('before-pending-remove', plan.target);
            }
            removePendingHeader(patchesDir, plan.target);
            removeRebasePending(patchesDir, plan.target);
            out.info(`${plan.artifact}: removed, ${plan.target} is back at the pin`);
            touched += 1;
            continue;
        }
        if (plan.action === 'unchanged' || plan.bytes === null) {
            if (plan.consumesPending) {
                if (rebasePending !== null) {
                    checkpoint?.('artifact-written', plan.target);
                    advanceCompletedRebaseMove(patchesDir, treeDir, plan.target);
                    checkpoint?.('receipt-updated', plan.target);
                    checkpoint?.('before-pending-remove', plan.target);
                }
                removePendingHeader(patchesDir, plan.target);
                removeRebasePending(patchesDir, plan.target);
            }
            continue;
        }
        mkdirSync(dirname(plan.artifactAbsolute), { recursive: true });
        writeFileSync(plan.artifactAbsolute, plan.bytes);
        if (plan.consumesPending) {
            if (rebasePending !== null) {
                checkpoint?.('artifact-written', plan.target);
                advanceCompletedRebaseMove(patchesDir, treeDir, plan.target);
                checkpoint?.('receipt-updated', plan.target);
                checkpoint?.('before-pending-remove', plan.target);
            }
            removePendingHeader(patchesDir, plan.target);
            removeRebasePending(patchesDir, plan.target);
        }
        out.info(`${plan.artifact}: ${plan.action}`);
        touched += 1;
    }
    return touched;
}
/**
 * The invariant of PROP-008 sec. 4: the rebuilt branch is byte for byte the
 * working state of the tree, so moving HEAD onto it touches no file at all. A
 * rewritten file means the delta codkit just extracted does not reproduce the
 * tree it was extracted from - a bug in codkit, not something the developer can
 * act on, and never something to pass over in silence.
 *
 * With one exception, and it is the exception the invariant was always about:
 * `save` extracts two layers, patch and own, while the other layers are authored
 * by hand in patchset and reach the tree only by materialization (PROP-007 sec. 7).
 * A developer who adds a resource entry and then runs `save` gives the rebuild a
 * file that is in patchset and not yet in the tree, and writing it is the rebuild
 * doing its job. Such a rewrite is explained by the artifact that asked for it
 * and is reported; every other one is still the internal error above.
 */
function assertNothingMoved(changedPaths, nonPatchTargets, out) {
    if (changedPaths.length === 0) {
        return;
    }
    const explained = new Set(nonPatchTargets);
    const materialized = changedPaths.filter((path) => explained.has(path));
    const unexplained = changedPaths.filter((path) => !explained.has(path));
    if (materialized.length > 0) {
        out.info(`reconciled ${materialized.length} file(s) through normative overlay/resource/own materialization ` +
            `(${materialized.slice(0, 5).join(', ')}); the rebuild put their patchset-authored state into the selected tree channel`);
    }
    if (unexplained.length === 0) {
        return;
    }
    throw ckError('INTERNAL', `the rebuilt branch does not match the working tree: ${unexplained.length} file(s) had to be rewritten ` +
        `(${unexplained.slice(0, 5).join(', ')}); the delta codkit extracted does not reproduce the tree it was extracted from`, 're-run with --verbose and attach the output to a bug report');
}
// ---------------------------------------------------------------------------
// --commit
// ---------------------------------------------------------------------------
/**
 * Stage exactly the delta paths this run touched and commit them in patchset.
 *
 * The commit is an ordinary commit of the person running the command, so the
 * identity is read with the machine's own git configuration (##gitLocal) rather
 * than with the isolated environment the tree work uses.
 */
function commitDelta(options, planned, own, out) {
    const { patchesDir } = options;
    const paths = [...new Set(planned.filter((plan) => plan.action !== 'unchanged').map((plan) => plan.artifact))].sort();
    if (own.copied > 0 || own.removed > 0) {
        paths.push('delta/own');
    }
    if (paths.length === 0) {
        return null;
    }
    const added = runGit({ args: ['add', '--all', '--', ...paths], cwd: patchesDir });
    if (added.status !== 0) {
        throw ckError('INTERNAL', `cannot stage the saved delta in ${patchesDir}: ${added.stderr.trim()}`, 'stage and commit delta/ yourself, or re-run without --commit');
    }
    // The delta can already be what the last commit holds - a change made, undone
    // and made again ends there - and git refuses an empty commit. That is a
    // result, not a failure.
    const staged = runGit({ args: ['diff', '--cached', '--name-only', '--', ...paths], cwd: patchesDir });
    if (staged.status === 0 && staged.stdout.trim() === '') {
        out.info('nothing to commit: the saved delta is already what the last commit of patchset holds');
        return null;
    }
    const count = planned.filter((plan) => plan.action !== 'unchanged').length + own.copied + own.removed;
    const message = options.message ?? `codkit save: ${count} file(s)`;
    const identity = commitIdentity(patchesDir);
    const committed = runGit({
        args: [
            '-c',
            `user.name=${identity.name}`,
            '-c',
            `user.email=${identity.email}`,
            'commit',
            '--quiet',
            '--message',
            message,
            '--',
            ...paths
        ],
        cwd: patchesDir
    });
    if (committed.status !== 0) {
        throw ckError('INTERNAL', `cannot commit the saved delta in ${patchesDir}: ${firstLine(committed.stderr) ?? firstLine(committed.stdout) ?? 'git refused the commit'}`, 'commit delta/ yourself, or re-run without --commit');
    }
    const head = runGit({ args: ['rev-parse', 'HEAD'], cwd: patchesDir });
    const sha = head.status === 0 ? head.stdout.trim() : null;
    out.info(`committed ${paths.length} delta path(s) in patchset${sha === null ? '' : ` at ${sha.slice(0, 8)}`}: ${message}`);
    return sha;
}
function commitIdentity(patchesDir) {
    return {
        name: localConfigValue(patchesDir, 'user.name') ?? FALLBACK_COMMIT_NAME,
        email: localConfigValue(patchesDir, 'user.email') ?? FALLBACK_COMMIT_EMAIL
    };
}
function localConfigValue(patchesDir, key) {
    const result = gitLocal({ args: ['config', '--get', key], cwd: patchesDir });
    if (result.status !== 0) {
        return null;
    }
    const value = result.stdout.trim();
    return value === '' ? null : value;
}
function firstLine(text) {
    const trimmed = text.trim();
    if (trimmed === '') {
        return null;
    }
    const [line] = trimmed.split('\n');
    return line ?? null;
}
// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
function reportOwn(out, own) {
    if (own.copied === 0 && own.removed === 0 && own.kept === 0) {
        return;
    }
    out.info(`own code: ${own.copied} extracted, ${own.removed} removed, ${own.kept} left as patchset has them`);
}
function toReport(plan) {
    return { target: plan.target, artifact: plan.artifact, action: plan.action };
}
function result(status, exitCode, parts) {
    return {
        exitCode,
        status,
        files: parts.files ?? [],
        own: parts.own ?? NO_OWN,
        branch: parts.branch,
        branchTip: parts.branchTip ?? null,
        commit: parts.commit ?? null
    };
}
