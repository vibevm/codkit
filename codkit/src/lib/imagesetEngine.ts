/** @scope spec://codkit/modules/codkit/PROP-007#CMD-IMAGESET */
// The imageset engine (CMD-IMAGESET): regenerate the product's icon set from
// the branding masters and deliver it as ordinary resource-layer artifacts -
// files under delta/resources/files/ plus map entries. The fork tree is only
// read; the operator reviews the delta and commits it themselves. No other
// command invokes this one, and this one invokes no other.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeBmp24 } from './imagesetBmp.ts';
import { encodeIcns } from './imagesetIcns.ts';
import { encodeIco } from './imagesetIco.ts';
import { chooseMaster, ignoredMasterFiles, inBranding, seedMasters } from './imagesetMasters.ts';
import type { SeededMaster } from './imagesetMasters.ts';
import { decodePng, encodePng } from './imagesetPng.ts';
import type { Rgba } from './imagesetPng.ts';
import { renderSvgToRgba } from './imagesetRender.ts';
import { parseSvg } from './imagesetSvg.ts';
import { resizeRgba } from './imagesetRaster.ts';
import type { DiscoveredTarget, TargetFrame } from './imagesetTargets.ts';
import { artworkKey, discoverTargets } from './imagesetTargets.ts';
import { encodeXpm } from './imagesetXpm.ts';
import { ckError } from './messages.ts';
import { ownTestIds } from './inventory.ts';
import { RESOURCE_FILES_PREFIX, RESOURCE_MAP_PATH, assertTargetAtPin, loadResourceMap, serializeResourceMap } from './layers/resource.ts';
import type { ResourceEntry, ResourceMapDocument } from './layers/resource.ts';

/** Installer art has no alpha channel; the backdrop is part of the design. */
const BMP_BACKGROUND = { r: 255, g: 255, b: 255 };

/** The guard-test id convention: one suite per family, declared in own code. */
export function guardTestId(family: string): string {
	return `guard.brand.${family}`;
}

export type ImagesetReport = {
	readonly brandingDir: string;
	readonly dryRun: boolean;
	readonly seeded: readonly SeededMaster[];
	readonly targets: readonly {
		readonly target: string;
		readonly family: string;
		readonly artwork: string | null;
		readonly kind: string;
		readonly frames: readonly { width: number; height: number; source: string }[];
		readonly skipped: string | null;
		readonly entry: 'created' | 'updated' | null;
		readonly legacyTypes: readonly string[];
	}[];
	readonly written: readonly string[];
};

export type ImagesetOptions = {
	readonly patchesDir: string;
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
	const targets = discoverTargets(treeDir, onInfo);
	const seeded = seedMasters(brandingDir, treeDir, targets, dryRun);
	for (const seed of seeded) {
		onInfo(`${dryRun ? 'would seed' : 'seeded'} branding/${seed.file} from ${seed.from} (${seed.width}x${seed.height})`);
	}

	const keys = [...new Set(targets.map((target) => artworkKey(target)))].sort();
	for (const ignored of ignoredMasterFiles(brandingDir, keys)) {
		onWarn(`branding file matches no master convention and was ignored: ${ignored}`);
	}
	// In a dry run the planned seeds are not on disk yet; the plan still has
	// to say which master would serve each frame, so a planned seed counts as
	// the master it will become.
	const virtualMasters = new Set(seeded.map((seed) => seed.file));

	const map = loadResourceMap(patchesDir);
	const ownerOf = ownerResolver(patchesDir);
	const declaredTests = ownTestIds(patchesDir);

	const renders: { target: DiscoveredTarget; bytes: Uint8Array; frames: { width: number; height: number; source: string }[] }[] = [];
	const skipReport: { target: DiscoveredTarget; reason: string }[] = [];
	for (const target of targets) {
		const rendered = renderTarget(brandingDir, target, virtualMasters, dryRun);
		if (rendered.skipped !== null) {
			skipReport.push({ target, reason: rendered.skipped });
			continue;
		}
		renders.push({ target, bytes: rendered.bytes, frames: rendered.frames });
	}
	for (const skip of skipReport) {
		onWarn(`skipped ${skip.target.target}: ${skip.reason}`);
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
			entries[at] = { ...existing, pin: `${options.pin.tag}@${options.pin.sha}` };
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
				pin: `${options.pin.tag}@${options.pin.sha}`,
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

type RenderOutcome = { bytes: Uint8Array; frames: { width: number; height: number; source: string }[]; skipped: string | null };

function renderTarget(brandingDir: string, target: DiscoveredTarget, virtualMasters: ReadonlySet<string>, dryRun: boolean): RenderOutcome {
	const key = artworkKey(target);
	if (target.kind === 'svg') {
		return emitVectorTarget(brandingDir, target, key, virtualMasters, dryRun);
	}
	const frames: { width: number; height: number; source: string }[] = [];
	const rendered: { frame: TargetFrame; image: Rgba }[] = [];
	for (const frame of target.frames) {
		const master = chooseMaster(brandingDir, key, frame.width, frame.height, virtualMasters);
		if (master === null) {
			return { bytes: new Uint8Array(0), frames: [], skipped: `no ${key} master in ${brandingDir}` };
		}
		frames.push({ width: frame.width, height: frame.height, source: describeMaster(master, frame) });
		if (dryRun) {
			// The plan names the master per frame; the pixels are the real
			// run's business, and the master may not even exist yet.
			continue;
		}
		const image = masterAt(brandingDir, master, frame);
		if (image === null) {
			return {
				bytes: new Uint8Array(0),
				frames: [],
				skipped: `the per-size override ${master.file} does not cover ${frame.width}x${frame.height}`
			};
		}
		rendered.push({ frame, image });
	}
	if (dryRun) {
		return { bytes: new Uint8Array(0), frames, skipped: null };
	}
	if (target.kind === 'ico') {
		return {
			bytes: encodeIco(rendered.map((item) => ({ width: item.frame.width, height: item.frame.height, png: encodePng(item.image) }))),
			frames,
			skipped: null
		};
	}
	if (target.kind === 'icns') {
		return {
			bytes: encodeIcns(rendered.map((item) => ({ type: item.frame.type ?? 'ic07', png: encodePng(item.image) }))),
			frames,
			skipped: null
		};
	}
	if (target.kind === 'png') {
		return { bytes: encodePng(rendered[0]?.image ?? { width: 0, height: 0, data: new Uint8Array(0) }), frames, skipped: null };
	}
	if (target.kind === 'bmp') {
		return {
			bytes: encodeBmp24(rendered[0]?.image ?? { width: 0, height: 0, data: new Uint8Array(0) }, BMP_BACKGROUND),
			frames,
			skipped: null
		};
	}
	const text = encodeXpm(rendered[0]?.image ?? { width: 0, height: 0, data: new Uint8Array(0) }, target.stem);
	return { bytes: new TextEncoder().encode(text), frames, skipped: null };
}

/**
 * A vector target: the master IS the artifact, so nothing is rasterised and
 * the bytes are emitted unchanged. Two things are still checked, because a
 * watermark delivered at the wrong size or from a raster master would
 * otherwise ship silently: the master has to be a vector, and it has to carry
 * the size the distribution ships the image at.
 */
function emitVectorTarget(
	brandingDir: string,
	target: DiscoveredTarget,
	key: string,
	virtualMasters: ReadonlySet<string>,
	dryRun: boolean
): RenderOutcome {
	const nothing = (skipped: string): RenderOutcome => ({ bytes: new Uint8Array(0), frames: [], skipped });
	const frame = target.frames[0];
	if (frame === undefined) {
		return nothing(`${target.target} carries no readable size`);
	}
	const master = chooseMaster(brandingDir, key, frame.width, frame.height, virtualMasters);
	if (master === null) {
		return nothing(`no ${key} master in ${brandingDir}`);
	}
	if (master.origin !== 'vector') {
		return nothing(`${target.target} is a vector target and needs ${key}.svg; ${master.file} is a raster master`);
	}
	const frames = [
		{ width: frame.width, height: frame.height, source: `emitted ${master.file} unchanged at ${frame.width}x${frame.height}` }
	];
	if (dryRun) {
		return { bytes: new Uint8Array(0), frames, skipped: null };
	}
	const text = readFileSync(inBranding(brandingDir, master.file), 'utf8');
	const size = parseSvg(text);
	if (size === null) {
		return nothing(`${master.file} is not an SVG document with usable dimensions`);
	}
	if (size.width !== frame.width || size.height !== frame.height) {
		return nothing(`${master.file} is ${size.width}x${size.height} but ${target.target} ships ${frame.width}x${frame.height}`);
	}
	return { bytes: new TextEncoder().encode(text), frames, skipped: null };
}

/** Render one frame from its master: verbatim override, vector, or resample. */
function masterAt(brandingDir: string, master: { origin: string; file: string }, frame: TargetFrame): Rgba | null {
	if (master.origin === 'vector') {
		return renderSvgToRgba(readFileSync(inBranding(brandingDir, master.file), 'utf8'), frame.width, frame.height).image;
	}
	const image = decodePng(readFileSync(inBranding(brandingDir, master.file)));
	if (master.origin === 'override') {
		if (image.width !== frame.width || image.height !== frame.height) {
			return null;
		}
		return image;
	}
	return resizeRgba(image, frame.width, frame.height);
}

function describeMaster(master: { origin: string; file: string }, frame: TargetFrame): string {
	if (master.origin === 'override') {
		return `override ${master.file} verbatim at ${frame.width}x${frame.height}`;
	}
	if (master.origin === 'vector') {
		return `rendered ${master.file} at ${frame.width}x${frame.height}`;
	}
	return `resampled ${master.file} to ${frame.width}x${frame.height}`;
}

/** The C identifier the XPM array carries: the shipped file's stem. */
function describeFrames(target: DiscoveredTarget): string {
	if (target.kind === 'icns') {
		return `${target.frames.length} element(s) ${target.frames.map((frame) => frame.type).join(',')}`;
	}
	return `${target.frames.length} frame(s) ${target.frames.map((frame) => `${frame.width}x${frame.height}`).join(',')}`;
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
	targets: readonly DiscoveredTarget[],
	renders: readonly { target: DiscoveredTarget; frames: { width: number; height: number; source: string }[] }[],
	created: readonly string[],
	updated: readonly string[],
	skipped: readonly { target: DiscoveredTarget; reason: string }[],
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
			frames: byTarget.get(target.target)?.frames ?? [],
			skipped: skipByTarget.get(target.target) ?? null,
			entry: created.includes(target.target) ? 'created' : updated.includes(target.target) ? 'updated' : null,
			legacyTypes: target.legacyTypes
		})),
		written
	};
}
