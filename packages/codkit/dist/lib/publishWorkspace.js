/** @scope spec://codkit/modules/codkit/PROP-007#PUBLISH-DISPOSABLE-FORK */
// The workspace of one `publish` run (PROP-007 ##PUBLISH-DISPOSABLE-FORK): the
// patchset commit checked out into a snapshot, and the fork tree cloned with
// `--shared` into a disposable fork at the pin, both under one temporary root
// that goes with the run whatever its outcome.
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
export function materializeWorkspace(patchesDir, sha, source, config, dependencyRoots) {
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
        // The disposable fork lives under the temp directory, deeper than the
        // tree it copies; on Windows the longest upstream paths then pass the
        // 260-character limit unless git is told to use long paths (a no-op
        // elsewhere). codkit's git reads no global or system config, so the fork
        // carries the setting in its own.
        const cloned = runGit({
            args: ['clone', '--quiet', '--shared', '--no-checkout', '--config', 'core.longpaths=true', '--', source.path, fork],
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
        root,
        patchesDir: snapshot,
        resolution: { path: realpathSync(fork), source: source.source, exists: true, warning: null },
        release
    };
}
/** What `git lfs install --local --skip-repo` writes: the filters, and no hooks. */
export const LFS_FILTER_CONFIG = [
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
function firstLine(text) {
    return text.trim().split('\n')[0] ?? '';
}
