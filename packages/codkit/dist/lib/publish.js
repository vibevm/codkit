/** @scope spec://codkit/modules/codkit/PROP-011#root */
// Immutable publish transaction: observe remote, build/check one patchset commit,
// reject tag collisions, create the tag without force, then lease the branch.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCi } from './ciEngine.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './command.js';
import { CONFIG_FILE_NAME, parseBaseConfig } from './configFile.js';
import { treeId } from './fingerprint.js';
import { runGit } from './gitx.js';
import { resolvePatchSetRef } from './inventory.js';
import { acquireLock } from './lock.js';
import { ckError } from './messages.js';
const ZERO_SHA = '0'.repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export async function runPublish(options) {
    assertPublishGate(options);
    const remote = requiredRemote(options.config);
    if (options.patchSetRef.startsWith('-'))
        throw ckError('CONFIG', 'publish patchset ref must not start with a dash');
    const release = checkedRelease(options.release);
    const patchSetSha = resolvePatchSetRef(options.patchesDir, options.patchSetRef);
    const snapshotConfig = configAtCommit(options.patchesDir, patchSetSha);
    const branchName = `${snapshotConfig.releaseRefPrefix}${patchSetSha.slice(0, 12)}+${snapshotConfig.pin.tag}`;
    const branchRef = `refs/heads/${branchName}`;
    const tagName = release === null ? null : `patchset-v${release}+${snapshotConfig.pin.tag}`;
    const tagRef = tagName === null ? null : `refs/tags/${tagName}`;
    assertRef(options.patchesDir, branchRef);
    if (tagRef !== null)
        assertRef(options.patchesDir, tagRef);
    // The initial access gate happens before lock/scratch/tree/ref mutation. A
    // second read after checks refreshes the exact lease/tag verdict before push.
    const observed = observeRemote(options.patchesDir, remote, branchRef, tagRef);
    options.checkpoint?.('remote-observed');
    options.out.info(`publish ${patchSetSha.slice(0, 12)} at ${snapshotConfig.pin.tag}: remote branch ${observed.branch?.slice(0, 12) ?? 'absent'}, ` +
        `tag ${observed.tag?.slice(0, 12) ?? 'absent'}`);
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
            return publishResult(checks.exitCode === EXIT_OK ? EXIT_ENVIRONMENT : checks.exitCode, checks.exitCode === EXIT_CHECK_FAILED ? 'check-failed' : 'environment-failed', baseResult(patchSetSha, snapshotConfig.pin.tag, branchName, tagName, observed, checks));
        }
        const tip = checks.branchTip;
        options.checkpoint?.('checks-passed');
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
                ...baseResult(patchSetSha, snapshotConfig.pin.tag, branchName, tagName, refreshed, checks),
                tip
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
        options.out.info(`${status}: ${branchRef} -> ${tip}${tagRef === null ? '' : `; ${tagRef}`}`);
        return publishResult(EXIT_OK, status, {
            ...baseResult(patchSetSha, snapshotConfig.pin.tag, branchName, tagName, refreshed, checks),
            tip,
            pushedBranch,
            pushedTag
        });
    }
    finally {
        workspace?.release();
        handle.release();
    }
}
function assertPublishGate(options) {
    if (options.ci) {
        throw ckError('NET-FORBIDDEN', 'publish cannot run with global --ci: publish is an explicit network operation');
    }
    if (!options.confirmed) {
        throw ckError('CONFIG', 'publish requires --yes-i-am-publish-bot', 'only the release bot may run this network mutation');
    }
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
function materializeWorkspace(patchesDir, sha, source, config, dependencyRoots) {
    const root = mkdtempSync(join(tmpdir(), `codkit-publish-${sha.slice(0, 12)}-`));
    const snapshot = join(root, 'patchset');
    const index = join(root, 'patchset.index');
    const fork = join(root, 'fork');
    mkdirSync(snapshot, { recursive: true });
    const release = () => {
        rmSync(root, { recursive: true, force: true });
    };
    try {
        mustLocalGit(patchesDir, ['read-tree', sha], { GIT_INDEX_FILE: index }, `cannot read patchset snapshot ${sha}`);
        mustLocalGit(patchesDir, ['checkout-index', '--all', `--prefix=${snapshot}/`], { GIT_INDEX_FILE: index }, `cannot materialize patchset snapshot ${sha}`);
        const cloned = runGit({
            args: ['clone', '--quiet', '--shared', '--no-checkout', '--', source.path, fork],
            cwd: root,
            netAllowed: true
        });
        if (cloned.status !== 0)
            throw ckError('CONFIG', `cannot create disposable publish fork: ${firstLine(cloned.stderr)}`);
        shareLfsContent(source.path, fork);
        mustLocalGit(fork, ['checkout', '--quiet', '--detach', config.pin.sha], {}, `cannot check out publish pin ${config.pin.sha}`);
        copySupplyKit(source.path, fork, dependencyRoots);
    }
    catch (error) {
        release();
        throw error;
    }
    rmSync(index, { force: true });
    return {
        patchesDir: snapshot,
        resolution: { path: realpathSync(fork), source: source.source, exists: true, warning: null },
        release
    };
}
/** What `git lfs install --local --skip-repo` writes: the filters, and no hooks. */
const LFS_FILTER_CONFIG = [
    ['filter.lfs.clean', 'git-lfs clean -- %f'],
    ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
    ['filter.lfs.process', 'git-lfs filter-process'],
    ['filter.lfs.required', 'true']
];
/**
 * The disposable fork shares the git-lfs content of the tree it is cloned from,
 * the way `--shared` shares its objects. codkit's git reads no global or system
 * config, where git-lfs keeps its filters, so the fork carries them in its own
 * config, and its lfs storage is the source's: the checkout of the pin then
 * smudges from local content, without the network. A source without git-lfs or
 * without lfs content is left alone; check-tree names what is missing.
 */
function shareLfsContent(sourceTree, fork) {
    if (runGit({ args: ['lfs', 'version'], cwd: fork }).status !== 0)
        return;
    const common = runGit({ args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: sourceTree });
    if (common.status !== 0)
        return;
    const storage = join(common.stdout.trim(), 'lfs');
    if (!existsSync(join(storage, 'objects')))
        return;
    for (const [key, value] of LFS_FILTER_CONFIG) {
        mustLocalGit(fork, ['config', key, value], {}, 'cannot configure git-lfs in the disposable publish fork');
    }
    mustLocalGit(fork, ['config', 'lfs.storage', storage], {}, 'cannot share git-lfs content with the disposable publish fork');
}
function mustLocalGit(cwd, args, env, message) {
    const result = runGit({ args, cwd, env });
    if (result.status !== 0)
        throw ckError('CONFIG', `${message}: ${firstLine(result.stderr)}`);
}
/**
 * The dependency roots of the type, carried into the disposable fork as they
 * are. Which directories those are is the type's answer (PROP-016
 * ##TYPE-AREA-BUILD); this run only copies them.
 */
function copySupplyKit(sourceTree, disposableTree, dependencyRoots) {
    for (const relative of dependencyRoots) {
        const source = join(sourceTree, ...relative.split('/'));
        if (!existsSync(source))
            continue;
        const target = join(disposableTree, ...relative.split('/'));
        mkdirSync(join(target, '..'), { recursive: true });
        cpSync(source, target, { recursive: true, dereference: true, preserveTimestamps: true, errorOnExist: true });
    }
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
        checks
    };
}
function publishResult(exitCode, status, parts) {
    return { exitCode, status, ...parts };
}
function firstLine(text) {
    return text.trim().split('\n')[0] ?? '';
}
