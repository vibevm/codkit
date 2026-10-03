/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit overlay new|apply|check - the config-overlay layer's own commands.
// Contract: PROP-007 sec. 12 (##CMD-OVERLAY, ##CMD-OVERLAY-NEW); format and
// channels: PROP-005 sec. 5.
//
// An everyday developer never needs these: `load` writes the dev channel and
// leaves the upstream file alone. Packaging does need them, because a packaged
// build reads the target itself, and that is what `apply` rewrites - from the
// clean file at the pin, so running it twice writes the same bytes.
//
// `new` is the scaffold the layer went without: an overlay artifact has to be
// canonical JSON in the serializer's key order, and a hand-written one is
// refused until its author reproduces that order by reading the code.
//
// `check` is the read-only half: it asks whether the artifact still describes
// the upstream it was written against (expectUpstream against the pin), whether
// any operation writes a key the packaging step stamps by itself, and - when the
// target is already materialized - whether the file in the tree really is "the
// pin plus these operations" and not something a hand edit left behind.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import {
	EXIT_CHECK_FAILED,
	EXIT_ENVIRONMENT,
	EXIT_OK,
	commandFlagList,
	commandFlagValue,
	forkResolution,
	requireProjectType
} from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { loadConventions } from '../lib/conventionsFile.ts';
import type { Conventions } from '../lib/conventionsFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import {
	OVERLAYS_DIR,
	OVERLAY_FILE_SUFFIX,
	OVERLAY_SCHEMA_VERSION,
	applyOverlaysToTree,
	checkOverlayTarget,
	loadOverlays,
	overlayArtifactName,
	overlayTargetOf,
	parseOverlay,
	restrictedTargetViolations,
	serializeOverlay,
	overlayDriftErrors
} from '../lib/layers/overlay.ts';
import type { Overlay, OverlayDocument, OverlayTargetReport } from '../lib/layers/overlay.ts';
import { withLock } from '../lib/lock.ts';
import { ckError, isCkError } from '../lib/messages.ts';
import { OWNERS_PATH, loadOwnerKeys } from '../lib/owners.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { overlayVarContext, pinCommitDate, toPosix, patchSetCommitId } from '../lib/syncEngine.ts';
import { checkTree } from '../lib/treeIdentity.ts';

type Mode = 'apply' | 'check';

async function run(ctx: CommandContext, mode: Mode): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));

	const config = requireConfig(ctx.config, mode);
	const overlays = loadOverlays(ctx.patchesDir, ctx.type ?? undefined);
	const selected = selectTarget(overlays, ctx.args[0]);

	const identity = checkTree(resolution, config, { mode: mode === 'apply' ? 'write' : 'read', type: requireProjectType(ctx) });
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		return EXIT_ENVIRONMENT;
	}
	const tree = resolution.path;
	const context = overlayVarContext(config, pinCommitDate(tree, config.pin.sha), patchSetCommitId(ctx.patchesDir));

	let report: OverlayTargetReport;
	try {
		report = checkOverlayTarget(selected.overlays, { type: requireProjectType(ctx), treeDir: tree, pinSha: config.pin.sha, context });
	} catch (error) {
		// An artifact that no longer describes the tree is a check that did not
		// pass (exit 1); a schema failure never reaches here - it is raised when
		// the overlays are read, and that is a startup failure (exit 2).
		if (!isCkError(error) || error.code !== 'ARTIFACT-BROKEN') {
			throw error;
		}
		ctx.out.addError(error.toPayload());
		return EXIT_CHECK_FAILED;
	}
	for (const warning of report.warnings) {
		ctx.out.warn(warning);
	}
	// ##OVERLAY-NON-PRODUCT-TARGETS: a target without a dev channel may only gain
	// npm scripts, and materializing anything else would rewrite an upstream file
	// the fork has no business rewriting - so `apply` refuses it too.
	const outOfBounds = selected.overlays.flatMap((overlay) => restrictedTargetViolations(requireProjectType(ctx), overlay));
	if (report.drift.length > 0 || outOfBounds.length > 0) {
		for (const error of [...overlayDriftErrors(report.drift), ...outOfBounds]) {
			ctx.out.addError(error.toPayload());
		}
		ctx.out.setData(buildData(mode, selected, report, null));
		return EXIT_CHECK_FAILED;
	}

	if (mode === 'check') {
		return reportCheck(ctx, selected, report);
	}
	return applyTarget(ctx, config, tree, selected, report, context);
}

type Selection = { readonly target: string; readonly overlays: readonly Overlay[] };

/**
 * The argument names a target of the type or the overlay file itself
 * (`delta/overlays/<target>.overlay.json`, or any path ending in it). Both
 * are accepted: the command is used from scripts, where the artifact path is at
 * hand, and by people, who think in targets.
 */
function selectTarget(overlays: readonly Overlay[], given: string | undefined): Selection {
	if (given === undefined || given === '') {
		throw ckError(
			'CONFIG',
			'overlay apply|check needs the target to materialize or check',
			`usage: codkit overlay check <target|overlay file>   (targets in this delta: ${knownTargets(overlays)})`
		);
	}
	const byTarget = overlays.filter((overlay) => overlay.target === given);
	if (byTarget.length > 0) {
		return { target: given, overlays: byTarget };
	}
	const wanted = toPosix(given).replace(/^\.\//, '');
	const name = wanted.slice(wanted.lastIndexOf('/') + 1);
	const byFile = overlays.filter((overlay) => overlay.artifactPath === wanted || overlay.artifactPath.endsWith(`/${name}`));
	const first = byFile[0];
	if (first !== undefined) {
		// A file names one artifact, but the target it changes may be shared, and
		// the materialized file is the sum of all of them.
		return { target: first.target, overlays: overlays.filter((overlay) => overlay.target === first.target) };
	}
	throw ckError(
		'CONFIG',
		`no overlay of this delta targets "${given}"`,
		`name a target or an overlay file under ${OVERLAYS_DIR}/ (targets in this delta: ${knownTargets(overlays)})`
	);
}

function knownTargets(overlays: readonly Overlay[]): string {
	const targets = [...new Set(overlays.map((overlay) => overlay.target))];
	return targets.length === 0 ? `none, there is no ${OVERLAYS_DIR}/*${OVERLAY_FILE_SUFFIX}` : targets.join(', ');
}

/**
 * `check`: the pin side already agreed, so what is left is the tree side. A
 * materialized target that is not "the pin plus the operations" is a file
 * somebody edited by hand, and the layer cannot own it any more. A target that
 * is not materialized has nothing to be compared with, and the check says so
 * rather than claiming a drift (##CMD-OVERLAY-CHECK-TREE).
 */
function reportCheck(ctx: CommandContext, selected: Selection, report: OverlayTargetReport): number {
	ctx.out.setData(buildData('check', selected, report, null));
	if (report.materialization?.matches === false) {
		ctx.out.addError({
			code: 'OVERLAY-DRIFT',
			message: `${report.target} in the fork tree is not the pin plus the operations of ${selected.overlays.map((overlay) => overlay.id).join(', ')}`,
			hint: 'restore the file (git checkout -- <target>) and run codkit overlay apply, or extract the edit into the overlay',
			file: selected.overlays[0]?.artifactPath ?? report.target
		});
		return EXIT_CHECK_FAILED;
	}
	ctx.out.info(
		`${selected.target}: ${selected.overlays.length} overlay(s) agree with the pin; ${treeSentence(selected.target, inTree(report))}`
	);
	return EXIT_OK;
}

/** Where the target stands in the tree: `data.inTree` (##CMD-OVERLAY-CHECK-TREE). */
type InTree = 'absent' | 'pin' | 'materialized';

function inTree(report: OverlayTargetReport): InTree {
	const materialization = report.materialization;
	if (materialization === null || !materialization.present) {
		return 'absent';
	}
	return materialization.differsFromPin ? 'materialized' : 'pin';
}

function treeSentence(target: string, state: InTree): string {
	if (state === 'materialized') {
		return 'the target is materialized in the fork tree and is the pin plus the operations';
	}
	if (state === 'pin') {
		return "the target is not materialized in the fork tree (the file there is the pin's), so there is nothing to compare with the operations";
	}
	return `the target is not materialized: the fork tree has no ${target}`;
}

/** `apply`: rewrite the target in the tree. A writing command, so it locks. */
function applyTarget(
	ctx: CommandContext,
	config: CodkitConfig,
	tree: string,
	selected: Selection,
	report: OverlayTargetReport,
	context: ReturnType<typeof overlayVarContext>
): number {
	return withLock(
		ctx.patchesDir,
		treeId(tree),
		'overlay apply',
		() => {
			const applied = applyOverlaysToTree(selected.overlays, tree, config.pin.sha, context);
			ctx.out.info(
				applied.changed
					? `${applied.target}: materialized ${selected.overlays.length} overlay(s) from the pin`
					: `${applied.target}: already materialized, left untouched`
			);
			ctx.out.setData(buildData('apply', selected, report, applied.changed));
			return EXIT_OK;
		},
		(text) => {
			ctx.out.warn(text);
		}
	);
}

function buildData(mode: Mode, selected: Selection, report: OverlayTargetReport, changed: boolean | null): JsonValue {
	const data: { [key: string]: JsonValue } = {
		mode,
		target: selected.target,
		overlays: selected.overlays.map((overlay) => overlay.id),
		drift: report.drift.map((entry) => ({
			overlay: entry.overlayId,
			path: [...entry.path],
			expected: entry.expectedAbsent ? null : (entry.expected ?? null),
			expectedAbsent: entry.expectedAbsent,
			actual: entry.actual ?? null,
			actualAbsent: entry.actual === undefined
		})),
		warnings: [...report.warnings],
		inTree: inTree(report),
		materialized: inTree(report) === 'materialized',
		// Compared only when there is a materialization to compare.
		matchesOperations: inTree(report) === 'materialized' ? report.materialization?.matches !== false : null
	};
	if (changed !== null) {
		data['changed'] = changed;
	}
	return data;
}

function requireConfig(config: CodkitConfig | null, mode: Mode | 'new'): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			`codkit.json was not found in the patchset root: overlay ${mode} needs the pin and the overlays of this repository`,
			`run overlay ${mode} from a patchset checkout that carries codkit.json`
		);
	}
	return config;
}

// ---------------------------------------------------------------------------
// new (##CMD-OVERLAY-NEW)
// ---------------------------------------------------------------------------

const ID = '--id';
const TYPE = '--type';
const OWNER = '--owner';
const REASON = '--reason';
const CATEGORY = '--category';
const CONTRACT_TEST = '--contract-test';

/** PROP-007 sec. 8: the vocabularies of an intervention default the same way. */
const DEFAULT_CATEGORY = 'follow';

/**
 * `overlay new <target>` - the scaffold this layer had no equivalent of. A patch
 * gets its skeleton from `marker new` and own code from `gen feature`; an
 * overlay had to be written by hand, and a hand-written one is refused
 * (`CK-E-ARTIFACT-BROKEN: metadata bytes are not canonical JSON`) until its
 * author reproduces the schema key order from the serializer. So every first
 * overlay of every patch set cost one refusal that taught nothing.
 *
 * It writes the artifact and nothing else: canonical metadata, the pin this
 * delta stands on, the guard tests the layer makes mandatory, and an empty list
 * of operations for the author to fill in. No fork tree is touched and none is
 * needed - the target is a path in the tree, not a file this command reads.
 */
async function runNew(ctx: CommandContext): Promise<number> {
	try {
		return scaffoldOverlay(ctx);
	} catch (error) {
		if (!isCkError(error)) {
			throw error;
		}
		// PROP-007 ##CLI-EXIT-CODES, as `marker new` reads it: a problem with what
		// was typed or with the configuration is a startup failure (2); a problem
		// with the state of the delta - a taken id, an unknown owner, a malformed
		// id, an artifact that is already there - is a check that did not pass (1).
		ctx.out.addError(error.toPayload());
		return error.code === 'CONFIG' ? EXIT_ENVIRONMENT : EXIT_CHECK_FAILED;
	}
}

function scaffoldOverlay(ctx: CommandContext): number {
	const config = requireConfig(ctx.config, 'new');
	const type = requireProjectType(ctx);
	const conventions = loadConventions(type, ctx.patchesDir);
	const target = requireTarget(ctx.args[0], type);
	const fields = readNewFields(ctx);
	validateNewFields(ctx.patchesDir, fields, conventions);

	if (overlayTargetOf(type, target) === null) {
		ctx.out.warn(
			`the project type ${type.id} does not declare ${target} as an overlay target, so only the keys it restricts an ` +
				'undeclared target to may be written; codkit overlay check names the violation'
		);
	}
	for (const overlay of loadOverlays(ctx.patchesDir, ctx.type ?? undefined)) {
		if (overlay.id === fields.id) {
			throw ckError(
				'MARKER-DUP-ID',
				`id already used: ${fields.id} is the id of ${overlay.artifactPath}`,
				'give this intervention its own id',
				overlay.artifactPath
			);
		}
	}

	const artifactPath = `${OVERLAYS_DIR}/${overlayArtifactName(target)}`;
	const absolute = join(ctx.patchesDir, ...artifactPath.split('/'));
	if (existsSync(absolute)) {
		throw ckError(
			'GEN-EXISTS',
			`${artifactPath} already exists`,
			'add the operation to the existing artifact of this target, or remove it deliberately first',
			artifactPath
		);
	}

	const document: OverlayDocument = {
		codkitOverlay: OVERLAY_SCHEMA_VERSION,
		id: fields.id,
		target,
		type: fields.type,
		category: fields.category,
		owner: fields.owner,
		reason: fields.reason,
		link: 'none',
		cause: 'none',
		pin: `${config.pin.tag}@${config.pin.sha}`,
		contractTests: fields.contractTests,
		operations: []
	};
	const text = serializeOverlay(document);
	// The bytes this command writes are the bytes the loader accepts: proving it
	// here is what makes the scaffold worth having.
	parseOverlay(JSON.parse(text), artifactPath);
	mkdirSync(join(ctx.patchesDir, ...OVERLAYS_DIR.split('/')), { recursive: true });
	writeFileSync(absolute, text, { encoding: 'utf8', flag: 'wx' });

	ctx.out.info(`${artifactPath}: created for ${target} at ${config.pin.tag}`);
	ctx.out.info(`now add the operations, then: codkit overlay check ${target}`);
	ctx.out.setData({
		artifact: artifactPath,
		target,
		id: fields.id,
		type: fields.type,
		category: fields.category,
		owner: fields.owner,
		reason: fields.reason,
		pin: document.pin,
		contractTests: [...fields.contractTests],
		operations: 0
	});
	return EXIT_OK;
}

type NewFields = {
	readonly id: string;
	readonly type: string;
	readonly owner: string;
	readonly reason: string;
	readonly category: string;
	readonly contractTests: readonly string[];
};

/** The target as a canonical tree-relative path; the schema holds it to it too. */
function requireTarget(given: string | undefined, type: ReturnType<typeof requireProjectType>): string {
	if (given === undefined || given === '') {
		const declared = type.layers.overlayTargets.map((entry) => entry.path).join(', ');
		throw ckError(
			'CONFIG',
			'overlay new needs the target the overlay changes',
			`usage: codkit overlay new <target> ${ID} CK-<subsystem>-<NNN> ${TYPE} <type> ${OWNER} <owner> ${REASON} <why> ${CONTRACT_TEST} <test>` +
				`   (targets ${type.id} declares: ${declared === '' ? 'none' : declared})`
		);
	}
	return toPosix(given).replace(/^\.\//, '');
}

function readNewFields(ctx: CommandContext): NewFields {
	const contractTests = commandFlagList(ctx.commandFlags, CONTRACT_TEST).filter((value) => value !== '');
	if (contractTests.length === 0) {
		throw ckError(
			'CONFIG',
			`overlay new needs at least one ${CONTRACT_TEST}`,
			'a guard test is mandatory for this layer (PROP-005 ##CROSS-CUTTING-MECHANISMS): the overlay has no marker in the ' +
				'target file, so the test is the only thing that fails when upstream takes the key away'
		);
	}
	return {
		id: requireNewFlag(ctx, ID),
		type: requireNewFlag(ctx, TYPE),
		owner: requireNewFlag(ctx, OWNER),
		reason: requireNewFlag(ctx, REASON),
		category: commandFlagValue(ctx.commandFlags, CATEGORY) ?? DEFAULT_CATEGORY,
		contractTests
	};
}

function requireNewFlag(ctx: CommandContext, name: string): string {
	const value = commandFlagValue(ctx.commandFlags, name);
	if (value === null || value === '') {
		throw ckError(
			'CONFIG',
			`overlay new needs ${name}`,
			`usage: codkit overlay new <target> ${ID} CK-<subsystem>-<NNN> ${TYPE} <type> ${OWNER} <owner> ${REASON} <why> ${CONTRACT_TEST} <test>`
		);
	}
	return value;
}

/** The same vocabularies `marker new` holds an intervention to (PROP-007 sec. 8). */
function validateNewFields(patchesDir: string, fields: NewFields, conventions: Conventions): void {
	if (!new RegExp(conventions.idPattern).test(fields.id)) {
		throw ckError(
			'MARKER-BAD-ID',
			`id "${fields.id}" does not match the id pattern of conventions.json`,
			`use an id of the form CK-<subsystem>-<NNN> with a subsystem from conventions.json (pattern: ${conventions.idPattern})`
		);
	}
	if (!conventions.interventionTypes.includes(fields.type)) {
		throw ckError(
			'CONFIG',
			`type "${fields.type}" is not one of the intervention types`,
			`use one of: ${conventions.interventionTypes.join(', ')}`
		);
	}
	if (!conventions.categories.includes(fields.category)) {
		throw ckError(
			'CONFIG',
			`category "${fields.category}" is not one of the categories`,
			`use one of: ${conventions.categories.join(', ')}`
		);
	}
	const owners = loadOwnerKeys(patchesDir);
	if (owners !== null && !owners.includes(fields.owner)) {
		throw ckError(
			'OWNER-UNKNOWN',
			`owner "${fields.owner}" is not declared in ${OWNERS_PATH}`,
			`use one of: ${owners.join(', ')}   (or add the owner to ${OWNERS_PATH} first)`,
			OWNERS_PATH
		);
	}
}

export const overlayApplyCommand: CommandDefinition = {
	name: 'overlay apply',
	summary: 'materialize an overlay target into the fork tree (packaging, CI, publish)',
	configMode: 'load',
	maxArgs: 1,
	run: (ctx) => run(ctx, 'apply')
};

export const overlayCheckCommand: CommandDefinition = {
	name: 'overlay check',
	summary: 'check an overlay against the pin and against the file in the tree',
	configMode: 'load',
	maxArgs: 1,
	run: (ctx) => run(ctx, 'check')
};

export const overlayNewCommand: CommandDefinition = {
	name: 'overlay new',
	summary: 'scaffold an overlay artifact for a target of the config-overlay layer',
	configMode: 'load',
	maxArgs: 1,
	commandFlags: [ID, TYPE, OWNER, REASON, CATEGORY, CONTRACT_TEST],
	run: runNew
};
