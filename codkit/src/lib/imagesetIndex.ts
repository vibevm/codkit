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

import { existsSync, readdirSync } from 'node:fs';
import { chooseMaster, ignoredMasterFiles } from './imagesetMasters.ts';
import type { DiscoveredTarget, TargetKind } from './imagesetTargets.ts';
import { discoverTargets } from './imagesetTargets.ts';
import type { JsonValue } from './jsonOut.ts';

/** Where one required size comes from on the next generation run. */
export type SizeSource = 'master' | 'generated' | 'missing';

export type IndexSize = {
	readonly width: number;
	readonly height: number;
	/** ICNS element type; null for the other containers. */
	readonly type: string | null;
	readonly source: SizeSource;
	/** Master file that serves this size, or null when none can. */
	readonly from: string | null;
};

export type IndexTarget = {
	readonly target: string;
	readonly family: string;
	readonly role: string;
	readonly container: TargetKind;
	readonly sizes: readonly IndexSize[];
	/** ICNS elements found in the shipped file and not reproduced. */
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
	readonly totals: { readonly master: number; readonly generated: number; readonly missing: number };
};

/**
 * Build the index. Nothing is written - not even the seeding `gen` does on a
 * missing directory: an index of a not-yet-seeded set reports every size as
 * absent and names the command that would seed it.
 */
export function buildImagesetIndex(options: {
	readonly treeDir: string;
	readonly brandingDir: string;
	readonly onReport: (text: string) => void;
}): ImagesetIndex {
	const discovered = discoverTargets(options.treeDir, options.onReport);
	const brandingDirExists = existsSync(options.brandingDir);
	const families = [...new Set(discovered.map((target) => target.family))];
	const targets = discovered.map((target) => indexTarget(options.brandingDir, target));
	const totals = { master: 0, generated: 0, missing: 0 };
	for (const target of targets) {
		for (const size of target.sizes) {
			totals[size.source] += 1;
		}
	}
	return {
		treeDir: options.treeDir,
		brandingDir: options.brandingDir,
		brandingDirExists,
		masters: brandingDirExists ? knownMasterFiles(options.brandingDir, families) : [],
		ignored: ignoredMasterFiles(options.brandingDir, families),
		seedCommand: brandingDirExists ? null : 'codkit imageset gen',
		targets,
		totals
	};
}

function indexTarget(brandingDir: string, target: DiscoveredTarget): IndexTarget {
	return {
		target: target.target,
		family: target.family,
		role: target.role,
		container: target.kind,
		sizes: target.frames.map((frame) => {
			const master = chooseMaster(brandingDir, target.family, frame.width, frame.height);
			const source: SizeSource = master === null ? 'missing' : master.origin === 'override' ? 'master' : 'generated';
			return { width: frame.width, height: frame.height, type: frame.type, source, from: master?.file ?? null };
		}),
		legacyTypes: target.legacyTypes,
		constraints: constraintsOf(target)
	};
}

/** Master files the convention recognises, present in the directory. */
function knownMasterFiles(brandingDir: string, families: readonly string[]): readonly string[] {
	const family = families.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
	const known = new RegExp(`^(?:${family})(?:-\\d+(?:x\\d+)?)?\\.(?:svg|png)$`);
	return readdirSync(brandingDir)
		.filter((name) => known.test(name))
		.sort();
}

/** What someone drawing this target has to know before they start. */
function constraintsOf(target: DiscoveredTarget): readonly string[] {
	const constraints: string[] = [];
	if (target.kind === 'bmp') {
		constraints.push('no alpha channel: transparent pixels of the master are composited onto an explicit white background');
	} else if (target.kind === 'xpm') {
		constraints.push('palette-quantised on write; transparent pixels become the XPM `None` colour');
	} else {
		constraints.push('transparency is expected and preserved end to end');
	}
	if (target.kind === 'icns' && target.legacyTypes.length > 0) {
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
		ignored: [...index.ignored],
		seedCommand: index.seedCommand,
		totals: { ...index.totals },
		targets: index.targets.map((target) => ({
			target: target.target,
			family: target.family,
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
	'separately - which is what the distribution itself does. Regenerate a layer from the',
	'largest layer of its own container and compare it with the layer the distribution ships,',
	'and the mean absolute difference per RGB channel comes out as:',
	'',
	'| regenerated layer | mean difference |',
	'| --- | --- |',
	'| `code.icns` 256x256 and 512x512, from its 1024x1024 element | 1.0-2.3 / 255 |',
	'| `code.icns` 128x128, from the same element | 4.7 / 255 |',
	'| `code.ico` 128x128, from its own 256x256 frame | 13.1 / 255 |',
	'| `code.ico` and `code.icns` at 32x32 | 17.9-20.2 / 255 |',
	'| `code.ico` 16x16, from its own 256x256 frame | 65.6 / 255 |',
	'',
	'The shipped 16x16 mark is not a downsample of the large one at all - it is a different,',
	'simplified drawing. So: drop `<family>-16.png` and `<family>-32.png` into the masters',
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
	lines.push(...mastersSection(index), '', PREFERENCE_RULE, '', '## Targets', '');
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
		'Convention: `<family>.svg` is the vector master rendered at every size, `<family>.png` the',
		'raster master resampled to every size, `<family>-<N>.png` a per-size master used verbatim at',
		'exactly NxN, and `<family>-<W>x<H>.png` the same for a non-square size.'
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
		`- Family: \`${target.family}\`; container: ${target.container.toUpperCase()}; required sizes: ${target.sizes.length}`
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
	return `no \`${target.family}\` master exists; the run skips this target and exits 1`;
}
