/** @scope spec://codkit/modules/codkit/PROP-007#CMD-IMAGESET */
// codkit imageset - the namespace of the product icon set, with `gen`, `index`
// and `verify` under it. Contract: PROP-007 (##CMD-IMAGESET, ##IMAGESET-INDEX,
// ##IMAGESET-VERIFY and the other IMAGESET-* anchors of its section). The
// operator runs these, looks at the result, and commits the patchset
// themselves; no other command invokes them and they invoke none.
//
// Delivery is the resource layer: `gen` writes generated files under
// delta/resources/files/ with map entries in delta/resources/map.json, and
// `codkit load` materialises them into the fork tree. That is what keeps the
// product repository free of implementation detail - it gains resource
// artifacts indistinguishable from hand-made ones.
//
// The root is a namespace and never generates: a bare `codkit imageset` that
// quietly did work is exactly the dumping ground splitting the verbs avoids.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { requireCapability } from '../types/capability.ts';
import { EXIT_OK, commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { runImageset } from '../lib/imagesetEngine.ts';
import { buildImagesetIndex, indexData, renderImagesetIndex } from '../lib/imagesetIndex.ts';
import { defaultBrandingDir } from '../lib/imagesetMasters.ts';
import { renderImagesetVerification, verificationData, verificationExitCode, verifyImageset } from '../lib/imagesetVerify.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { withLock } from '../lib/lock.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';

const DRY_RUN = '--dry-run';
const BRANDING_DIR = '--branding-dir';
const HELP = '--help';

/**
 * The long help, and it lives on the namespace: the owner asked one question
 * of it - which tools must be installed - and with this design the answer is
 * none, on every supported OS. The linked libraries and their licences follow
 * so the claim can be checked instead of trusted. Repeating any of that per
 * subcommand would only invite the two copies to drift apart.
 */
const HELP_TEXT = `codkit imageset - the product's brand images: generate them, or report on them

usage: codkit imageset <subcommand> [flags]

subcommands:
  gen [--dry-run] [--branding-dir <path>]
      Regenerate every brand image of the distribution from the branding
      masters and write the result into the resource layer. --dry-run prints
      the plan, including which master would serve each size, and writes
      nothing.
  index [--branding-dir <path>]
      Print an index of the image set - every target, its role, the sizes the
      distribution requires, and where each size comes from. Read-only: it
      never seeds and never writes. --json emits the same model structurally.
  verify [--branding-dir <path>]
      Run the acceptance bands against the distribution the fork tree already
      holds: for every raster target, take the largest layer of a container,
      regenerate the other layers of that same container from it, and measure
      each against the layer the distribution ships. Read-only, and it never
      compares one container with another. Exit 0 when every asserted
      comparison is inside its band, 1 when one is outside.

Masters live in <patchset>/branding by default; --branding-dir overrides it.
On the first gen run the directory is created and seeded with the fork tree's
own icons, then you replace them piece by piece:

  <key>.svg          vector master, rendered at every size (preferred)
  <key>.png          raster master, Lanczos-resampled to every size
  <key>-<N>.png      per-size override, used verbatim at exactly NxN
  <key>-<W>x<H>.png  per-size override for non-square sizes

<key> is the family for a family that holds one drawing, and family/artwork
for one that holds several - so icon.svg, but filetype/json.svg.

Which families a distribution has, what each of them is for, and which
containers they are stored in are the project type's answer; codkit imageset
index prints them for the patch set at hand, family by family and file by file.

Every raster size is rendered from a vector at its native resolution; raster
masters are the only resampled path. A vector target is not rasterised at all:
its master is emitted unchanged, so whatever the file contains - comments
included - is what ships.

Generated files are written into delta/resources/files/ and map entries into
delta/resources/map.json; a new map entry needs the guard suite
guard.brand.<family> declared under delta/own/test/ first - one suite per
family, not one per drawing. Deliver the icons
into the fork tree with codkit load, then review and commit the patchset.

Required tools: none, on every supported OS. The SVG rasteriser ships as a
prebuilt native module for twelve platforms (darwin x64/arm64, linux
x64/arm64/arm each in gnu and musl, win32 x64/ia32/arm64, android), and the
container codecs are hand-written inside the project type's own package - there
is no image-processing dependency to install.

Linked libraries and licences:
  @resvg/resvg-js 2.6.2 and its twelve platform binaries      MPL-2.0
  resvg / usvg (Rust, statically linked into the binary)      MPL-2.0
  tiny-skia (raster backend, statically linked)               BSD-3-Clause
  rustybuzz, ttf-parser (text shaping and fonts)              Apache-2.0 OR MIT
  roxmltree, svgtypes, simplecss, fontdb, data-url, xmlwriter Apache-2.0 OR MIT
  png, flate2, serde_json (image and support crates)          Apache-2.0 OR MIT
  zlib (via the flate2 backend)                               Zlib
No GPL, LGPL or AGPL code is in the closure; the licences above are the whole
of it.`;

/** The namespace itself: only `--help` reaches here (see main.ts). */
async function runNamespace(ctx: CommandContext): Promise<number> {
	for (const line of HELP_TEXT.split('\n')) {
		ctx.out.info(line);
	}
	return EXIT_OK;
}

async function runGen(ctx: CommandContext): Promise<number> {
	requireCapability(ctx.type, 'brand-images', 'imageset gen');
	const config = requireConfigForImageset(ctx.config, 'gen');
	const resolution = requireTree(ctx, 'gen');
	const brandingDir = brandingDirOf(ctx);
	const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);

	return withLock(
		ctx.patchesDir,
		treeId(resolution.path),
		'imageset gen',
		() => {
			const { exitCode, report } = runImageset({
				patchesDir: ctx.patchesDir,
				type: requireProjectType(ctx),

				treeDir: resolution.path,
				brandingDir,
				pin: { tag: config.pin.tag, sha: config.pin.sha },
				dryRun,
				onInfo: (text) => ctx.out.info(text),
				onWarn: (text) => ctx.out.warn(text)
			});
			ctx.out.setData(dataOf(report));
			return exitCode;
		},
		(text) => ctx.out.warn(text)
	);
}

/**
 * `index` runs read-only and takes no lock: it opens the same two sources the
 * generator reads and writes neither of them, so a concurrent `gen` can only
 * make the report a moment stale - which is cheaper than serialising a report
 * behind a run that may take minutes.
 */
async function runIndex(ctx: CommandContext): Promise<number> {
	requireCapability(ctx.type, 'brand-images', 'imageset index');
	const resolution = requireTree(ctx, 'index');
	const index = buildImagesetIndex({
		type: requireProjectType(ctx),

		treeDir: resolution.path,
		brandingDir: brandingDirOf(ctx),
		onReport: (text) => ctx.out.info(text)
	});
	ctx.out.setData(indexData(index));
	if (!ctx.out.jsonMode) {
		for (const line of renderImagesetIndex(index).split('\n')) {
			ctx.out.info(line);
		}
	}
	// A missing master is information, not a failure: the whole point of the
	// index is to report a set that is not finished yet.
	return EXIT_OK;
}

/**
 * `verify` is the executable form of the acceptance bands, and it is as
 * read-only as `index`: no lock, nothing written to the patchset, nothing
 * written to - or seeded into - the masters directory. The masters take no
 * part in the measurement at all, because the master of every round trip is a
 * layer of the shipped file itself; --branding-dir is accepted so the three
 * verbs of the namespace are addressed the same way, and the report names the
 * directory it did not touch.
 */
async function runVerify(ctx: CommandContext): Promise<number> {
	requireCapability(ctx.type, 'brand-images', 'imageset verify');
	const resolution = requireTree(ctx, 'verify');
	const verification = verifyImageset({
		type: requireProjectType(ctx),

		treeDir: resolution.path,
		brandingDir: brandingDirOf(ctx),
		onReport: (text) => ctx.out.info(text)
	});
	ctx.out.setData(verificationData(verification));
	if (!ctx.out.jsonMode) {
		for (const line of renderImagesetVerification(verification).split('\n')) {
			ctx.out.info(line);
		}
	}
	return verificationExitCode(verification);
}

function brandingDirOf(ctx: CommandContext): string {
	const flag = commandFlagValue(ctx.commandFlags, BRANDING_DIR);
	return flag !== null ? flag : defaultBrandingDir(ctx.patchesDir);
}

function requireTree(ctx: CommandContext, mode: 'gen' | 'index' | 'verify') {
	const resolution = forkResolution(ctx);
	if (!resolution.exists) {
		throw ckError(
			'CONFIG',
			`the fork tree ${resolution.path} does not exist, and imageset ${mode} reads the distribution's own icons from it`,
			'run codkit load first, or point --fork-dir at an existing fork tree'
		);
	}
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}
	return resolution;
}

function requireConfigForImageset(config: CodkitConfig | null, mode: string): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			`codkit.json was not found in the patchset root: imageset ${mode} writes resource entries that name the current pin`,
			`run imageset ${mode} from a patchset checkout that carries codkit.json`
		);
	}
	return config;
}

function dataOf(report: ReturnType<typeof runImageset>['report']): JsonValue {
	return {
		brandingDir: report.brandingDir,
		dryRun: report.dryRun,
		seeded: report.seeded.map((seed) => ({ file: seed.file, from: seed.from, width: seed.width, height: seed.height })),
		targets: report.targets.map((target) => ({
			target: target.target,
			family: target.family,
			kind: target.kind,
			frames: target.frames.map((frame) => ({
				width: frame.width,
				height: frame.height,
				source: frame.source,
				// ##IMAGESET-STRETCH-REPORTED: the stretch as fields, not only inside `source`.
				stretched: frame.stretch?.stretched ?? false,
				stretchPercent: frame.stretch?.percent ?? null,
				// ##IMAGESET-SELF-CHECK-READS-MASTERS: a 16-bit master brought to 8 bits.
				reducedFrom16Bit: frame.reduced
			})),
			skipped: target.skipped,
			entry: target.entry,
			legacyTypes: [...target.legacyTypes]
		})),
		written: [...report.written]
	};
}

export const imagesetCommand: CommandDefinition = {
	name: 'imageset',
	summary: 'namespace of the product icon set; run imageset gen, index or verify',
	configMode: 'none',
	namespace: true,
	maxArgs: 0,
	commandFlags: [HELP],
	run: runNamespace
};

export const imagesetGenCommand: CommandDefinition = {
	name: 'imageset gen',
	summary: 'regenerate the product icon set from branding masters into the resource layer',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [DRY_RUN, BRANDING_DIR],
	run: runGen
};

export const imagesetIndexCommand: CommandDefinition = {
	name: 'imageset index',
	summary: 'report the icon set: every required size and the master it comes from',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [BRANDING_DIR],
	run: runIndex
};

export const imagesetVerifyCommand: CommandDefinition = {
	name: 'imageset verify',
	summary: 'round-trip every layered target against itself and check the acceptance bands',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [BRANDING_DIR],
	run: runVerify
};
