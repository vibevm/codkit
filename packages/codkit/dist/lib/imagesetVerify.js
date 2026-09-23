/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-VERIFY */
// The imageset verification (IMAGESET-VERIFY): the acceptance bands of
// ##DECISION-IMAGESET-ACCEPTANCE-CRITERION run as an executable gate against
// the distribution the operator already has.
//
// The round trip is the one ##IMAGESET-ROUND-TRIP describes: take the largest
// layer OF THE SAME CONTAINER as the master, regenerate the other layers from
// it through the production pipeline, and compare each with the layer the
// distribution ships. Structure has to match exactly; pixels only have to fall
// inside the band of their size range.
//
// Cross-container comparison is impossible by construction rather than
// discouraged: layers enter this module through layersOf, which takes the
// bytes of ONE file, and the master is picked out of that one list. There is
// no parameter, and no flag, that could point the comparison at a second file
// - and there must not be, because two containers of one product are different
// drawings, not two encodings of one (##IMAGESET-ROUND-TRIP).
//
// A target of the product's declaration is verified against it
// (##IMAGESET-VERIFY-DECLARED): a declared frame set is the structure the file
// must have, and the layers are round-tripped one master key at a time - two
// keys are two drawings, for the same reason two containers are.
//
// One model, two renderings, exactly as the index does it: this module builds
// the ImagesetVerification value, and imagesetVerifyReport.ts renders it as
// Markdown and as the schema-2 payload, so the prose and the JSON cannot
// disagree about a measured number.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from '@codkit/type-api';
import { articleFor, codecFor, readingImage } from './imagesetCodec.js';
import { readDeclaration, resolveTargets } from './imagesetDeclaration.js';
import { resizeRgba } from './imagesetRaster.js';
import { artworkKey, discoverTargets } from './imagesetTargets.js';
import { ckError } from './messages.js';
const BAND_LARGE = { ceiling: 10, label: '256 px and up: mean abs RGB difference at most 10/255' };
const BAND_MEDIUM = { ceiling: 25, label: '64-255 px: mean abs RGB difference at most 25/255' };
const BAND_SMALL = { ceiling: null, label: 'below 64 px: no pixel criterion is asserted, structure only' };
/** All bands in report order; the document prints them from this list. */
export const BANDS = [BAND_LARGE, BAND_MEDIUM, BAND_SMALL];
/** The band a layer of this size falls in; size is its larger dimension. */
export function bandFor(size) {
    if (size >= 256) {
        return BAND_LARGE;
    }
    return size >= 64 ? BAND_MEDIUM : BAND_SMALL;
}
/**
 * Run the verification. Read-only throughout: the fork tree is opened for
 * reading, no lock is taken (the argument of ##DECISION-IMAGESET-INDEX-NO-LOCK
 * holds here too), and neither the patchset nor the masters directory is
 * written or seeded - the masters play no part at all, because the master of
 * every round trip is a layer of the shipped file itself. The declaration is
 * read from the masters directory and checked as `gen` checks it.
 */
export function verifyImageset(options) {
    const discovered = discoverTargets(options.type, options.treeDir, options.onReport);
    const declaration = readDeclaration(options.brandingDir);
    const targets = resolveTargets(options.type, discovered, declaration, options.brandingDir).map((target) => verifyTarget(options.type, options.treeDir, target));
    return {
        treeDir: options.treeDir,
        brandingDir: options.brandingDir,
        declaration: declaration?.file ?? null,
        targets,
        totals: totalsOf(targets)
    };
}
/** 0 when every asserted comparison is inside its band, 1 when one is not. */
export function verificationExitCode(verification) {
    return verification.totals.outside === 0 && verification.totals.structureMismatches === 0 ? 0 : 1;
}
function totalsOf(targets) {
    const totals = {
        targets: targets.length,
        verified: 0,
        unverifiable: 0,
        comparisons: 0,
        inside: 0,
        outside: 0,
        notAsserted: 0,
        structureMismatches: 0
    };
    for (const target of targets) {
        if (!target.verifiable) {
            totals.unverifiable += 1;
            continue;
        }
        totals.verified += 1;
        if (target.structure !== null && !target.structure.matches) {
            totals.structureMismatches += 1;
        }
        for (const layer of target.layers) {
            if (layer.verdict === 'master' || layer.verdict === 'alone') {
                continue;
            }
            totals.comparisons += 1;
            if (layer.verdict === 'inside') {
                totals.inside += 1;
            }
            else if (layer.verdict === 'outside') {
                totals.outside += 1;
            }
            else {
                totals.notAsserted += 1;
            }
        }
    }
    return totals;
}
/**
 * The layers of one file, through the codec of its container. The bytes are the
 * only input, so nothing outside this file can become the master of its round
 * trip - and the engine learns what a layer is without naming the container.
 */
function layersOf(codec, file, bytes) {
    return readingImage(file, () => {
        const frames = codec.parse(bytes);
        const payloads = codec.extract(bytes);
        return frames.map((frame, index) => {
            const png = payloads[index] ?? null;
            if (png === null) {
                throw ckError('ARTIFACT-BROKEN', `${file}: the container carries a layer it cannot give back as a picture`, 'a layered container must return the payload of every frame it declares');
            }
            return { label: frame.type ?? `${frame.width}x${frame.height}`, frame, type: frame.type, image: decodePng(png) };
        });
    });
}
/** The structural signature of a container: layers, sizes, in file order. */
function signatureOf(kind, layers) {
    return framesSignature(kind, layers.map((layer) => ({ type: layer.type, width: layer.image.width, height: layer.image.height })));
}
function framesSignature(kind, frames) {
    return `${kind.toUpperCase()} ${frames.map(frameLabel).join(' ')}`;
}
function frameLabel(frame) {
    return `${frame.type === null ? '' : `${frame.type}:`}${frame.width}x${frame.height}`;
}
/** What a declaration lists and the file lacks, and what the file carries unlisted. */
function structuralDrift(declared, shipped) {
    const unmatched = shipped.map((layer) => frameLabel({ type: layer.type, width: layer.image.width, height: layer.image.height }));
    const missing = [];
    for (const frame of declared) {
        const at = unmatched.indexOf(frameLabel(frame));
        if (at === -1) {
            missing.push(frameLabel(frame));
        }
        else {
            unmatched.splice(at, 1);
        }
    }
    return { missing, extra: unmatched };
}
/** The master key of a layer: the key the target gives the frame of its size, or the target's own. */
function keyOfLayer(target, layer) {
    const at = target.frames.findIndex((frame) => frame.width === layer.image.width && frame.height === layer.image.height && frame.type === layer.type);
    return target.frameSources[at]?.key ?? artworkKey(target);
}
function verifyTarget(type, treeDir, target) {
    const codec = codecFor(type, target.kind);
    const base = {
        target: target.target,
        family: target.family,
        key: artworkKey(target),
        role: target.role,
        container: target.kind,
        legacyTypes: target.legacyTypes,
        framesDeclared: target.framesDeclared
    };
    const unverifiable = (reason) => ({
        ...base,
        verifiable: false,
        reason,
        master: null,
        masters: [],
        structure: null,
        layers: []
    });
    if (!codec.layered) {
        return unverifiable(`${articleFor(target.kind)} ${target.kind.toUpperCase()} target carries exactly one layer, so no layer of it can be regenerated from another`);
    }
    const bytes = readFileSync(join(treeDir, ...target.target.split('/')));
    const shipped = layersOf(codec, target.target, bytes);
    const shippedSignature = signatureOf(target.kind, shipped);
    // A declared frame set is the structure the file must have, not the frames
    // the pin shipped (##IMAGESET-VERIFY-DECLARED).
    const declared = target.framesDeclared ? framesSignature(target.kind, target.frames) : null;
    if (shipped.length < 2 && (declared === null || declared === shippedSignature)) {
        return unverifiable(`the shipped file carries a single layer (${shipped[0]?.label ?? 'none'}), so there is nothing to regenerate it from`);
    }
    // Every layer is compared within the master key that serves it, and the
    // master of a key is its largest layer in THIS file, first in file order on
    // a tie (a container may carry two layers at one size, and the round trip
    // has to be reproducible rather than dependent on which one was seen last).
    const keys = shipped.map((layer) => keyOfLayer(target, layer));
    const masterOf = new Map();
    shipped.forEach((layer, index) => {
        const key = keys[index] ?? '';
        const best = masterOf.get(key);
        if (best === undefined || area(layer.image) > area(best.image)) {
            masterOf.set(key, layer);
        }
    });
    const masterAt = (index) => masterOf.get(keys[index] ?? '') ?? shipped[index];
    // The regenerated container is decoded back out of its own bytes, so the
    // comparison runs against what the encoder really wrote and not against the
    // buffer that went into it.
    const regenerated = layersOf(codec, target.target, regenerate(codec, target, shipped, masterAt));
    const regeneratedSignature = signatureOf(target.kind, regenerated);
    const drift = declared === null ? { missing: [], extra: [] } : structuralDrift(target.frames, shipped);
    const structure = {
        shipped: shippedSignature,
        regenerated: regeneratedSignature,
        declared,
        missing: drift.missing,
        extra: drift.extra,
        matches: shippedSignature === regeneratedSignature && (declared === null || declared === shippedSignature)
    };
    const severalKeys = masterOf.size > 1;
    const layers = shipped.map((layer, index) => {
        const key = keys[index] ?? '';
        const master = masterAt(index);
        const compared = compareLayer(layer, layer === master ? null : (regenerated[index] ?? null), structure.matches, key);
        const alone = layer === master && severalKeys && keys.filter((other) => other === key).length === 1;
        return alone ? { ...compared, verdict: 'alone' } : compared;
    });
    // The report names the master of the key the largest layer belongs to, as it
    // always has, and every key's master beside it.
    const largest = shipped.reduce((best, layer) => (area(layer.image) > area(best.image) ? layer : best));
    const masters = [...masterOf.entries()].map(([key, layer]) => ({ key, label: layer.label }));
    return { ...base, verifiable: true, reason: null, master: masterAt(shipped.indexOf(largest)).label, masters, structure, layers };
}
/**
 * The production pipeline, and only it: decoded master -> resizeRgba -> the
 * container encoder. A master layer keeps its own pixels - it is the source of
 * the round trip of its key, not a result of it.
 */
function regenerate(codec, target, shipped, masterAt) {
    const payloads = shipped.map((layer, index) => {
        const master = masterAt(index);
        return {
            frame: layer.frame,
            png: encodePng(layer === master ? master.image : resizeRgba(master.image, layer.image.width, layer.image.height))
        };
    });
    return readingImage(target.target, () => codec.encode(payloads, target.stem));
}
function compareLayer(shipped, regenerated, structureMatches, key) {
    const { width, height } = shipped.image;
    const band = bandFor(Math.max(width, height));
    const common = { label: shipped.label, key, type: shipped.type, width, height, band };
    if (regenerated === null) {
        return { ...common, measured: null, verdict: 'master' };
    }
    // A structural mismatch is already the failure; measuring across it would
    // only report a second, derived number for the same defect.
    if (!structureMatches || regenerated.image.width !== width || regenerated.image.height !== height) {
        return { ...common, measured: null, verdict: 'outside' };
    }
    const measured = meanAbsoluteRgbDifference(regenerated.image, shipped.image);
    if (band.ceiling === null) {
        return { ...common, measured, verdict: 'not-asserted' };
    }
    return { ...common, measured, verdict: measured <= band.ceiling ? 'inside' : 'outside' };
}
/**
 * The house metric: the mean absolute difference over the three RGB channels
 * of the raw decoded straight-alpha buffers. Alpha is outside the average and
 * nothing is composited onto a background - every figure the specification
 * quotes was measured this way, so a different metric here would make the
 * report incomparable with the table it is checked against.
 */
export function meanAbsoluteRgbDifference(left, right) {
    if (left.width !== right.width || left.height !== right.height) {
        throw ckError('ARTIFACT-BROKEN', `cannot compare a ${left.width}x${left.height} layer with a ${right.width}x${right.height} one`, 'the two layers must have the same dimensions');
    }
    let sum = 0;
    for (let at = 0; at < left.data.length; at += 4) {
        sum += Math.abs((left.data[at] ?? 0) - (right.data[at] ?? 0));
        sum += Math.abs((left.data[at + 1] ?? 0) - (right.data[at + 1] ?? 0));
        sum += Math.abs((left.data[at + 2] ?? 0) - (right.data[at + 2] ?? 0));
    }
    return sum / (left.width * left.height * 3);
}
function area(image) {
    return image.width * image.height;
}
