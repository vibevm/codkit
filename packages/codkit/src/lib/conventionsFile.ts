/** @scope spec://codkit/modules/codkit/PROP-003#root */
// Reading config/conventions.json of the tool root (PROP-003 sec. 3), and
// composing it with the defaults of the project type.
//
// ##CONVENTIONS-SINGLE-DEFINITION: the enumerations exist once and every
// consumer reads them from here. They come from three places and from nowhere
// else: the shipped file holds what is the engine's - the marker forms, the
// intervention types, the categories, the layer order; the project type holds
// what belongs to a family of upstreams - the subsystems an id may name, the
// service ids own code may not re-register, the build outputs a fresh pass may
// remove, the paths a patch may never target; and a patch set may extend the
// family's lists additively through `conventionsExtensionFile`.
//
// The shipped file ships with the tool and is looked up only next to the Codkit
// sources. A patch set is untrusted input and cannot weaken safety policy.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectType } from '@codkit/type-api';
import { z } from 'zod';
import { loadBaseConfig } from './configFile.ts';
import { readContainedFile } from './containedFile.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';

export const CONVENTIONS_RELATIVE_PATH = 'config/conventions.json';

export type Conventions = {
	/**
	 * The subsystem names an id may carry. The second component of every id is
	 * one of them, which is what lets the inventory group interventions by
	 * subsystem without a second table (PROP-006 ##IB-MAKE-ENTRIES).
	 */
	readonly subsystems: readonly string[];
	readonly idPattern: string;
	readonly interventionTypes: readonly string[];
	readonly categories: readonly string[];
	readonly layers: readonly string[];
	readonly forbiddenPatchTargets: readonly string[];
	/**
	 * Decorator ids own code may never re-register (modules/vscode/PROP-003 ##SO-FORBIDDEN-IDS):
	 * these singletons are set explicitly before the composition root exists, so a later
	 * registration is ignored - silently - and the product breaks at load.
	 */
	readonly forbiddenServiceIds: readonly string[];
	/** Untracked paths `--fresh` keeps (PROP-011 ##CLEANUP-WHITELIST-CONTENT). */
	readonly cleanupWhitelist: readonly string[];
	/** Marker forms by file extension (PROP-004 sec. 1); read by markers.ts. */
	readonly markerComment: Readonly<Record<string, unknown>>;
};

/**
 * The shipped half. The type's half - subsystems, forbidden service ids, the
 * cleanup whitelist and the forbidden patch targets - is not in this file and
 * cannot be put there: it is a fact about a family of upstreams, and the engine
 * has no way to know it.
 */
const conventionsSchema = z.object({
	codkitConventions: z.literal(1),
	interventionTypes: z.array(z.string().min(1)).min(1),
	categories: z.array(z.string().min(1)).min(1),
	layers: z.array(z.string().min(1)).min(1),
	markerComment: z.record(z.string(), z.unknown()).default({})
});

type ShippedConventions = z.infer<typeof conventionsSchema>;

/** ##CONV-ID-PATTERN: the engine's shape over the subsystems the type names. */
export function idPatternOf(subsystems: readonly string[]): string {
	return `^CK-(?:${subsystems.map(escapeRegex).join('|')})-[0-9]{3}$`;
}

const extensionMarkerSchema = z.object({ open: z.string().min(1), close: z.string() }).strict();
const conventionsExtensionSchema = z
	.object({
		codkitConventionsExtension: z.literal(1),
		subsystems: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).default([]),
		forbiddenPatchTargets: z.array(z.string().min(1)).default([]),
		forbiddenServiceIds: z.array(z.string().min(1)).default([]),
		markerComment: z.record(z.string().regex(/^\.[A-Za-z0-9]+$/), extensionMarkerSchema).default({})
	})
	.strict();

/** Where this module sits, so the shipped conventions can be found from it. */
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let cachedShippedConventions: ShippedConventions | null = null;
const composedCache = new Map<string, Conventions>();
const extensionCache = new Map<string, Conventions>();

/**
 * The effective conventions of a patch set: the engine's shipped half, the
 * defaults of its project type, and - when the patch set declares one - the
 * additive extension of that patch set.
 */
export function loadConventions(type: ProjectType, patchesDir?: string): Conventions {
	const shipped = composedCache.get(type.id) ?? composeConventions(loadShippedConventions(), type);
	composedCache.set(type.id, shipped);
	if (patchesDir === undefined) return shipped;
	const configured = loadBaseConfig(patchesDir)?.conventionsExtensionFile ?? null;
	if (configured === null) return shipped;
	const resolved = resolveContainedPath(patchesDir, configured);
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`conventionsExtensionFile is unsafe or unreadable: ${resolved.reason}`,
			'point conventionsExtensionFile at a real non-symlink JSON file inside the patch-set repository',
			'codkit.json'
		);
	}
	const cached = extensionCache.get(`${type.id}\0${resolved.absolute}`);
	if (cached !== undefined) return cached;
	let raw: unknown;
	try {
		// The contained reader: parents proven real directories, leaf opened
		// without following a symlink, descriptor proven inside the patch set
		// (PROP-002 ##CONTAINED-FILE-IO).
		const read = readContainedFile(patchesDir, configured, { what: configured });
		if (read.state === 'absent') {
			throw new Error('the file does not exist');
		}
		raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			'write valid JSON in the configured conventions extension',
			configured
		);
	}
	const parsed = conventionsExtensionSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw ckError(
			'CONFIG',
			`${issue?.path.map(String).join('.') || 'document'}: ${issue?.message ?? 'failed validation'}`,
			'use the codkitConventionsExtension:1 additive schema',
			configured
		);
	}
	for (const extension of Object.keys(parsed.data.markerComment)) {
		if (Object.prototype.hasOwnProperty.call(shipped.markerComment, extension)) {
			throw ckError(
				'CONFIG',
				`markerComment.${extension} cannot replace a shipped marker form`,
				'remove the duplicate; extensions may add new file extensions only',
				configured
			);
		}
	}
	const subsystems = unique([...shipped.subsystems, ...parsed.data.subsystems]);
	const merged: Conventions = {
		...shipped,
		subsystems,
		idPattern: idPatternOf(subsystems),
		forbiddenPatchTargets: unique([...shipped.forbiddenPatchTargets, ...parsed.data.forbiddenPatchTargets]),
		forbiddenServiceIds: unique([...shipped.forbiddenServiceIds, ...parsed.data.forbiddenServiceIds]),
		markerComment: { ...shipped.markerComment, ...parsed.data.markerComment }
	};
	extensionCache.set(`${type.id}\0${resolved.absolute}`, merged);
	return merged;
}

/**
 * The shipped half plus the type's defaults. The forbidden patch targets of a
 * family always include the targets of its configuration overlay: an overlay
 * owns those files as data, and a patch over the same bytes would be a second,
 * silent owner (##CONV-FORBIDDEN-TARGETS).
 */
function composeConventions(shipped: ShippedConventions, type: ProjectType): Conventions {
	const subsystems = unique(type.conventions.subsystems);
	return {
		subsystems,
		idPattern: idPatternOf(subsystems),
		interventionTypes: shipped.interventionTypes,
		categories: shipped.categories,
		layers: shipped.layers,
		forbiddenPatchTargets: unique([...type.layout.forbiddenPatchTargets, ...type.layers.overlayTargets.map((target) => target.path)]),
		forbiddenServiceIds: unique(type.conventions.forbiddenServiceIds),
		cleanupWhitelist: unique(type.layout.cleanupWhitelist),
		markerComment: shipped.markerComment
	};
}

function loadShippedConventions(): ShippedConventions {
	if (cachedShippedConventions !== null) return cachedShippedConventions;
	let raw: unknown;
	try {
		const read = readContainedFile(codkitRoot, 'config/conventions.json', { what: CONVENTIONS_RELATIVE_PATH });
		if (read.state === 'absent') {
			throw new Error('the file does not exist');
		}
		raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot be read: ${error instanceof Error ? error.message : String(error)}`,
			'conventions.json ships with codkit; restore it from the repository',
			CONVENTIONS_RELATIVE_PATH
		);
	}
	const parsed = conventionsSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
		throw ckError(
			'CONFIG',
			`${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`,
			'see PROP-003 sec. 3 for the conventions file',
			CONVENTIONS_RELATIVE_PATH
		);
	}
	cachedShippedConventions = parsed.data;
	return parsed.data;
}

function unique(values: readonly string[]): readonly string[] {
	return [...new Set(values)];
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * gitignore semantics for the two pattern lists of conventions.json
 * (`cleanupWhitelist`, `forbiddenPatchTargets`), restricted to the shapes they
 * use:
 *   * a trailing slash matches directories only;
 *   * a leading slash anchors the pattern at the tree root and is not part of it
 *     (PROP-011 ##CLEANUP-WHITELIST-CONTENT: the rooted out-directory pattern
 *     protects the top-level build output and never `outer/` somewhere deep);
 *   * a pattern with an inner slash is anchored too, as gitignore has it;
 *   * a pattern without any slash matches at any level;
 *   * `*` does not cross a slash, `**` does.
 *
 * `path` is POSIX and relative to the tree root; a trailing slash marks a
 * directory entry.
 */
export function matchesPatternList(path: string, patterns: readonly string[]): boolean {
	const isDirectoryEntry = path.endsWith('/');
	const clean = isDirectoryEntry ? path.slice(0, -1) : path;
	const segments = clean.split('/');
	const directories: string[] = [];
	const upTo = isDirectoryEntry ? segments.length : segments.length - 1;
	for (let count = 1; count <= upTo; count += 1) {
		directories.push(segments.slice(0, count).join('/'));
	}

	for (const pattern of patterns) {
		if (pattern === '') {
			continue;
		}
		const directoryOnly = pattern.endsWith('/');
		let core = directoryOnly ? pattern.slice(0, -1) : pattern;
		const rooted = core.startsWith('/');
		if (rooted) {
			core = core.slice(1);
		}
		if (core === '') {
			continue;
		}
		const expression = globToRegExp(core, rooted || core.includes('/'));
		// A directory pattern matches the entry itself and everything under it.
		if (directories.some((directory) => expression.test(directory))) {
			return true;
		}
		if (!directoryOnly && expression.test(clean)) {
			return true;
		}
	}
	return false;
}

function globToRegExp(core: string, anchored: boolean): RegExp {
	let body = '';
	for (let index = 0; index < core.length; index += 1) {
		const character = core[index];
		if (character === undefined) {
			continue;
		}
		if (character === '*') {
			if (core[index + 1] === '*') {
				body += '.*';
				index += 1;
				continue;
			}
			body += '[^/]*';
			continue;
		}
		if (character === '?') {
			body += '[^/]';
			continue;
		}
		body += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`);
}
