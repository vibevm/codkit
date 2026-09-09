/** @scope spec://codkit/modules/codkit/PROP-008#root */
// The generated-branch-only own-code atom. A local load deliberately keeps own
// code outside Git; CI and publish need the complete reproducible tree instead.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { gitOk, runGit } from './gitx.js';
import { OWN_EXTENSIONS_DIR, ownExtensionFiles } from './layers/ownExtensions.js';
import { OWN_MANIFEST_PATH, loadOwnManifest } from './layers/ownManifest.js';
import { ckError } from './messages.js';
import { isDeliveredOwnFile, isReleasedOwnFile, listOwnFiles, ownSourceRoot } from './ownCopy.js';
export const GENERATED_HISTORY_FINGERPRINT_VERSION = 1;
/**
 * Which own files the generated snapshot carries. A release branch leaves the
 * codkit licence notice out; every other generated branch carries it
 * (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
 */
function ownPredicate(omitLicenceNotice) {
    return omitLicenceNotice ? isReleasedOwnFile : isDeliveredOwnFile;
}
/** Fail before object/ref/worktree mutation when two generated layers claim one target. */
export function assertGeneratedTargetOwnership(patchesDir, ownRoot, layerTargets, omitLicenceNotice = false) {
    const ownTargets = listOwnFiles(ownSourceRoot(patchesDir), { refuseSymlinks: true })
        .filter(ownPredicate(omitLicenceNotice))
        .map((relative) => `${ownRoot}/${relative}`);
    const claims = new Map(ownTargets.map((target) => [target, { layer: 'own', artifact: `delta/own/${target.slice(ownRoot.length + 1)}` }]));
    const ids = new Map();
    const manifest = loadOwnManifest(patchesDir);
    const extensionFiles = ownExtensionFiles(patchesDir, manifest.extensions);
    for (const file of extensionFiles) {
        claims.set(file.target, { layer: 'own-extension', artifact: `${OWN_EXTENSIONS_DIR}/${file.relative}` });
    }
    for (const entry of [
        ...manifest.units.map((unit) => ({ id: unit.id, label: `${OWN_MANIFEST_PATH} unit ${unit.id}` })),
        ...manifest.serviceOverrides.map((override) => ({ id: override.id, label: `${OWN_MANIFEST_PATH} serviceOverride ${override.id}` })),
        ...manifest.extensions.map((extension) => ({ id: extension.id, label: `${OWN_MANIFEST_PATH} extension ${extension.id}` }))
    ]) {
        const previous = ids.get(entry.id);
        if (previous !== undefined) {
            throw ckError('ARTIFACT-BROKEN', `generated artifact id ${entry.id} is claimed by both ${previous} and ${entry.label}`, 'every generated artifact id must identify exactly one source', OWN_MANIFEST_PATH);
        }
        ids.set(entry.id, entry.label);
    }
    for (const artifact of layerTargets) {
        const label = artifact.artifactPaths.join(', ');
        for (const id of artifact.ids) {
            const previous = ids.get(id);
            if (previous !== undefined) {
                throw ckError('ARTIFACT-BROKEN', `generated artifact id ${id} is claimed by both ${previous} and ${label}`, 'every generated artifact id must identify exactly one source', artifact.artifactPaths[0]);
            }
            ids.set(id, label);
        }
        const previous = claims.get(artifact.target);
        if (previous !== undefined) {
            throw ckError('ARTIFACT-BROKEN', `${artifact.target} is claimed by both the ${previous.layer} layer (${previous.artifact}) and ${artifact.layer} layer (${label})`, 'one generated target must have exactly one source group; remove the overlapping artifact or own file', artifact.artifactPaths[0]);
        }
        claims.set(artifact.target, { layer: artifact.layer, artifact: label });
    }
    return { ownTargets, extensionTargets: extensionFiles.map((file) => file.target) };
}
/** Keep full and local branch/cache variants distinct without changing schemas. */
export function generatedHistoryFingerprint(deltaFingerprint, patchesDir, omitLicenceNotice = false) {
    const sourceRoot = ownSourceRoot(patchesDir);
    const files = listOwnFiles(sourceRoot, { refuseSymlinks: true }).filter(ownPredicate(omitLicenceNotice));
    const hash = createHash('sha256')
        .update(`codkit-generated-history\0${GENERATED_HISTORY_FINGERPRINT_VERSION}\0`, 'utf8')
        .update(deltaFingerprint, 'utf8');
    // The release snapshot and the ci snapshot must never share a fingerprint:
    // they hold different bytes (PROP-014 ##STD-NOTICE-RELEASE-EXCLUSION).
    if (omitLicenceNotice)
        hash.update('\0omit-licence-notice\0', 'utf8');
    for (const relative of files)
        hash.update(`\0${relative}\0${ownFileMode(patchesDir, relative)}`, 'utf8');
    // ##OWN-EXTENSION-UNIT: the extensions are part of the snapshot, so a change
    // to one of them has to change the fingerprint the fast path compares.
    for (const file of extensionSnapshot(patchesDir))
        hash.update(`\0${OWN_EXTENSIONS_DIR}/${file.relative}\0${fileMode(patchesDir, `${OWN_EXTENSIONS_DIR}/${file.relative}`)}`, 'utf8');
    return hash.digest('hex');
}
/**
 * Replace the complete non-empty own subtree in a temporary index and append
 * exactly one deterministic commit. Like every other empty layer, an empty own
 * layer is skipped. The caller has already appended all patch commits and will
 * append overlay/resource commits afterwards.
 */
export function appendGeneratedOwnCommit(options) {
    const indexEnv = { GIT_INDEX_FILE: options.indexFile };
    const targetRoot = options.ownRoot;
    const sourceRoot = ownSourceRoot(options.patchesDir);
    const files = listOwnFiles(sourceRoot, { refuseSymlinks: true }).filter(ownPredicate(options.omitLicenceNotice ?? false));
    // ##OWN-EXTENSION-UNIT: the own extensions ride in the same atom. `ci` and
    // `publish` need the complete reproducible tree, and an extension the branch
    // does not carry is an extension the build does not see.
    const extensions = extensionSnapshot(options.patchesDir);
    // An own snapshot that is only the licence notice is empty for a release, and
    // an empty layer is skipped exactly like any other.
    if (files.length === 0 && extensions.length === 0)
        return { sha: null, files };
    removeIndexedOwnTree(options.treeDir, targetRoot, indexEnv);
    for (const relative of files) {
        stageGeneratedFile(options, indexEnv, join(sourceRoot, ...relative.split('/')), `${targetRoot}/${relative}`, `delta/own/${relative}`);
    }
    for (const file of extensions) {
        stageGeneratedFile(options, indexEnv, file.source, file.target, `${OWN_EXTENSIONS_DIR}/${file.relative}`);
    }
    const tree = gitOk({ args: ['write-tree'], cwd: options.treeDir, env: indexEnv }, { code: 'ARTIFACT-BROKEN', message: 'cannot write the generated own-code tree' }).stdout.trim();
    const commitEnv = {
        ...indexEnv,
        GIT_AUTHOR_DATE: options.pinDateIso,
        GIT_COMMITTER_DATE: options.pinDateIso,
        GIT_AUTHOR_NAME: options.authorName,
        GIT_COMMITTER_NAME: options.authorName,
        GIT_AUTHOR_EMAIL: options.authorEmail,
        GIT_COMMITTER_EMAIL: options.authorEmail
    };
    const sha = gitOk({
        args: ['commit-tree', tree, '-p', options.parent, '-m', ownCommitMessage(targetRoot, options)],
        cwd: options.treeDir,
        env: commitEnv
    }, { code: 'ARTIFACT-BROKEN', message: 'cannot create the aggregate generated own-code commit' }).stdout.trim();
    return { sha, files: [...files, ...extensions.map((file) => file.target)] };
}
/** One blob of the generated own atom: hashed into the tree, then indexed. */
function stageGeneratedFile(options, indexEnv, source, target, deltaPath) {
    const blob = gitOk({ args: ['hash-object', '-w', '--no-filters', '--', source], cwd: options.treeDir, env: indexEnv }, {
        code: 'ARTIFACT-BROKEN',
        message: `cannot store own-code file ${deltaPath} in ${options.treeDir}`,
        hint: 'check that the fork tree object database is writable'
    }).stdout.trim();
    const mode = fileMode(options.patchesDir, deltaPath, options.modeSource);
    gitOk({ args: ['update-index', '--add', '--cacheinfo', `${mode},${blob},${target}`], cwd: options.treeDir, env: indexEnv }, {
        code: 'ARTIFACT-BROKEN',
        message: `cannot stage generated own-code file ${target}`,
        hint: 're-run with a healthy writable fork tree'
    });
}
/** The own-extension files of the delta, or none when the manifest is unusable. */
function extensionSnapshot(patchesDir) {
    return ownExtensionFiles(patchesDir, loadOwnManifest(patchesDir).extensions);
}
function removeIndexedOwnTree(treeDir, targetRoot, indexEnv) {
    const listed = gitOk({ args: ['ls-files', '-z', '--', `${targetRoot}/`], cwd: treeDir, env: indexEnv }, { code: 'ARTIFACT-BROKEN', message: `cannot inspect the generated own-code subtree ${targetRoot}` }).stdout;
    for (const path of listed.split('\0')) {
        if (path === '')
            continue;
        gitOk({ args: ['update-index', '--force-remove', '--', path], cwd: treeDir, env: indexEnv }, { code: 'ARTIFACT-BROKEN', message: `cannot remove stale generated own-code path ${path}` });
    }
}
function ownFileMode(patchesDir, relative, modeSource) {
    return fileMode(patchesDir, `delta/own/${relative}`, modeSource);
}
/** The mode git records for one delta file; anything unreadable is a plain file. */
function fileMode(patchesDir, sourcePath, modeSource) {
    const listed = modeSource === undefined
        ? runGit({ args: ['ls-files', '--stage', '--', sourcePath], cwd: patchesDir })
        : runGit({ args: ['ls-tree', modeSource.ref, '--', sourcePath], cwd: modeSource.repositoryRoot });
    if (listed.status !== 0)
        return '100644';
    const match = /^(100644|100755)\s/.exec(listed.stdout);
    return match?.[1] === '100755' ? '100755' : '100644';
}
function ownCommitMessage(targetRoot, options) {
    return [
        `codkit: own code ${targetRoot}`,
        '',
        `Codkit-Patchset-Commit: ${options.patchSetCommit}`,
        `Codkit-Upstream-Pin: ${options.pinTag}@${options.pinSha}`
    ].join('\n');
}
