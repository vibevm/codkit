/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-MASTERS */
// Master discovery and seeding (IMAGESET-MASTERS).
//
// Naming convention of the branding directory, where <key> is the family for
// a family that holds one drawing and <family>/<artwork> for one that holds
// several (IMAGESET-ARTWORK):
//   <key>.svg          vector master (rendered per size);
//   <key>.png          raster master (resampled per size);
//   <key>-<N>.png      per-size override, used verbatim at exactly NxN;
//   <key>-<W>x<H>.png  per-size override for non-square sizes.
// A per-size override beats the vector master, and the vector master beats
// the raster one. Anything else in the directory is reported as ignored -
// nothing is silently picked up, and nothing is silently skipped.
//
// Seeding: when the directory does not exist, the first run creates it and
// fills it with the distribution's own artwork, read from the fork tree - per
// key, the largest raster its own targets carry, converted to PNG, or the
// vector itself for a vector family. Seeding is reported, never silent, and
// an existing directory is never touched.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeBmp } from './imagesetBmp.js';
import { encodePng, isPng } from './imagesetPng.js';
import { artworkKey } from './imagesetTargets.js';
/** Where masters live when the operator did not say otherwise. */
export function defaultBrandingDir(patchesDir) {
    return join(patchesDir, 'branding');
}
/**
 * The master that serves one frame: an exact-size raster override wins, then
 * the vector master, then the raster master. Null when the key has no master
 * at all - the caller reports the target as skipped.
 */
export function chooseMaster(brandingDir, key, width, height, virtualMasters = new Set()) {
    const square = width === height ? `${key}-${width}.png` : null;
    const exact = `${key}-${width}x${height}.png`;
    for (const candidate of [square, exact]) {
        if (candidate !== null && existsSync(inBranding(brandingDir, candidate))) {
            return { origin: 'override', file: candidate };
        }
    }
    if (existsSync(inBranding(brandingDir, `${key}.svg`)) || virtualMasters.has(`${key}.svg`)) {
        return { origin: 'vector', file: `${key}.svg` };
    }
    if (existsSync(inBranding(brandingDir, `${key}.png`)) || virtualMasters.has(`${key}.png`)) {
        return { origin: 'raster', file: `${key}.png` };
    }
    return null;
}
/** Absolute path of a master file named with forward slashes. */
export function inBranding(brandingDir, file) {
    return join(brandingDir, ...file.split('/'));
}
/** Files in the branding directory the convention does not know about. */
export function ignoredMasterFiles(brandingDir, keys) {
    if (!existsSync(brandingDir)) {
        return [];
    }
    const known = new Set();
    for (const key of keys) {
        known.add(`${key}.svg`);
        known.add(`${key}.png`);
    }
    const keySet = new Set(keys);
    return listFiles(brandingDir, '')
        .filter((name) => {
        if (known.has(name)) {
            return false;
        }
        const match = /^(.+)-(\d+(?:x\d+)?)\.png$/.exec(name);
        return !(match !== null && keySet.has(match[1] ?? ''));
    })
        .sort();
}
/** Master files the convention recognises, present in the directory; sorted. */
export function knownMasterFiles(brandingDir, keys) {
    if (!existsSync(brandingDir)) {
        return [];
    }
    const ignored = new Set(ignoredMasterFiles(brandingDir, keys));
    return listFiles(brandingDir, '')
        .filter((name) => !ignored.has(name))
        .sort();
}
/** Every file under the branding directory, as forward-slash relative paths. */
function listFiles(root, prefix) {
    const here = prefix === '' ? root : join(root, ...prefix.split('/'));
    const found = [];
    for (const name of readdirSync(here)) {
        const relative = prefix === '' ? name : `${prefix}/${name}`;
        if (statSync(join(here, name)).isDirectory()) {
            found.push(...listFiles(root, relative));
            continue;
        }
        found.push(relative);
    }
    return found;
}
/**
 * Create the branding directory and seed it from the fork tree. Returns the
 * seeded files, or an empty list when the directory already exists - an
 * existing directory is never overwritten, whatever it holds. With `dryRun`
 * the plan is computed and reported, but nothing is created.
 */
export function seedMasters(brandingDir, treeDir, targets, dryRun = false) {
    if (existsSync(brandingDir)) {
        return [];
    }
    const byKey = new Map();
    for (const target of targets) {
        const key = artworkKey(target);
        byKey.set(key, [...(byKey.get(key) ?? []), target]);
    }
    const seeds = [];
    for (const key of [...byKey.keys()].sort()) {
        const candidates = (byKey.get(key) ?? []).flatMap((target) => seedCandidatesOf(treeDir, target));
        // Largest wins: the master is downsampled to every other size, so the
        // most detail available in the tree is the honest starting point.
        candidates.sort((left, right) => right.width * right.height - left.width * left.height);
        const best = candidates[0];
        if (best !== undefined) {
            seeds.push({ file: `${key}.${best.extension}`, seed: best });
        }
    }
    if (dryRun) {
        return seeds.map(({ file, seed }) => ({ file, from: seed.from, width: seed.width, height: seed.height }));
    }
    mkdirSync(brandingDir, { recursive: true });
    const seeded = [];
    for (const { file, seed } of seeds) {
        const path = inBranding(brandingDir, file);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, seed.bytes);
        seeded.push({ file, from: seed.from, width: seed.width, height: seed.height });
    }
    return seeded;
}
/**
 * What one target can contribute as a seed. A container codkit can only write
 * and not read back - .ico frames and .xpm palettes - contributes nothing,
 * which is why the icon family seeds from the PNG and ICNS targets it also
 * carries rather than from the .ico.
 */
function seedCandidatesOf(treeDir, target) {
    const absolute = join(treeDir, ...target.target.split('/'));
    const frame = target.frames[0];
    if (target.kind === 'png' && frame !== undefined) {
        return [
            { from: target.target, bytes: Uint8Array.from(readFileSync(absolute)), width: frame.width, height: frame.height, extension: 'png' }
        ];
    }
    if (target.kind === 'svg' && frame !== undefined) {
        return [
            { from: target.target, bytes: Uint8Array.from(readFileSync(absolute)), width: frame.width, height: frame.height, extension: 'svg' }
        ];
    }
    if (target.kind === 'bmp' && frame !== undefined) {
        const image = decodeBmp(readFileSync(absolute));
        return [{ from: target.target, bytes: encodePng(image), width: image.width, height: image.height, extension: 'png' }];
    }
    if (target.kind === 'icns') {
        const largest = largestIcnsPng(treeDir, target);
        return largest === null
            ? []
            : [
                {
                    from: `${target.target} (${largest.width}x${largest.height} element)`,
                    bytes: largest.bytes,
                    width: largest.width,
                    height: largest.height,
                    extension: 'png'
                }
            ];
    }
    return [];
}
/**
 * Extract the largest PNG payload of an .icns target, or null when the file
 * carries none. The payload is already a PNG; it is written out verbatim.
 */
export function largestIcnsPng(treeDir, target) {
    const bytes = readFileSync(join(treeDir, ...target.target.split('/')));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    let best = null;
    while (at + 8 <= bytes.length) {
        const length = view.getUint32(at + 4);
        const payload = bytes.subarray(at + 8, at + length);
        if (isPng(payload)) {
            const size = pngDimensionsOf(payload);
            if (size !== null && (best === null || size.width * size.height > best.width * best.height)) {
                best = { width: size.width, height: size.height, bytes: Uint8Array.from(payload) };
            }
        }
        at += length;
    }
    return best;
}
function pngDimensionsOf(bytes) {
    if (bytes.length < 24) {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
}
