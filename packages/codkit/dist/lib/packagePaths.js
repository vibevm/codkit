/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-PACKAGE-ANSWERS */
// Where a packaging run left its artifacts, and what it rewrote on the way.
//
// Two of the type's packaging answers are path patterns rather than commands -
// `packageOutputs` and `packageScratch` (PROP-016 ##TYPE-PACKAGE-ANSWERS,
// ##TYPE-PACKAGE-SCRATCH) - and both are read with the same rules: a pattern is
// matched segment by segment, `*` never crosses a `/`, a trailing `/` names a
// directory, and a pattern that would leave the tree is skipped with a warning
// rather than followed. They differ in what they are asked about: an output is
// looked up on disk, because the question is what exists after the run; a
// scratch path is looked up in git, because the question is what the run
// changed.
//
// It is a module of its own so that `codkit status` can ask the second question
// without importing the engine of `codkit package`, and so that the engine
// stays the order of one run rather than a glob matcher with a run around it.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './gitx.js';
/** The declared outputs that exist in the tree, in pattern order then path order. */
export function packageOutputPaths(treeDir, patterns, onWarn) {
    const found = [];
    for (const pattern of patterns) {
        const directoryOnly = pattern.endsWith('/');
        const segments = (directoryOnly ? pattern.slice(0, -1) : pattern).split('/');
        if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
            onWarn(`the project type names an unusable package output pattern and it was skipped: ${pattern}`);
            continue;
        }
        for (const relative of expand(treeDir, segments)) {
            const absolute = join(treeDir, ...relative.split('/'));
            const isDirectory = statSync(absolute).isDirectory();
            if (directoryOnly && !isDirectory) {
                continue;
            }
            const shown = isDirectory ? `${relative}/` : relative;
            if (!found.includes(shown)) {
                found.push(shown);
            }
        }
    }
    return found;
}
/** Every existing tree-relative path the segments match; `*` never crosses a `/`. */
function expand(treeDir, segments) {
    let matches = [''];
    for (const segment of segments) {
        const next = [];
        for (const prefix of matches) {
            const parent = prefix === '' ? treeDir : join(treeDir, ...prefix.split('/'));
            if (!segment.includes('*')) {
                const candidate = prefix === '' ? segment : `${prefix}/${segment}`;
                if (existsSync(join(parent, segment))) {
                    next.push(candidate);
                }
                continue;
            }
            const expression = segmentExpression(segment);
            let entries;
            try {
                entries = readdirSync(parent).sort();
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (expression.test(entry)) {
                    next.push(prefix === '' ? entry : `${prefix}/${entry}`);
                }
            }
        }
        matches = next;
    }
    return matches;
}
function segmentExpression(segment) {
    const source = segment
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('[^/]*');
    return new RegExp(`^${source}$`, 'u');
}
/** The declared scratch paths that the run actually changed, in git's order. */
export function packageScratchPaths(treeDir, patterns, onWarn) {
    const usable = patterns.filter((pattern) => {
        if (patternSegments(pattern).every((segment) => segment !== '' && segment !== '.' && segment !== '..')) {
            return true;
        }
        onWarn(`the project type names an unusable package scratch pattern and it was skipped: ${pattern}`);
        return false;
    });
    if (usable.length === 0) {
        return [];
    }
    return changedTrackedPaths(treeDir).filter((path) => usable.some((pattern) => matchesTreePattern(path, pattern)));
}
/** Does a tree-relative path match one pattern; `*` never crosses a `/`. */
export function matchesTreePattern(path, pattern) {
    const directoryOnly = pattern.endsWith('/');
    const expected = patternSegments(pattern);
    const actual = path.split('/');
    if (directoryOnly ? actual.length <= expected.length : actual.length !== expected.length) {
        return false;
    }
    return expected.every((segment, index) => segmentExpression(segment).test(actual[index] ?? ''));
}
function patternSegments(pattern) {
    return (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).split('/');
}
/** Tracked paths that differ from the tip of the tree, deletions included. */
function changedTrackedPaths(treeDir) {
    const diff = runGit({ args: ['diff', '--name-only', '--no-renames', '-z', 'HEAD'], cwd: treeDir });
    if (diff.status !== 0) {
        return [];
    }
    return diff.stdout.split('\0').filter((path) => path !== '');
}
