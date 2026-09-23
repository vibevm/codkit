/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-VERIFY */
// The two renderings of a verification (IMAGESET-VERIFY): `verificationData`,
// the schema-2 payload, and `renderImagesetVerification`, the Markdown - both
// walking the one ImagesetVerification model imagesetVerify.ts builds, so the
// prose and the JSON cannot disagree about a measured number.
import { BANDS } from './imagesetVerify.js';
/** Two decimals: the report is a number someone re-measures, not a verdict. */
function measured(value) {
    return value === null ? '-' : value.toFixed(2);
}
/** The envelope payload: the same model, structurally. */
export function verificationData(verification) {
    return {
        treeDir: verification.treeDir,
        brandingDir: verification.brandingDir,
        declaration: verification.declaration,
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
            masters: target.masters.map((master) => ({ key: master.key, label: master.label })),
            framesDeclared: target.framesDeclared,
            structure: target.structure === null
                ? null
                : { ...target.structure, missing: [...target.structure.missing], extra: [...target.structure.extra] },
            legacyTypes: [...target.legacyTypes],
            layers: target.layers.map((layer) => ({
                label: layer.label,
                key: layer.key,
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
    lines.push(`Every raster target of the fork tree at \`${verification.treeDir}\`, round-tripped against`, 'itself: the largest layer of a container is taken as the master, the other layers are', 'regenerated from it through the pipeline `codkit imageset gen` uses, and each is compared', 'with the layer the distribution ships. The master is always a layer of the same file:', 'two containers of one product are different drawings, so comparing them would measure', 'the difference between the drawings and not between the pipelines.', '', 'The number is the mean absolute difference over the R, G and B channels of the decoded', 'layers, in units of 1/255. Alpha is not in the average and nothing is composited onto a', 'background: measure it any other way and the figures below stop being comparable with', 'the ones the acceptance criterion was set from.', '', ...bandSection(), '', ...summarySection(verification), '', '## Targets', '');
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
        ...(verification.declaration === null
            ? []
            : [`- declaration: \`${verification.declaration}\` - its targets are verified against it, one master key at a time`]),
        '',
        verdict
    ];
}
function targetSection(target) {
    const severalKeys = target.masters.length > 1;
    const masterLine = severalKeys
        ? `master layers: ${target.masters.map((master) => `\`${master.label}\` for key \`${master.key}\``).join(', ')} - the largest layer of each key in this same file`
        : `master layer: \`${target.master ?? ''}\` - the largest layer of this same file`;
    const lines = [
        `### \`${target.target}\``,
        '',
        `- Role: ${target.role}`,
        `- Container: ${target.container.toUpperCase()}; family: \`${target.family}\`; ${masterLine}`,
        ...structureLines(target.structure)
    ];
    if (target.legacyTypes.length > 0) {
        lines.push(`- Legacy elements carried by the shipped file and not regenerated: ${target.legacyTypes.join(', ')}`);
    }
    lines.push('', '| Layer | Size | Band | Measured | Verdict |', '| --- | --- | --- | --- | --- |');
    for (const layer of target.layers) {
        const ceiling = layer.band.ceiling === null ? 'not asserted' : `at most ${layer.band.ceiling}/255`;
        const band = layer.verdict === 'master' ? 'the master' : layer.verdict === 'alone' ? 'not compared' : ceiling;
        const label = severalKeys ? `\`${layer.label}\`, key \`${layer.key}\`` : `\`${layer.label}\``;
        lines.push(`| ${label} | ${layer.width}x${layer.height} | ${band} | ${measured(layer.measured)} | ${verdictText(layer, severalKeys)} |`);
    }
    return lines;
}
/** The structure against the shipped file, and against the declaration where there is one. */
function structureLines(structure) {
    if (structure === null) {
        return [];
    }
    const lines = [];
    if (structure.declared === null) {
        lines.push(`- Structure: ${structure.matches ? 'matches the shipped file' : 'DIFFERS from the shipped file'} - \`${structure.shipped}\``);
    }
    else if (structure.declared === structure.shipped) {
        lines.push(`- Structure: the file matches the declaration - \`${structure.declared}\``);
    }
    else {
        lines.push(`- Structure: the file DIFFERS from the declaration \`${structure.declared}\` - it carries \`${structure.shipped}\``);
        if (structure.missing.length > 0) {
            lines.push(`- Declared and missing from the file: ${structure.missing.join(', ')}`);
        }
        if (structure.extra.length > 0) {
            lines.push(`- In the file and not declared: ${structure.extra.join(', ')}`);
        }
        if (structure.missing.length === 0 && structure.extra.length === 0) {
            lines.push('- The file carries the declared frames in another order');
        }
    }
    if (structure.regenerated !== structure.shipped) {
        lines.push(`- Regenerated structure: \`${structure.regenerated}\``);
    }
    return lines;
}
function verdictText(layer, severalKeys) {
    if (layer.verdict === 'master') {
        return severalKeys
            ? `the layer the other layers of key \`${layer.key}\` are regenerated from`
            : 'the layer everything else is regenerated from';
    }
    if (layer.verdict === 'alone') {
        return `the only layer of key \`${layer.key}\` in this file, so nothing here regenerates it`;
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
