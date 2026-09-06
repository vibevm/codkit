/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-MASTERS */
// Master discovery and seeding (IMAGESET-MASTERS).
//
// Naming convention of the branding directory:
//   <family>.svg          vector master of a family (rendered per size);
//   <family>.png          raster master of a family (resampled per size);
//   <family>-<N>.png      per-size override, used verbatim at exactly NxN;
//   <family>-<W>x<H>.png  per-size override for non-square sizes.
// A per-size override beats the vector master, and the vector master beats
// the raster one. Anything else in the directory is reported as ignored -
// nothing is silently picked up, and nothing is silently skipped.
//
// Seeding: when the directory does not exist, the first run creates it and
// fills it with the distribution's own artwork, read from the fork tree: the
// largest icon raster becomes icon.png, the largest installer bitmap of each
// family becomes that family's master. Seeding is reported, never silent, and
// an existing directory is never touched.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeBmp } from './imagesetBmp.js';
import { encodePng, isPng } from './imagesetPng.js';
/** Where masters live when the operator did not say otherwise. */
export function defaultBrandingDir(patchesDir) {
    return join(patchesDir, 'branding');
}
/**
 * The master that serves one frame: an exact-size raster override wins, then
 * the vector master, then the raster master. Null when the family has no
 * master at all - the caller reports the target as skipped.
 */
export function chooseMaster(brandingDir, family, width, height, virtualMasters = new Set()) {
    const square = width === height ? `${family}-${width}.png` : null;
    const exact = `${family}-${width}x${height}.png`;
    for (const candidate of [square, exact]) {
        if (candidate !== null && existsSync(join(brandingDir, candidate))) {
            return { origin: 'override', file: candidate };
        }
    }
    if (existsSync(join(brandingDir, `${family}.svg`))) {
        return { origin: 'vector', file: `${family}.svg` };
    }
    if (existsSync(join(brandingDir, `${family}.png`)) || virtualMasters.has(family)) {
        return { origin: 'raster', file: `${family}.png` };
    }
    return null;
}
/** Files in the branding directory the convention does not know about. */
export function ignoredMasterFiles(brandingDir, families) {
    if (!existsSync(brandingDir)) {
        return [];
    }
    const known = new Set();
    for (const family of families) {
        known.add(`${family}.svg`);
        known.add(`${family}.png`);
    }
    return readdirSync(brandingDir)
        .filter((name) => {
        if (known.has(name)) {
            return false;
        }
        const match = /^([a-z0-9-]+)-(\d+(?:x\d+)?)\.png$/.exec(name);
        return !(match !== null && families.includes(match[1] ?? ''));
    })
        .sort();
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
    const seeds = [];
    const iconCandidates = [];
    for (const target of targets) {
        if (target.family !== 'icon') {
            continue;
        }
        if (target.kind === 'png') {
            const frame = target.frames[0];
            if (frame === undefined) {
                continue;
            }
            iconCandidates.push({
                from: target.target,
                bytes: Uint8Array.from(readFileSync(join(treeDir, ...target.target.split('/')))),
                width: frame.width,
                height: frame.height
            });
            continue;
        }
        if (target.kind === 'icns') {
            const largest = largestIcnsPng(treeDir, target);
            if (largest !== null) {
                iconCandidates.push({
                    from: `${target.target} (${largest.width}x${largest.height} element)`,
                    bytes: largest.bytes,
                    width: largest.width,
                    height: largest.height
                });
            }
        }
    }
    const icon = iconCandidates.sort((left, right) => right.width * right.height - left.width * left.height)[0];
    if (icon !== undefined) {
        seeds.push({ file: 'icon.png', seed: icon });
    }
    for (const family of ['installer-big', 'installer-small']) {
        const sized = targets
            .filter((target) => target.family === family)
            .flatMap((target) => {
            const frame = target.frames[0];
            return frame === undefined ? [] : [{ target, frame }];
        });
        sized.sort((left, right) => right.frame.width * right.frame.height - left.frame.width * left.frame.height);
        const largest = sized[0];
        if (largest !== undefined) {
            const image = decodeBmp(readFileSync(join(treeDir, ...largest.target.target.split('/'))));
            seeds.push({
                file: `${family}.png`,
                seed: { from: largest.target.target, bytes: encodePng(image), width: image.width, height: image.height }
            });
        }
    }
    if (dryRun) {
        return seeds.map(({ file, seed }) => ({ file, from: seed.from, width: seed.width, height: seed.height }));
    }
    mkdirSync(brandingDir, { recursive: true });
    const seeded = [];
    for (const { file, seed } of seeds) {
        writeFileSync(join(brandingDir, file), seed.bytes);
        seeded.push({ file, from: seed.from, width: seed.width, height: seed.height });
    }
    return seeded;
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
