/** @scope spec://codkit/modules/vscode/PROP-006#IMAGESET-TARGET-DISCOVERY */
// Target discovery (IMAGESET-TARGET-DISCOVERY): which image files of the fork
// tree belong to the product's icon set, and what structure each one carries.
//
// The file set is the project type's answer - the image locations a fork of
// that family rebrands - and reaches this module as patterns and roles. The
// STRUCTURE is never assumed: each existing file is parsed, and the frame list,
// element types and exact per-frame dimensions come from the bytes the
// distribution ships. Upstream adding a frame, an installer size or a whole new
// file under the globs is therefore followed automatically.
//
// A target names two things, and they are not the same (IMAGESET-ARTWORK):
// the FAMILY is the guard group and the masters folder - one contract test
// covers all of it - while the ARTWORK is which drawing inside that family
// the target wants. The application icon is one family with one artwork; the
// file-type icons are one family with dozens.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { codecFor, readingImage } from './imagesetCodec.js';
import { ckError } from './messages.js';
/**
 * Discover the image set of a fork tree. Missing fixed paths are reported per
 * file (they are the distribution's own layout, so their absence is news),
 * while a glob that matches nothing simply contributes no targets.
 */
export function discoverTargets(type, treeDir, onReport) {
    const targets = [];
    const claimed = new Map();
    for (const pattern of type.brandImages?.targets ?? []) {
        const files = pattern.glob
            ? globFiles(treeDir, pattern.path, pattern.exclude ?? [])
            : existsSync(joinTree(treeDir, pattern.path))
                ? [pattern.path]
                : [];
        if (!pattern.glob && files.length === 0) {
            onReport(`target absent in the tree: ${pattern.path}`);
            continue;
        }
        for (const file of files) {
            // Two patterns claiming one file would silently produce two map
            // entries for one path; that is a codkit bug, so it is loud.
            const owner = claimed.get(file);
            if (owner !== undefined) {
                throw ckError('ARTIFACT-BROKEN', `${file} is claimed by two target patterns (${owner} and ${pattern.path})`, 'the built-in pattern table must assign every discovered file to exactly one family');
            }
            claimed.set(file, pattern.path);
            targets.push(discoverOne(type, treeDir, file, pattern));
        }
    }
    targets.sort((left, right) => compareBytes(left.target, right.target));
    return targets;
}
function discoverOne(type, treeDir, file, pattern) {
    const bytes = readFileSync(joinTree(treeDir, file));
    const stem = basename(file, extname(file));
    const { family, kind, role } = pattern;
    const codec = codecFor(type, kind);
    // One door, whatever the container: the frame list, the element types and
    // the exact sizes all come out of the bytes the distribution ships.
    const read = readingImage(file, () => ({ frames: codec.parse(bytes), legacyTypes: codec.legacyTypes(bytes) }));
    return {
        family,
        artwork: artworkOf(stem, pattern),
        role,
        target: file,
        kind,
        frames: read.frames,
        legacyTypes: read.legacyTypes,
        stem
    };
}
/** The artwork name of a target: the stem minus the pattern's prefix, or null. */
function artworkOf(stem, pattern) {
    if (pattern.artworkFromStem === undefined) {
        return null;
    }
    const { strip } = pattern.artworkFromStem;
    return stem.startsWith(strip) ? stem.slice(strip.length) : stem;
}
/** The masters base name of a target: 'icon', or 'filetype/json'. */
export function artworkKey(target) {
    return target.artwork === null ? target.family : `${target.family}/${target.artwork}`;
}
function globFiles(treeDir, pattern, exclude) {
    const separator = pattern.lastIndexOf('/');
    const directory = separator === -1 ? '' : pattern.slice(0, separator);
    const namePattern = pattern.slice(separator + 1);
    const star = namePattern.indexOf('*');
    if (star === -1) {
        return [];
    }
    const prefix = namePattern.slice(0, star);
    const suffix = namePattern.slice(star + 1).replace(/\*/g, '');
    const absolute = joinTree(treeDir, directory);
    if (!existsSync(absolute)) {
        return [];
    }
    return readdirSync(absolute)
        .filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length)
        .filter((name) => !exclude.includes(name))
        .sort((left, right) => compareBytes(left, right))
        .map((name) => (directory === '' ? name : `${directory}/${name}`));
}
function joinTree(treeDir, relative) {
    return join(treeDir, ...relative.split('/'));
}
function compareBytes(left, right) {
    return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
