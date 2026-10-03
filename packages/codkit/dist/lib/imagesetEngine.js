/** @scope spec://codkit/modules/codkit/PROP-007#CMD-IMAGESET */
import { pinKey } from './pinIdentity.js';
// The imageset engine (CMD-IMAGESET): regenerate the product's icon set from
// the branding masters and deliver it as ordinary resource-layer artifacts -
// files under delta/resources/files/ plus map entries. The fork tree is only
// read; the operator reviews the delta and commits it themselves. No other
// command invokes this one, and this one invokes no other.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codecFor, readingImage } from './imagesetCodec.js';
import { readDeclaration, resolveTargets } from './imagesetDeclaration.js';
import { DECLARATION_FILE, REDUCED_TO_8_BITS, chooseMaster, ignoredMasterFiles, masterReader, seedMasters } from './imagesetMasters.js';
import { encodePng } from '@codkit/type-api';
import { formatVectorSize, renderSvgToRgba, stretchOf, stretchPhrase } from './imagesetRender.js';
import { resizeRgba } from './imagesetRaster.js';
import { artworkKey, discoverTargets } from './imagesetTargets.js';
import { ckError } from './messages.js';
import { ownTestIds } from './inventory.js';
import { RESOURCE_FILES_PREFIX, RESOURCE_MAP_PATH, assertTargetAtPin, loadResourceMap, serializeResourceMap } from './layers/resource.js';
/** The guard-test id convention: one suite per family, declared in own code. */
export function guardTestId(family) {
    return `guard.brand.${family}`;
}
/**
 * Run the regeneration. Every validation happens before the first write: a
 * refused run leaves the patchset byte-identical, which is what makes a retry
 * after fixing the report cheap and safe.
 */
export function runImageset(options) {
    const { patchesDir, treeDir, brandingDir, dryRun, onInfo, onWarn } = options;
    onInfo(`branding: ${brandingDir}`);
    const discovered = discoverTargets(options.type, treeDir, onInfo);
    // The declaration is checked in full before a master is read or a byte is
    // written (##IMAGESET-DECLARATION); a run that seeds has none to check.
    const targets = resolveTargets(options.type, discovered, readDeclaration(brandingDir), brandingDir);
    const seeded = seedMasters(options.type, brandingDir, treeDir, discovered, dryRun);
    for (const seed of seeded) {
        onInfo(`${dryRun ? 'would seed' : 'seeded'} branding/${seed.file} from ${seed.from} (${seed.width}x${seed.height})`);
    }
    const keys = [...new Set(targets.flatMap((target) => [artworkKey(target), ...target.frameSources.map((source) => source.key)]))].sort();
    for (const ignored of ignoredMasterFiles(brandingDir, keys)) {
        onWarn(`branding file matches no master convention and was ignored: ${ignored}`);
    }
    // In a dry run the planned seeds are not on disk yet; the plan still has
    // to say which master would serve each frame, so a planned seed counts as
    // the master it will become - and its bytes are the master the plan reads.
    const virtualMasters = new Set(seeded.map((seed) => seed.file));
    const masters = masterReader(brandingDir, new Map(seeded.map((seed) => [seed.file, seed.bytes])));
    const map = loadResourceMap(patchesDir);
    const ownerOf = ownerResolver(patchesDir);
    const declaredTests = ownTestIds(patchesDir);
    const renders = [];
    const skipReport = [];
    for (const target of targets) {
        const rendered = renderTarget(options.type, brandingDir, target, virtualMasters, dryRun, masters);
        if (rendered.skipped !== null) {
            skipReport.push({ target, reason: rendered.skipped });
            continue;
        }
        renders.push({ target, bytes: rendered.bytes, frames: rendered.frames });
    }
    for (const skip of skipReport) {
        onWarn(`skipped ${skip.target.target}: ${skip.reason}`);
    }
    // A stretched frame is delivered all the same, so it is a warning and not a
    // skip: one line per frame, in the run and in its plan alike, naming the
    // size of the master that has to change (##IMAGESET-STRETCH-REPORTED).
    for (const render of renders) {
        for (const frame of render.frames) {
            if (frame.stretch?.stretched === true) {
                onWarn(`${render.target.target}: ${frame.source} (the master is ${formatVectorSize(frame.stretch.master)})`);
            }
        }
    }
    const created = [];
    const updated = [];
    const writes = [];
    const entries = map === null ? [] : [...map.entries];
    for (const render of renders) {
        const existing = entries.find((entry) => entry.target === render.target.target);
        const source = existing !== undefined ? existing.source : `${RESOURCE_FILES_PREFIX}${render.target.target}`;
        if (existing !== undefined) {
            updated.push(render.target.target);
            const at = entries.indexOf(existing);
            entries[at] = { ...existing, pin: `${pinKey(options.pin)}@${options.pin.sha}` };
        }
        else {
            created.push(render.target.target);
            entries.push({
                id: brandArtifactId(render.target.target),
                target: render.target.target,
                source,
                type: 'modify',
                category: 'own',
                owner: ownerOf(render.target.target),
                reason: `product brand asset at ${render.target.target}`,
                link: 'none',
                cause: 'none',
                pin: `${pinKey(options.pin)}@${options.pin.sha}`,
                contractTests: [guardTestId(render.target.family)]
            });
        }
        const entry = entries.find((candidate) => candidate.target === render.target.target) ?? null;
        writes.push({ path: join(patchesDir, ...source.split('/')), bytes: render.bytes, entry });
    }
    if (dryRun) {
        for (const render of renders) {
            onInfo(`would regenerate ${render.target.target}: ${describeFrames(render.target)}`);
            for (const frame of render.frames) {
                onInfo(`  ${frame.width}x${frame.height}: ${frame.source}`);
            }
        }
        for (const path of created) {
            onInfo(`would create map entry ${brandArtifactId(path)} for ${path}`);
        }
        for (const path of updated) {
            onInfo(`would refresh the map entry pin for ${path}`);
        }
        onInfo('dry run: nothing written');
        return {
            exitCode: skipReport.length === 0 ? 0 : 1,
            report: buildReport(options, seeded, targets, renders, created, updated, skipReport, [])
        };
    }
    const missingGuards = entries
        .filter((entry) => created.includes(entry.target))
        .filter((entry) => !entry.contractTests.every((test) => declaredTests.has(test)));
    if (missingGuards.length > 0) {
        throw ckError('GUARD-MISSING', `new resource entries need a declared guard test: ${missingGuards.map((entry) => `${entry.id} names ${entry.contractTests.join(', ')}`).join('; ')}`, `write suite('${guardTestId('<family>')}') into a test file under delta/own/test/ first - the resource layer has no marker blocks, so the guard is mandatory`);
    }
    for (const write of writes) {
        if (write.entry !== null) {
            assertTargetAtPin(treeDir, options.pin.sha, write.entry);
        }
    }
    for (const write of writes) {
        mkdirSync(dirname(write.path), { recursive: true });
        writeFileSync(write.path, write.bytes);
    }
    if (created.length > 0 || updated.length > 0) {
        const document = { entries };
        writeFileSync(join(patchesDir, ...RESOURCE_MAP_PATH.split('/')), serializeResourceMap(document));
    }
    for (const render of renders) {
        onInfo(`regenerated ${render.target.target}: ${render.frames.map((frame) => `${frame.width}x${frame.height} (${frame.source})`).join(', ')}`);
    }
    for (const path of created) {
        onInfo(`map entry created: ${brandArtifactId(path)} -> ${RESOURCE_FILES_PREFIX}${path}`);
    }
    for (const path of updated) {
        onInfo(`map entry pin refreshed: ${path}`);
    }
    onInfo(`wrote ${writes.length} artifact file(s) into ${RESOURCE_FILES_PREFIX}`);
    return {
        exitCode: skipReport.length === 0 ? 0 : 1,
        report: buildReport(options, seeded, targets, renders, created, updated, skipReport, writes.map((write) => write.path))
    };
}
/**
 * One target of the run: its plan, and - unless this is a dry run - the
 * container written from the pixels the plan produced.
 */
function renderTarget(type, brandingDir, target, virtualMasters, dryRun, masters) {
    const plan = planTarget(type, brandingDir, target, virtualMasters, masters, !dryRun);
    if (plan.skipped !== null) {
        return { bytes: new Uint8Array(0), frames: [], skipped: plan.skipped };
    }
    if (dryRun) {
        return { bytes: new Uint8Array(0), frames: [...plan.frames], skipped: null };
    }
    if (plan.emitted !== null) {
        return { bytes: plan.emitted, frames: [...plan.frames], skipped: null };
    }
    // The container is written by its own codec, from the PNG payloads the
    // pipeline rendered: the engine never names one (##TYPE-ENGINE-IS-BLIND).
    const codec = codecFor(type, target.kind);
    const bytes = readingImage(target.target, () => codec.encode(plan.images.map((item) => ({ frame: item.frame, png: encodePng(item.image) })), target.stem));
    return { bytes, frames: [...plan.frames], skipped: null };
}
/**
 * Apply the rules of the run to one target: choose the master of every frame,
 * read it the way the run reads it, and state what the run reports about the
 * frame and why it would skip the target. With `produce` the pixels are made
 * as well; without it nothing is rendered, and the dry run and the index get
 * the very verdict of the run - its refusals, its skips and its facts - from
 * the very same code (##IMAGESET-SELF-CHECK-READS-MASTERS).
 */
export function planTarget(type, brandingDir, target, virtualMasters, masters, produce) {
    const codec = codecFor(type, target.kind);
    // Every frame is served by its own key: the target's, or the one a rule of
    // the declaration gave it (##IMAGESET-DECLARED-SOURCES).
    const sourceAt = (index) => target.frameSources[index] ?? { key: artworkKey(target), declared: false };
    if (codec.vector) {
        return planVectorTarget(codec, brandingDir, target, sourceAt(0), virtualMasters, masters, produce);
    }
    const frames = [];
    const images = [];
    // A skip keeps the frames planned before it: the index still states them.
    const skip = (skipped, skippedAt) => ({ frames, skipped, skippedAt, images: [], emitted: null });
    for (const [index, frame] of target.frames.entries()) {
        const source = sourceAt(index);
        const master = chooseMaster(brandingDir, source.key, frame.width, frame.height, virtualMasters);
        if (master === null) {
            return skip(`no ${source.key} master in ${brandingDir}`, index);
        }
        if (master.origin === 'vector') {
            // How far a vector master stretches the frame needs no pixels: the
            // rasteriser's parse gives the size the render fits. The run takes
            // it off the instance that rendered the frame.
            if (produce) {
                const { image, stretch } = renderSvgToRgba(Buffer.from(masters.bytes(master.file)).toString('utf8'), frame.width, frame.height);
                frames.push(reportedFrame(master, frame, stretch, false, source));
                images.push({ frame, image });
            }
            else {
                frames.push(reportedFrame(master, frame, stretchOf(masters.vectorSize(master.file), frame.width, frame.height), false, source));
            }
            continue;
        }
        // A raster master is decoded in every mode: the refusal of a file that
        // does not decode, and the size of an override, are the run's verdict.
        const { image, reduced } = masters.raster(master.file);
        if (master.origin === 'override' && (image.width !== frame.width || image.height !== frame.height)) {
            return skip(`the per-size override ${master.file} does not cover ${frame.width}x${frame.height}`, index);
        }
        frames.push(reportedFrame(master, frame, null, reduced, source));
        if (produce) {
            images.push({ frame, image: master.origin === 'override' ? image : resizeRgba(image, frame.width, frame.height) });
        }
    }
    return { frames, skipped: null, skippedAt: null, images, emitted: null };
}
/**
 * A vector target: the master IS the artifact, so nothing is rasterised and
 * the bytes are emitted unchanged. Two things are still checked, because a
 * watermark delivered at the wrong size or from a raster master would
 * otherwise ship silently: the master has to be a vector, and it has to carry
 * the size the distribution ships the image at.
 */
function planVectorTarget(codec, brandingDir, target, source, virtualMasters, masters, produce) {
    const nothing = (skipped) => ({ frames: [], skipped, skippedAt: 0, images: [], emitted: null });
    const { key } = source;
    const frame = target.frames[0];
    if (frame === undefined) {
        return nothing(`${target.target} carries no readable size`);
    }
    const master = chooseMaster(brandingDir, key, frame.width, frame.height, virtualMasters);
    if (master === null) {
        return nothing(`no ${key} master in ${brandingDir}`);
    }
    if (master.origin !== 'vector') {
        return nothing(`${target.target} is a vector target and needs ${key}${codec.extension}; ${master.file} is a raster master`);
    }
    const bytes = masters.bytes(master.file);
    let size;
    try {
        const parsed = codec.parse(bytes)[0];
        if (parsed === undefined) {
            return nothing(`${master.file} carries no readable size`);
        }
        size = parsed;
    }
    catch (error) {
        // A master that is not a document of this container is a skip with a
        // reason, not a broken artifact: the operator replaces the file.
        return nothing(`${master.file} is ${error instanceof Error ? error.message : String(error)}`);
    }
    if (size.width !== frame.width || size.height !== frame.height) {
        return nothing(`${master.file} is ${size.width}x${size.height} but ${target.target} ships ${frame.width}x${frame.height}`);
    }
    const emitted = `emitted ${master.file} unchanged at ${frame.width}x${frame.height}`;
    const frames = [
        {
            width: frame.width,
            height: frame.height,
            source: declaredKeyNoted(emitted, source),
            stretch: null,
            reduced: false,
            key,
            keyDeclared: source.declared,
            master: master.file,
            origin: master.origin
        }
    ];
    return { frames, skipped: null, skippedAt: null, images: [], emitted: produce ? bytes : null };
}
/** A frame as the reports state it: where it came from, how far it is stretched, whether it was reduced. */
function reportedFrame(master, frame, stretch, reduced, source) {
    return {
        width: frame.width,
        height: frame.height,
        source: declaredKeyNoted(describeMaster(master, frame, stretch, reduced), source),
        stretch,
        reduced,
        key: source.key,
        keyDeclared: source.declared,
        master: master.file,
        origin: master.origin
    };
}
/**
 * The master file names its key by the naming convention; a key a rule of the
 * declaration chose is said in so many words (##IMAGESET-FRAME-SOURCES-REPORTED).
 */
function declaredKeyNoted(text, source) {
    return source.declared ? `${text}, from the declared key ${source.key}` : text;
}
function describeMaster(master, frame, stretch, reduced) {
    const size = `${frame.width}x${frame.height}`;
    if (master.origin === 'vector') {
        const rendered = `rendered ${master.file} at ${size}`;
        return stretch !== null && stretch.stretched ? `${rendered}, ${stretchPhrase(stretch)}` : rendered;
    }
    const origin = master.origin === 'override' ? `override ${master.file} verbatim at ${size}` : `resampled ${master.file} to ${size}`;
    return reduced ? `${origin}, ${REDUCED_TO_8_BITS}` : origin;
}
/**
 * What a dry run says the target is made of. A container whose frames carry
 * names is described by those names; one whose frames are told apart by size
 * is described by the sizes. A declared frame set says what it replaced
 * (##IMAGESET-FRAME-SOURCES-REPORTED).
 */
function describeFrames(target) {
    const { frames } = target;
    const named = frames.length > 0 && frames.every((frame) => frame.type !== null);
    const described = `${frames.length} ${named ? 'element(s)' : 'frame(s)'} ${frameList(frames)}`;
    if (!target.framesDeclared) {
        return described;
    }
    return `${described}, declared in ${DECLARATION_FILE} in place of the shipped ${frameList(target.shippedFrames)}`;
}
/** Frames by their element names when every one has a name, by their sizes otherwise. */
function frameList(frames) {
    const named = frames.length > 0 && frames.every((frame) => frame.type !== null);
    return frames.map((frame) => (named ? frame.type : `${frame.width}x${frame.height}`)).join(',');
}
/** Artifact id of a brand resource: neutral, derived from the target path. */
export function brandArtifactId(target) {
    return `CK-brand-${target.split('/').join('-')}`;
}
/**
 * Owners whose declared paths cover the target, declaration order first. The
 * first covering owner wins; a target nobody owns is a configuration gap.
 */
function ownerResolver(patchesDir) {
    const raw = existsSync(join(patchesDir, 'delta', 'owners.json'))
        ? JSON.parse(readFileSync(join(patchesDir, 'delta', 'owners.json'), 'utf8'))
        : {};
    const owners = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
        ? raw['owners']
        : undefined;
    const declared = [];
    if (owners !== null && typeof owners === 'object' && !Array.isArray(owners)) {
        for (const [owner, value] of Object.entries(owners)) {
            const patterns = value !== null && typeof value === 'object' && !Array.isArray(value)
                ? value['paths']
                : undefined;
            if (Array.isArray(patterns)) {
                declared.push({ owner, patterns });
            }
        }
    }
    return (target) => {
        for (const { owner, patterns } of declared) {
            if (patterns.some((pattern) => globMatch(pattern, target))) {
                return owner;
            }
        }
        throw ckError('OWNER-UNKNOWN', `no owner in delta/owners.json covers ${target}, and a resource entry without an owner has no reviewer`, `add the path to an existing owner in delta/owners.json, or declare a new owner for it`);
    };
}
/** Segment glob: '*' inside a segment, '**' across segments, like owners.json. */
export function globMatch(pattern, path) {
    const patternParts = pattern.split('/');
    const pathParts = path.split('/');
    return matchSegments(patternParts, pathParts);
}
function matchSegments(pattern, path) {
    if (pattern.length === 0) {
        return path.length === 0;
    }
    const head = pattern[0] ?? '';
    if (head === '**') {
        for (let skip = 0; skip <= path.length; skip += 1) {
            if (matchSegments(pattern.slice(1), path.slice(skip))) {
                return true;
            }
        }
        return false;
    }
    if (path.length === 0) {
        return false;
    }
    return segmentMatch(head, path[0] ?? '') && matchSegments(pattern.slice(1), path.slice(1));
}
function segmentMatch(pattern, segment) {
    const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
    return regex.test(segment);
}
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function buildReport(options, seeded, targets, renders, created, updated, skipped, written) {
    const byTarget = new Map(renders.map((render) => [render.target.target, render]));
    const skipByTarget = new Map(skipped.map((skip) => [skip.target.target, skip.reason]));
    return {
        brandingDir: options.brandingDir,
        dryRun: options.dryRun,
        seeded,
        targets: targets.map((target) => ({
            target: target.target,
            family: target.family,
            artwork: target.artwork,
            kind: target.kind,
            framesDeclared: target.framesDeclared,
            frames: byTarget.get(target.target)?.frames ?? [],
            skipped: skipByTarget.get(target.target) ?? null,
            entry: created.includes(target.target) ? 'created' : updated.includes(target.target) ? 'updated' : null,
            legacyTypes: target.legacyTypes
        })),
        written
    };
}
