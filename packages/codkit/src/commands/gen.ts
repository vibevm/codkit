/** @scope spec://codkit/modules/codkit/PROP-015#gen */
// codkit gen - the skeletons a product starts a feature and a brand table from,
// and the licence surfaces it writes from its profile. Contract: PROP-007 sec.
// 26, algorithm PROP-015 sec. 5 and PROP-019 (##GEN-LICENSING).
//
// `gen feature` and `gen brand` need the patch-set root and nothing else
// (##GEN-NAMESPACE): a skeleton is written into the delta, and the fork tree
// receives it on the next `codkit load` like any other own file. `gen licensing`
// needs the fork tree as well, because the `expectUpstream` of its overlays and
// the component licences it ships are the pin's bytes.

import type { ProjectType } from '@codkit/type-api';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { requireCapability } from '../types/capability.ts';
import {
	EXIT_CHECK_FAILED,
	EXIT_ENVIRONMENT,
	EXIT_OK,
	commandFlagGiven,
	commandFlagValue,
	forkResolution,
	patchesRoot,
	requireProjectType
} from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { featureDirectoryName, planBrand, planFeature, readHeaderText, refuseExisting, writeGenerated } from '../lib/genFeature.ts';
import type { GenHeader, GenOutcome, HeaderByPath } from '../lib/genFeature.ts';
import { existingTargets, planLicensing, refuseExistingLicensing, writeLicensingPlan } from '../lib/genLicensing.ts';
import type { LicensingPlan, PlannedFile } from '../lib/genLicensing.ts';
import type { HeaderStyle } from '../lib/genTemplates.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { COPYRIGHT_LINE, SPDX_LINE, holderOf } from '../lib/licenseCarrier.ts';
import { headerFieldsFor, headerStyleOf, ownLicenseFor, readLicensingProfile } from '../lib/licensingProfile.ts';
import type { LicensingProfile } from '../lib/licensingProfile.ts';
import { licensingAreaOf } from '../lib/licensingSurfaces.ts';
import { ckError, isCkError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { RELEASE_LICENSING_FILE } from '../lib/releaseLicensing.ts';
import { checkTree } from '../lib/treeIdentity.ts';

const TITLE = '--title';
const SETTING = '--setting';
const COLD = '--cold';
const HOLDER = '--holder';
const LICENSE = '--license';
const YEAR = '--year';
const HEADER_STYLE = '--header-style';
const HEADER_FILE = '--header-file';
const OWNER = '--owner';
const UPDATE = '--update';
const DRY_RUN = '--dry-run';

/** The two shapes codkit can lay a header out in from fields (##GEN-HEADER-IS-THE-PRODUCTS). */
const HEADER_STYLES: readonly HeaderStyle[] = ['line', 'block'];

/** ##GEN-HEADER-IS-THE-PRODUCTS: a header is written only when the product supplies one. */
const NO_HEADER_WARNING = 'no header written; pass --holder and --license, or --header-file';

/** ##HEADER-FROM-PROFILE: the carrier a header file must resolve to is read in the window the consumer check reads. */
const HEADER_WINDOW_LINES = 20;

/** The flags of the header, shared by both skeleton subcommands (##GEN-NAMESPACE). */
const HEADER_FLAGS: readonly string[] = [HOLDER, LICENSE, YEAR, HEADER_STYLE, HEADER_FILE];

/** main.ts answers a bare namespace before this runs (##GEN-NAMESPACE). */
async function runNamespace(): Promise<number> {
	return EXIT_ENVIRONMENT;
}

/** The header flags as they were given; null where a flag was not. */
type HeaderFlags = {
	readonly file: string | null;
	readonly holder: string | null;
	readonly license: string | null;
	readonly year: string | null;
	readonly style: string | null;
};

function headerFlagsOf(ctx: CommandContext): HeaderFlags {
	return {
		file: commandFlagValue(ctx.commandFlags, HEADER_FILE),
		holder: commandFlagValue(ctx.commandFlags, HOLDER),
		license: commandFlagValue(ctx.commandFlags, LICENSE),
		year: commandFlagValue(ctx.commandFlags, YEAR),
		style: commandFlagValue(ctx.commandFlags, HEADER_STYLE)
	};
}

/**
 * ##GEN-HEADER-IS-THE-PRODUCTS: the header the run will write, or null when the
 * product asked for none. The two forms do not mix - either codkit lays the
 * product's fields out, or the product hands over the finished text - so the
 * combination is settled here, before a single target is planned. With a
 * licensing profile selected the header comes from the profile instead
 * (##HEADER-FROM-PROFILE), and the flags may only restate what it says.
 */
function headerOf(ctx: CommandContext, patchesDir: string, type: ProjectType): GenHeader {
	const flags = headerFlagsOf(ctx);
	if (flags.file !== null) {
		const also = [HOLDER, LICENSE, YEAR, HEADER_STYLE].filter((flag) => ctx.commandFlags.has(flag));
		if (also.length > 0) {
			throw ckError(
				'CONFIG',
				`${HEADER_FILE} writes the header verbatim and cannot be combined with ${also.join(', ')}`,
				`drop ${also.join(', ')}, or drop ${HEADER_FILE} and let codkit lay the fields out; nothing was written`
			);
		}
	}
	const profile = readLicensingProfile(patchesDir);
	if (profile !== null) return headerFromProfile(patchesDir, profile, type, flags);
	if (flags.file !== null) return { form: 'text', text: readHeaderText(patchesDir, flags.file) };
	if (flags.holder === null || flags.license === null) {
		// A style with nothing to lay out is a typo, not a request for no header.
		if (flags.style !== null) {
			throw ckError('CONFIG', `${HEADER_STYLE} has no header to shape`, `pass ${HOLDER} and ${LICENSE} as well; nothing was written`);
		}
		return null;
	}
	return {
		form: 'fields',
		holder: flags.holder,
		license: flags.license,
		year: flags.year ?? new Date().getUTCFullYear().toString(),
		style: styleFlagOf(flags.style)
	};
}

/**
 * ##HEADER-FROM-PROFILE: the header of every generated file from the selected
 * profile - the holder of the product block, the own expression resolved for
 * the file's path, the year, the title and the licence file, in the style the
 * type names. A flag still takes effect where the profile leaves room (the
 * year, the style) and must agree with it where it does not: a holder outside
 * the policy or an identifier other than the own one is a refusal with nothing
 * written. `--header-file` keeps the house form, and its text has to resolve to
 * a carrier of the profile for every file it would head.
 */
function headerFromProfile(patchesDir: string, profile: LicensingProfile, type: ProjectType, flags: HeaderFlags): HeaderByPath {
	if (flags.file !== null) {
		const file = flags.file;
		const text = readHeaderText(patchesDir, file);
		return {
			form: 'by-path',
			style: 'file',
			headerFor: (path) => {
				assertHeaderTextAgrees(profile, text, path, file);
				return { form: 'text', text };
			}
		};
	}
	const holders = profile.selected.policy.holders;
	const holder = flags.holder ?? profile.product.holder;
	if (!holders.includes(holder)) {
		throw ckError(
			'CONFIG',
			`the header disagrees with the selected profile: ${HOLDER} ${JSON.stringify(holder)} is not one of its holders`,
			`use one of: ${holders.join(', ')}; nothing was written`,
			RELEASE_LICENSING_FILE
		);
	}
	const style = flags.style === null ? headerStyleOf(type) : styleFlagOf(flags.style);
	return {
		form: 'by-path',
		style,
		headerFor: (path) => {
			const fields = headerFieldsFor(profile, path, style);
			if (flags.license !== null && flags.license !== fields.license) {
				throw ckError(
					'CONFIG',
					`the header disagrees with the selected profile: ${LICENSE} ${flags.license} is not the own licence ${fields.license} of ${path}`,
					`drop ${LICENSE}, or pass the own licence of the profile; nothing was written`,
					RELEASE_LICENSING_FILE
				);
			}
			return { form: 'fields', ...fields, holder, year: flags.year ?? fields.year };
		}
	};
}

/**
 * ##HEADER-FROM-PROFILE: a header file read in the window of the consumer check
 * (PROP-019 ##CONSUMER-LICENSE-CHECK): every copyright line names a holder of
 * the policy, and exactly one SPDX line names the own expression of the file the
 * text would head.
 */
function assertHeaderTextAgrees(profile: LicensingProfile, text: string, path: string, file: string): void {
	const window = text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.slice(0, HEADER_WINDOW_LINES);
	const holders = profile.selected.policy.holders;
	const named = window.map((line) => COPYRIGHT_LINE.exec(line)).filter((match): match is RegExpExecArray => match !== null);
	const foreign = named.map((match) => holderOf(match)).find((holder) => !holders.includes(holder));
	if (named.length === 0 || foreign !== undefined) {
		throw ckError(
			'CONFIG',
			named.length === 0
				? `the header file carries no copyright line naming a holder of the selected profile`
				: `the header file names the holder ${JSON.stringify(foreign)}, who is not a holder of the selected profile`,
			`write a copyright line naming one of: ${holders.join(', ')}; nothing was written`,
			file
		);
	}
	const own = ownLicenseFor(profile, path);
	const expressions = window.map((line) => SPDX_LINE.exec(line)?.groups?.['expr']).filter((found): found is string => found !== undefined);
	if (expressions.length !== 1 || expressions[0] !== own) {
		throw ckError(
			'CONFIG',
			expressions.length === 1
				? `the header file says SPDX-License-Identifier: ${expressions[0] ?? ''}, not the own licence ${own} of ${path}`
				: `the header file carries ${expressions.length} SPDX-License-Identifier lines instead of one`,
			`write exactly one SPDX-License-Identifier line naming ${own}; nothing was written`,
			file
		);
	}
}

/** ##GEN-HEADER-IS-THE-PRODUCTS: `line` is the default, and there is no third shape. */
function styleFlagOf(style: string | null): HeaderStyle {
	if (style === null) return 'line';
	const known = HEADER_STYLES.find((candidate) => candidate === style);
	if (known === undefined) {
		throw ckError('CONFIG', `${HEADER_STYLE} ${JSON.stringify(style)} is not a header style`, `use ${HEADER_STYLES.join(' or ')}`);
	}
	return known;
}

/**
 * The own root shapes what a generator of this family writes and what a person
 * is asked to write by hand. It comes from the configuration, which is why
 * these two verbs read one (##GEN-NAMESPACE is about the namespace, not about
 * the answers the type needs to give).
 */
function ownRoot(ctx: CommandContext): string {
	return ctx.config?.typeConfig.ownRoot ?? '';
}

/**
 * ##GEN-REFUSES-EXISTING: exit 1 with nothing written. It is a verdict about
 * the patch set, not a broken environment, so it is answered here rather than
 * thrown out of the command.
 */
function refuse(ctx: CommandContext, patchesDir: string, outcome: GenOutcome): number | null {
	try {
		refuseExisting(patchesDir, outcome.files);
		return null;
	} catch (error) {
		if (!isCkError(error) || error.code !== 'GEN-EXISTS') throw error;
		ctx.out.addError(error.toPayload());
		ctx.out.setData({ files: outcome.files.map((file) => file.path), written: false } satisfies JsonValue);
		return EXIT_CHECK_FAILED;
	}
}

async function runFeature(ctx: CommandContext): Promise<number> {
	const patchesDir = patchesRoot(ctx);
	const id = ctx.args[0];
	if (id === undefined) {
		throw ckError('CONFIG', 'gen feature needs a feature id', 'usage: codkit gen feature <id> --title <text>');
	}
	const title = commandFlagValue(ctx.commandFlags, TITLE);
	if (title === null || title === '') {
		throw ckError('CONFIG', 'gen feature needs --title <text>', 'usage: codkit gen feature <id> --title <text>');
	}
	// The id is validated before anything else: it decides the directory, and a
	// refusal here has nothing to undo (##GEN-FEATURE).
	featureDirectoryName(id);
	const type = requireProjectType(ctx);
	const header = headerOf(ctx, patchesDir, type);
	const outcome = planFeature({
		patchesDir,
		header,
		type,
		ownRoot: ownRoot(ctx),
		id,
		title,
		setting: commandFlagGiven(ctx.commandFlags, SETTING),
		cold: commandFlagGiven(ctx.commandFlags, COLD)
	});

	const refusal = refuse(ctx, patchesDir, outcome);
	if (refusal !== null) return refusal;
	writeGenerated(patchesDir, outcome.files);

	for (const file of outcome.files) ctx.out.info(`created ${file.path}`);
	if (!outcome.headerWritten) ctx.out.warn(NO_HEADER_WARNING);
	ctx.out.info(`next: add to the composition root of the product: ${outcome.importLine}`);
	for (const reminder of outcome.reminders) ctx.out.info(`next: ${reminder}`);
	ctx.out.setData({
		id,
		files: outcome.files.map((file) => file.path),
		importLine: outcome.importLine,
		headerWritten: outcome.headerWritten,
		headerStyle: outcome.headerStyle,
		reminders: [...outcome.reminders]
	} satisfies JsonValue);
	return EXIT_OK;
}

async function runBrand(ctx: CommandContext): Promise<number> {
	requireCapability(ctx.type, 'gen-brand', 'gen brand');
	const patchesDir = patchesRoot(ctx);
	const type = requireProjectType(ctx);
	const outcome = planBrand({ patchesDir, header: headerOf(ctx, patchesDir, type), type, ownRoot: ownRoot(ctx) });

	const refusal = refuse(ctx, patchesDir, outcome);
	if (refusal !== null) return refusal;
	writeGenerated(patchesDir, outcome.files);

	for (const file of outcome.files) ctx.out.info(`created ${file.path}`);
	if (!outcome.headerWritten) ctx.out.warn(NO_HEADER_WARNING);
	ctx.out.info('----- the graft into the string funnel of the distribution (write it as a patch of the product) -----');
	ctx.out.info(outcome.hookText.replace(/\n$/u, ''));
	ctx.out.info('----- end of the graft -----');
	for (const reminder of outcome.reminders) ctx.out.info(`reminder: ${reminder}`);
	ctx.out.setData({
		file: outcome.files[0]?.path ?? '',
		files: outcome.files.map((file) => file.path),
		hookText: outcome.hookText,
		reminders: [...outcome.reminders],
		headerWritten: outcome.headerWritten
	} satisfies JsonValue);
	return EXIT_OK;
}

// ---------------------------------------------------------------------------
// gen licensing (##GEN-LICENSING, PROP-007 ##CMD-GEN-LICENSING)
// ---------------------------------------------------------------------------

/** `gen licensing` reads the pin, so a patch set without a configuration has nothing to write from. */
function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: gen licensing needs the pin and the type of this patch set',
			'run gen licensing from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

/**
 * ##GEN-LICENSING: the surfaces of the product from the selected profile and the
 * type's area. The plan is computed in full first; then an existing artifact is
 * refused or, under `--update`, rewritten; a dry run stops after the plan. The
 * profile is read before the tree is touched: a patch set without a declaration
 * has nothing to write, whatever the tree looks like.
 */
async function runLicensing(ctx: CommandContext): Promise<number> {
	const patchesDir = patchesRoot(ctx);
	const config = requireConfig(ctx.config);
	const type = requireProjectType(ctx);
	licensingAreaOf(type, 'gen licensing');
	const profile = readLicensingProfile(patchesDir);
	if (profile === null) {
		throw ckError(
			'CONFIG',
			`gen licensing needs ${RELEASE_LICENSING_FILE} selecting a trusted profile`,
			'write the declaration selecting the profile of the organization; see PROP-019 LICENSING-DECLARATION-V2',
			RELEASE_LICENSING_FILE
		);
	}

	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	// Read-only on the tree, like verify: the pin's bytes come from git objects,
	// so a dirty tree is no obstacle, but an unreachable pin is.
	const identity = checkTree(resolution, config, { mode: 'read', type });
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		return EXIT_ENVIRONMENT;
	}

	const plan = planLicensing({
		patchesDir,
		treeDir: resolution.path,
		toolRoot: ctx.toolRoot,
		config,
		type,
		profile,
		owner: commandFlagValue(ctx.commandFlags, OWNER)
	});
	const update = commandFlagGiven(ctx.commandFlags, UPDATE);
	const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
	if (!update) {
		try {
			refuseExistingLicensing(plan);
		} catch (error) {
			if (!isCkError(error) || error.code !== 'GEN-EXISTS') throw error;
			ctx.out.addError(error.toPayload());
			ctx.out.setData({ files: [...existingTargets(plan)], written: false } satisfies JsonValue);
			return EXIT_CHECK_FAILED;
		}
	}
	if (!dryRun) writeLicensingPlan(patchesDir, plan);

	for (const file of plan.files) ctx.out.info(dryRun ? `dry run: would have ${describeWrite(plan, file)}` : describeWrite(plan, file));
	for (const reminder of plan.reminders) ctx.out.info(`next: ${reminder}`);
	ctx.out.setData({
		owner: plan.owner,
		files: plan.files.map((file) => ({ path: file.path, action: dryRun ? 'planned' : file.exists ? 'updated' : 'created' })),
		overlays: plan.overlays.map((overlay) => ({ artifact: overlay.artifact, target: overlay.target, operations: overlay.operations })),
		reminders: [...plan.reminders],
		dryRun
	} satisfies JsonValue);
	return EXIT_OK;
}

/** `created <path>`, `updated <path>`, or `merged <overlay> (<n> operation(s))` for an overlay the patch set already had. */
function describeWrite(plan: LicensingPlan, file: PlannedFile): string {
	const overlay = plan.overlays.find((candidate) => candidate.artifact === file.path);
	if (overlay !== undefined && overlay.merged) return `merged ${file.path} (${overlay.operations} operation(s))`;
	return `${file.exists ? 'updated' : 'created'} ${file.path}`;
}

export const genCommand: CommandDefinition = {
	name: 'gen',
	summary: 'namespace of the product skeletons and licence surfaces; run gen feature, gen brand or gen licensing',
	configMode: 'none',
	namespace: true,
	roots: 'none',
	maxArgs: 0,
	run: runNamespace
};

export const genFeatureCommand: CommandDefinition = {
	name: 'gen feature',
	summary: 'write the skeleton of a flag-gated product feature into delta/own/',
	configMode: 'load',
	roots: 'patches',
	maxArgs: 1,
	commandFlags: [TITLE, SETTING, COLD, ...HEADER_FLAGS],
	run: runFeature
};

export const genBrandCommand: CommandDefinition = {
	name: 'gen brand',
	summary: "write the brand rules table and print the graft for the distribution's string funnel",
	configMode: 'load',
	roots: 'patches',
	maxArgs: 0,
	commandFlags: [...HEADER_FLAGS],
	run: runBrand
};

export const genLicensingCommand: CommandDefinition = {
	name: 'gen licensing',
	summary: 'write the licence surfaces of the product from the selected profile',
	configMode: 'load',
	roots: 'patches',
	maxArgs: 0,
	commandFlags: [OWNER, UPDATE, DRY_RUN],
	run: runLicensing
};
