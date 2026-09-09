/** @scope spec://codkit/modules/codkit/PROP-005#root */
// config-overlay layer: file format, operations, dev-channel materialization
// (PROP-005 sec. 5).
//
// An overlay describes a change to a JSON file as data, never as text: the
// target is parsed, the operations are applied to the parsed value, and the
// result is serialized. That is what makes the layer survive upstream
// reformatting of the same file.
//
// Materialization has two channels (##OVERLAY-TWO-CHANNELS), and both live here.
// Channel 1 is the one `load` uses: the dev-channel sidecar the type names,
// which the running product reads instead of the target during development and
// which upstream ignores, so the tree stays clean. Channel 2 rewrites the target file itself, for
// packaging and publishing; its base is always the *clean file at the pin*
// (`git show <pin>:<target>`), never the current state of the tree, which is
// what makes `overlay apply` idempotent.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { OverlayTarget, ProjectType } from '@codkit/type-api';
import { z } from 'zod';
import { bytesEqual, encodeUtf8 } from '../bytes.ts';
import { runGit } from '../gitx.ts';
import { ckError } from '../messages.ts';
import type { CkError } from '../messages.ts';
import { repoRelativePathProblem, resolveContainedPath } from '../pathSafety.ts';

export const OVERLAY_SCHEMA_VERSION = 2;

/** Overlays live here, one file per target, relative to the patchset root. */
export const OVERLAYS_DIR = 'delta/overlays';

export const OVERLAY_FILE_SUFFIX = '.overlay.json';

/** How a `/` of the target is spelled inside the artifact's file name. */
const NAME_SEPARATOR = '__';

/**
 * The artifact file name a scaffold gives an overlay of this target, encoded
 * the way a patch file name is: one file per target, `/` written as `__`, and
 * the layer's suffix. The loader reads the target out of the document rather
 * than out of the name, so this is a convention for people and for `selectTarget`
 * - but it has to be a total one, and a target that already contains the
 * separator would not read back.
 */
export function overlayArtifactName(target: string): string {
	if (target === '' || target.includes(NAME_SEPARATOR)) {
		throw ckError(
			'CONFIG',
			`cannot name an overlay artifact for the target ${JSON.stringify(target)}`,
			`the file name writes "/" as "${NAME_SEPARATOR}", so the target must be non-empty and must not contain "${NAME_SEPARATOR}"`
		);
	}
	return `${target.split('/').join(NAME_SEPARATOR)}${OVERLAY_FILE_SUFFIX}`;
}

/**
 * The overlay target that carries a dev channel, or null when this family has
 * none. The two-channel machinery is universal; which file is the manifest, and
 * whether a dev channel exists for it at all, is the type's answer
 * (##OVERLAY-TWO-CHANNELS).
 */
export function devChannelTarget(type: ProjectType): OverlayTarget | null {
	return type.layers.overlayTargets.find((target) => target.devChannel !== null) ?? null;
}

/** The dev-channel file of this family, relative to the tree root, or null. */
export function devChannelFile(type: ProjectType): string | null {
	return devChannelTarget(type)?.devChannel ?? null;
}

/** What the type says about one target, or null when it declares none. */
export function overlayTargetOf(type: ProjectType, target: string): OverlayTarget | null {
	return type.layers.overlayTargets.find((declared) => declared.path === target) ?? null;
}

/**
 * The only top-level keys an overlay of this target may touch, or null when the
 * whole document is open to it. A target the type does not declare is held to
 * the strictest rule the type states for a target without a dev channel: an
 * undeclared target is not upstream's manifest, so it is written to as
 * conservatively as the ones that are known not to be.
 */
export function allowedOverlayKeys(type: ProjectType, target: string): readonly string[] | null {
	const declared = overlayTargetOf(type, target);
	if (declared !== null) {
		return declared.allowedKeys;
	}
	const restricted = type.layers.overlayTargets.flatMap((candidate) => candidate.allowedKeys ?? []);
	return [...new Set(restricted)];
}

/** Variables `{"$var": ...}` may name (##OVERLAY-VARS). */
export const OVERLAY_VARS = ['pin.tag', 'pin.sha', 'pin.date', 'patchset.commit', 'build.date'] as const;

export type OverlayVarName = (typeof OVERLAY_VARS)[number];

export type JsonLike = string | number | boolean | null | JsonLike[] | { [key: string]: JsonLike };

export type OverlayVarContext = {
	readonly pinTag: string;
	readonly pinSha: string;
	readonly pinDate: string;
	/** HEAD of the patchset repository, or `dirty` when it carries uncommitted work. */
	readonly patchSetCommit: string;
	/**
	 * ISO date of the materialization. In deterministic contexts - and `load` is
	 * one, because the generated commits must have the same sha everywhere - it
	 * is the commit date of the pin, not the wall clock.
	 */
	readonly buildDate: string;
};

export type OverlayOperation = {
	readonly op: 'set' | 'remove';
	readonly path: readonly string[];
	readonly value?: JsonLike | undefined;
	readonly expectUpstream?: JsonLike | undefined;
};

export type Overlay = {
	readonly codkitOverlay: number;
	readonly id: string;
	/** Path of the target file from the tree root. */
	readonly target: string;
	readonly type: string;
	readonly category: string;
	readonly owner: string;
	readonly reason: string;
	readonly link: string;
	readonly cause: string;
	readonly pin: string;
	/** A guard test is mandatory for this layer (##CROSS-CUTTING-MECHANISMS). */
	readonly contractTests: readonly string[];
	readonly operations: readonly OverlayOperation[];
	/** Artifact path relative to the patchset root; carried for diagnostics. */
	readonly artifactPath: string;
};

export type OverlayDocument = Omit<Overlay, 'artifactPath'>;

const jsonSchema: z.ZodType<JsonLike> = z.lazy(() =>
	z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonSchema), z.record(z.string(), jsonSchema)])
);

const operationSchema = z.object({
	op: z.enum(['set', 'remove']),
	path: z.array(z.string().min(1)).min(1),
	value: jsonSchema.optional(),
	expectUpstream: jsonSchema.optional()
});

const overlaySchema = z.object({
	codkitOverlay: z.literal(OVERLAY_SCHEMA_VERSION),
	id: z.string().min(1),
	target: z.string().min(1),
	type: z.string().min(1),
	category: z.string().min(1),
	owner: z.string().min(1),
	reason: z.string().min(1),
	link: z.string().min(1),
	cause: z.string().min(1),
	pin: z.string().min(1),
	contractTests: z.array(z.string().min(1)).min(1),
	operations: z.array(operationSchema)
});

/**
 * What each field must be, in the words the reviewer sees. The registry has one
 * code for this layer (CK-E-OVERLAY-SCHEMA); the text is what makes the failure
 * actionable, so it is written here rather than taken from the validator.
 */
const FIELD_EXPECTATION: Readonly<Record<string, string>> = {
	codkitOverlay: `must be exactly ${OVERLAY_SCHEMA_VERSION}`,
	id: 'must be a non-empty artifact id',
	target: 'must be the path of the target file from the tree root',
	type: 'must be a non-empty intervention type',
	category: 'must be a non-empty category',
	owner: 'must be a non-empty owner name',
	reason: 'must be a non-empty reason',
	link: 'must be an issue reference or the literal "none"',
	cause: 'must be an upstream sha or the literal "none"',
	pin: 'must be "<tag>@<sha>" of the pin the overlay was written against',
	contractTests: 'must be a non-empty list of contract test names (a guard test is mandatory for this layer)',
	operations: 'must be a list of operations',
	op: 'must be "set" or "remove"',
	path: 'must be a non-empty list of object keys (array indices are not supported)',
	value: 'must be a JSON value or {"$var": "<name>"}',
	expectUpstream: 'must be a JSON value or {"$absent": true}',
	$var: `must be one of ${OVERLAY_VARS.join(', ')}`
};

/** Read every overlay in the repository, in path order. */
export function loadOverlays(patchesDir: string): readonly Overlay[] {
	const dir = join(patchesDir, ...OVERLAYS_DIR.split('/'));
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files = names.filter((name) => name.endsWith(OVERLAY_FILE_SUFFIX)).sort();
	return files.map((name) => parseOverlayFile(join(dir, name), `${OVERLAYS_DIR}/${name}`));
}

export function parseOverlayFile(absolutePath: string, artifactPath: string): Overlay {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(absolutePath, 'utf8'));
	} catch (error) {
		throw ckError(
			'OVERLAY-SCHEMA',
			`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			'an overlay is plain JSON without comments',
			artifactPath
		);
	}
	return parseOverlay(raw, artifactPath);
}

/** Validate a decoded overlay document. Exposed so tests need no file. */
export function parseOverlay(raw: unknown, artifactPath: string): Overlay {
	const parsed = overlaySchema.safeParse(raw);
	if (!parsed.success) {
		throw schemaError(parsed.error.issues, raw, artifactPath);
	}
	const targetProblem = repoRelativePathProblem(parsed.data.target);
	if (targetProblem !== null) {
		throw ckError(
			'OVERLAY-SCHEMA',
			`target ${parsed.data.target} ${targetProblem}`,
			'target must be a canonical path relative to the fork-tree root',
			artifactPath
		);
	}
	assertVariableNames(parsed.data.operations, artifactPath);
	assertSetHasValue(parsed.data.operations, artifactPath);
	return { ...parsed.data, artifactPath };
}

/** Canonical artifact bytes: schema key order, two spaces, exactly one final LF. */
export function serializeOverlay(overlay: OverlayDocument): string {
	const operations = overlay.operations.map((operation) => {
		const canonical: {
			op: OverlayOperation['op'];
			path: readonly string[];
			value?: JsonLike;
			expectUpstream?: JsonLike;
		} = { op: operation.op, path: [...operation.path] };
		if (operation.value !== undefined) canonical.value = operation.value;
		if (operation.expectUpstream !== undefined) canonical.expectUpstream = operation.expectUpstream;
		return canonical;
	});
	const canonical: OverlayDocument = {
		codkitOverlay: overlay.codkitOverlay,
		id: overlay.id,
		target: overlay.target,
		type: overlay.type,
		category: overlay.category,
		owner: overlay.owner,
		reason: overlay.reason,
		link: overlay.link,
		cause: overlay.cause,
		pin: overlay.pin,
		contractTests: [...overlay.contractTests],
		operations
	};
	return `${JSON.stringify(canonical, null, 2)}\n`;
}

/** Value of a `{"$var": name}` reference (##OVERLAY-VARS). */
export function resolveVar(name: string, context: OverlayVarContext): string {
	switch (name) {
		case 'pin.tag':
			return context.pinTag;
		case 'pin.sha':
			return context.pinSha;
		case 'pin.date':
			return context.pinDate;
		case 'patchset.commit':
			return context.patchSetCommit;
		case 'build.date':
			return context.buildDate;
		default:
			throw ckError('OVERLAY-SCHEMA', `unknown variable "${name}"`, `known variables: ${OVERLAY_VARS.join(', ')}`);
	}
}

/** Is this value a `{"$var": "<name>"}` reference rather than a literal? */
export function readVarReference(value: JsonLike | undefined): string | null {
	if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
		return null;
	}
	const keys = Object.keys(value);
	if (keys.length !== 1 || keys[0] !== '$var') {
		return null;
	}
	const name = value['$var'];
	return typeof name === 'string' ? name : null;
}

/** Is this expectUpstream the "there is no such key at the pin" assertion? */
export function isAbsentExpectation(value: JsonLike | undefined): boolean {
	if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return keys.length === 1 && keys[0] === '$absent' && value['$absent'] === true;
}

/**
 * Apply operations to a parsed JSON object, in order. `set` creates missing
 * objects along the path; `remove` of an absent key is a no-op, not an error -
 * the operation states the intended end state, and it already holds.
 */
export function applyOperations(
	base: { readonly [key: string]: JsonLike },
	operations: readonly OverlayOperation[],
	context: OverlayVarContext
): { [key: string]: JsonLike } {
	const result = JSON.parse(JSON.stringify(base)) as { [key: string]: JsonLike };
	for (const operation of operations) {
		if (operation.op === 'set') {
			setAtPath(result, operation.path, materializeValue(operation.value, context));
		} else {
			removeAtPath(result, operation.path);
		}
	}
	return result;
}

export type ProductOverridesResult = {
	/** Absolute path of the dev-channel file. */
	readonly path: string;
	/** False when there was nothing to materialize and no file to refresh. */
	readonly written: boolean;
	/** Top-level keys the dev channel now carries. */
	readonly keys: readonly string[];
	/** Overlays that contributed to it. */
	readonly overlayIds: readonly string[];
};

/**
 * Channel 1 (##OVERLAY-TWO-CHANNELS): collect every overlay whose target is
 * the dev-channel target and write their operations into its sidecar.
 *
 * Upstream merges that file over the real target with a flat
 * Object.assign of the top level, so the dev channel is a set of top-level
 * keys, and a `remove` cannot be expressed in it at all - an absent key in the
 * overrides file means "unchanged", not "deleted". Such an operation is skipped
 * with a warning rather than silently dropped.
 *
 * A `set` deeper than one key would otherwise replace the whole top-level key
 * and hide the upstream siblings under it. It does not: the top-level key is
 * first seeded with its value from the clean pin (`git show <pin>:<target>`),
 * and only then is the operation applied, so the flat merge keeps the siblings.
 * That is the normal way to write a nested key in the dev channel, not a
 * degraded one, so it is not announced.
 *
 * `pinSha` is what the seeding reads; pass an empty string where there is no
 * tree to read from (the seeding is then skipped, as it is for a target the pin
 * does not carry).
 */
export function writeDevChannel(
	type: ProjectType,
	treeDir: string,
	overlays: readonly Overlay[],
	context: OverlayVarContext,
	pinSha: string,
	onWarn?: (text: string) => void
): ProductOverridesResult {
	const channel = devChannelTarget(type);
	if (channel === null || channel.devChannel === null) {
		// A family with no dev channel materializes through channel 2 only; there
		// is no sidecar to write and nothing to report (##OVERLAY-TWO-CHANNELS).
		return { path: '', written: false, keys: [], overlayIds: [] };
	}
	const devChannelPath = channel.devChannel;
	const applicable = overlays.filter((overlay) => overlay.target === channel.path);
	const ids: string[] = [];
	let document: { [key: string]: JsonLike } = {};
	const seeded = new Set<string>();

	for (const overlay of applicable) {
		const expressible: OverlayOperation[] = [];
		for (const operation of overlay.operations) {
			if (operation.op === 'remove') {
				onWarn?.(
					`${overlay.artifactPath}: operation remove ${renderPath(operation.path)} has no meaning in the dev channel ` +
						`(the dev channel is merged over the target, it cannot delete a key); it is applied only when the overlay is materialized into the target file`
				);
				continue;
			}
			const top = operation.path[0] ?? '';
			if (operation.path.length > 1 && top !== '' && !seeded.has(top) && document[top] === undefined) {
				const upstream = valueAtPinPath(treeDir, pinSha, overlay.target, top);
				if (upstream !== undefined) {
					document[top] = upstream;
				}
				seeded.add(top);
			}
			expressible.push(operation);
		}
		document = applyOperations(document, expressible, context);
		ids.push(overlay.id);
	}

	const path = overlayTreePath(treeDir, devChannelPath, 'the dev-channel target');
	// A delta with no overlay of that target writes no file at all: an empty
	// overrides document changes nothing upstream reads, and a file the tree did
	// not ask for is one more thing that could show up in `git status`. An
	// existing one is still refreshed, so removing the last overlay empties it.
	if (applicable.length === 0 && !existsSync(path)) {
		return { path, written: false, keys: [], overlayIds: [] };
	}
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
	if (onWarn !== undefined) {
		const ignoreWarning = devChannelIgnoreWarning(type, treeDir);
		if (ignoreWarning !== null) {
			onWarn(ignoreWarning);
		}
	}
	return { path, written: true, keys: Object.keys(document), overlayIds: ids };
}

/**
 * The dev-channel file is written into the tree on every load, so upstream has
 * to ignore it - otherwise every tree would carry permanent dirt and the drift
 * guard would refuse to work (##OVERLAY-TWO-CHANNELS). Returns the warning text,
 * or null when the file is ignored or the question cannot be answered (the tree
 * is not a git repository, as in a unit fixture).
 */
export function devChannelIgnoreWarning(type: ProjectType, treeDir: string): string | null {
	const file = devChannelFile(type);
	if (file === null) {
		return null;
	}
	const result = runGit({ args: ['check-ignore', '--quiet', '--', file], cwd: treeDir });
	// 0 = ignored, 1 = not ignored, anything else = git could not tell us.
	if (result.status !== 1) {
		return null;
	}
	return (
		`${file} is not ignored by the fork tree, so the dev channel of the config-overlay layer ` +
		"leaves the tree permanently dirty; add it to .gitignore upstream or to the repository's own git exclusion (info/exclude)"
	);
}

/** The value of one top-level key of a JSON target at the pin, or undefined. */
function valueAtPinPath(treeDir: string, pinSha: string, target: string, key: string): JsonLike | undefined {
	if (pinSha === '') {
		return undefined;
	}
	const shown = runGit({ args: ['show', `${pinSha}:${target}`], cwd: treeDir });
	if (shown.status !== 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(shown.stdout);
	} catch {
		// A target that is not readable JSON has nothing to seed from; the
		// overlay layer refuses it in its own check, not here.
		return undefined;
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const value = (parsed as Record<string, unknown>)[key];
	return value === undefined ? undefined : (value as JsonLike);
}

/** True when the tree carries a dev-channel file written by an earlier load. */
export function devChannelExists(type: ProjectType, treeDir: string): boolean {
	const file = devChannelFile(type);
	return file !== null && existsSync(join(treeDir, file));
}

// ---------------------------------------------------------------------------
// Channel 2: the target file itself (##OVERLAY-TWO-CHANNELS, packaging/publish)
// ---------------------------------------------------------------------------

export type OverlayRender = {
	readonly target: string;
	/** The document after the operations of every contributing overlay. */
	readonly document: { readonly [key: string]: JsonLike };
	/** Serialized with tabs and a final line feed, the style of the targets. */
	readonly text: string;
	readonly bytes: Uint8Array;
	readonly overlayIds: readonly string[];
};

export type OverlayApplyResult = OverlayRender & {
	/** Absolute path of the file that was written. */
	readonly path: string;
	/** False when the tree already carried exactly these bytes. */
	readonly changed: boolean;
};

/**
 * Serialize a materialized target: tabs for indentation, a final line feed -
 * the style the upstream targets are written in, so the diff of an applied
 * overlay is the change and nothing else.
 */
export function serializeOverlayTarget(document: JsonLike): string {
	return `${JSON.stringify(document, null, '\t')}\n`;
}

/**
 * The clean target file at the pin, parsed. This is the base of channel 2: not
 * the file in the work tree, which may already carry a previous application, and
 * not the branch tip, which may carry one too. Reading git objects also means a
 * dirty tree is no obstacle (##PIN-FILE-READ-RULE).
 */
export function overlayBaseAtPin(treeDir: string, pinSha: string, target: string): { readonly [key: string]: JsonLike } {
	const shown = runGit({ args: ['show', `${pinSha}:${target}`], cwd: treeDir });
	if (shown.status !== 0) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`the overlay target ${target} does not exist at the pin, and an overlay changes an existing file`,
			'add the file with an add-file patch, or keep it in own code; an overlay only edits what upstream ships',
			`${OVERLAYS_DIR}/${target}${OVERLAY_FILE_SUFFIX}`
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(shown.stdout);
	} catch (error) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`the overlay target ${target} is not readable JSON at the pin: ${error instanceof Error ? error.message : String(error)}`,
			'the config-overlay layer parses and serializes its target; a file that is not JSON belongs to another layer',
			`${OVERLAYS_DIR}/${target}${OVERLAY_FILE_SUFFIX}`
		);
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`the overlay target ${target} is not a JSON object at the pin`,
			'operation paths are object keys, so the target has to be an object',
			`${OVERLAYS_DIR}/${target}${OVERLAY_FILE_SUFFIX}`
		);
	}
	return parsed as { readonly [key: string]: JsonLike };
}

/**
 * Apply every given overlay to the clean pin file, in order, and serialize the
 * result. Nothing is written; `applyOverlayToTree` does that.
 *
 * Several overlay files may name the same target - the dev channel already
 * composes them that way - so this takes a list and folds them one after
 * another over one base.
 */
export function renderOverlayTarget(
	overlays: readonly Overlay[],
	treeDir: string,
	pinSha: string,
	context: OverlayVarContext
): OverlayRender {
	const target = overlays[0]?.target;
	if (target === undefined) {
		throw ckError('INTERNAL', 'cannot materialize an overlay target without an overlay');
	}
	let document: { [key: string]: JsonLike } = { ...overlayBaseAtPin(treeDir, pinSha, target) };
	for (const overlay of overlays) {
		document = applyOperations(document, overlay.operations, context);
	}
	const text = serializeOverlayTarget(document);
	return { target, document, text, bytes: encodeUtf8(text), overlayIds: overlays.map((overlay) => overlay.id) };
}

/**
 * Channel 2 for one overlay: base is the clean pin file, the operations are
 * applied in order, and the result replaces the target in the work tree.
 *
 * A file whose bytes already equal the result is left alone, mtime included
 * (##MTIME-DISCIPLINE): re-applying an overlay must not restart the watch
 * daemons of the tree.
 */
export function applyOverlayToTree(overlay: Overlay, treeDir: string, pinSha: string, context: OverlayVarContext): OverlayApplyResult {
	return applyOverlaysToTree([overlay], treeDir, pinSha, context);
}

/** As applyOverlayToTree, for every overlay that names the same target. */
export function applyOverlaysToTree(
	overlays: readonly Overlay[],
	treeDir: string,
	pinSha: string,
	context: OverlayVarContext
): OverlayApplyResult {
	const rendered = renderOverlayTarget(overlays, treeDir, pinSha, context);
	const path = overlayTreePath(treeDir, rendered.target, 'the overlay target');
	const existing = readFileIfPresent(path);
	if (existing !== null && bytesEqual(existing, rendered.bytes)) {
		return { ...rendered, path, changed: false };
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, rendered.bytes);
	return { ...rendered, path, changed: true };
}

/**
 * Does the tree carry exactly the strict composition of these overlays over the
 * clean pin file (##OVERLAY-KNOWN-MATERIALIZATION)? This is the state
 * `applyOverlaysToTree` writes, asked of bytes that already exist: the drift
 * guard of `load --fresh` uses it to tell codkit's own packaging materialization
 * from a manual edit, and unlike `checkOverlayTarget` it is a plain byte answer,
 * because the caller already knows the target differs from what its load would
 * leave in place.
 *
 * False when the file is absent or unreadable - that is not a materialization
 * and stays dirt. A render failure propagates to the caller (it cannot happen
 * after the load-time drift check has read the same pin base; the one caller
 * converts any surprise into a false answer rather than into a weaker guard).
 */
export function isExactOverlayMaterialization(
	overlays: readonly Overlay[],
	treeDir: string,
	pinSha: string,
	context: OverlayVarContext
): boolean {
	const target = overlays[0]?.target;
	if (target === undefined) {
		throw ckError('INTERNAL', 'cannot classify an overlay materialization without an overlay');
	}
	let current: Uint8Array;
	try {
		current = readFileSync(overlayTreePath(treeDir, target, 'the overlay target'));
	} catch {
		return false;
	}
	return bytesEqual(current, renderOverlayTarget(overlays, treeDir, pinSha, context).bytes);
}

// ---------------------------------------------------------------------------
// overlay check (PROP-007 sec. 12)
// ---------------------------------------------------------------------------

/** One operation whose `expectUpstream` no longer describes the pin. */
export type OverlayDrift = {
	readonly overlayId: string;
	readonly artifactPath: string;
	readonly target: string;
	readonly operationIndex: number;
	readonly path: readonly string[];
	/** What the artifact expects; undefined when it expects the key to be absent. */
	readonly expected: JsonLike | undefined;
	readonly expectedAbsent: boolean;
	/** What the pin actually carries; undefined when the key is not there. */
	readonly actual: JsonLike | undefined;
};

/** How the target in the work tree relates to "the pin plus the operations". */
export type OverlayMaterialization = {
	/** True when the tree carries the target at all. */
	readonly present: boolean;
	/** True when the file in the tree differs from the clean pin file. */
	readonly differsFromPin: boolean;
	/**
	 * Byte equality of the file in the tree with the materialization of this
	 * overlay. null when the target is not materialized, so there is nothing to
	 * compare against.
	 */
	readonly matches: boolean | null;
};

export type OverlayCheckReport = {
	readonly overlayId: string;
	readonly artifactPath: string;
	readonly target: string;
	/** Every mismatch, not only the first one. */
	readonly drift: readonly OverlayDrift[];
	/** Uncoded advisories, e.g. an operation on a key packaging stamps. */
	readonly warnings: readonly string[];
	/** null when the work tree was not consulted. */
	readonly materialization: OverlayMaterialization | null;
};

export type OverlayCheckOptions = {
	/** The project type: it names the targets, their channels and their stamps. */
	readonly type: ProjectType;
	/** The fork tree: the source of the pin's git objects. */
	readonly treeDir: string;
	readonly pinSha: string;
	/**
	 * Needed to render "the pin plus the operations" for the materialization
	 * comparison. Without it only the pin side is checked.
	 */
	readonly context?: OverlayVarContext | undefined;
	/** Skip the work-tree side entirely (a check about the artifact and the pin). */
	readonly pinOnly?: boolean | undefined;
};

/**
 * `overlay check` for one overlay (##OVERLAY-DRIFT-DETECTOR).
 *
 * The schema was validated when the artifact was read, so what is left is the
 * part that depends on the world: does `expectUpstream` still describe the clean
 * file at the pin, does any operation touch a key the packaging step stamps, and
 * - when the target is already materialized in the tree - does the file there
 * equal the pin plus the operations.
 *
 * Nothing here throws for a mismatch: every finding goes into the report, so one
 * run tells the whole story instead of the first line of it.
 */
export function checkOverlay(overlay: Overlay, options: OverlayCheckOptions): OverlayCheckReport {
	const base = overlayBaseAtPin(options.treeDir, options.pinSha, overlay.target);
	const drift: OverlayDrift[] = [];
	const warnings: string[] = [];

	for (let index = 0; index < overlay.operations.length; index += 1) {
		const operation = overlay.operations[index];
		if (operation === undefined) {
			continue;
		}
		const stamped = stampedKeyWarning(options.type, overlay, operation);
		if (stamped !== null) {
			warnings.push(stamped);
		}
		if (operation.expectUpstream === undefined) {
			continue;
		}
		const actual = valueAtPath(base, operation.path);
		const expectsAbsent = isAbsentExpectation(operation.expectUpstream);
		const holds = expectsAbsent ? actual === undefined : actual !== undefined && deepEqual(actual, operation.expectUpstream);
		if (holds) {
			continue;
		}
		drift.push({
			overlayId: overlay.id,
			artifactPath: overlay.artifactPath,
			target: overlay.target,
			operationIndex: index,
			path: operation.path,
			expected: expectsAbsent ? undefined : operation.expectUpstream,
			expectedAbsent: expectsAbsent,
			actual
		});
	}

	const materialization =
		options.pinOnly === true ? null : inspectMaterialization([overlay], options.treeDir, options.pinSha, options.context);
	return { overlayId: overlay.id, artifactPath: overlay.artifactPath, target: overlay.target, drift, warnings, materialization };
}

export type OverlayTargetReport = {
	readonly target: string;
	/** One report per contributing overlay; their materialization is not used. */
	readonly reports: readonly OverlayCheckReport[];
	readonly drift: readonly OverlayDrift[];
	readonly warnings: readonly string[];
	/** The file in the tree against *all* the overlays of the target, composed. */
	readonly materialization: OverlayMaterialization | null;
};

/**
 * `overlay check` for a whole target. The difference from checking the overlays
 * one by one is the materialized file: it is the pin plus the operations of
 * every overlay that names the target, so comparing it with one overlay's
 * result would call a correct file wrong as soon as a second overlay exists.
 */
export function checkOverlayTarget(overlays: readonly Overlay[], options: OverlayCheckOptions): OverlayTargetReport {
	const target = overlays[0]?.target;
	if (target === undefined) {
		throw ckError('INTERNAL', 'cannot check an overlay target without an overlay');
	}
	const reports = overlays.map((overlay) => checkOverlay(overlay, { ...options, pinOnly: true }));
	return {
		target,
		reports,
		drift: reports.flatMap((report) => report.drift),
		warnings: reports.flatMap((report) => [...report.warnings]),
		materialization: options.pinOnly === true ? null : inspectMaterialization(overlays, options.treeDir, options.pinSha, options.context)
	};
}

/**
 * ##OVERLAY-NON-PRODUCT-TARGETS: a target the type keeps closed has no dev
 * channel, so an overlay on it rewrites an upstream file for real. The only
 * change allowed there is *adding* under one of the keys the type opened - a
 * `set` on a path of exactly two keys whose first is one of them.
 *
 * The finding is a check, not a parse failure: the document is well formed, and
 * what it asks for is out of bounds. `verify` reports it like any other
 * violation, and `overlay check` refuses the target.
 */
export function restrictedTargetViolations(type: ProjectType, overlay: Overlay): readonly CkError[] {
	const allowedKeys = allowedOverlayKeys(type, overlay.target);
	if (allowedKeys === null) {
		return [];
	}
	const errors: CkError[] = [];
	for (let index = 0; index < overlay.operations.length; index += 1) {
		const operation = overlay.operations[index];
		if (operation === undefined) {
			continue;
		}
		const top = operation.path[0] ?? '';
		const allowed = operation.op === 'set' && operation.path.length === 2 && allowedKeys.includes(top);
		if (allowed) {
			continue;
		}
		errors.push(
			ckError(
				'OVERLAY-SCHEMA',
				`operations[${index}] is ${operation.op} ${renderPath(operation.path)} on ${overlay.target}: ` +
					`only additions under ${allowedKeys.join(', ')} are allowed for this target`,
				`write the operation as {"op": "set", "path": ["${allowedKeys[0] ?? 'scripts'}", "<name>"], …}, or move the change to a layer above`,
				overlay.artifactPath
			)
		);
	}
	return errors;
}

/**
 * One error per mismatch, all of them: `load` and `overlay check` list every
 * drifted key at once, because an upgrade that moved one key usually moved
 * several and fixing them one run at a time is what makes upgrades expensive.
 */
export function overlayDriftErrors(drift: readonly OverlayDrift[]): readonly CkError[] {
	return drift.map((entry) =>
		ckError(
			'OVERLAY-DRIFT',
			`${entry.overlayId}: ${entry.target}:${renderPath(entry.path)} at the pin is ${renderValue(entry.actual)}, ` +
				`but the overlay expects ${entry.expectedAbsent ? 'no such key' : renderValue(entry.expected)}`,
			'upstream changed the key this intervention is written against: review the overlay and update expectUpstream',
			entry.artifactPath
		)
	);
}

/**
 * The advisory about a key the packaging step of this family stamps by itself,
 * or null when none applies. An operation on such a key is announced, not
 * refused: whatever it writes is overwritten when the product is packaged.
 */
function stampedKeyWarning(type: ProjectType, overlay: Overlay, operation: OverlayOperation): string | null {
	const stamped = overlayTargetOf(type, overlay.target)?.stampedKeys ?? [];
	const top = operation.path[0] ?? '';
	if (stamped.length === 0 || operation.path.length !== 1 || !stamped.includes(top)) {
		return null;
	}
	return (
		`${overlay.artifactPath}: operation ${operation.op} ${renderPath(operation.path)} writes a key the upstream packaging step stamps itself ` +
		`(${stamped.join(', ')}), so the value is overwritten when the product is packaged`
	);
}

function inspectMaterialization(
	overlays: readonly Overlay[],
	treeDir: string,
	pinSha: string,
	context: OverlayVarContext | undefined
): OverlayMaterialization {
	const target = overlays[0]?.target ?? '';
	if (target === '') {
		return { present: false, differsFromPin: false, matches: null };
	}
	const current = readFileIfPresent(overlayTreePath(treeDir, target, 'the overlay target'));
	if (current === null) {
		return { present: false, differsFromPin: false, matches: null };
	}
	const atPin = runGit({ args: ['show', `${pinSha}:${target}`], cwd: treeDir });
	const differsFromPin = atPin.status !== 0 || !bytesEqual(current, encodeUtf8(atPin.stdout));
	if (!differsFromPin || context === undefined) {
		return { present: true, differsFromPin, matches: null };
	}
	return { present: true, differsFromPin, matches: bytesEqual(current, renderOverlayTarget(overlays, treeDir, pinSha, context).bytes) };
}

function readFileIfPresent(path: string): Uint8Array | null {
	try {
		return readFileSync(path);
	} catch {
		return null;
	}
}

function overlayTreePath(treeDir: string, target: string, label: string): string {
	const resolved = resolveContainedPath(treeDir, target, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`${label} ${target} is unsafe: ${resolved.reason}`,
			'keep overlay targets inside the fork tree and replace symlinks with regular files',
			target
		);
	}
	return resolved.absolute;
}

/** The value at an object path, or undefined when the path is not there. */
export function valueAtPath(document: { readonly [key: string]: JsonLike }, path: readonly string[]): JsonLike | undefined {
	let current: JsonLike | undefined = document as JsonLike;
	for (const key of path) {
		if (current === null || current === undefined || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		current = (current as { [name: string]: JsonLike })[key];
	}
	return current;
}

/** Structural equality of two JSON values (##OVERLAY-DRIFT-DETECTOR: deep equality). */
export function deepEqual(left: JsonLike | undefined, right: JsonLike | undefined): boolean {
	if (left === right) {
		return true;
	}
	if (left === null || right === null || left === undefined || right === undefined) {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
			return false;
		}
		return left.every((item, index) => deepEqual(item, right[index]));
	}
	if (typeof left !== 'object' || typeof right !== 'object') {
		return false;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) {
		return false;
	}
	return leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]));
}

function materializeValue(value: JsonLike | undefined, context: OverlayVarContext): JsonLike {
	const variable = readVarReference(value);
	if (variable !== null) {
		return resolveVar(variable, context);
	}
	return value === undefined ? null : clone(value);
}

function setAtPath(root: { [key: string]: JsonLike }, path: readonly string[], value: JsonLike): void {
	let current = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const key = path[index];
		if (key === undefined) {
			return;
		}
		const next = current[key];
		if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
			// The path states the shape; anything else in the way is replaced,
			// which is what "set this path" means for a JSON document.
			const created: { [key: string]: JsonLike } = {};
			current[key] = created;
			current = created;
			continue;
		}
		current = next;
	}
	const last = path[path.length - 1];
	if (last !== undefined) {
		current[last] = value;
	}
}

function removeAtPath(root: { [key: string]: JsonLike }, path: readonly string[]): void {
	let current: { [key: string]: JsonLike } = root;
	for (let index = 0; index < path.length - 1; index += 1) {
		const key = path[index];
		if (key === undefined) {
			return;
		}
		const next = current[key];
		if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
			return;
		}
		current = next;
	}
	const last = path[path.length - 1];
	if (last !== undefined) {
		delete current[last];
	}
}

function clone<T extends JsonLike>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function assertVariableNames(operations: readonly OverlayOperation[], artifactPath: string): void {
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index];
		if (operation === undefined) {
			continue;
		}
		const name = readVarReference(operation.value);
		if (name === null || (OVERLAY_VARS as readonly string[]).includes(name)) {
			continue;
		}
		throw overlayError(`operations[${index}].value.$var`, FIELD_EXPECTATION['$var'] ?? '', name, artifactPath);
	}
}

function assertSetHasValue(operations: readonly OverlayOperation[], artifactPath: string): void {
	for (let index = 0; index < operations.length; index += 1) {
		const operation = operations[index];
		if (operation !== undefined && operation.op === 'set' && operation.value === undefined) {
			throw overlayError(`operations[${index}].value`, 'is required for op "set"', undefined, artifactPath);
		}
	}
}

type SchemaIssue = { readonly path: ReadonlyArray<PropertyKey>; readonly message: string };

function schemaError(issues: readonly SchemaIssue[], raw: unknown, artifactPath: string): Error {
	const issue = issues[0];
	if (issue === undefined) {
		return ckError('OVERLAY-SCHEMA', 'failed validation', 'see PROP-005 sec. 5 for the overlay format', artifactPath);
	}
	const label = renderIssuePath(issue.path);
	const field = String(issue.path[issue.path.length - 1] ?? '');
	const expectation = FIELD_EXPECTATION[field] ?? issue.message;
	return overlayError(label, expectation, rawValueAtPath(raw, issue.path), artifactPath);
}

/**
 * `operations[0].op must be "set" or "remove", got "insert"` - the shape fixed
 * by PROP-005 ##OVERLAY-INVALID-SAMPLE.
 */
function overlayError(label: string, expectation: string, actual: unknown, artifactPath: string): Error {
	const got = actual === undefined ? 'nothing' : renderValue(actual);
	const text = label === '' ? `${expectation}, got ${got}` : `${label} ${expectation}, got ${got}`;
	return ckError('OVERLAY-SCHEMA', text, 'see PROP-005 sec. 5 for the overlay format', artifactPath);
}

function renderIssuePath(path: ReadonlyArray<PropertyKey>): string {
	let out = '';
	for (const segment of path) {
		if (typeof segment === 'number') {
			out += `[${segment}]`;
			continue;
		}
		out = out === '' ? String(segment) : `${out}.${String(segment)}`;
	}
	return out;
}

function renderPath(path: readonly string[]): string {
	return path.join('.');
}

function renderValue(value: unknown): string {
	const text = JSON.stringify(value) ?? String(value);
	return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The value at a validator issue path of an arbitrary decoded document. */
function rawValueAtPath(raw: unknown, path: ReadonlyArray<PropertyKey>): unknown {
	let current: unknown = raw;
	for (const segment of path) {
		if (current === null || typeof current !== 'object') {
			return undefined;
		}
		current = (current as Record<string, unknown>)[String(segment)];
	}
	return current;
}
