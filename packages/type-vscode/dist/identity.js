/** @scope spec://codkit/modules/vscode/PROP-001#VSCODE-UPSTREAM-IDENTITY */
// Area 1: what a pin of this family looks like, and what proves that a
// directory really is a tree of it.
//
// The resolution of a pin into `tag@sha@date` and the anchor-commit rule that
// proves the origin of a fork stay with the engine; only the shape of a tag and
// the fingerprints of a healthy tree are answered here.
/** Upstream release tags of this family are `<major>.<minor>.<patch>`. */
export const TAG_PATTERN = /^\d+\.\d+\.\d+$/;
export const identity = {
    tagPattern: TAG_PATTERN,
    tagShape: '<major>.<minor>.<patch>',
    fingerprints: [
        {
            path: 'package.json',
            kind: 'file',
            why: 'the tree of this family is an npm project, and every build, lint and test command of the type is one of its scripts'
        },
        {
            path: 'product.json',
            kind: 'file',
            why: 'the product manifest of the distribution: the target of the configuration overlay and the carrier of the built-in extension list'
        },
        {
            path: 'src/vs',
            kind: 'directory',
            why: 'the source root of the distribution; the own root of a patch set of this type lives inside it'
        }
    ]
};
