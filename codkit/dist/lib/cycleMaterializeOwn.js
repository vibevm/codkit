/** @scope spec://codkit/modules/codkit/PROP-009#state */
// Strict, lossless own-code preflight for cycle materialization.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { CYCLE_STATE_PATH } from './cycleState.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
import { fileContentEqual, isDeliveredOwnFile, listOwnFiles, OWN_SOURCE_DIR, ownSourceRoot, ownTargetRelativeDir, ownTargetRoot } from './ownCopy.js';
import { repoRelativePathProblem, resolveContainedPath } from './pathSafety.js';
import { createRebaseCheckoutContext, rebaseTreeEntry, releaseRebaseCheckoutContext } from './rebaseOntoPinCheckout.js';
/**
 * Accept only the two exact local own endpoints authorized by the canonical
 * rename atom: the old materialized bytes or the new committed bytes. This is
 * what makes an interrupted delivery resumable without turning a rename into
 * permission to overwrite arbitrary ignored files.
 */
export function assertCycleOwnPreflight(patchesDir, tree, ownDirName, generatedOwnTargets, renameAuthority) {
    const source = ownSourceRoot(patchesDir);
    const target = ownTargetRoot(tree, ownDirName);
    strictOwnRoot(source, 'own source', true);
    strictOwnRoot(target, 'materialized own target', true);
    const relatives = ownRelatives(generatedOwnTargets, ownDirName);
    const accepted = acceptedOwnTransitions(patchesDir, relatives, renameAuthority);
    const sourceSet = new Set(relatives);
    const targetFiles = listOwnFiles(target, { refuseSymlinks: true }).filter(isDeliveredOwnFile);
    const targetSet = new Set(targetFiles);
    const dangerous = [];
    for (const relative of targetFiles) {
        if (!sourceSet.has(relative))
            dangerous.push(`tree-only ${relative}`);
    }
    for (const relative of relatives) {
        const sourcePath = contained(source, relative, false);
        const targetPath = contained(tree, `${ownTargetRelativeDir(ownDirName)}/${relative}`, true);
        if (!targetSet.has(relative) || fileContentEqual(sourcePath, targetPath))
            continue;
        const transition = accepted.get(relative);
        if (transition !== undefined &&
            sha256(readFileSync(sourcePath)) === transition.afterSha256 &&
            sha256(readFileSync(targetPath)) === transition.beforeSha256)
            continue;
        dangerous.push(`both ${relative}`);
    }
    if (dangerous.length > 0) {
        throw ckError('DIRTY-TREE', `own code carries unextracted work: ${dangerous.join(', ')}`, 'save or reconcile own code before continuing the cycle');
    }
}
function acceptedOwnTransitions(patchesDir, relatives, authority) {
    if (authority === undefined)
        return new Map();
    if (!orderedUnique(authority.paths))
        throw broken('rename authority paths are not byte-sorted and unique');
    if (authority.paths.length === 0) {
        if (authority.commit !== null)
            throw broken('rename authority has a commit without changed paths');
        return new Map();
    }
    if (authority.commit === null)
        throw broken('rename authority has changed paths without a committed endpoint');
    for (const path of authority.paths) {
        const problem = repoRelativePathProblem(path);
        if (problem !== null)
            throw broken(`unsafe rename authority path ${path}: ${problem}`);
    }
    assertCanonicalRenameCommit(patchesDir, authority);
    const expectedRelatives = new Set(relatives);
    const transitions = new Map();
    const ownPaths = authority.paths.filter((candidate) => candidate.startsWith(`${OWN_SOURCE_DIR}/`));
    if (ownPaths.length === 0)
        return transitions;
    const checkout = createRebaseCheckoutContext(patchesDir, patchesDir);
    try {
        for (const path of ownPaths) {
            const relative = path.slice(OWN_SOURCE_DIR.length + 1);
            if (!isDeliveredOwnFile(relative) || !expectedRelatives.has(relative)) {
                throw broken(`rename authority names non-delivered own path ${path}`);
            }
            const before = rebaseTreeEntry(checkout, authority.parent, path);
            const after = rebaseTreeEntry(checkout, authority.commit, path);
            if (before === null ||
                after === null ||
                before.object.mode === '120000' ||
                after.object.mode !== before.object.mode ||
                before.digest.sha256 === after.digest.sha256) {
                throw broken(`rename authority has no exact changed regular-file endpoints for ${path}`);
            }
            const sourcePath = contained(ownSourceRoot(patchesDir), relative, false);
            if (sha256(readFileSync(sourcePath)) !== after.digest.sha256) {
                throw broken(`current own source differs from rename endpoint ${path}`);
            }
            transitions.set(relative, { beforeSha256: before.digest.sha256, afterSha256: after.digest.sha256 });
        }
    }
    finally {
        releaseRebaseCheckoutContext(checkout);
    }
    return transitions;
}
function assertCanonicalRenameCommit(patchesDir, authority) {
    const commit = authority.commit;
    if (commit === null)
        throw broken('rename commit is absent');
    const parents = runGit({ args: ['rev-list', '--parents', '-n', '1', commit], cwd: patchesDir });
    const fields = parents.stdout.trim().split(' ');
    if (parents.status !== 0 || fields.length !== 2 || fields[0] !== commit || fields[1] !== authority.parent) {
        throw broken('rename commit is not the exact single-parent child of its recorded parent');
    }
    if (runGit({ args: ['merge-base', '--is-ancestor', commit, 'HEAD'], cwd: patchesDir }).status !== 0) {
        throw broken('rename commit is not an ancestor of the current cycle checkout');
    }
    const changed = runGit({ args: ['diff', '--name-only', '--no-renames', '-z', authority.parent, commit], cwd: patchesDir });
    if (changed.status !== 0 || (changed.stdout !== '' && !changed.stdout.endsWith('\0'))) {
        throw broken('rename commit paths cannot be read exactly');
    }
    const actual = byteSorted(changed.stdout.split('\0').filter((path) => path !== ''));
    const expected = byteSorted([...authority.paths, CYCLE_STATE_PATH]);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw broken('rename commit changed paths differ from its canonical plan and cycle state');
    }
}
function ownRelatives(targets, ownDirName) {
    const prefix = `${ownTargetRelativeDir(ownDirName)}/`;
    const relatives = targets.map((target) => {
        if (!target.startsWith(prefix))
            throw broken(`generated own evidence contains foreign target ${target}`);
        const relative = target.slice(prefix.length);
        if (!isDeliveredOwnFile(relative) || repoRelativePathProblem(relative) !== null) {
            throw broken(`generated own evidence contains unsafe target ${target}`);
        }
        return relative;
    });
    if (!orderedUnique(relatives))
        throw broken('generated own evidence is not byte-sorted and unique');
    return relatives;
}
function strictOwnRoot(root, label, rootMayBeAbsent) {
    let stat;
    try {
        stat = lstatSync(root);
    }
    catch (error) {
        if (rootMayBeAbsent && error.code === 'ENOENT')
            return;
        throw broken(`${label} cannot be inspected: ${messageOf(error)}`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory())
        throw broken(`${label} is not a real directory`);
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    }
    catch (error) {
        throw broken(`${label} cannot be enumerated: ${messageOf(error)}`);
    }
    for (const entry of entries) {
        const child = join(root, entry.name);
        if (entry.isSymbolicLink())
            throw broken(`${label} contains symlink ${entry.name}`);
        if (entry.isDirectory())
            strictOwnRoot(child, `${label}/${entry.name}`, false);
        else if (!entry.isFile())
            throw broken(`${label} contains non-file ${entry.name}`);
    }
}
function contained(root, relative, allowMissing) {
    const resolved = resolveContainedPath(root, relative, allowMissing ? { allowMissing: true } : {});
    if (!resolved.ok)
        throw broken(`unsafe own path ${relative}: ${resolved.reason}`);
    return resolved.absolute;
}
function orderedUnique(paths) {
    return paths.every((path, index) => index === 0 || compare(paths[index - 1] ?? '', path) < 0);
}
function byteSorted(paths) {
    return [...new Set(paths)].sort(compare);
}
function compare(left, right) {
    return Buffer.from(left).compare(Buffer.from(right));
}
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function broken(message) {
    return ckError('ARTIFACT-BROKEN', message, 'restore exact canonical rename and own-code endpoints, then retry');
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
