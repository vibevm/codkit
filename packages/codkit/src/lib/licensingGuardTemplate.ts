/** @scope spec://codkit/modules/codkit/PROP-019#LICENCE-GUARD */
// The leftover guard of the licence, as one template of the engine rendered with
// the type's runner words and the profile's values (##LICENCE-GUARD). `gen
// licensing` writes the result at the type's path inside the own layer, and
// `verify` finds it under its suite id (`licence-leftovers`).
//
// The guard runs in the fork tree, under the product's own test run, from the
// directory the runner starts in - the tree root - and without the tool: it
// imports four modules of node and nothing else, re-implements the few lines of
// the carrier model it needs, and names no path of the tool. What it proves is
// what the profile promised: a carrier on every own file (a header in the first
// twenty non-empty lines for a file with a comment style, a `.license` sidecar,
// or a REUSE.toml annotation of a registry inside the scope - the whole carrier
// model of PROP-014, a declared third party accepted as provenance), no retired
// notice in any own text file or licence surface, the licence file byte-identical
// to the canonical text, the manifest fields equal to the profile, the component
// licences and the renderings present.
//
// The guard is written to pass the family's lint and hygiene as well as its
// runner: every branch body is braced, every baked string literal is
// single-quoted and ASCII-only (a character outside ASCII is written as an
// escape), the builtin modules are imported by their bare names, and the lines
// the type's `guard()` answers as the preamble stand right before the suite.
//
// The template is a raw string: the regular expressions of the guard keep their
// backslashes, so the generated code carries no template literal and no `${` of
// its own. The baked values are JSON literals, and the retired phrases are
// written as escapes so that the guard does not itself carry what it forbids.

import { LICENCE_GUARD_SUITE } from './licensingSurfaces.ts';

/** One own directory of the tree and the licence its files carry (##ORGANIZATION-OWN-SCOPES). */
export type LicenceGuardScope = {
	/** From the tree root: the own root, or a materialized own extension. */
	readonly treeDirectory: string;
	readonly expression: string;
};

/**
 * One manifest field the guard reads back; `absent` means the key must not be
 * there. `devChannel` says the target is the one the type's dev channel feeds,
 * so a development tree reads it with the channel merged over it.
 */
export type LicenceGuardField = {
	readonly target: string;
	readonly path: readonly string[];
	readonly expected: string | 'absent';
	readonly devChannel: boolean;
};

export type LicenceGuardInput = {
	/** The runner's words: `suite`/`test` or `describe`/`it`. */
	readonly words: { readonly suite: string; readonly test: string };
	/** The lines the family needs in front of the suite - a directive of its lint rules, say; empty for none. */
	readonly preamble: readonly string[];
	readonly holders: readonly string[];
	readonly scopes: readonly LicenceGuardScope[];
	/** The directory the tool delivers its runtime library into, inside the own root; never the product's. */
	readonly skipDirectory: string;
	readonly licenceFile: { readonly treePath: string; readonly sha256: string };
	readonly fields: readonly LicenceGuardField[];
	/** The type's dev channel file, from the tree root, or null for a type without one (PROP-005 OVERLAY-TWO-CHANNELS). */
	readonly devChannel: string | null;
	/** The extensions and bare names with a comment style (PROP-014 LIC-COMMENT-STYLES), so the guard can tell a source file from data. */
	readonly commentStyleNames: readonly string[];
	readonly components: readonly string[];
	readonly renderings: readonly string[];
	readonly retiredNotices: readonly string[];
};

/** A key that may stand bare in an object literal. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * A string literal in the house style of a family's lint: single-quoted, with
 * the backslash, the quote and the line breaks escaped, and every code unit
 * outside printable ASCII written as an escape - a family's hygiene may refuse
 * a non-ASCII character in a source file, and a rights holder's name need not
 * be ASCII.
 */
function quoted(text: string): string {
	let out = "'";
	for (let index = 0; index < text.length; index += 1) {
		const unit = text.charCodeAt(index);
		const character = text.charAt(index);
		if (character === '\\' || character === "'") {
			out += `\\${character}`;
		} else if (unit >= 0x20 && unit <= 0x7e) {
			out += character;
		} else {
			out += `\\u${unit.toString(16).padStart(4, '0')}`;
		}
	}
	return `${out}'`;
}

/** A TypeScript literal of a baked value: strings quoted the house way, arrays and plain objects spelled out, the rest as JSON. */
function literal(value: unknown): string {
	if (typeof value === 'string') {
		return quoted(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => literal(entry)).join(', ')}]`;
	}
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>).map(
			([key, entry]) => `${IDENTIFIER.test(key) ? key : quoted(key)}: ${literal(entry)}`
		);
		return `{ ${entries.join(', ')} }`;
	}
	return JSON.stringify(value) ?? 'undefined';
}

/**
 * A string literal with every code unit written as an escape, so the phrase is
 * not in the file's text: the guard scans the own files for the retired notices,
 * and it is an own file itself.
 */
function escapedLiteral(text: string): string {
	let out = "'";
	for (let index = 0; index < text.length; index += 1) {
		out += `\\u${text.charCodeAt(index).toString(16).padStart(4, '0')}`;
	}
	return `${out}'`;
}

/** ##LICENCE-GUARD: the guard as a TypeScript test file of the product, ending with a newline. */
export function licenceGuardText(input: LicenceGuardInput): string {
	const { suite, test } = input.words;
	const scopes = input.scopes.map((scope) => ({ directory: scope.treeDirectory, expression: scope.expression }));
	const fields = input.fields.map((field) => ({
		target: field.target,
		path: [...field.path],
		expected: field.expected === 'absent' ? null : field.expected,
		devChannel: field.devChannel
	}));
	const notices = `[${input.retiredNotices.map((notice) => escapedLiteral(notice)).join(', ')}]`;
	const preamble = input.preamble.length === 0 ? '' : `${input.preamble.join('\n')}\n`;
	return String.raw`// The leftover guard of the licence (codkit, PROP-019 LICENCE-GUARD).
//
// Written by codkit gen licensing from the selected profile and the answers of
// the project type; codkit gen licensing --update rewrites it, so it is not
// edited by hand. It runs under the product's own test run from the root of the
// tree, imports nothing of the tool, and proves that the licence the product
// declares is the one its own files, its licence file, its manifests and its
// component licences carry.

import assert from 'assert';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

type Scope = { readonly directory: string; readonly expression: string };
type Field = { readonly target: string; readonly path: readonly string[]; readonly expected: string | null; readonly devChannel: boolean };
type Annotation = { paths: string[]; copyright: string[]; license: string | null; comment: string };

/** The rights holders of the profile: a copyright line names one of them. */
const HOLDERS: readonly string[] = ${literal(input.holders)};
/** The own directories of the tree, each with the licence its files carry. */
const SCOPES: readonly Scope[] = ${literal(scopes)};
/** The directory the tool delivers its runtime library into: not the product's to annotate. */
const SKIP_DIRECTORY = ${literal(input.skipDirectory)};
/** The licence file of the product and the SHA-256 of its canonical text. */
const LICENCE_FILE = ${literal(input.licenceFile.treePath)};
const LICENCE_SHA256 = ${literal(input.licenceFile.sha256)};
/** The manifest fields that name the licence; an expected null means the key must be absent. */
const FIELDS: readonly Field[] = ${literal(fields)};
/** The dev channel of the type: present in a development tree, where the running product reads it merged over its target. */
const DEV_CHANNEL: string | null = ${literal(input.devChannel)};
/** The extensions and bare file names that have a comment style: only such a file carries a header. */
const COMMENT_STYLE_NAMES: ReadonlySet<string> = new Set(${literal([...input.commentStyleNames])});
/** The component licences and the renderings the distributable carries. */
const COMPONENTS: readonly string[] = ${literal(input.components)};
const RENDERINGS: readonly string[] = ${literal(input.renderings)};
/** Phrases the profile retired, written as escapes so that this file does not carry them itself. */
const RETIRED_NOTICES: readonly string[] = ${notices};

const HEADER_WINDOW = 20;
const BINARY_PROBE = 8192;
const COPYRIGHT_LINE = /(SPDX-FileCopyrightText:\s*)?(Copyright\s*(\(c\)|\u00a9)?|\u00a9)\s*(\d{4}(\s*[-,]\s*\d{4})*)?\s+(?<holder>.+?)\s*$/u;
const SPDX_LINE = /SPDX-License-Identifier:\s*(?<expression>[A-Za-z0-9.+\-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+\-]+)*)/u;
const TRAILING_MARKER = /(-->|\*\/|-\*\))\s*$/u;
const ROOT = process.cwd();

function absolute(path: string): string {
	return join(ROOT, ...path.split('/'));
}

function isFile(path: string): boolean {
	return existsSync(absolute(path)) && statSync(absolute(path)).isFile();
}

function readText(path: string): string {
	return readFileSync(absolute(path), 'utf8');
}

/** The files under a directory of the tree, by name, the delivered directory left out. */
function filesUnder(directory: string): string[] {
	const found: string[] = [];
	const visit = (dir: string): void => {
		if (dir === SKIP_DIRECTORY) {
			return;
		}
		const entries = readdirSync(absolute(dir), { withFileTypes: true }).sort((left, right) =>
			left.name < right.name ? -1 : left.name > right.name ? 1 : 0
		);
		for (const entry of entries) {
			const path = dir + '/' + entry.name;
			if (entry.isDirectory()) {
				visit(path);
			} else if (entry.isFile()) {
				found.push(path);
			}
		}
	};
	visit(directory);
	return found;
}

/** Whether a file has a comment style and so can carry a header; the table is the tool's (PROP-014 LIC-COMMENT-STYLES). */
function hasCommentStyle(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	if (COMMENT_STYLE_NAMES.has(name) || COMMENT_STYLE_NAMES.has(name.replace(/^\./u, ''))) {
		return true;
	}
	const dot = name.lastIndexOf('.');
	return dot > 0 && COMMENT_STYLE_NAMES.has(name.slice(dot + 1));
}

/** Registries, sidecars and licence texts (LICENSE, LICENCE, COPYING, with or without one extension) are the metadata of other files, not files that need a carrier. */
function isMetadata(path: string): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	return name === 'REUSE.toml' || name.endsWith('.license') || /^(LICENSE|LICENCE|COPYING)(\.[A-Za-z0-9]+)?$/u.test(name);
}

/** The text of a file, or null when it is binary (a NUL in its first 8 KiB) or not UTF-8. */
function textOf(path: string): string | null {
	const bytes = readFileSync(absolute(path));
	if (bytes.subarray(0, BINARY_PROBE).includes(0)) {
		return null;
	}
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function headerWindow(text: string): string[] {
	return text
		.split('\n')
		.filter((line) => line.trim() !== '')
		.slice(0, HEADER_WINDOW);
}

function holderOf(line: string): string | null {
	const match = COPYRIGHT_LINE.exec(line);
	return match === null ? null : (match.groups?.holder ?? '').replace(TRAILING_MARKER, '').trim();
}

function expressionOf(line: string): string | null {
	const match = SPDX_LINE.exec(line);
	return match === null ? null : (match.groups?.expression ?? '');
}

/** What is wrong with the carrier lines of a file, or null when they name a holder and the expression of the scope. */
function carrierProblem(lines: readonly string[], expression: string, where: string): string | null {
	const holders = lines.map(holderOf).filter((holder): holder is string => holder !== null);
	const expressions = lines.map(expressionOf).filter((found): found is string => found !== null);
	if (holders.length === 0) {
		return where + ' has no copyright line';
	}
	const foreign = holders.find((holder) => !HOLDERS.includes(holder));
	if (foreign !== undefined) {
		return where + ' names the holder "' + foreign + '", who is not a holder of the profile';
	}
	if (expressions.length !== 1) {
		return where + ' carries ' + String(expressions.length) + ' SPDX-License-Identifier lines instead of one';
	}
	const found = expressions[0] ?? '';
	if (found !== expression) {
		return where + ' says SPDX-License-Identifier: ' + found + ' instead of ' + expression;
	}
	return null;
}

/** The string values on the right of a TOML key: one basic string, or an array of them. */
function stringValues(raw: string): string[] {
	const values: string[] = [];
	for (const match of raw.matchAll(/"((?:[^"\\]|\\.)*)"/gu)) {
		values.push((match[1] ?? '').replace(/\\(["\\])/gu, '$1'));
	}
	return values;
}

/** The [[annotations]] of a REUSE.toml, read for the four keys of the carrier model and nothing else of TOML. */
function annotationsOf(registryText: string): Annotation[] {
	const annotations: Annotation[] = [];
	let current: Annotation | null = null;
	for (const raw of registryText.split('\n')) {
		const line = raw.trim();
		if (line === '[[annotations]]') {
			current = { paths: [], copyright: [], license: null, comment: '' };
			annotations.push(current);
			continue;
		}
		const equals = line.indexOf('=');
		if (current === null || equals === -1 || line.startsWith('#')) {
			continue;
		}
		const key = line.slice(0, equals).trim();
		const values = stringValues(line.slice(equals + 1));
		if (key === 'path') {
			current.paths.push(...values);
		} else if (key === 'SPDX-FileCopyrightText') {
			current.copyright.push(...values);
		} else if (key === 'SPDX-License-Identifier') {
			current.license = values[0] ?? null;
		} else if (key === 'SPDX-FileComment') {
			current.comment = values[0] ?? '';
		}
	}
	return annotations;
}

/** A REUSE path glob as the tool reads it: * crosses slashes, ? is one character. */
function globMatches(pattern: string, path: string): boolean {
	if (pattern === path) {
		return true;
	}
	let body = '';
	for (const character of pattern) {
		if (character === '*') {
			body += '.*';
		} else if (character === '?') {
			body += '.';
		} else {
			body += character.replace(/[.+^{}$()|[\]\\]/gu, '\\$&');
		}
	}
	return new RegExp('^' + body + '$', 'u').test(path);
}

/** The directories a REUSE.toml may annotate the file from, nearest first, up to the directory of the scope. */
function registryDirectories(path: string, scope: Scope): string[] {
	const directories: string[] = [];
	let directory = path.slice(0, path.lastIndexOf('/'));
	while (directory === scope.directory || directory.startsWith(scope.directory + '/')) {
		directories.push(directory);
		if (directory === scope.directory) {
			break;
		}
		directory = directory.slice(0, directory.lastIndexOf('/'));
	}
	return directories;
}

/** The annotation covering the file from the nearest registry that has one, or null. */
function annotationFor(path: string, scope: Scope): Annotation | null {
	for (const directory of registryDirectories(path, scope)) {
		const registry = directory + '/REUSE.toml';
		if (!isFile(registry)) {
			continue;
		}
		const relative = path.slice(directory.length + 1);
		const found = annotationsOf(readText(registry)).find((annotation) =>
			annotation.paths.some((pattern) => globMatches(pattern, relative))
		);
		if (found !== undefined) {
			return found;
		}
	}
	return null;
}

/** A declared third party is accepted provenance; any other annotation names a holder and the expression of the scope. */
function annotationProblem(annotation: Annotation, expression: string): string | null {
	if (annotation.comment.startsWith('third-party;')) {
		return null;
	}
	if (!annotation.copyright.some((line) => HOLDERS.some((holder) => line.includes(holder)))) {
		return 'its REUSE.toml annotation names no holder of the profile';
	}
	if (annotation.license !== expression) {
		return 'its REUSE.toml annotation says ' + (annotation.license ?? 'no licence') + ' instead of ' + expression;
	}
	return null;
}

/**
 * The carrier of one own file and what is wrong with it. A declared third party
 * is accepted provenance whatever its own notice says; otherwise the sidecar,
 * else the header of a file with a comment style - which keeps its own header,
 * an annotation never replaces it - else an annotation for a data file.
 */
function fileProblem(path: string, scope: Scope): string | null {
	const annotation = annotationFor(path, scope);
	if (annotation !== null && annotation.comment.startsWith('third-party;')) {
		return null;
	}
	const sidecar = path + '.license';
	if (isFile(sidecar)) {
		return carrierProblem(headerWindow(readText(sidecar)), scope.expression, 'its sidecar');
	}
	const text = textOf(path);
	if (text !== null && hasCommentStyle(path)) {
		const window = headerWindow(text);
		if (window.some((line) => COPYRIGHT_LINE.test(line) || SPDX_LINE.test(line))) {
			return carrierProblem(window, scope.expression, 'its header');
		}
		return 'has no licence carrier: no header in its first 20 non-empty lines and no .license sidecar (a source file keeps its own header; an annotation does not replace it)';
	}
	if (annotation !== null) {
		return annotationProblem(annotation, scope.expression);
	}
	return text === null
		? 'is binary and has neither a .license sidecar nor a REUSE.toml annotation'
		: 'has no licence carrier: a data file takes a .license sidecar or a REUSE.toml annotation';
}

function carrierProblems(): string[] {
	const problems: string[] = [];
	for (const scope of SCOPES) {
		if (!existsSync(absolute(scope.directory))) {
			problems.push(scope.directory + ': the own directory is missing from the tree');
			continue;
		}
		for (const path of filesUnder(scope.directory)) {
			if (isMetadata(path)) {
				continue;
			}
			const problem = fileProblem(path, scope);
			if (problem !== null) {
				problems.push(path + ': ' + problem);
			}
		}
	}
	return problems;
}

/** Every text surface a retired phrase must not survive in: the own files, the licence file, the renderings, the components. */
function textSurfaces(): string[] {
	const paths: string[] = [LICENCE_FILE, ...RENDERINGS, ...COMPONENTS];
	for (const scope of SCOPES) {
		if (existsSync(absolute(scope.directory))) {
			paths.push(...filesUnder(scope.directory));
		}
	}
	return paths;
}

function retiredNoticeProblems(): string[] {
	const problems: string[] = [];
	for (const path of textSurfaces()) {
		if (!isFile(path)) {
			continue;
		}
		const text = textOf(path);
		if (text === null) {
			continue;
		}
		const lower = text.toLowerCase();
		for (const notice of RETIRED_NOTICES) {
			if (lower.includes(notice.toLowerCase())) {
				problems.push(path + ': carries the retired notice "' + notice + '"');
			}
		}
	}
	return problems;
}

function valueAt(document: unknown, path: readonly string[]): unknown {
	let current: unknown = document;
	for (const key of path) {
		if (current === null || typeof current !== 'object' || Array.isArray(current)) {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

/** The dev channel merged over its target, the way the running product reads the manifest in a development tree. */
function merged(target: unknown, channel: unknown): unknown {
	if (target === null || typeof target !== 'object' || Array.isArray(target)) {
		return target;
	}
	if (channel === null || typeof channel !== 'object' || Array.isArray(channel)) {
		return target;
	}
	return { ...(target as Record<string, unknown>), ...(channel as Record<string, unknown>) };
}

function fieldProblems(): string[] {
	const problems: string[] = [];
	// A development tree carries the type's dev channel: the running product reads
	// its manifest with the channel merged over it, a key the overlay removes stays
	// until packaging materializes the target, and a target without a channel is
	// the upstream's until then. Those release-only expectations are codkit
	// verify's and the materialized tree's; here they are left alone.
	const development = DEV_CHANNEL !== null && isFile(DEV_CHANNEL);
	for (const field of FIELDS) {
		const where = field.target + ':' + field.path.join('.');
		if (development && (!field.devChannel || field.expected === null)) {
			continue;
		}
		if (!isFile(field.target)) {
			problems.push(where + ': the manifest is missing from the tree');
			continue;
		}
		let document: unknown;
		try {
			document = JSON.parse(readText(field.target));
			if (development && DEV_CHANNEL !== null) {
				document = merged(document, JSON.parse(readText(DEV_CHANNEL)));
			}
		} catch {
			problems.push(where + ': the manifest is not JSON');
			continue;
		}
		const value = valueAt(document, field.path);
		if (field.expected === null) {
			if (value !== undefined) {
				problems.push(where + ': expected no such key, found ' + JSON.stringify(value));
			}
		} else if (value !== field.expected) {
			problems.push(where + ': expected ' + JSON.stringify(field.expected) + ', found ' + JSON.stringify(value));
		}
	}
	return problems;
}

${preamble}${suite}('${LICENCE_GUARD_SUITE}', () => {
	${test}('every own file carries the licence of its directory', () => {
		const problems = carrierProblems();
		assert.ok(problems.length === 0, problems.join('\n'));
	});

	${test}('no retired notice survives in an own file or a licence surface', () => {
		const problems = retiredNoticeProblems();
		assert.ok(problems.length === 0, problems.join('\n'));
	});

	${test}('the licence file is the canonical text of the profile', () => {
		assert.ok(isFile(LICENCE_FILE), LICENCE_FILE + ': the licence file is missing from the tree');
		const digest = createHash('sha256').update(readFileSync(absolute(LICENCE_FILE))).digest('hex');
		assert.strictEqual(digest, LICENCE_SHA256, LICENCE_FILE + ': not the canonical text of the profile (SHA-256 ' + digest + ')');
	});

	${test}('every manifest field names the licence of the profile', () => {
		const problems = fieldProblems();
		assert.ok(problems.length === 0, problems.join('\n'));
	});

	${test}('every component licence and rendering is in the tree', () => {
		const missing = [...COMPONENTS, ...RENDERINGS].filter((path) => !isFile(path));
		assert.ok(missing.length === 0, 'missing from the tree: ' + missing.join(', '));
	});
});
`;
}
