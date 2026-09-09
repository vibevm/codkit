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
// - and there must not be, because an .icns and an .ico of the same product
// are different drawings, not two encodings of one (##IMAGESET-ROUND-TRIP).
//
// One model, two renderings, exactly as the index does it: `render` writes the
// Markdown and `verificationData` the schema-2 payload, both walking the same
// ImagesetVerification value, so the prose and the JSON cannot disagree about
// a measured number.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeIcnsElements, encodeIcns } from './imagesetIcns.js';
import { decodeIcoFrames, encodeIco } from './imagesetIco.js';
import { encodePng } from './imagesetPng.js';
import { resizeRgba } from './imagesetRaster.js';
import { artworkKey, discoverTargets } from './imagesetTargets.js';
import { ckError } from './messages.js';
/** The two containers that carry more than one layer, and so a round trip. */
const LAYERED = new Set(['ico', 'icns']);
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
 * every round trip is a layer of the shipped file itself.
 */
export function verifyImageset(options) {
    const targets = discoverTargets(options.treeDir, options.onReport).map((target) => verifyTarget(options.treeDir, target));
    return { treeDir: options.treeDir, brandingDir: options.brandingDir, targets, totals: totalsOf(targets) };
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
            if (layer.verdict === 'master') {
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
 * The layers of one file. The bytes are the only input, so nothing outside
 * this file can become the master of its round trip.
 */
function layersOf(kind, bytes) {
    if (kind === 'ico') {
        return decodeIcoFrames(bytes).map((frame) => ({ label: `${frame.width}x${frame.height}`, type: null, image: frame.image }));
    }
    return decodeIcnsElements(bytes).map((element) => ({ label: element.type, type: element.type, image: element.image }));
}
/** The structural signature of a container: layers, sizes, in file order. */
function signatureOf(kind, layers) {
    const parts = layers.map((layer) => `${layer.type === null ? '' : `${layer.type}:`}${layer.image.width}x${layer.image.height}`);
    return `${kind.toUpperCase()} ${parts.join(' ')}`;
}
function verifyTarget(treeDir, target) {
    const base = {
        target: target.target,
        family: target.family,
        key: artworkKey(target),
        role: target.role,
        container: target.kind,
        legacyTypes: target.legacyTypes
    };
    const unverifiable = (reason) => ({
        ...base,
        verifiable: false,
        reason,
        master: null,
        structure: null,
        layers: []
    });
    if (!LAYERED.has(target.kind)) {
        return unverifiable(`${article(target.kind)} ${target.kind.toUpperCase()} target carries exactly one layer, so no layer of it can be regenerated from another`);
    }
    const bytes = readFileSync(join(treeDir, ...target.target.split('/')));
    const shipped = layersOf(target.kind, bytes);
    if (shipped.length < 2) {
        return unverifiable(`the shipped file carries a single layer (${shipped[0]?.label ?? 'none'}), so there is nothing to regenerate it from`);
    }
    // The master: the largest layer of THIS file, first in file order on a tie
    // (an .icns ships ic08 and ic13 at the same size, and the round trip has to
    // be reproducible rather than dependent on which one was seen last).
    const master = shipped.reduce((best, layer) => (area(layer.image) > area(best.image) ? layer : best));
    // The regenerated container is decoded back out of its own bytes, so the
    // comparison runs against what the encoder really wrote and not against the
    // buffer that went into it.
    const regenerated = layersOf(target.kind, regenerate(target.kind, shipped, master));
    const shippedSignature = signatureOf(target.kind, shipped);
    const regeneratedSignature = signatureOf(target.kind, regenerated);
    const structure = {
        shipped: shippedSignature,
        regenerated: regeneratedSignature,
        matches: shippedSignature === regeneratedSignature
    };
    const layers = shipped.map((layer, index) => compareLayer(layer, layer === master ? null : (regenerated[index] ?? null), structure.matches));
    return { ...base, verifiable: true, reason: null, master: master.label, structure, layers };
}
/**
 * The production pipeline, and only it: decoded master -> resizeRgba -> the
 * container encoder. The master layer keeps its own pixels - it is the source
 * of the round trip, not a result of it.
 */
function regenerate(kind, shipped, master) {
    const images = shipped.map((layer) => layer === master ? master.image : resizeRgba(master.image, layer.image.width, layer.image.height));
    if (kind === 'ico') {
        return encodeIco(images.map((image) => ({ width: image.width, height: image.height, png: encodePng(image) })));
    }
    return encodeIcns(images.map((image, index) => {
        const type = shipped[index]?.type;
        if (type === undefined || type === null) {
            throw ckError('ARTIFACT-BROKEN', 'ICNS: an element reached regeneration without its type', 'the target must be an intact .icns file');
        }
        return { type, png: encodePng(image) };
    }));
}
function compareLayer(shipped, regenerated, structureMatches) {
    const { width, height } = shipped.image;
    const band = bandFor(Math.max(width, height));
    const common = { label: shipped.label, type: shipped.type, width, height, band };
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
/** The article a container name takes when it is read out letter by letter. */
function article(kind) {
    return kind === 'png' || kind === 'bmp' ? 'a' : 'an';
}
function area(image) {
    return image.width * image.height;
}
/** Two decimals: the report is a number someone re-measures, not a verdict. */
function measured(value) {
    return value === null ? '-' : value.toFixed(2);
}
/** The envelope payload: the same model, structurally. */
export function verificationData(verification) {
    return {
        treeDir: verification.treeDir,
        brandingDir: verification.brandingDir,
        metric: 'mean absolute difference over the R, G and B channels of the decoded straight-alpha layers, in units of 1/255',
        bands: BANDS.map((band) => ({ ceiling: band.ceiling, label: band.label })),
        totals: { ...verification.totals },
        targets: verification.targets.map((target) => ({
            target: target.target,
            family: target.family,
            key: target.key,
            role: target.role,
            container: target.container,
            verifiable: target.verifiable,
            reason: target.reason,
            master: target.master,
            structure: target.structure === null ? null : { ...target.structure },
            legacyTypes: [...target.legacyTypes],
            layers: target.layers.map((layer) => ({
                label: layer.label,
                type: layer.type,
                width: layer.width,
                height: layer.height,
                band: layer.band.ceiling,
                measured: layer.measured,
                verdict: layer.verdict
            }))
        }))
    };
}
/** The Markdown document: the same model, in the form a person reads. */
export function renderImagesetVerification(verification) {
    const lines = ['# Icon set verification', ''];
    lines.push(`Every raster target of the fork tree at \`${verification.treeDir}\`, round-tripped against`, 'itself: the largest layer of a container is taken as the master, the other layers are', 'regenerated from it through the pipeline `codkit imageset gen` uses, and each is compared', 'with the layer the distribution ships. The master is always a layer of the same file - an', '`.icns` and an `.ico` of one product are different drawings, so comparing them would', 'measure the difference between the drawings and not between the pipelines.', '', 'The number is the mean absolute difference over the R, G and B channels of the decoded', 'layers, in units of 1/255. Alpha is not in the average and nothing is composited onto a', 'background: measure it any other way and the figures below stop being comparable with', 'the ones the acceptance criterion was set from.', '', ...bandSection(), '', ...summarySection(verification), '', '## Targets', '');
    for (const target of verification.targets.filter((candidate) => candidate.verifiable)) {
        lines.push(...targetSection(target), '');
    }
    lines.push(...unverifiableSection(verification));
    return lines.join('\n');
}
function bandSection() {
    const lines = ['## Bands', '', '| Size range | Accepted mean difference |', '| --- | --- |'];
    for (const band of BANDS) {
        const [range, criterion] = splitBandLabel(band);
        lines.push(`| ${range} | ${criterion} |`);
    }
    return lines;
}
function splitBandLabel(band) {
    const at = band.label.indexOf(':');
    return [band.label.slice(0, at), band.label.slice(at + 1).trim()];
}
function summarySection(verification) {
    const { totals } = verification;
    const verdict = totals.outside === 0 && totals.structureMismatches === 0
        ? 'Every asserted comparison is inside its band.'
        : `${totals.outside} comparison(s) outside the band and ${totals.structureMismatches} structural mismatch(es): this is the gate, and it is red.`;
    return [
        '## Summary',
        '',
        `- targets discovered: ${totals.targets} - ${totals.verified} round-tripped, ${totals.unverifiable} unverifiable`,
        `- comparisons: ${totals.comparisons} - ${totals.inside} inside the band, ${totals.outside} outside, ${totals.notAsserted} in a range where no pixel criterion is asserted`,
        `- structure: ${totals.structureMismatches === 0 ? 'every regenerated container matches the shipped one' : `${totals.structureMismatches} target(s) differ`}`,
        '',
        verdict
    ];
}
function targetSection(target) {
    const lines = [
        `### \`${target.target}\``,
        '',
        `- Role: ${target.role}`,
        `- Container: ${target.container.toUpperCase()}; family: \`${target.family}\`; master layer: \`${target.master ?? ''}\` - the largest layer of this same file`,
        `- Structure: ${target.structure?.matches === true ? 'matches the shipped file' : 'DIFFERS from the shipped file'} - \`${target.structure?.shipped ?? ''}\``
    ];
    if (target.structure?.matches === false) {
        lines.push(`- Regenerated structure: \`${target.structure.regenerated}\``);
    }
    if (target.legacyTypes.length > 0) {
        lines.push(`- Legacy elements carried by the shipped file and not regenerated: ${target.legacyTypes.join(', ')}`);
    }
    lines.push('', '| Layer | Size | Band | Measured | Verdict |', '| --- | --- | --- | --- | --- |');
    for (const layer of target.layers) {
        const ceiling = layer.band.ceiling === null ? 'not asserted' : `at most ${layer.band.ceiling}/255`;
        lines.push(`| \`${layer.label}\` | ${layer.width}x${layer.height} | ${layer.verdict === 'master' ? 'the master' : ceiling} | ${measured(layer.measured)} | ${verdictText(layer)} |`);
    }
    return lines;
}
function verdictText(layer) {
    if (layer.verdict === 'master') {
        return 'the layer everything else is regenerated from';
    }
    if (layer.verdict === 'inside') {
        return 'inside the band';
    }
    if (layer.verdict === 'outside') {
        return 'OUTSIDE the band';
    }
    return 'measured, not asserted at this size';
}
function unverifiableSection(verification) {
    const unverifiable = verification.targets.filter((target) => !target.verifiable);
    const lines = ['## Unverifiable targets', ''];
    if (unverifiable.length === 0) {
        lines.push('None: every discovered target carries more than one layer.', '');
        return lines;
    }
    lines.push('These carry no round trip of their own, so they are reported and NOT counted as passed.', 'A single-layer target is checked by the guard suite of its family instead.', '', '| Target | Container | Why |', '| --- | --- | --- |');
    for (const target of unverifiable) {
        lines.push(`| \`${target.target}\` | ${target.container.toUpperCase()} | ${target.reason ?? ''} |`);
    }
    lines.push('');
    return lines;
}
