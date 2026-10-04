/** @scope spec://codkit/modules/codkit/PROP-009#state */
import { pinKey } from './pinIdentity.js';
import { provisionalBranch } from './cycleControlGit.js';
// Provisional cycle apply: reload, reclassify and preflight the complete delta,
// build deterministic objects, then hand the move to the durable transaction.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyArtifacts } from './classifyEngine.js';
import { loadConventions } from './conventionsFile.js';
import { gitOk, runGit, runGitBytes } from './gitx.js';
import { assertGeneratedTargetOwnership } from './generatedBranch.js';
import { OVERLAYS_DIR, loadOverlays, renderOverlayTarget } from './layers/overlay.js';
import { loadResourceMap, resourceSourcePath } from './layers/resource.js';
import { RULES_DIR, loadRules } from './layers/rule.js';
import { ckError } from './messages.js';
import { syncAllOwnCode } from './ownCopy.js';
import { ownedRootsOf } from './ownedRoots.js';
import { PATCH_FILE_SUFFIX, parseCkpatch } from './patchFormat.js';
import { COMMIT_AUTHOR_EMAIL, COMMIT_AUTHOR_NAME, PATCHES_DIR, overlayVarContext, pinCommitDate, toPosix, patchSetCommitId } from './syncEngine.js';
import { checkTree } from './treeIdentity.js';
import { executeProvisionalMove, prepareProvisionalMove, provisionalMoveSource } from './cycleMaterializeMove.js';
import { workspaceForkReceipt } from './workspaceReceipt.js';
import { assertCycleOwnPreflight } from './cycleMaterializeOwn.js';
/** Materialize the complete target-pin classification onto a private cycle ref. */
export function materializeCycleApply(options) {
    const tree = options.resolution.path;
    const branch = provisionalBranch(options.config, tree);
    const checked = checkTree(options.resolution, options.config, { mode: 'write', type: options.type });
    if (checked.fatal !== null)
        throw checked.fatal;
    const patchSetCommit = patchSetCommitId(options.patchesDir);
    const prepared = prepare(options, patchSetCommit);
    const sourceHead = provisionalMoveSource(options.patchesDir, tree);
    const prospective = buildProspective(options, prepared.stages, patchSetCommit, sourceHead);
    try {
        const moveOptions = {
            patchesDir: options.patchesDir,
            tree,
            branch,
            targetPin: options.config.pin.sha,
            tip: prospective.tip,
            changedPaths: prospective.changedPaths,
            prospectiveGitDir: prospective.gitDir,
            conflicts: prepared.conflicts,
            allowedOwnPaths: [...prepared.allowedOwnPaths, ...workspaceForkReceipt(tree, options.config.workspace?.record)],
            ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint })
        };
        const preflight = prepareProvisionalMove(moveOptions);
        importProspectiveObjects(tree, prospective.gitDir);
        const move = executeProvisionalMove(moveOptions, preflight);
        const own = syncAllOwnCode(options.patchesDir, tree, ownedRootsOf(options.type, options.config.typeConfig, { treeDir: options.resolution.path, pinSha: options.config.pin.sha }));
        for (const blocker of prepared.blockers) {
            options.out.info(`cycle blocker ${blocker.outcome}: ${blocker.artifactPath} -> ${blocker.targetPath}`);
        }
        options.out.info(`provisional cycle tip ${prospective.tip.slice(0, 8)} on ${branch}; ${prepared.blockers.length} blocker(s)`);
        return { branch, provisionalTip: prospective.tip, changedPaths: move.changedPaths, blockers: prepared.blockers, own };
    }
    finally {
        rmSync(prospective.root, { recursive: true, force: true });
    }
}
function prepare(options, patchSetCommit) {
    assertSourcePin(options);
    const loaded = loadCurrent(options);
    const supplied = classificationMap(options.classifications);
    const rebound = bindRenameTargets(loaded.artifacts, supplied, options.renames ?? []);
    const recomputed = classifyArtifacts({
        type: options.type,
        treeDir: options.resolution.path,
        artifacts: rebound,
        oldPin: loaded.oldPin,
        newRef: options.config.pin.sha
    });
    assertClassificationsEqual(recomputed, supplied);
    const roots = ownedRootsOf(options.type, options.config.typeConfig, { treeDir: options.resolution.path, pinSha: options.config.pin.sha });
    const ownEvidence = assertGeneratedTargetOwnership(options.patchesDir, options.type, roots, generatedLayerTargets(recomputed, loaded.resources));
    assertCycleOwnPreflight(options.patchesDir, options.resolution.path, roots, ownEvidence.ownTargets, options.ownRenameAuthority);
    const stages = [];
    const conflicts = [];
    const blockers = [];
    const addPatches = new Set(loaded.artifacts.flatMap((artifact) => (artifact.kind === 'patch' && artifact.patch.isAddFile ? [artifact.artifactPath] : [])));
    for (const item of recomputed) {
        if (item.kind === 'patch')
            preparePatch(options, item, addPatches.has(item.artifactPath), stages, conflicts, blockers);
        else
            strictBlob(options.resolution.path, options.config.pin.sha, item.targetPath, item.outcome === 'target-deleted');
    }
    prepareOverlays(options, loaded.overlays, recomputed, stages, blockers, patchSetCommit);
    for (const item of recomputed) {
        if (item.kind === 'rule' && item.outcome !== 'clean')
            blockers.push(blocker(item));
    }
    for (const resource of loaded.resources)
        stages.push(resourceStage(options, resource));
    return {
        stages,
        conflicts,
        blockers: sortBlockers(blockers),
        allowedOwnPaths: ownEvidence.ownTargets
    };
}
function loadCurrent(options) {
    const conventions = loadConventions(options.type, options.patchesDir);
    strictLayerDirectory(options.patchesDir, RULES_DIR);
    strictLayerDirectory(options.patchesDir, OVERLAYS_DIR);
    const patches = patchNames(options.patchesDir).map((name) => {
        const artifactPath = `${PATCHES_DIR}/${name}`;
        return {
            artifactPath,
            patch: parseCkpatch(readFileSync(join(options.patchesDir, ...artifactPath.split('/'))), conventions, artifactPath)
        };
    });
    const rules = loadRules(options.patchesDir);
    const overlays = loadOverlays(options.patchesDir, options.type);
    const resources = loadResourceMap(options.patchesDir)?.entries ?? [];
    const expectedPin = `${pinKey(options.sourcePin)}@${options.sourcePin.sha}`;
    for (const [artifact, pin] of [
        ...patches.map((entry) => [entry.artifactPath, entry.patch.header.pin]),
        ...rules.map((rule) => [rule.artifactPath, rule.pin]),
        ...overlays.map((overlay) => [overlay.artifactPath, overlay.pin]),
        ...resources.map((resource) => [resource.source, resource.pin])
    ]) {
        if (pin !== expectedPin)
            throw broken(`${artifact}: pin ${pin} does not match cycle source ${expectedPin}`);
    }
    const oldPin = options.sourcePin.sha;
    for (const entry of patches) {
        const baseTarget = options.renames?.find((rename) => rename.to === entry.patch.targetPath)?.from ?? entry.patch.targetPath;
        if (!entry.patch.isAddFile)
            strictBlob(options.resolution.path, oldPin, baseTarget, false);
    }
    const artifacts = [
        ...patches.map((entry) => {
            const rename = options.renames?.find((candidate) => candidate.to === entry.patch.targetPath);
            return rename === undefined
                ? { kind: 'patch', ...entry }
                : { kind: 'patch', ...entry, baseTargetPath: rename.from, newTargetPath: rename.to };
        }),
        ...rules.map((rule) => ({ kind: 'rule', rule })),
        ...overlays.map((overlay) => ({ kind: 'overlay', overlay }))
    ];
    return { oldPin, artifacts, overlays, resources };
}
function classificationMap(classifications) {
    const map = new Map();
    for (const item of classifications) {
        if (map.has(item.artifactPath))
            throw broken(`duplicate classification ${item.artifactPath}`);
        map.set(item.artifactPath, item);
    }
    return map;
}
function bindRenameTargets(artifacts, supplied, renames) {
    const expected = new Set(artifacts.map(artifactPath));
    const missing = [...expected].filter((path) => !supplied.has(path));
    const extra = [...supplied.keys()].filter((path) => !expected.has(path));
    if (missing.length > 0 || extra.length > 0) {
        throw broken(`classification is incomplete (missing: ${byteSorted(missing).join(', ') || 'none'}; extra: ${byteSorted(extra).join(', ') || 'none'})`);
    }
    return artifacts.map((artifact) => {
        if (artifact.kind !== 'patch')
            return artifact;
        const item = supplied.get(artifact.artifactPath);
        if (item?.kind !== 'patch')
            throw broken(`${artifact.artifactPath}: classification kind changed`);
        const renamed = renames.find((rename) => rename.to === artifact.patch.targetPath);
        if (renamed !== undefined)
            return { ...artifact, baseTargetPath: renamed.from, newTargetPath: renamed.to };
        return item.targetPath === artifact.patch.targetPath ? artifact : { ...artifact, newTargetPath: item.targetPath };
    });
}
function assertClassificationsEqual(recomputed, supplied) {
    for (const item of recomputed) {
        const previous = supplied.get(item.artifactPath);
        if (previous === undefined || comparable(previous) !== comparable(item)) {
            throw broken(`${item.artifactPath}: supplied classification is stale or tampered`);
        }
    }
}
function comparable(item) {
    return JSON.stringify(item, (_key, value) => value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('base64') } : value);
}
function preparePatch(options, item, isAddFile, stages, conflicts, blockers) {
    const atPin = strictBlob(options.resolution.path, options.config.pin.sha, item.targetPath, item.outcome === 'target-deleted' || isAddFile);
    if (item.outcome === 'target-deleted') {
        if (atPin !== null)
            throw broken(`${item.artifactPath}: deleted target unexpectedly exists`);
        blockers.push(blocker(item));
        return;
    }
    const mode = atPin?.mode ?? '100644';
    const bytes = item.outcome === 'conflict' ? item.materials.ours : item.bytes;
    stages.push({ kind: 'patch', artifactIds: [item.artifactId], targetPath: item.targetPath, bytes, outcome: item.outcome, mode });
    if (item.outcome === 'conflict') {
        conflicts.push({ path: item.targetPath, bytes: item.bytes });
        blockers.push(blocker(item));
    }
}
function prepareOverlays(options, overlays, classifications, stages, blockers, patchSetCommit) {
    const classified = new Map(classifications.filter((item) => item.kind === 'overlay').map((item) => [item.artifactPath, item]));
    const byTarget = new Map();
    for (const overlay of overlays) {
        const item = classified.get(overlay.artifactPath);
        if (item === undefined)
            throw broken(`${overlay.artifactPath}: missing rebound overlay`);
        if (item.outcome !== 'clean')
            blockers.push(blocker(item));
        const group = byTarget.get(overlay.target);
        if (group === undefined)
            byTarget.set(overlay.target, [overlay]);
        else
            group.push(overlay);
    }
    const context = overlayVarContext(options.config, pinCommitDate(options.resolution.path, options.config.pin.sha), patchSetCommit);
    for (const target of byteSorted([...byTarget.keys()])) {
        const group = byTarget.get(target) ?? [];
        if (group.some((overlay) => classified.get(overlay.artifactPath)?.outcome !== 'clean'))
            continue;
        const pin = strictBlob(options.resolution.path, options.config.pin.sha, target, false);
        if (pin === null)
            throw broken(`${target}: clean overlay target is absent`);
        const rendered = renderOverlayTarget(group, options.resolution.path, options.config.pin.sha, context);
        stages.push({
            kind: 'overlay',
            artifactIds: group.map((overlay) => overlay.id),
            targetPath: target,
            bytes: rendered.bytes,
            outcome: 'clean',
            mode: pin.mode
        });
    }
}
function resourceStage(options, entry) {
    const pin = strictBlob(options.resolution.path, options.config.pin.sha, entry.target, false);
    if (pin === null)
        throw broken(`${entry.id}: resource target ${entry.target} is absent at target pin`);
    return {
        kind: 'resource',
        artifactIds: [entry.id],
        targetPath: entry.target,
        bytes: readFileSync(resourceSourcePath(options.patchesDir, entry)),
        outcome: 'clean',
        mode: pin.mode
    };
}
function assertSourcePin(options) {
    const resolved = runGit({ args: ['rev-parse', '--verify', `${options.sourcePin.sha}^{commit}`], cwd: options.resolution.path });
    if (resolved.status !== 0 || resolved.stdout.trim() !== options.sourcePin.sha) {
        throw ckError('PIN-UNREACHABLE', `cycle source pin ${options.sourcePin.sha} is not an exact commit`);
    }
    const date = runGit({ args: ['show', '-s', '--format=%cs', options.sourcePin.sha], cwd: options.resolution.path });
    if (date.status !== 0 || date.stdout.trim() !== options.sourcePin.date) {
        throw broken(`cycle source pin date does not match ${options.sourcePin.date}`);
    }
}
function generatedLayerTargets(classifications, resources) {
    const targets = classifications.flatMap((item) => item.kind === 'patch' ? [{ layer: 'patch', target: item.targetPath, artifactPaths: [item.artifactPath], ids: [item.artifactId] }] : []);
    const overlays = new Map();
    for (const item of classifications) {
        if (item.kind !== 'overlay')
            continue;
        const group = overlays.get(item.targetPath);
        if (group === undefined)
            overlays.set(item.targetPath, { artifactPaths: [item.artifactPath], ids: [item.artifactId] });
        else {
            group.artifactPaths.push(item.artifactPath);
            group.ids.push(item.artifactId);
        }
    }
    for (const target of byteSorted([...overlays.keys()])) {
        const group = overlays.get(target);
        if (group === undefined)
            throw broken(`missing generated overlay ownership group for ${target}`);
        targets.push({ layer: 'overlay', target, artifactPaths: group.artifactPaths, ids: group.ids });
    }
    for (const resource of resources) {
        targets.push({ layer: 'resource', target: resource.target, artifactPaths: [resource.source], ids: [resource.id] });
    }
    return targets;
}
function buildProspective(options, stages, patchSetCommit, sourceHead) {
    const tree = options.resolution.path;
    const root = mkdtempSync(join(tmpdir(), 'codkit-cycle-apply-'));
    const gitDir = join(root, 'objects.git');
    gitOk({ args: ['init', '--quiet', '--bare', gitDir], cwd: root }, { code: 'ARTIFACT-BROKEN', message: 'cannot create prospective object store' });
    const alternates = join(gitDir, 'objects/info/alternates');
    mkdirSync(dirname(alternates), { recursive: true });
    writeFileSync(alternates, `${realObjectDirectory(tree)}\n`, 'utf8');
    const indexFile = join(root, 'index');
    const blobFile = join(root, 'blob');
    const indexEnv = { GIT_DIR: gitDir, GIT_INDEX_FILE: indexFile };
    const date = pinCommitDate(tree, options.config.pin.sha);
    const commitEnv = {
        ...indexEnv,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
        GIT_AUTHOR_NAME: COMMIT_AUTHOR_NAME,
        GIT_COMMITTER_NAME: COMMIT_AUTHOR_NAME,
        GIT_AUTHOR_EMAIL: COMMIT_AUTHOR_EMAIL,
        GIT_COMMITTER_EMAIL: COMMIT_AUTHOR_EMAIL
    };
    mustGit(tree, ['read-tree', options.config.pin.sha], indexEnv, 'read target pin');
    let parent = options.config.pin.sha;
    for (const stage of stages) {
        writeFileSync(blobFile, stage.bytes);
        const blob = mustGit(tree, ['hash-object', '-w', '--no-filters', '--', blobFile], indexEnv, `store ${stage.targetPath}`);
        mustGit(tree, ['update-index', '--add', '--cacheinfo', `${stage.mode},${blob},${toPosix(stage.targetPath)}`], indexEnv, `stage ${stage.targetPath}`);
        const treeSha = mustGit(tree, ['write-tree'], indexEnv, `write ${stage.targetPath}`);
        parent = mustGit(tree, ['commit-tree', treeSha, '-p', parent, '-m', stageMessage(stage, options, patchSetCommit)], commitEnv, `commit ${stage.targetPath}`);
        if (options.verbose === true)
            options.out.diag(`  ${stage.kind} ${stage.targetPath} -> ${parent.slice(0, 8)}`);
    }
    const changedPaths = mustGit(tree, ['diff', '--name-only', '--no-renames', '-z', sourceHead, parent], { GIT_DIR: gitDir }, 'compute prospective paths')
        .split('\0')
        .filter((path) => path !== '');
    return { root, gitDir, tip: parent, changedPaths: byteSorted(changedPaths) };
}
function realObjectDirectory(tree) {
    const common = gitOk({ args: ['rev-parse', '--git-common-dir'], cwd: tree }, { code: 'ARTIFACT-BROKEN', message: 'cannot locate the fork object directory' }).stdout.trim();
    return join(isAbsolute(common) ? common : resolve(tree, common), 'objects');
}
function importProspectiveObjects(tree, prospectiveGitDir) {
    const sourceObjects = join(prospectiveGitDir, 'objects');
    const targetObjects = realObjectDirectory(tree);
    for (const prefix of readdirSync(sourceObjects, { withFileTypes: true })) {
        if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name))
            continue;
        for (const object of readdirSync(join(sourceObjects, prefix.name), { withFileTypes: true })) {
            if (!object.isFile() || !/^[0-9a-f]{38}$/.test(object.name))
                continue;
            const source = join(sourceObjects, prefix.name, object.name);
            const directory = join(targetObjects, prefix.name);
            const target = join(directory, object.name);
            let existing = null;
            try {
                existing = readFileSync(target);
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
            const bytes = readFileSync(source);
            if (existing !== null) {
                if (!Buffer.from(existing).equals(Buffer.from(bytes)))
                    throw broken(`object collision while importing ${prefix.name}${object.name}`);
                continue;
            }
            mkdirSync(directory, { recursive: true });
            const temporary = `${target}.${randomUUID()}.tmp`;
            try {
                writeFileSync(temporary, bytes, { flag: 'wx' });
                renameSync(temporary, target);
            }
            finally {
                rmSync(temporary, { force: true });
            }
        }
    }
}
function strictBlob(tree, ref, path, allowAbsent) {
    const listed = runGit({ args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', path], cwd: tree });
    if (listed.status !== 0 || (listed.stdout !== '' && !listed.stdout.endsWith('\0')))
        throw broken(`cannot inspect ${path} at ${ref}`);
    if (listed.stdout === '') {
        if (!allowAbsent)
            throw broken(`${path} is absent at ${ref}`);
        return null;
    }
    const records = listed.stdout.split('\0').filter(Boolean);
    if (records.length !== 1)
        throw broken(`ls-tree returned ${records.length} entries for ${path}`);
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(records[0] ?? '');
    if (match === null || match[3] !== path)
        throw broken(`${path} is not one regular 100644/100755 blob at ${ref}`);
    const object = match[2] ?? '';
    const blob = runGitBytes({ args: ['cat-file', 'blob', object], cwd: tree });
    if (blob.status !== 0)
        throw broken(`cannot read blob ${object} for ${path} at ${ref}`);
    return { mode: (match[1] ?? '100644'), bytes: blob.stdout };
}
function mustGit(tree, args, env, action) {
    return gitOk({ args, cwd: tree, env }, { code: 'ARTIFACT-BROKEN', message: `cannot ${action} while building provisional tip`, hint: 'repair the fork repository and retry' }).stdout.trim();
}
function stageMessage(stage, options, patchSetCommit) {
    return [
        `codkit cycle: ${stage.artifactIds[0] ?? stage.targetPath} ${stage.targetPath}`,
        '',
        ...stage.artifactIds.map((id) => `Codkit-Artifact: ${id}`),
        `Codkit-Cycle-Outcome: ${stage.outcome}`,
        `Codkit-Patchset-Commit: ${patchSetCommit}`,
        `Codkit-Upstream-Pin: ${pinKey(options.config.pin)}@${options.config.pin.sha}`
    ].join('\n');
}
function patchNames(patchesDir) {
    const directory = join(patchesDir, ...PATCHES_DIR.split('/'));
    try {
        const stat = lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw broken(`${PATCHES_DIR} is not a real directory`);
        return readdirSync(directory)
            .filter((name) => name.endsWith(PATCH_FILE_SUFFIX))
            .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return [];
        throw broken(`cannot read ${PATCHES_DIR}: ${messageOf(error)}`);
    }
}
function strictLayerDirectory(patchesDir, relative) {
    const directory = join(patchesDir, ...relative.split('/'));
    try {
        const stat = lstatSync(directory);
        if (stat.isSymbolicLink() || !stat.isDirectory())
            throw broken(`${relative} is not a real directory`);
        readdirSync(directory);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return;
        if (error instanceof Error && error.name === 'CkError')
            throw error;
        throw broken(`cannot read ${relative}: ${messageOf(error)}`);
    }
}
function artifactPath(artifact) {
    return artifact.kind === 'patch'
        ? artifact.artifactPath
        : artifact.kind === 'rule'
            ? artifact.rule.artifactPath
            : artifact.overlay.artifactPath;
}
function blocker(item) {
    if (item.outcome !== 'conflict' && item.outcome !== 'target-deleted' && item.outcome !== 'rule-broken')
        throw broken('non-blocker classified as blocker');
    return { artifactPath: item.artifactPath, artifactId: item.artifactId, targetPath: item.targetPath, outcome: item.outcome };
}
function sortBlockers(blockers) {
    return [...blockers].sort((left, right) => Buffer.from(left.artifactPath).compare(Buffer.from(right.artifactPath)));
}
function byteSorted(paths) {
    return [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}
function broken(message) {
    return ckError('ARTIFACT-BROKEN', message, 're-run complete classification against the current artifacts and configured target pin');
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
