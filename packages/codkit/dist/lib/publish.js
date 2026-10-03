/** @scope spec://codkit/modules/codkit/PROP-011#root */
import { pinKey } from './pinIdentity.js';
// Immutable publish transaction: observe remote, build/check one patchset commit,
// reject tag collisions, create the tag without force, then lease the branch.
import { join } from 'node:path';
import { runCi } from './ciEngine.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './command.js';
import { CONFIG_FILE_NAME, loadLocalConfig, mergeLocal, parseBaseConfig } from './configFile.js';
import { treeId } from './fingerprint.js';
import { runGit } from './gitx.js';
import { releasedInputs } from './inputsTree.js';
import { resolvePatchSetRef } from './inventory.js';
import { acquireLock } from './lock.js';
import { ckError } from './messages.js';
import { assertExportTarget, writeExport } from './publishExport.js';
import { orphanRefusal, shapeTip } from './publishTip.js';
import { materializeWorkspace } from './publishWorkspace.js';
const ZERO_SHA = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
/** An export observes no remote. */
const UNOBSERVED = { branch: null, tag: null };
export async function runPublish(options) {
    if (options.orphan === true && (options.squash ?? null) === null)
        throw orphanRefusal();
    assertPublishGate(options);
    const destination = options.export ?? null;
    // An export has no remote: publishRemoteUrl is neither required nor read (##PUBLISH-EXPORT).
    const remote = destination === null ? requiredRemote(options.config) : null;
    if (destination !== null)
        assertExportTarget(destination, options.patchesDir, options.resolution.path);
    if (options.patchSetRef.startsWith('-'))
        throw ckError('CONFIG', 'publish patchset ref must not start with a dash');
    const release = checkedRelease(options.release);
    const squash = options.squash ?? null;
    const scrub = options.scrub === true;
    if (scrub && squash === null) {
        throw ckError('CONFIG', '--scrub needs --squash', 'a history that carries the markers is not a clean release; add --squash');
    }
    const patchSetSha = resolvePatchSetRef(options.patchesDir, options.patchSetRef);
    const snapshotConfig = locatedInputs(options.patchesDir, configAtCommit(options.patchesDir, patchSetSha));
    if (snapshotConfig.type !== options.type.id)
        throw ckError('TYPE-UNKNOWN', 'selected immutable patchset type differs from the supplied project type', 'resolve the selected snapshot type before publishing');
    const branchName = options.branch === undefined || options.branch === null
        ? `${snapshotConfig.releaseRefPrefix}${patchSetSha.slice(0, 12)}+${pinKey(snapshotConfig.pin)}`
        : checkedBranch(options.patchesDir, options.branch, [snapshotConfig, options.config]);
    const branchRef = `refs/heads/${branchName}`;
    const tagName = release === null ? null : `patchset-v${release}+${pinKey(snapshotConfig.pin)}`;
    const tagRef = tagName === null ? null : `refs/tags/${tagName}`;
    assertRef(options.patchesDir, branchRef);
    if (tagRef !== null)
        assertRef(options.patchesDir, tagRef);
    const publishConfig = scrub ? releasePublishConfig(options.patchesDir, snapshotConfig) : undefined;
    const exclude = scrub ? releaseExclusions(publishConfig?.exclude ?? [], snapshotConfig, options.resolution.path) : [];
    const squashDate = squash === null ? null : committerDate(options.patchesDir, patchSetSha);
    // The initial access gate happens before lock/scratch/tree/ref mutation. A
    // second read after checks refreshes the exact lease/tag verdict before push.
    const observed = remote === null ? UNOBSERVED : observeRemote(options.patchesDir, remote, branchRef, tagRef);
    if (remote !== null) {
        options.checkpoint?.('remote-observed');
        options.out.info(`publish ${patchSetSha.slice(0, 12)} at ${pinKey(snapshotConfig.pin)}: remote branch ${observed.branch?.slice(0, 12) ?? 'absent'}, ` +
            `tag ${observed.tag?.slice(0, 12) ?? 'absent'}`);
    }
    else if (destination !== null) {
        options.out.info(`publish ${patchSetSha.slice(0, 12)} at ${pinKey(snapshotConfig.pin)}: into ${exportName(destination)}`);
    }
    const handle = acquireLock(options.patchesDir, treeId(options.resolution.path), 'publish', (text) => options.out.warn(text));
    let workspace = null;
    try {
        workspace = materializeWorkspace(options.patchesDir, patchSetSha, options.resolution, snapshotConfig, options.type.build.dependencyRoots);
        const checks = await runCi({
            patchesDir: workspace.patchesDir,
            resolution: workspace.resolution,
            config: snapshotConfig,
            type: options.type,
            out: options.out,
            profile: options.profile,
            effectiveDiffBase: null,
            pinGuardBase: null,
            verbose: options.verbose,
            patchSetCommit: patchSetSha,
            patchesRepositoryRoot: options.patchesDir,
            // The release branch does not carry the codkit licence notice; the
            // developer tree and the ci branch do (PROP-014
            // ##STD-NOTICE-RELEASE-EXCLUSION). publish is the only caller that
            // asks for this, and it asks here.
            omitLicenceNotice: true
        });
        if (checks.exitCode !== EXIT_OK || checks.branchTip === null) {
            if (checks.exitCode === EXIT_OK) {
                options.out.addError({ code: 'INTERNAL', message: 'publish checks returned no generated branch tip' });
            }
            return publishResult(checks.exitCode === EXIT_OK ? EXIT_ENVIRONMENT : checks.exitCode, checks.exitCode === EXIT_CHECK_FAILED ? 'check-failed' : 'environment-failed', baseResult(patchSetSha, pinKey(snapshotConfig.pin), branchName, tagName, observed, checks));
        }
        const shaped = shapeTip({
            workspaceRoot: workspace.root,
            treeDir: workspace.resolution.path,
            snapshotDir: workspace.patchesDir,
            type: options.type,
            config: snapshotConfig,
            patchSetSha,
            checkedTip: checks.branchTip,
            squash,
            squashDate,
            orphan: options.orphan === true,
            scrub,
            noLfs: options.noLfs === true,
            publishConfig,
            exclude,
            out: options.out
        });
        if (!shaped.ok) {
            return publishResult(EXIT_CHECK_FAILED, shaped.status, {
                ...baseResult(patchSetSha, pinKey(snapshotConfig.pin), branchName, tagName, observed, checks),
                tip: null,
                scrub: shaped.scrub,
                lfs: shaped.lfs
            });
        }
        const tip = shaped.tip;
        const shapes = { squash: shaped.squash, scrub: shaped.scrub, lfs: shaped.lfs };
        options.checkpoint?.('checks-passed');
        options.onPreparedRelease?.({
            forkDir: workspace.resolution.path,
            config: snapshotConfig,
            patchsetCommit: patchSetSha,
            generatedTip: checks.branchTip,
            tip,
            branch: branchName,
            tag: tagName
        });
        if (remote === null) {
            if (destination === null)
                throw ckError('INTERNAL', 'publish has neither a remote nor an export');
            const exported = writeExport({
                request: destination,
                forkDir: workspace.resolution.path,
                scratchDir: join(workspace.root, 'export'),
                branchRef,
                tagRef,
                tip,
                keepLfs: options.noLfs !== true,
                forkTree: options.resolution.path,
                pinSha: snapshotConfig.pin.sha,
                out: options.out,
                created: () => options.checkpoint?.('export-created')
            });
            const inputs = reportInputs(options.out, releasedInputs(workspace.resolution.path, tip, snapshotConfig.inputs ?? []));
            options.out.info(`published: ${branchRef} -> ${tip}${tagRef === null ? '' : `; ${tagRef}`}; into ${exportName(destination)}`);
            return publishResult(EXIT_OK, 'published', {
                ...baseResult(patchSetSha, pinKey(snapshotConfig.pin), branchName, tagName, UNOBSERVED, checks),
                tip,
                ...shapes,
                inputs,
                export: exported
            });
        }
        const refreshed = observeRemote(options.patchesDir, remote, branchRef, tagRef);
        options.checkpoint?.('remote-refreshed');
        // Immutable tag verdict precedes every remote write, including the branch.
        if (tagRef !== null && refreshed.tag !== null && refreshed.tag !== tip) {
            options.out.addError({
                code: 'CONFIG',
                message: `immutable tag ${tagName ?? ''} already names ${refreshed.tag}, not generated tip ${tip}`,
                hint: 'choose another --release value; published release tags are never moved'
            });
            return publishResult(EXIT_CHECK_FAILED, 'tag-collision', {
                ...baseResult(patchSetSha, pinKey(snapshotConfig.pin), branchName, tagName, refreshed, checks),
                tip,
                ...shapes
            });
        }
        const tagSatisfied = tagRef !== null && refreshed.tag === tip;
        if (tagSatisfied)
            options.out.info(`tag ${tagName ?? ''} already names ${tip.slice(0, 12)}; tag push is not needed`);
        let pushedTag = false;
        if (tagRef !== null && !tagSatisfied) {
            options.checkpoint?.('before-tag-push');
            pushTag(workspace.resolution.path, remote, tagRef, tip);
            pushedTag = true;
            options.checkpoint?.('tag-pushed');
        }
        let pushedBranch = false;
        if (refreshed.branch !== tip) {
            options.checkpoint?.('before-branch-push');
            pushBranch(workspace.resolution.path, remote, branchRef, tip, refreshed.branch);
            pushedBranch = true;
            options.checkpoint?.('branch-pushed');
        }
        const status = pushedBranch || pushedTag ? 'published' : 'up-to-date';
        const inputs = reportInputs(options.out, releasedInputs(workspace.resolution.path, tip, snapshotConfig.inputs ?? []));
        options.out.info(`${status}: ${branchRef} -> ${tip}${tagRef === null ? '' : `; ${tagRef}`}`);
        return publishResult(EXIT_OK, status, {
            ...baseResult(patchSetSha, pinKey(snapshotConfig.pin), branchName, tagName, refreshed, checks),
            tip,
            pushedBranch,
            pushedTag,
            ...shapes,
            inputs
        });
    }
    finally {
        workspace?.release();
        handle.release();
    }
}
/** The two gates of the release bot; an export keeps both, and their words name it (##PUBLISH-EXPORT). */
function assertPublishGate(options) {
    const exporting = (options.export ?? null) !== null;
    if (options.ci) {
        throw ckError('NET-FORBIDDEN', exporting
            ? 'publish cannot run with global --ci: publish is an explicit operation of the release bot, an export into a local repository included'
            : 'publish cannot run with global --ci: publish is an explicit network operation');
    }
    if (!options.confirmed) {
        throw ckError('CONFIG', 'publish requires --yes-i-am-publish-bot', exporting
            ? 'only the release bot may publish a release, into a remote or into a new local repository'
            : 'only the release bot may run this network mutation');
    }
}
/** One line per input of the published commit, with its commit and the files the published tree carries. */
function reportInputs(out, inputs) {
    for (const input of inputs)
        out.info(`input ${input.name}: ${input.commit.slice(0, 12)} -> ${input.to}: ${input.files} file(s)`);
    return inputs;
}
function exportName(request) {
    return `the new ${request.kind === 'bare' ? 'bare repository' : 'repository'} ${request.path}`;
}
function requiredRemote(config) {
    const remote = config.publishRemoteUrl;
    if (remote === null || remote.trim() === '') {
        throw ckError('CONFIG', 'publishRemoteUrl is required for publish', 'set it in codkit.local.json for the release bot');
    }
    return remote;
}
function checkedRelease(release) {
    if (release === null)
        return null;
    if (!SEMVER.test(release))
        throw ckError('CONFIG', `--release expects strict semver, got ${release}`, 'example: --release 1.2.3');
    return release;
}
/**
 * ##PUBLISH-BRANCH-NAME: the short name of a branch that git accepts and that
 * stays out of the namespaces the patch set manages itself.
 */
function checkedBranch(patchesDir, name, configs) {
    if (name.startsWith('-') || name.startsWith('refs/') || name === 'HEAD') {
        throw ckError('CONFIG', `--branch expects the short name of a branch, got ${name}`, 'example: --branch nimbus/rc/1.0.0');
    }
    const checked = runGit({ args: ['check-ref-format', `refs/heads/${name}`], cwd: patchesDir });
    if (checked.status !== 0) {
        throw ckError('CONFIG', `--branch is not a valid branch name: ${name}`, 'see git check-ref-format; example: --branch nimbus/rc/1.0.0');
    }
    for (const config of configs) {
        for (const prefix of [config.generatedBranchPrefix, config.cycleBranchPrefix, config.releaseRefPrefix]) {
            if (name.startsWith(prefix) || prefix.startsWith(`${name}/`)) {
                throw ckError('CONFIG', `--branch ${name} collides with the patch-set namespace ${prefix}`, 'name the release branch outside the generated, cycle and release prefixes of the configuration');
            }
        }
    }
    return name;
}
/** ##LOCAL-CONFIG-RULE: the inputs of the published commit, found where this machine keeps them. */
function locatedInputs(patchesDir, snapshot) {
    const local = loadLocalConfig(patchesDir);
    return local === null || snapshot.inputs === undefined ? snapshot : { ...snapshot, inputs: mergeLocal(snapshot, local).inputs };
}
/** The `publish` section of the published commit's codkit.json joined with the local one. */
function releasePublishConfig(patchesDir, snapshot) {
    const local = loadLocalConfig(patchesDir);
    return (local === null ? snapshot : mergeLocal(snapshot, local)).publish;
}
/**
 * ##PUBLISH-EXCLUDE: every entry of the joined list proven to name no path of
 * the pin - an exclusion leaves out what the patch set adds, never an upstream
 * file.
 */
function releaseExclusions(exclude, snapshot, treeDir) {
    for (const entry of exclude) {
        const listed = runGit({
            args: ['--literal-pathspecs', 'ls-tree', '-r', '--name-only', '-z', snapshot.pin.sha, '--', entry],
            cwd: treeDir
        });
        if (listed.status !== 0) {
            throw ckError('CONFIG', `cannot read the pin to check publish.exclude: ${firstLine(listed.stderr)}`, 'run publish over a fork tree that holds the pin');
        }
        const upstream = listed.stdout.split('\0').find((path) => path !== '');
        if (upstream !== undefined) {
            throw ckError('CONFIG', `publish.exclude entry ${entry} names ${upstream}, which the pin carries`, 'an exclusion leaves out what the patch set adds; it never deletes or reverts an upstream file', CONFIG_FILE_NAME);
        }
    }
    return exclude;
}
/** Both dates of the squashed commit: the committer date of the patchset commit. */
function committerDate(patchesDir, sha) {
    const shown = runGit({ args: ['show', '-s', '--format=%cI', sha], cwd: patchesDir });
    const date = shown.stdout.trim();
    if (shown.status !== 0 || date === '')
        throw ckError('CONFIG', `cannot read the date of patchset commit ${sha}: ${firstLine(shown.stderr)}`);
    return date;
}
function configAtCommit(patchesDir, sha) {
    const shown = runGit({ args: ['show', `${sha}:${CONFIG_FILE_NAME}`], cwd: patchesDir });
    if (shown.status !== 0)
        throw ckError('CONFIG', `${sha} does not carry ${CONFIG_FILE_NAME}`, 'publish a patchset commit with canonical config');
    let raw;
    try {
        raw = JSON.parse(shown.stdout);
    }
    catch {
        throw ckError('CONFIG', `${CONFIG_FILE_NAME} at ${sha} is not JSON`);
    }
    return parseBaseConfig(raw, `${CONFIG_FILE_NAME}@${sha}`);
}
function assertRef(patchesDir, ref) {
    const checked = runGit({ args: ['check-ref-format', ref], cwd: patchesDir });
    if (checked.status !== 0)
        throw ckError('CONFIG', `publish ref is invalid: ${ref}`, 'fix releaseRefPrefix, pin tag, or release semver');
}
function observeRemote(patchesDir, remote, branchRef, tagRef) {
    const patterns = tagRef === null ? [branchRef] : [branchRef, tagRef, `${tagRef}^{}`];
    const result = runGit({ args: ['ls-remote', '--', remote, ...patterns], cwd: patchesDir, netAllowed: true });
    if (result.status !== 0) {
        throw ckError('CONFIG', `cannot inspect publish remote: ${firstLine(result.stderr)}`, 'fix remote URL, authentication, or network and retry');
    }
    let branch = null;
    let directTag = null;
    let peeledTag = null;
    for (const line of result.stdout.split('\n')) {
        if (line === '')
            continue;
        const [sha, ref] = line.split('\t');
        if (sha === undefined || ref === undefined || !SHA.test(sha))
            throw ckError('CONFIG', 'publish remote returned malformed refs');
        if (ref === branchRef)
            branch = sha;
        if (tagRef !== null && ref === tagRef)
            directTag = sha;
        if (tagRef !== null && ref === `${tagRef}^{}`)
            peeledTag = sha;
    }
    return { branch, tag: peeledTag ?? directTag };
}
function pushBranch(treeDir, remote, branchRef, tip, observed) {
    const expected = observed ?? ZERO_SHA;
    const result = runGit({
        args: ['push', '--porcelain', `--force-with-lease=${branchRef}:${expected}`, '--', remote, `${tip}:${branchRef}`],
        cwd: treeDir,
        netAllowed: true
    });
    if (result.status !== 0) {
        throw ckError('CONFIG', `publish branch push failed: ${firstLine(result.stderr || result.stdout)}`, 'remote changed, authentication failed, or network was lost; inspect and retry');
    }
}
function pushTag(treeDir, remote, tagRef, tip) {
    const result = runGit({ args: ['push', '--porcelain', '--', remote, `${tip}:${tagRef}`], cwd: treeDir, netAllowed: true });
    if (result.status !== 0) {
        throw ckError('CONFIG', `publish tag push failed: ${firstLine(result.stderr || result.stdout)}`, 'release tags are immutable; inspect the remote and retry');
    }
}
function baseResult(patchSetSha, pinTag, branch, tag, observed, checks) {
    return {
        patchSetSha,
        pinTag,
        tip: checks.branchTip,
        branch,
        tag,
        observedBranch: observed.branch,
        observedTag: observed.tag,
        pushedBranch: false,
        pushedTag: false,
        checks,
        squash: null,
        scrub: null,
        lfs: null,
        inputs: [],
        export: null
    };
}
function publishResult(exitCode, status, parts) {
    return { exitCode, status, ...parts };
}
function firstLine(text) {
    return text.trim().split('\n')[0] ?? '';
}
