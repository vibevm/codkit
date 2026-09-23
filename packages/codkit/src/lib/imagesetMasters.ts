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
import type { ProjectType } from '@codkit/type-api';
import { codecFor, readingImage } from './imagesetCodec.ts';
import { ckError } from './messages.ts';
import { vectorMasterSize } from './imagesetRender.ts';
import type { VectorSize } from './imagesetRender.ts';
import type { DiscoveredTarget } from './imagesetTargets.ts';
import { artworkKey } from './imagesetTargets.ts';

/** Where masters live when the operator did not say otherwise. */
export function defaultBrandingDir(patchesDir: string): string {
	return join(patchesDir, 'branding');
}

export type MasterOrigin = 'override' | 'vector' | 'raster';

export type MasterChoice = {
	readonly origin: MasterOrigin;
	/** Path inside the branding directory, forward slashes. */
	readonly file: string;
};

/**
 * The master that serves one frame: an exact-size raster override wins, then
 * the vector master, then the raster master. Null when the key has no master
 * at all - the caller reports the target as skipped.
 */
export function chooseMaster(
	brandingDir: string,
	key: string,
	width: number,
	height: number,
	virtualMasters: ReadonlySet<string> = new Set()
): MasterChoice | null {
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
export function inBranding(brandingDir: string, file: string): string {
	return join(brandingDir, ...file.split('/'));
}

/**
 * The intrinsic size of a vector master for a report that renders nothing,
 * read once per master: the file in the branding directory or, in a dry run
 * that plans the seeding, the bytes the seeding would write there - so a plan
 * measures the very master its run would render (##IMAGESET-STRETCH-REPORTED).
 */
export function vectorSizeReader(brandingDir: string, planned: ReadonlyMap<string, Uint8Array>): (file: string) => VectorSize {
	const sizes = new Map<string, VectorSize>();
	return (file) => {
		const known = sizes.get(file);
		if (known !== undefined) {
			return known;
		}
		const path = inBranding(brandingDir, file);
		const bytes = existsSync(path) ? readFileSync(path) : planned.get(file);
		if (bytes === undefined) {
			throw ckError('INTERNAL', `the master ${file} was chosen but is neither in ${brandingDir} nor planned for it`);
		}
		const size = vectorMasterSize(Buffer.from(bytes).toString('utf8'));
		sizes.set(file, size);
		return size;
	};
}

/** Files in the branding directory the convention does not know about. */
export function ignoredMasterFiles(brandingDir: string, keys: readonly string[]): readonly string[] {
	if (!existsSync(brandingDir)) {
		return [];
	}
	const known = new Set<string>();
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
export function knownMasterFiles(brandingDir: string, keys: readonly string[]): readonly string[] {
	if (!existsSync(brandingDir)) {
		return [];
	}
	const ignored = new Set(ignoredMasterFiles(brandingDir, keys));
	return listFiles(brandingDir, '')
		.filter((name) => !ignored.has(name))
		.sort();
}

/** Every file under the branding directory, as forward-slash relative paths. */
function listFiles(root: string, prefix: string): string[] {
	const here = prefix === '' ? root : join(root, ...prefix.split('/'));
	const found: string[] = [];
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

export type SeededMaster = {
	readonly file: string;
	readonly from: string;
	readonly width: number;
	readonly height: number;
	/** What the seed writes - or, in a dry run, would write - into the branding directory. */
	readonly bytes: Uint8Array;
};

type SeedCandidate = {
	readonly from: string;
	readonly bytes: Uint8Array;
	readonly width: number;
	readonly height: number;
	/** File extension the seed is written with: a vector stays a vector. */
	readonly extension: string;
};

/**
 * Create the branding directory and seed it from the fork tree. Returns the
 * seeded files, or an empty list when the directory already exists - an
 * existing directory is never overwritten, whatever it holds. With `dryRun`
 * the plan is computed and reported, but nothing is created.
 */
export function seedMasters(
	type: ProjectType,
	brandingDir: string,
	treeDir: string,
	targets: readonly DiscoveredTarget[],
	dryRun = false
): readonly SeededMaster[] {
	if (existsSync(brandingDir)) {
		return [];
	}
	const byKey = new Map<string, DiscoveredTarget[]>();
	for (const target of targets) {
		const key = artworkKey(target);
		byKey.set(key, [...(byKey.get(key) ?? []), target]);
	}
	const seeds: { file: string; seed: SeedCandidate }[] = [];
	for (const key of [...byKey.keys()].sort()) {
		const candidates = (byKey.get(key) ?? []).flatMap((target) => seedCandidatesOf(type, treeDir, target));
		// Largest wins: the master is downsampled to every other size, so the
		// most detail available in the tree is the honest starting point.
		candidates.sort((left, right) => right.width * right.height - left.width * left.height);
		const best = candidates[0];
		if (best !== undefined) {
			seeds.push({ file: `${key}.${best.extension}`, seed: best });
		}
	}
	if (dryRun) {
		return seeds.map(({ file, seed }) => ({ file, from: seed.from, width: seed.width, height: seed.height, bytes: seed.bytes }));
	}
	mkdirSync(brandingDir, { recursive: true });
	const seeded: SeededMaster[] = [];
	for (const { file, seed } of seeds) {
		const path = inBranding(brandingDir, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, seed.bytes);
		seeded.push({ file, from: seed.from, width: seed.width, height: seed.height, bytes: seed.bytes });
	}
	return seeded;
}

/**
 * What one target can contribute as a seed: the picture of each of its frames,
 * as the codec of its container gives it back. A container that does not give
 * the drawing back the way it was drawn contributes nothing, which is why the
 * icon family seeds from the targets that hold its largest faithful copy rather
 * than from every file that carries the mark.
 */
function seedCandidatesOf(type: ProjectType, treeDir: string, target: DiscoveredTarget): SeedCandidate[] {
	const codec = codecFor(type, target.kind);
	if (!codec.seedsMasters) {
		return [];
	}
	const bytes = Uint8Array.from(readFileSync(join(treeDir, ...target.target.split('/'))));
	const extension = codec.extension.replace(/^\./u, '');
	if (codec.vector) {
		// The master of a vector target IS the artifact, so the seed is the file.
		const frame = target.frames[0];
		return frame === undefined ? [] : [{ from: target.target, bytes, width: frame.width, height: frame.height, extension }];
	}
	const payloads = readingImage(target.target, () => codec.extract(bytes));
	const candidates: SeedCandidate[] = [];
	target.frames.forEach((frame, index) => {
		const png = payloads[index] ?? null;
		if (png === null) {
			return;
		}
		candidates.push({
			// A container that carries several frames says which one was taken.
			from: codec.layered ? `${target.target} (${frame.width}x${frame.height} element)` : target.target,
			bytes: png,
			width: frame.width,
			height: frame.height,
			extension: 'png'
		});
	});
	return candidates;
}
