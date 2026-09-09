/** @scope spec://codkit/modules/codkit/PROP-006#root */
// Apply metadata: the per-tree cache in patchset and the mark inside the tree
// (PROP-006 sec. 1), plus the fast-path rule that reads them.
//
// ##TREE-IS-TRUTH: neither file is authoritative. The truth about what is
// applied is the generated branch, its tip and the trailers of its commits;
// these two files only let `load` decide quickly that nothing changed. Losing
// them means "apply from scratch", never a question to the user - which is why
// every read here degrades to null instead of failing.
//
// The mark lives inside .git/ on purpose: it survives `git clean -fdx` and is
// invisible to `git status`, so it cannot be mistaken for tree content.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { encodeUtf8 } from './bytes.js';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.js';
import { runGit } from './gitx.js';
export const TREE_CACHE_SCHEMA_VERSION = 1;
export const TREE_MARK_SCHEMA_VERSION = 1;
/** Directory of the per-tree cache files, relative to the patchset root. */
export const TREES_DIR = '.codkit/trees';
/** Path of the mark inside the tree's git directory. */
export const MARK_RELATIVE_PATH = 'codkit/applied.json';
const treeCacheSchema = z.object({
    codkitTreeCache: z.literal(TREE_CACHE_SCHEMA_VERSION),
    treePath: z.string().min(1),
    treeRepoAnchor: z.string().min(1),
    pinSha: z.string().min(1),
    deltaFingerprint: z.string().min(1),
    branchTip: z.string().min(1),
    updatedAt: z.string().min(1)
});
const treeMarkSchema = z.object({
    codkitTreeMark: z.literal(TREE_MARK_SCHEMA_VERSION),
    pinSha: z.string().min(1),
    deltaFingerprint: z.string().min(1),
    branchTip: z.string().min(1),
    ownFingerprint: z.string().min(1).optional(),
    ownFiles: z.record(z.string(), z.string().min(1)).optional(),
    ownRootFiles: z.record(z.string(), z.record(z.string(), z.string().min(1))).optional(),
    artifacts: z.record(z.string(), z.string().min(1)).optional(),
    patchSetCommit: z.string().min(1).optional()
});
export function treeCachePath(patchesDir, treeId) {
    return join(patchesDir, ...TREES_DIR.split('/'), `${treeId}.json`);
}
/**
 * The mark file of a tree. The git directory is asked for rather than assumed:
 * `.git` is a file, not a directory, in a linked worktree.
 */
export function treeMarkPath(treeDir) {
    return join(gitDirOf(treeDir), ...MARK_RELATIVE_PATH.split('/'));
}
export function gitDirOf(treeDir) {
    const result = runGit({ args: ['rev-parse', '--absolute-git-dir'], cwd: treeDir });
    if (result.status !== 0) {
        return join(treeDir, '.git');
    }
    const line = result.stdout.trim();
    return line === '' ? join(treeDir, '.git') : line;
}
/**
 * The common admin directory of the repository. Equal to gitDirOf() in a
 * normal repository and different from it exactly in a linked worktree, which
 * is how the caller tells the two apart. Fail-soft like gitDirOf: an
 * unresolvable tree reports the assumed `.git` of the tree.
 */
export function gitCommonDirOf(treeDir) {
    const result = runGit({ args: ['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd: treeDir });
    if (result.status !== 0) {
        return join(treeDir, '.git');
    }
    const line = result.stdout.trim();
    return line === '' ? join(treeDir, '.git') : line;
}
/**
 * The path Git itself consults for an administrative file whose effective
 * location it resolves inside its own directories - `info/exclude` resolves to
 * the common dir, which is why appending to gitDirOf() is wrong in a linked
 * worktree (PROP-005 ##OWN-EXCLUDED-LOCALLY).
 *
 * Deliberately not the rule for hooks: `--git-path hooks/<name>` follows
 * `core.hooksPath`. A caller that must know whether a hook it owns is the one
 * Git will run resolves the effective hook path STRICTLY - a failed resolution
 * (e.g. `core.hooksPath=/dev/null`) is "cannot prove", never a fallback to the
 * admin path - and across both config scopes; see writeTreeHook in syncEngine
 * and RunGitOptions.machineConfig in gitx (REPAIR-006).
 *
 * Returns { ok: false } when git cannot answer; callers decide what that
 * means for them instead of the old silent fallback, which turned "resolution
 * failed" into "the admin path is effective" and reported a guard that was
 * not there.
 */
export function effectiveGitPath(treeDir, relative) {
    const result = runGit({ args: ['rev-parse', '--path-format=absolute', '--git-path', relative], cwd: treeDir, pathResolution: true });
    if (result.status !== 0) {
        return { ok: false };
    }
    const line = result.stdout.trim();
    return line === '' ? { ok: false } : { ok: true, path: line };
}
/** Read the cache. A broken file is reported and treated as an absent one. */
export function readTreeCache(patchesDir, treeId, onWarn) {
    const path = treeCachePath(patchesDir, treeId);
    const parsed = readJson(path, treeCacheSchema);
    if (parsed.state === 'broken' && onWarn !== undefined) {
        onWarn(`ignoring the unreadable apply cache ${path} (${parsed.detail}); the delta will be applied from scratch`);
    }
    return parsed.state === 'ok' ? parsed.value : null;
}
export function writeTreeCache(patchesDir, treeId, cache) {
    const path = treeCachePath(patchesDir, treeId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}
/** Read the mark. A broken file is reported and treated as an absent one. */
export function readTreeMark(treeDir, onWarn, afterOpen) {
    const path = treeMarkPath(treeDir);
    let parsed;
    try {
        const read = readContainedFile(gitDirOf(treeDir), MARK_RELATIVE_PATH, {
            what: path,
            ...(afterOpen === undefined ? {} : { afterOpen })
        });
        parsed = read.state === 'absent' ? { state: 'absent' } : parseJsonBytes(read.bytes, path, treeMarkSchema);
    }
    catch (error) {
        // A symlinked or non-regular mark is an unusable mark, reported like a
        // broken one: the mark is a hint, the branch is the truth.
        parsed = { state: 'broken', detail: messageOf(error) };
    }
    if (parsed.state === 'broken' && onWarn !== undefined) {
        onWarn(`ignoring the unreadable apply mark ${path} (${parsed.detail}); the delta will be applied from scratch`);
    }
    return parsed.state === 'ok' ? parsed.value : null;
}
/**
 * Write the mark. Returns false when the tree does not take the write: a
 * read-only mount is a legal way to run codkit, so the caller only warns
 * (CK-W-MARK-RO) and carries on - the branch it just built is the real record.
 * The write goes through the contained administrative writer, so a symlinked
 * mark path refuses instead of landing outside git administration.
 */
export function writeTreeMark(treeDir, mark, onWarn) {
    const gitDir = gitDirOf(treeDir);
    const path = treeMarkPath(treeDir);
    try {
        writeContainedFileAtomic(gitDir, MARK_RELATIVE_PATH, {
            bytes: encodeUtf8(`${JSON.stringify(mark, null, 2)}\n`),
            what: path
        });
        return true;
    }
    catch (error) {
        if (onWarn !== undefined) {
            onWarn(`cannot write the apply mark ${path}: ${messageOf(error)}; the generated branch remains the record of what is applied`);
        }
        return false;
    }
}
export function removeTreeMark(treeDir) {
    rmSync(treeMarkPath(treeDir), { force: true });
}
/**
 * ##FAST-PATH-RULE, condition by condition. `status` reports how many of them
 * hold, so a developer can see how far the tree is from "up to date" rather than
 * only the first thing that is wrong.
 *
 * A stale cache cannot be mistaken for truth by construction: the branch, tip
 * and HEAD conditions are read from the tree itself, not from the cache.
 */
export function fastPathConditions(input) {
    const { cache, mark } = input;
    const noCache = 'no apply cache for this tree';
    const ref = `refs/heads/${input.branch}`;
    const tip = revParse(input.treeDir, ref);
    const head = symbolicHead(input.treeDir);
    const conditions = [
        condition('cache', cache !== null, noCache),
        condition('pin', cache !== null && cache.pinSha === input.pinSha, cache === null ? noCache : `the cache was written for pin ${cache.pinSha}, the config now pins ${input.pinSha}`),
        condition('fingerprint', cache !== null && cache.deltaFingerprint === input.deltaFingerprint, cache === null ? noCache : 'the delta fingerprint changed since the last apply'),
        condition('branch', tip !== null, `branch ${input.branch} does not exist in the tree`),
        condition('tip', cache !== null && tip !== null && tip === cache.branchTip, cache === null
            ? noCache
            : tip === null
                ? `branch ${input.branch} does not exist in the tree`
                : `branch ${input.branch} is at ${short(tip)}, the cache recorded ${short(cache.branchTip)}`),
        condition('head', head === ref, head === null ? `HEAD of the tree is detached, not on ${input.branch}` : `HEAD of the tree is on ${head}, not on ${ref}`),
        condition('mark', mark === null ||
            (mark.pinSha === input.pinSha && mark.deltaFingerprint === input.deltaFingerprint && mark.branchTip === cache?.branchTip), 'the mark inside the tree disagrees with the cache; the tree was changed by something else')
    ];
    return conditions;
}
/** The verdict: the first condition that does not hold names the reason. */
export function fastPathOk(input) {
    for (const check of fastPathConditions(input)) {
        if (!check.ok) {
            return { ok: false, reason: check.reason };
        }
    }
    return { ok: true };
}
function condition(id, ok, reason) {
    return { id, ok, reason: ok ? '' : reason };
}
/** Resolved sha of a ref, or null when it does not exist. */
export function revParse(treeDir, ref) {
    const result = runGit({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd: treeDir });
    if (result.status !== 0) {
        return null;
    }
    const sha = result.stdout.trim();
    return sha === '' ? null : sha;
}
/** The ref HEAD points at, or null when HEAD is detached. */
export function symbolicHead(treeDir) {
    const result = runGit({ args: ['symbolic-ref', '--quiet', 'HEAD'], cwd: treeDir });
    if (result.status !== 0) {
        return null;
    }
    const ref = result.stdout.trim();
    return ref === '' ? null : ref;
}
function readJson(path, schema) {
    if (!existsSync(path)) {
        return { state: 'absent' };
    }
    return parseJsonBytes(readFileSync(path), path, schema);
}
/** Validate already-read bytes; shared by the contained and legacy readers. */
function parseJsonBytes(bytes, _path, schema) {
    let raw;
    try {
        raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
    }
    catch (error) {
        return { state: 'broken', detail: messageOf(error) };
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? 'unknown field' : issue.path.map((segment) => String(segment)).join('.');
        return { state: 'broken', detail: `${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}` };
    }
    return { state: 'ok', value: parsed.data };
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
function short(sha) {
    return sha.slice(0, 8);
}
