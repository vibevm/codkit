/** @scope spec://codkit/modules/theia/PROP-002#THEIA-PIN-TAGS */
// Area 1: what a pin of this family looks like, and what proves that a
// directory really is a tree of it.
//
// Two facts shape the answers. A release tag is `v<major>.<minor>.<patch>`, and
// upstream also moves a rolling `next` tag onto its canary commit - a pin
// resolver must refuse it, because a pin that moves is not a pin
// (##THEIA-PIN-TAGS). And the version of the monorepo is written in
// `lerna.json`, not in the root manifest, which is the private `@theia/monorepo`
// at `0.0.0`; every workspace package carries the same literal, which is what
// makes the version of `packages/core` a fingerprint of a healthy tree
// (##THEIA-VERSION-SOURCE, ##THEIA-TREE-FINGERPRINT).
import { brokenArtifact } from '@codkit/type-api';
/** ##THEIA-PIN-TAGS: release tags of this family are `v<major>.<minor>.<patch>`. */
export const TAG_PATTERN = /^v\d+\.\d+\.\d+$/;
/** The manifest of the monorepo; its name is what the root of this family is called. */
export const ROOT_MANIFEST_PATH = 'package.json';
/** ##THEIA-VERSION-SOURCE: where the one version of the monorepo is written. */
export const LERNA_MANIFEST_PATH = 'lerna.json';
/** The manifest of the framework package every application depends on. */
export const CORE_MANIFEST_PATH = 'packages/core/package.json';
/** ##THEIA-VERSION-SOURCE: the name the root manifest of this family carries. */
export const MONOREPO_NAME = '@theia/monorepo';
/** The package whose manifest proves the tree is checked out, not just cloned. */
export const CORE_PACKAGE_NAME = '@theia/core';
/** ##THEIA-TREE-FINGERPRINT: the workspace globs the root manifest must cover. */
export const REQUIRED_WORKSPACE_GLOBS = ['packages/*', 'dev-packages/*'];
/** The version of the monorepo as `lerna.json` states it, or null when it does not. */
export function monorepoVersion(files) {
    const lerna = objectOf(files, LERNA_MANIFEST_PATH);
    const version = lerna?.['version'];
    return typeof version === 'string' ? version : null;
}
export const fingerprints = [
    {
        path: ROOT_MANIFEST_PATH,
        kind: 'file',
        why: 'the root of this family is one npm workspace, and its manifest is what lists the globs a package of the tree may live under',
        contentProblem: (files) => rootManifestProblem(files)
    },
    {
        path: LERNA_MANIFEST_PATH,
        kind: 'file',
        why: 'the version of the whole monorepo is written here, and this is where a version bump of an upgrade is read from',
        contentProblem: (files) => lernaProblem(files)
    },
    {
        path: CORE_MANIFEST_PATH,
        kind: 'file',
        why: 'the framework package every application of this family depends on; its version is the version of the monorepo, literally',
        contentProblem: (files) => coreProblem(files)
    }
];
export const identity = {
    tagPattern: TAG_PATTERN,
    tagShape: 'v<major>.<minor>.<patch> (the rolling tag next is mutable and is not a pin)',
    fingerprints
};
/** ##THEIA-TREE-FINGERPRINT: `@theia/monorepo` with the workspace globs of the family. */
function rootManifestProblem(files) {
    const manifest = objectOf(files, ROOT_MANIFEST_PATH);
    if (manifest === null) {
        return 'cannot be read as a JSON object';
    }
    if (manifest['name'] !== MONOREPO_NAME) {
        return `the manifest of this family is named ${MONOREPO_NAME}, and this one is named ${JSON.stringify(manifest['name'] ?? null)}`;
    }
    const workspaces = manifest['workspaces'];
    const globs = Array.isArray(workspaces) ? workspaces.filter((glob) => typeof glob === 'string') : [];
    const missing = REQUIRED_WORKSPACE_GLOBS.filter((glob) => !globs.includes(glob));
    if (missing.length > 0) {
        return `the workspace globs ${missing.join(', ')} are missing, so the packages of the tree are not workspace members`;
    }
    return null;
}
/** ##THEIA-TREE-FINGERPRINT: the version, and npm as the package manager of the tree. */
function lernaProblem(files) {
    const lerna = objectOf(files, LERNA_MANIFEST_PATH);
    if (lerna === null) {
        return 'cannot be read as a JSON object';
    }
    const version = lerna['version'];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
        return 'carries no version of the monorepo, and the version of this family is read from here';
    }
    if (lerna['npmClient'] !== 'npm') {
        return `the package manager of this family is npm ("npmClient": "npm"), and this tree declares ${JSON.stringify(lerna['npmClient'] ?? null)}`;
    }
    return null;
}
/** ##THEIA-TREE-FINGERPRINT: `@theia/core` at exactly the version of `lerna.json`. */
function coreProblem(files) {
    const core = objectOf(files, CORE_MANIFEST_PATH);
    if (core === null) {
        return 'cannot be read as a JSON object';
    }
    if (core['name'] !== CORE_PACKAGE_NAME) {
        return `the framework package of this family is ${CORE_PACKAGE_NAME}, and this one is named ${JSON.stringify(core['name'] ?? null)}`;
    }
    const version = monorepoVersion(files);
    if (version !== null && core['version'] !== version) {
        return `carries the version ${JSON.stringify(core['version'] ?? null)} while lerna.json says ${version}: this tree is in the middle of a version bump`;
    }
    return null;
}
/** One JSON object of the tree, or null when the file is absent or not an object. */
function objectOf(files, path) {
    const text = files.get(path) ?? null;
    if (text === null) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (error) {
        throw brokenArtifact(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`, 'restore the manifest from the pin');
    }
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
}
