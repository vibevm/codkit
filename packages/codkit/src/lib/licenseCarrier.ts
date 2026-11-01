/** @scope spec://codkit/modules/codkit/PROP-014#LIC-CARRIER-PRECEDENCE */
// Shared carrier selection; authority/verdicts remain in their scope-specific checkers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { commentStyleOf } from './licenseAnnotate.ts';
import type { LicenseProblem, ReuseAnnotation } from './licenseCheck.ts';
export type CarrierKind = 'header' | 'sidecar' | 'annotation';
export type CarrierReader = { readonly bytes: (path: string) => Uint8Array; readonly text: (path: string) => string };
/** Bytes probed for a NUL when deciding whether a file is binary. */
const BINARY_PROBE_BYTES = 8192;

/** ##LIC-HEADER-WINDOW: the carrier must be in the first 20 non-empty lines. */
const HEADER_WINDOW_LINES = 20;

/**
 * ##LIC-COPYRIGHT-REGEX, after the reuse-tool: an optional
 * `SPDX-FileCopyrightText:` prefix, the word or sign of the copyright notice,
 * an optional year or year range, then the holder. Comment markers around the
 * line are allowed, so the trailing one is trimmed off the holder separately.
 */
export const COPYRIGHT_LINE =
	/(SPDX-FileCopyrightText:\s*)?(Copyright\s*(\(c\)|©)?|©)\s*(?<years>\d{4}(\s*[-,]\s*\d{4})*)?\s+(?<holder>.+?)\s*$/u;

/** ##LIC-SPDX-REGEX: the licence line and the expression it carries. */
export const SPDX_LINE = /SPDX-License-Identifier:\s*(?<expr>[A-Za-z0-9.+\-]+(\s+(AND|OR|WITH)\s+[A-Za-z0-9.+\-]+)*)/u;

/** Our own edits of someone else's file; not part of who owns the file. */
export const MODIFICATIONS_LINE = /Modifications\s+Copyright/u;

/** Comment markers that can close a carrier line and are not part of a holder. */
const TRAILING_MARKER = /(-->|\*\/|-\*\))\s*$/u;

export function holderOf(match: RegExpExecArray): string {
	return (match.groups?.['holder'] ?? '').replace(TRAILING_MARKER, '').trim();
}

/** The carrier lines of one file, and where they came from. */
type Carrier = { readonly lines: readonly string[]; readonly kind: CarrierKind; readonly registry?: string };

/** A REUSE annotation states `2026 Holder`; the copyright regex wants the word, so it is supplied when absent. */
function copyrightLineOf(copyright: string): string {
	return /copyright|©/iu.test(copyright) ? copyright : `Copyright (c) ${copyright}`;
}

function annotationCarrier(annotation: ReuseAnnotation): Carrier {
	return {
		registry: annotation.registry ?? 'REUSE.toml',
		lines: [
			`SPDX-FileCopyrightText: ${copyrightLineOf(annotation.copyright ?? '')}`,
			`SPDX-License-Identifier: ${annotation.license ?? ''}`
		],
		kind: 'annotation'
	};
}

/**
 * ##LIC-CARRIER-PRECEDENCE: sidecar, override annotation, header, annotation.
 * ##LIC-CARRIER-ANNOTATION: an annotation carries a file that cannot hold a
 * comment (binary, undecodable, or an extension without a comment style); a
 * source file still needs its own header.
 */
export function selectLicenseCarrier(
	dir: string,
	relative: string,
	present: ReadonlySet<string>,
	annotations: readonly ReuseAnnotation[],
	problem: (code: LicenseProblem['code'], file: string, message: string) => void,
	reader?: CarrierReader
): Carrier | null {
	const sidecar = `${relative}.license`;
	if (present.has(sidecar)) {
		return { lines: (reader === undefined ? readFileSync(join(dir, sidecar), 'utf8') : reader.text(sidecar)).split('\n'), kind: 'sidecar' };
	}
	const override = annotations.find((annotation) => annotation.precedence === 'override');
	if (override !== undefined) return annotationCarrier(override);
	const closest = annotations.find((annotation) => annotation.precedence !== 'override');

	const bytes = reader === undefined ? readFileSync(join(dir, relative)) : reader.bytes(relative);
	if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
		if (closest !== undefined) return annotationCarrier(closest);
		problem('LICENSE-HEADER', relative, 'binary file without a .license sidecar or a REUSE.toml annotation');
		return null;
	}
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		if (closest !== undefined) return annotationCarrier(closest);
		problem('LICENSE-HEADER', relative, 'not valid UTF-8 and no .license sidecar or REUSE.toml annotation');
		return null;
	}
	// ##LIC-CARRIER-HEADER: the header form belongs to a file with a comment
	// style. A file without one (JSON, CSV, data) carries no header, and a
	// copyright-like line inside its data - the upstream's notice in a string of
	// a translation file, say - is data, not a carrier (##LIC-CARRIER-ANNOTATION).
	if (commentStyleOf(relative) !== null) {
		const window = text
			.split('\n')
			.filter((line) => line.trim() !== '')
			.slice(0, HEADER_WINDOW_LINES);
		if (window.some((line) => SPDX_LINE.test(line) || COPYRIGHT_LINE.test(line))) {
			return { lines: window, kind: 'header' };
		}
		problem(
			'LICENSE-HEADER',
			relative,
			closest === undefined
				? 'no licence carrier: no header in the first 20 non-empty lines, no sidecar, no REUSE.toml annotation'
				: 'source file without a header: a REUSE.toml annotation does not replace the header of a file that can carry one'
		);
		return null;
	}
	if (closest !== undefined) return annotationCarrier(closest);
	problem(
		'LICENSE-HEADER',
		relative,
		'no licence carrier: a file without a comment style carries no header, and it has no .license sidecar and no REUSE.toml annotation'
	);
	return null;
}

/**
 * REUSE path patterns, with the same semantics the reuse tool has: shell-style
 * globbing in which `*` is not stopped by a slash, so `icons/**` and `icons/*`
 * both reach a file two levels down.
 */
export function licenseGlobMatches(pattern: string, relative: string): boolean {
	if (pattern === relative) return true;
	let body = '';
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index] ?? '';
		if (character === '*') {
			body += '.*';
			continue;
		}
		if (character === '?') {
			body += '.';
			continue;
		}
		body += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
	}
	return new RegExp(`^${body}$`, 'u').test(relative);
}
