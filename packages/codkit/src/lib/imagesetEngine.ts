/** @scope spec://codkit/modules/codkit/PROP-007#CMD-IMAGESET */
import { pinKey } from './pinIdentity.ts';
// The imageset engine (CMD-IMAGESET): regenerate the product's icon set from
// the branding masters and deliver it as ordinary resource-layer artifacts -
// files under delta/resources/files/ plus map entries. The fork tree is only
// read; the operator reviews the delta and commits it themselves. No other
// command invokes this one, and this one invokes no other.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { codecFor, readingImage } from './imagesetCodec.ts';
import { readDeclaration, resolveTargets } from './imagesetDeclaration.ts';
import type { FrameSource, ImagesetTarget } from './imagesetDeclaration.ts';
import { DECLARATION_FILE, REDUCED_TO_8_BITS, chooseMaster, ignoredMasterFiles, masterReader, seedMasters } from './imagesetMasters.ts';
import type { MasterChoice, MasterOrigin, MasterReader, SeededMaster } from './imagesetMasters.ts';
import { encodePng } from '@codkit/type-api';
import type { ImageCodec, Rgba } from '@codkit/type-api';
import { formatVectorSize, renderSvgToRgba, stretchOf, stretchPhrase } from './imagesetRender.ts';
import type { VectorStretch } from './imagesetRender.ts';
import { resizeRgba } from './imagesetRaster.ts';
import type { TargetFrame } from './imagesetTargets.ts';
import { artworkKey, discoverTargets } from './imagesetTargets.ts';
import { ckError } from './messages.ts';
import { ownTestIds } from './inventory.ts';
import { RESOURCE_FILES_PREFIX, RESOURCE_MAP_PATH, assertTargetAtPin, loadResourceMap, serializeResourceMap } from './layers/resource.ts';
import type { ResourceEntry, ResourceMapDocument } from './layers/resource.ts';
import type { ProjectType } from '@codkit/type-api';

/** The guard-test id convention: one suite per family, declared in own code. */
export function guardTestId(family: string): string {
	return `guard.brand.${family}`;
}

/**
 * One frame of a target as every report states it. `stretch` is how far the
 * vector master that renders the frame stretches its drawing, and null where no
 * vector master renders it (##IMAGESET-STRETCH-REPORTED); `reduced` says the
 * raster master serving it had 16 bits per sample and was brought to 8
 * (##IMAGESET-SELF-CHECK-READS-MASTERS). `key`, `master` and `origin` say
 * where it came from, and `keyDeclared` that a rule of the declaration gave
 * it to that key (##IMAGESET-FRAME-SOURCES-REPORTED).
 */
export type ImagesetFrame = {
	readonly width: number;
	readonly height: number;
	readonly source: string;
	readonly stretch: VectorStretch | null;
	readonly reduced: boolean;
	readonly key: string;
	readonly keyDeclared: boolean;
	readonly master: string;
	readonly origin: MasterOrigin;
};

export type ImagesetReport = {
	readonly brandingDir: string;
	readonly dryRun: boolean;
	readonly seeded: readonly SeededMaster[];
	readonly targets: readonly {
		readonly target: string;
		readonly family: string;
		readonly artwork: string | null;
		readonly kind: string;
		/** The frames are the set the product declared (##IMAGESET-DECLARED-FRAMES). */
		readonly framesDeclared: boolean;
		readonly frames: readonly ImagesetFrame[];
		readonly skipped: string | null;
		readonly entry: 'created' | 'updated' | null;
		readonly legacyTypes: readonly string[];
	}[];
	readonly written: readonly string[];
};

export type ImagesetOptions = {
	readonly patchesDir: string;
	/** The project type of the patch set: the image set is its answer. */
	readonly type: ProjectType;
	readonly treeDir: string;
	readonly brandingDir: string;
	readonly pin: { readonly tag: string; readonly sha: string };
	readonly dryRun: boolean;
	readonly onInfo: (text: string) => void;
	readonly onWarn: (text: string) => void;
};

/**
 * Run the regeneration. Every validation happens before the first write: a
 * refused run leaves the patchset byte-identical, which is what makes a retry
 * after fixing the report cheap and safe.
 */
export function runImageset(options: ImagesetOptions): { exitCode: number; report: ImagesetReport } {
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

	const renders: { target: ImagesetTarget; bytes: Uint8Array; frames: ImagesetFrame[] }[] = [];
	const skipReport: { target: ImagesetTarget; reason: string }[] = [];
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

	const created: string[] = [];
	const updated: string[] = [];
	const writes: { path: string; bytes: Uint8Array; entry: ResourceEntry | null }[] = [];
	const entries: ResourceEntry[] = map === null ? [] : [...map.entries];
	for (const render of renders) {
		const existing = entries.find((entry) => entry.target === render.target.target);
		const source = existing !== undefined ? existing.source : `${RESOURCE_FILES_PREFIX}${render.target.target}`;
		if (existing !== undefined) {
			updated.push(render.target.target);
			const at = entries.indexOf(existing);
			entries[at] = { ...existing, pin: `${pinKey(options.pin)}@${options.pin.sha}` };
		} else {
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
		throw ckError(
			'GUARD-MISSING',
			`new resource entries need a declared guard test: ${missingGuards.map((entry) => `${entry.id} names ${entry.contractTests.join(', ')}`).join('; ')}`,
			`write suite('${guardTestId('<family>')}') into a test file under delta/own/test/ first - the resource layer has no marker blocks, so the guard is mandatory`
		);
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
		const document: ResourceMapDocument = { entries };
		writeFileSync(join(patchesDir, ...RESOURCE_MAP_PATH.split('/')), serializeResourceMap(document));
	}
	for (const render of renders) {
		onInfo(
			`regenerated ${render.target.target}: ${render.frames.map((frame) => `${frame.width}x${frame.height} (${frame.source})`).join(', ')}`
		);
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
		report: buildReport(
			options,
			seeded,
			targets,
			renders,
			created,
			updated,
			skipReport,
			writes.map((write) => write.path)
		)
	};
}

type RenderOutcome = { bytes: Uint8Array; frames: ImagesetFrame[]; skipped: string | null };

/**
 * One target of the run: its plan, and - unless this is a dry run - the
 * container written from the pixels the plan produced.
 */
function renderTarget(
	type: ProjectType,
	brandingDir: string,
	target: ImagesetTarget,
	virtualMasters: ReadonlySet<string>,
	dryRun: boolean,
	masters: MasterReader
): RenderOutcome {
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
	const bytes = readingImage(target.target, () =>
		codec.encode(
			plan.images.map((item) => ({ frame: item.frame, png: encodePng(item.image) })),
			target.stem
		)
	);
	return { bytes, frames: [...plan.frames], skipped: null };
}

/** What the run does with one target, and - when it produces - the pixels it makes. */
export type TargetPlan = {
	/**
	 * Every frame the plan reached, as the reports state it: all of them, or -
	 * when the target is skipped - the frames before the one it is skipped at.
	 */
	readonly frames: readonly ImagesetFrame[];
	/** Why the run skips the target, in the words of its warning; null when it does not. */
	readonly skipped: string | null;
	/** The position of the frame the skip is about; null when nothing is skipped. */
	readonly skippedAt: number | null;
	/** The frames of a raster container, rendered or resampled, when produced. */
	readonly images: readonly { readonly frame: TargetFrame; readonly image: Rgba }[];
	/** The bytes a vector target is delivered as, when produced. */
	readonly emitted: Uint8Array | null;
};

/**
 * Apply the rules of the run to one target: choose the master of every frame,
 * read it the way the run reads it, and state what the run reports about the
 * frame and why it would skip the target. With `produce` the pixels are made
 * as well; without it nothing is rendered, and the dry run and the index get
 * the very verdict of the run - its refusals, its skips and its facts - from
 * the very same code (##IMAGESET-SELF-CHECK-READS-MASTERS).
 */
export function planTarget(
	type: ProjectType,
	brandingDir: string,
	target: ImagesetTarget,
	virtualMasters: ReadonlySet<string>,
	masters: MasterReader,
	produce: boolean
): TargetPlan {
	const codec = codecFor(type, target.kind);
	// Every frame is served by its own key: the target's, or the one a rule of
	// the declaration gave it (##IMAGESET-DECLARED-SOURCES).
	const sourceAt = (index: number): FrameSource => target.frameSources[index] ?? { key: artworkKey(target), declared: false };
	if (codec.vector) {
		return planVectorTarget(codec, brandingDir, target, sourceAt(0), virtualMasters, masters, produce);
	}
	const frames: ImagesetFrame[] = [];
	const images: { frame: TargetFrame; image: Rgba }[] = [];
	// A skip keeps the frames planned before it: the index still states them.
	const skip = (skipped: string, skippedAt: number): TargetPlan => ({ frames, skipped, skippedAt, images: [], emitted: null });
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
			} else {
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
function planVectorTarget(
	codec: ImageCodec,
	brandingDir: string,
	target: ImagesetTarget,
	source: FrameSource,
	virtualMasters: ReadonlySet<string>,
	masters: MasterReader,
	produce: boolean
): TargetPlan {
	const nothing = (skipped: string): TargetPlan => ({ frames: [], skipped, skippedAt: 0, images: [], emitted: null });
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
	let size: TargetFrame;
	try {
		const parsed = codec.parse(bytes)[0];
		if (parsed === undefined) {
			return nothing(`${master.file} carries no readable size`);
		}
		size = parsed;
	} catch (error) {
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
function reportedFrame(
	master: MasterChoice,
	frame: TargetFrame,
	stretch: VectorStretch | null,
	reduced: boolean,
	source: FrameSource
): ImagesetFrame {
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
function declaredKeyNoted(text: string, source: FrameSource): string {
	return source.declared ? `${text}, from the declared key ${source.key}` : text;
}

function describeMaster(master: MasterChoice, frame: TargetFrame, stretch: VectorStretch | null, reduced: boolean): string {
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
function describeFrames(target: ImagesetTarget): string {
	const { frames } = target;
	const named = frames.length > 0 && frames.every((frame) => frame.type !== null);
	const described = `${frames.length} ${named ? 'element(s)' : 'frame(s)'} ${frameList(frames)}`;
	if (!target.framesDeclared) {
		return described;
	}
	return `${described}, declared in ${DECLARATION_FILE} in place of the shipped ${frameList(target.shippedFrames)}`;
}

/** Frames by their element names when every one has a name, by their sizes otherwise. */
function frameList(frames: readonly TargetFrame[]): string {
	const named = frames.length > 0 && frames.every((frame) => frame.type !== null);
	return frames.map((frame) => (named ? frame.type : `${frame.width}x${frame.height}`)).join(',');
}

/** Artifact id of a brand resource: neutral, derived from the target path. */
export function brandArtifactId(target: string): string {
	return `CK-brand-${target.split('/').join('-')}`;
}

/**
 * Owners whose declared paths cover the target, declaration order first. The
 * first covering owner wins; a target nobody owns is a configuration gap.
 */
function ownerResolver(patchesDir: string): (target: string) => string {
	const raw: unknown = existsSync(join(patchesDir, 'delta', 'owners.json'))
		? JSON.parse(readFileSync(join(patchesDir, 'delta', 'owners.json'), 'utf8'))
		: {};
	const owners =
		raw !== null && typeof raw === 'object' && !Array.isArray(raw)
			? ((raw as Record<string, unknown>)['owners'] as Record<string, unknown> | undefined)
			: undefined;
	const declared: { owner: string; patterns: readonly string[] }[] = [];
	if (owners !== null && typeof owners === 'object' && !Array.isArray(owners)) {
		for (const [owner, value] of Object.entries(owners)) {
			const patterns =
				value !== null && typeof value === 'object' && !Array.isArray(value)
					? ((value as Record<string, unknown>)['paths'] as readonly string[] | undefined)
					: undefined;
			if (Array.isArray(patterns)) {
				declared.push({ owner, patterns });
			}
		}
	}
	return (target: string) => {
		for (const { owner, patterns } of declared) {
			if (patterns.some((pattern) => globMatch(pattern, target))) {
				return owner;
			}
		}
		throw ckError(
			'OWNER-UNKNOWN',
			`no owner in delta/owners.json covers ${target}, and a resource entry without an owner has no reviewer`,
			`add the path to an existing owner in delta/owners.json, or declare a new owner for it`
		);
	};
}

/** Segment glob: '*' inside a segment, '**' across segments, like owners.json. */
export function globMatch(pattern: string, path: string): boolean {
	const patternParts = pattern.split('/');
	const pathParts = path.split('/');
	return matchSegments(patternParts, pathParts);
}

function matchSegments(pattern: readonly string[], path: readonly string[]): boolean {
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

function segmentMatch(pattern: string, segment: string): boolean {
	const regex = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`);
	return regex.test(segment);
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildReport(
	options: ImagesetOptions,
	seeded: readonly SeededMaster[],
	targets: readonly ImagesetTarget[],
	renders: readonly { target: ImagesetTarget; frames: ImagesetFrame[] }[],
	created: readonly string[],
	updated: readonly string[],
	skipped: readonly { target: ImagesetTarget; reason: string }[],
	written: readonly string[]
): ImagesetReport {
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
