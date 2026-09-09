/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-INDEX */
// The imageset index (IMAGESET-INDEX): a read-only report of the icon set,
// computed from the same two sources the generator uses - the distribution's
// targets and the masters directory - so it reports discovered state and is
// incapable of going stale the way a hand-written README would.
//
// One model, two renderings. `render` writes the Markdown a person or an agent
// reads; `indexData` writes the schema-2 envelope payload. Both walk the same
// ImagesetIndex value, so the prose and the JSON cannot disagree about which
// size comes from a hand-made master and which one is generated.

import { existsSync } from 'node:fs';
import { codecFor } from './imagesetCodec.ts';
import { chooseMaster, ignoredMasterFiles, knownMasterFiles } from './imagesetMasters.ts';
import type { DiscoveredTarget, TargetKind } from './imagesetTargets.ts';
import { artworkKey, discoverTargets } from './imagesetTargets.ts';
import type { JsonValue } from './jsonOut.ts';
import type { ImageCodec, ProjectType } from '@codkit/type-api';

/** Where one required size comes from on the next generation run. */
export type SizeSource = 'master' | 'generated' | 'missing';

export type IndexSize = {
	readonly width: number;
	readonly height: number;
	/** Element type of a container that names its elements; null otherwise. */
	readonly type: string | null;
	readonly source: SizeSource;
	/** Master file that serves this size, or null when none can. */
	readonly from: string | null;
};

export type IndexTarget = {
	readonly target: string;
	readonly family: string;
	/** Which drawing of the family, or null when the family holds one. */
	readonly artwork: string | null;
	/** The masters base name: the family, or `family/artwork`. */
	readonly key: string;
	readonly role: string;
	readonly container: TargetKind;
	readonly sizes: readonly IndexSize[];
	/** Elements found in the shipped file and not reproduced. */
	readonly legacyTypes: readonly string[];
	readonly constraints: readonly string[];
};

export type ImagesetIndex = {
	readonly treeDir: string;
	readonly brandingDir: string;
	readonly brandingDirExists: boolean;
	/** Master files present, by the naming convention; sorted. */
	readonly masters: readonly string[];
	/** Files in the directory the convention does not know. */
	readonly ignored: readonly string[];
	/** The command that would create the missing directory, or null. */
	readonly seedCommand: string | null;
	readonly targets: readonly IndexTarget[];
	readonly totals: Totals;
	/** The same three counts per family, in family order; the useful summary
	 *  once the set is large enough that the per-target list does not fit on
	 *  a screen. */
	readonly byFamily: readonly { readonly family: string; readonly artworks: number; readonly totals: Totals }[];
};

export type Totals = { readonly master: number; readonly generated: number; readonly missing: number };

/**
 * Build the index. Nothing is written - not even the seeding `gen` does on a
 * missing directory: an index of a not-yet-seeded set reports every size as
 * absent and names the command that would seed it.
 */
export function buildImagesetIndex(options: {
	/** The project type of the patch set: the image set is its answer. */
	readonly type: ProjectType;
	readonly treeDir: string;
	readonly brandingDir: string;
	readonly onReport: (text: string) => void;
}): ImagesetIndex {
	const discovered = discoverTargets(options.type, options.treeDir, options.onReport);
	const brandingDirExists = existsSync(options.brandingDir);
	const keys = [...new Set(discovered.map((target) => artworkKey(target)))].sort();
	const targets = discovered.map((target) => indexTarget(options.type, options.brandingDir, target));
	const totals = { master: 0, generated: 0, missing: 0 };
	const perFamily = new Map<string, { master: number; generated: number; missing: number }>();
	const artworksOf = new Map<string, Set<string>>();
	for (const target of targets) {
		const counts = perFamily.get(target.family) ?? { master: 0, generated: 0, missing: 0 };
		perFamily.set(target.family, counts);
		artworksOf.set(target.family, (artworksOf.get(target.family) ?? new Set()).add(target.key));
		for (const size of target.sizes) {
			totals[size.source] += 1;
			counts[size.source] += 1;
		}
	}
	return {
		treeDir: options.treeDir,
		brandingDir: options.brandingDir,
		brandingDirExists,
		masters: knownMasterFiles(options.brandingDir, keys),
		ignored: ignoredMasterFiles(options.brandingDir, keys),
		seedCommand: brandingDirExists ? null : 'codkit imageset gen',
		targets,
		totals,
		byFamily: [...perFamily.keys()].sort().map((family) => ({
			family,
			artworks: artworksOf.get(family)?.size ?? 0,
			totals: perFamily.get(family) ?? { master: 0, generated: 0, missing: 0 }
		}))
	};
}

function indexTarget(type: ProjectType, brandingDir: string, target: DiscoveredTarget): IndexTarget {
	const key = artworkKey(target);
	const codec = codecFor(type, target.kind);
	return {
		target: target.target,
		family: target.family,
		artwork: target.artwork,
		key,
		role: target.role,
		container: target.kind,
		sizes: target.frames.map((frame) => {
			const master = chooseMaster(brandingDir, key, frame.width, frame.height);
			const source: SizeSource = master === null ? 'missing' : master.origin === 'override' ? 'master' : 'generated';
			return { width: frame.width, height: frame.height, type: frame.type, source, from: master?.file ?? null };
		}),
		legacyTypes: target.legacyTypes,
		constraints: constraintsOf(codec, target)
	};
}

/**
 * What someone drawing this target has to know before they start: what the
 * container costs them, which the codec states, then what the masters
 * convention and the discovered file add, which is the engine's.
 */
function constraintsOf(codec: ImageCodec, target: DiscoveredTarget): readonly string[] {
	const constraints: string[] = [...codec.constraints];
	if (codec.vector) {
		constraints.push(
			`the master must be \`${target.family}/${target.artwork ?? ''}${codec.extension}\` and must carry the size the distribution ships`
		);
		return constraints;
	}
	if (target.legacyTypes.length > 0) {
		constraints.push(`legacy elements present in the shipped file and not reproduced: ${target.legacyTypes.join(', ')}`);
	}
	constraints.push('the master fills the frame edge to edge: any margin or safe area has to be drawn into the master itself');
	constraints.push('a per-size master whose own dimensions differ from the required size makes the whole target fail, not just that size');
	return constraints;
}

/** The envelope payload: the same model, structurally. */
export function indexData(index: ImagesetIndex): JsonValue {
	return {
		brandingDir: index.brandingDir,
		brandingDirExists: index.brandingDirExists,
		masters: [...index.masters],
		byFamily: index.byFamily.map((entry) => ({ family: entry.family, artworks: entry.artworks, totals: { ...entry.totals } })),
		ignored: [...index.ignored],
		seedCommand: index.seedCommand,
		totals: { ...index.totals },
		targets: index.targets.map((target) => ({
			target: target.target,
			family: target.family,
			artwork: target.artwork,
			key: target.key,
			role: target.role,
			container: target.container,
			legacyTypes: [...target.legacyTypes],
			constraints: [...target.constraints],
			sizes: target.sizes.map((size) => ({
				width: size.width,
				height: size.height,
				type: size.type,
				source: size.source,
				from: size.from
			}))
		}))
	};
}

/**
 * The rule the index states once, in its own words. It is here and not in a
 * README because it is what stops the next reader deleting the small masters
 * as redundant duplicates of the large one.
 */
const PREFERENCE_RULE = [
	'## Hand-made masters win over generated sizes',
	'',
	'A hand-made image for exactly one required size is used verbatim; generation is the',
	'fallback, not the default. The reason is measurable rather than aesthetic: at 16 and 32',
	'pixels a faithful downsize of a detailed mark turns to mush, so those sizes are drawn',
	'separately - which is what a distribution itself does. Regenerate a layer from the',
	'largest layer of its own container and compare it with the layer the distribution ships,',
	'and the mean absolute difference per RGB channel comes out as:',
	'',
	'| regenerated layer | mean difference |',
	'| --- | --- |',
	'| 256 and 512 pixels, from a 1024-pixel layer of the same container | 1.0-2.3 / 255 |',
	'| 128 pixels, from that same 1024-pixel layer | 4.7 / 255 |',
	'| 128 pixels, from a 256-pixel layer | 13.1 / 255 |',
	'| 32 pixels, from a 256-pixel layer | 17.9-20.2 / 255 |',
	'| 16 pixels, from a 256-pixel layer | 65.6 / 255 |',
	'',
	'A shipped 16-pixel mark is usually not a downsample of the large one at all - it is a',
	'different, simplified drawing. So: drop `<key>-16.png` and `<key>-32.png` into the masters',
	'directory and they win. Delete them and the run silently falls back to a downsize that',
	'measures roughly thirty times worse than the same generation does at 256 pixels.'
].join('\n');

/** The Markdown document: the form the owner asked to hand to an agent. */
export function renderImagesetIndex(index: ImagesetIndex): string {
	const lines: string[] = ['# Icon set index', ''];
	lines.push(
		`Computed from the fork tree at \`${index.treeDir}\` and the masters directory at`,
		`\`${index.brandingDir}\`. It reports discovered state - what this distribution actually`,
		'ships and which masters are actually present - so it says what the next',
		'`codkit imageset gen` will really do. Nothing here is written down in advance.',
		''
	);
	lines.push(...mastersSection(index), '', PREFERENCE_RULE, '', ...familySection(index), '', '## Targets', '');
	for (const target of index.targets) {
		lines.push(...targetSection(target), '');
	}
	lines.push(
		'## Totals',
		'',
		`- from a hand-made master: ${index.totals.master}`,
		`- generated from a base master: ${index.totals.generated}`,
		`- no master can produce it: ${index.totals.missing}`,
		''
	);
	return lines.join('\n');
}

/** The per-family summary: at eighty targets this is what a reader reads. */
function familySection(index: ImagesetIndex): readonly string[] {
	const lines = ['## Families', '', '| Family | Drawings | From a master | Generated | Missing |', '| --- | ---: | ---: | ---: | ---: |'];
	for (const entry of index.byFamily) {
		lines.push(
			`| \`${entry.family}\` | ${entry.artworks} | ${entry.totals.master} | ${entry.totals.generated} | ${entry.totals.missing} |`
		);
	}
	return lines;
}

function mastersSection(index: ImagesetIndex): readonly string[] {
	const lines = ['## Masters', ''];
	if (!index.brandingDirExists) {
		lines.push(
			'The masters directory does not exist, so every required size below is `missing`.',
			`Create it by running \`${index.seedCommand ?? 'codkit imageset gen'}\`: the first run seeds the directory`,
			"with the distribution's own icons taken from the fork tree, and reports what it seeded.",
			'Then replace the seeded files piece by piece.'
		);
		return lines;
	}
	lines.push(
		index.masters.length === 0
			? 'The directory exists but holds no file the naming convention recognises.'
			: `Present: ${index.masters.map((name) => `\`${name}\``).join(', ')}.`,
		'',
		'Convention, where `<key>` is the family for a family holding one drawing and',
		'`<family>/<artwork>` for one holding several: `<key>.svg` is the vector master rendered at',
		'every size, `<key>.png` the raster master resampled to every size, `<key>-<N>.png` a per-size',
		'master used verbatim at exactly NxN, and `<key>-<W>x<H>.png` the same for a non-square size.'
	);
	if (index.ignored.length > 0) {
		lines.push('', `Ignored - matching no convention: ${index.ignored.map((name) => `\`${name}\``).join(', ')}.`);
	}
	return lines;
}

function targetSection(target: IndexTarget): readonly string[] {
	const lines = [
		`### \`${target.target}\``,
		'',
		`- Role: ${target.role}`,
		`- Family: \`${target.family}\`; artwork: \`${target.key}\`; container: ${target.container.toUpperCase()}; required sizes: ${target.sizes.length}`
	];
	for (const constraint of target.constraints) {
		lines.push(`- Constraint: ${constraint}`);
	}
	lines.push('', '| Size | Element | Source | From |', '| --- | --- | --- | --- |');
	for (const size of target.sizes) {
		lines.push(`| ${size.width}x${size.height} | ${size.type ?? '-'} | \`${size.source}\` | ${describeSource(target, size)} |`);
	}
	return lines;
}

function describeSource(target: IndexTarget, size: IndexSize): string {
	if (size.source === 'master') {
		return `\`${size.from ?? ''}\`, used verbatim`;
	}
	if (size.source === 'generated') {
		const verb = size.from?.endsWith('.svg') === true ? 'rendered at this size from' : 'resampled to this size from';
		return `${verb} \`${size.from ?? ''}\``;
	}
	return `no \`${target.key}\` master exists; the run skips this target and exits 1`;
}
