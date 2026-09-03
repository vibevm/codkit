/** @scope spec://codkit/modules/codkit/PROP-006#root */
// "Every hunk inside a marker" - the cross-check of PROP-006 sec. 5.
//
// The rule it enforces is the one that makes an upgrade cycle mechanical: a
// patch may only add lines inside a block it owns, and it may not delete an
// upstream line at all - an upstream line that has to go is commented out, so
// the next release's diff still shows what was neutralized and why (PROP-004
// ##MR-FUNCTIONAL-ONLY).
//
// Everything is computed against the *target* state (pin + patch), because that
// is where the marker lines actually exist: they are added by the patch itself.

import { markerFormFor, parseMarkers } from './markers.ts';
import type { MarkerBlock, MarkerConventions } from './markers.ts';
import { applyUnified } from './applyUnified.ts';
import { ckError } from './messages.ts';
import type { CkError, WarningCode } from './messages.ts';
import type { ParsedPatch } from './patchFormat.ts';

export type MarkerWarning = {
	readonly code: WarningCode;
	readonly message: string;
	readonly file: string;
	readonly line?: number;
};

export type HunksInMarkersResult = {
	readonly errors: readonly CkError[];
	readonly warnings: readonly MarkerWarning[];
	/** The blocks found in the target state, for callers that report them. */
	readonly blocks: readonly MarkerBlock[];
};

export type HunksInMarkersOptions = {
	/** Path of the .ckpatch, used in diagnostics (PROP-004 sec. 4, invalid sample). */
	readonly patchFile?: string;
	/**
	 * Ids a block may carry besides the patch id. Only the entry-module layer
	 * needs it: there one id covers blocks in several files (PROP-005 sec. 4).
	 */
	readonly allowIds?: readonly string[];
};

/** One added line, numbered in the target state. */
type AddedLine = { readonly line: number; readonly text: string; readonly hunk: number };

/** One removed line, numbered in the pin. */
type RemovedLine = { readonly line: number; readonly text: string; readonly hunk: number };

/**
 * Check one patch against its target state. Diagnosed conditions are returned,
 * never thrown; a patch that cannot be applied to its pin at all is a different
 * failure and comes out of applyUnified as CK-E-ARTIFACT-BROKEN.
 */
export function checkHunksInsideMarkers(
	patch: ParsedPatch,
	pinBytes: Uint8Array,
	ext: string,
	conventions: MarkerConventions,
	options?: HunksInMarkersOptions
): HunksInMarkersResult {
	const patchFile = options?.patchFile ?? patch.targetPath;
	const targetBytes = applyUnified(pinBytes, patch);
	const parsed = parseMarkers(targetBytes, ext, conventions, patch.targetPath);

	const errors: CkError[] = [...parsed.errors];
	const warnings: MarkerWarning[] = [];
	const blocks = parsed.blocks;

	const { added, removed } = walkHunks(patch);
	const addedLines = new Set(added.map((entry) => entry.line));

	reportAddedOutsideBlocks(added, blocks, patch, patchFile, conventions, ext, errors);
	reportDeletedUpstreamLines(removed, added, ext, conventions, patchFile, errors);
	reportMarkerOrigin(blocks, addedLines, patchFile, errors);
	reportEmptyBlocks(blocks, addedLines, patchFile, warnings);
	errors.push(...checkMarkerArtifactConsistency(blocks, patch.header.id, options?.allowIds, patchFile));

	return { errors, warnings, blocks };
}

/**
 * "Marker <-> artifact consistency" (PROP-006 ##MARKER-ARTIFACT-CONSISTENCY):
 * every block in the target state carries the id of the patch that produced it,
 * and the patch id is actually present among the blocks.
 */
export function checkMarkerArtifactConsistency(
	blocks: readonly MarkerBlock[],
	patchId: string,
	allowIds?: readonly string[],
	file?: string
): readonly CkError[] {
	const allowed = new Set<string>([patchId, ...(allowIds ?? [])]);
	const errors: CkError[] = [];
	for (const block of blocks) {
		if (!allowed.has(block.id)) {
			errors.push(
				ckError(
					'MARKER-ARTIFACT-MISMATCH',
					`marker block "${block.id}" is not owned by this artifact (id ${patchId})`,
					'a block belongs to the artifact whose id it carries; move it to that artifact or fix the id',
					file,
					block.beginLine
				)
			);
		}
	}
	if (!blocks.some((block) => block.id === patchId)) {
		errors.push(
			ckError(
				'MARKER-ARTIFACT-MISMATCH',
				`no marker block carries the artifact id ${patchId}`,
				`wrap the change of this artifact in a codkit:begin ${patchId} / codkit:end ${patchId} block`,
				file
			)
		);
	}
	return errors;
}

/**
 * Walk the hunks and number every added line in the target state and every
 * removed line in the pin. The numbering is the same walk applyUnified does,
 * so a line number reported here points at the file the tree will hold.
 */
function walkHunks(patch: ParsedPatch): { added: AddedLine[]; removed: RemovedLine[] } {
	const added: AddedLine[] = [];
	const removed: RemovedLine[] = [];
	for (let hunkIndex = 0; hunkIndex < patch.hunks.length; hunkIndex += 1) {
		const hunk = patch.hunks[hunkIndex];
		if (hunk === undefined) {
			continue;
		}
		let oldLine = hunk.startOld;
		let newLine = hunk.startNew;
		for (const line of hunk.lines) {
			if (line.kind === '\\') {
				continue;
			}
			if (line.kind === ' ') {
				oldLine += 1;
				newLine += 1;
				continue;
			}
			if (line.kind === '+') {
				added.push({ line: newLine, text: line.text, hunk: hunkIndex });
				newLine += 1;
				continue;
			}
			removed.push({ line: oldLine, text: line.text, hunk: hunkIndex });
			oldLine += 1;
		}
	}
	return { added, removed };
}

function reportAddedOutsideBlocks(
	added: readonly AddedLine[],
	blocks: readonly MarkerBlock[],
	patch: ParsedPatch,
	patchFile: string,
	conventions: MarkerConventions,
	ext: string,
	errors: CkError[]
): void {
	let previousOutside = -2;
	for (const entry of added) {
		if (blocks.some((block) => entry.line >= block.beginLine && entry.line <= block.endLine)) {
			continue;
		}
		// One diagnostic per run of adjacent lines: a three-line addition outside
		// a block is one mistake, not three.
		if (entry.line === previousOutside + 1) {
			previousOutside = entry.line;
			continue;
		}
		previousOutside = entry.line;
		errors.push(
			ckError(
				'HUNK-OUTSIDE-MARKER',
				`hunk at target line ${entry.line} adds lines outside any codkit marker block. ${wrapHint(patch.header.id, ext, conventions)}`,
				`every added line lives between ${markerText(patch.header.id, 'begin', ext, conventions)} and ${markerText(patch.header.id, 'end', ext, conventions)}`,
				patchFile
			)
		);
	}
}

function reportDeletedUpstreamLines(
	removed: readonly RemovedLine[],
	added: readonly AddedLine[],
	ext: string,
	conventions: MarkerConventions,
	patchFile: string,
	errors: CkError[]
): void {
	const wrapper = commentWrapper(ext, conventions);
	for (const entry of removed) {
		if (wrapper !== null && isNeutralizedByComment(entry, added, wrapper)) {
			continue;
		}
		errors.push(
			ckError(
				'DELETES-UPSTREAM-LINE',
				`hunk deletes upstream line ${entry.line}: ${quote(entry.text)}`,
				'an upstream line is neutralized by commenting it out inside the block, never by deleting it (PROP-004 ##MR-FUNCTIONAL-ONLY)',
				patchFile
			)
		);
	}
}

/** The plain comment syntax of a language: the marker form without `codkit:`. */
type CommentWrapper = { readonly open: string; readonly close: string };

/**
 * `// codkit:` -> `//`, `/* codkit:` -> `/*` + the closing marker. Neutralizing
 * an upstream line is ordinary commenting out, not a codkit marker, so the
 * keyword is dropped and only the language's own syntax is left.
 */
function commentWrapper(ext: string, conventions: MarkerConventions): CommentWrapper | null {
	const form = markerFormFor(ext, conventions);
	if (form === null) {
		return null;
	}
	const at = form.open.indexOf('codkit:');
	const open = (at === -1 ? form.open : form.open.slice(0, at)).trim();
	return open === '' ? null : { open, close: form.close.trim() };
}

/**
 * "Neutralization by commenting out": the same hunk adds a line that is the
 * removed line wrapped in the language's own comment syntax. The comparison
 * ignores indentation on both sides, so putting the prefix in front of the
 * indent or behind it makes no difference.
 */
function isNeutralizedByComment(entry: RemovedLine, added: readonly AddedLine[], wrapper: CommentWrapper): boolean {
	const wanted = entry.text.trim();
	for (const candidate of added) {
		if (candidate.hunk !== entry.hunk) {
			continue;
		}
		let rest = candidate.text.trim();
		if (!rest.startsWith(wrapper.open)) {
			continue;
		}
		rest = rest.slice(wrapper.open.length);
		if (wrapper.close !== '') {
			if (!rest.endsWith(wrapper.close)) {
				continue;
			}
			rest = rest.slice(0, -wrapper.close.length);
		}
		if (rest.trim() === wanted) {
			return true;
		}
	}
	return false;
}

/**
 * Upstream has no codkit markers: every marker line of the target state must be
 * a line this patch added. A marker that is already in the pin means the patch
 * and the tree have drifted apart.
 */
function reportMarkerOrigin(blocks: readonly MarkerBlock[], addedLines: ReadonlySet<number>, patchFile: string, errors: CkError[]): void {
	for (const block of blocks) {
		for (const line of [block.beginLine, block.endLine]) {
			if (!addedLines.has(line)) {
				errors.push(
					ckError(
						'MARKER-ARTIFACT-MISMATCH',
						`the marker line ${line} of block "${block.id}" is not added by this patch`,
						'upstream carries no codkit markers; a marker in the target state is always a line the patch adds',
						patchFile,
						line
					)
				);
			}
		}
	}
}

function reportEmptyBlocks(
	blocks: readonly MarkerBlock[],
	addedLines: ReadonlySet<number>,
	patchFile: string,
	warnings: MarkerWarning[]
): void {
	for (const block of blocks) {
		let inner = 0;
		for (let line = block.beginLine + 1; line < block.endLine; line += 1) {
			if (addedLines.has(line)) {
				inner += 1;
			}
		}
		if (inner === 0) {
			warnings.push({
				code: 'EMPTY-BLOCK',
				message: `marker block "${block.id}" adds nothing but its own marker lines`,
				file: patchFile,
				line: block.beginLine
			});
		}
	}
}

function markerText(id: string, keyword: 'begin' | 'end', ext: string, conventions: MarkerConventions): string {
	const form = markerFormFor(ext, conventions);
	if (form === null) {
		return `codkit:${keyword} ${id}`;
	}
	return `"${form.open}${keyword} ${id}${form.close}"`;
}

function wrapHint(id: string, ext: string, conventions: MarkerConventions): string {
	return `Wrap the change in ${markerText(id, 'begin', ext, conventions)} ... ${markerText(id, 'end', ext, conventions)}.`;
}

function quote(text: string): string {
	return JSON.stringify(text);
}
