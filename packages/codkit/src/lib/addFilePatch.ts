/** @scope spec://codkit/modules/codkit/PROP-019#GEN-LICENSING */
// The add-file patch as text, for the files the engine authors itself: the
// licence file of the product, the component licences and the renderings
// (##GEN-LICENSING). The shape is the one `codkit save` writes and PROP-004
// fixes for a new file - `--- /dev/null`, `+++ b/<path>`, one hunk
// `@@ -0,0 +1,N @@` of added lines - so what is written here parses with the
// same reader as every other patch, and `verify` reads the body back with the
// second function.

import { ckError } from './messages.ts';
import type { ParsedPatch } from './patchFormat.ts';

/**
 * An add-file patch for `treePath` carrying `content`, after the header lines.
 * The content ends with a newline and carries no carriage return: the patch
 * format is LF-only, and a file that ends mid-line would make the last added
 * line a lie about the file.
 */
export function addFilePatchText(headerText: string, treePath: string, content: string): string {
	if (content === '' || !content.endsWith('\n')) {
		throw ckError(
			'CONFIG',
			`the content of ${treePath} is empty or does not end with a newline`,
			'the engine writes LF-only files that end with a newline',
			treePath
		);
	}
	if (content.includes('\r')) {
		throw ckError('CRLF', `the content of ${treePath} carries a carriage return`, 'codkit artifacts are LF-only', treePath);
	}
	const lines = content.slice(0, -1).split('\n');
	return `${headerText}--- /dev/null\n+++ b/${treePath}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`;
}

/** The content an add-file patch creates, ending with a newline; null for a patch of an existing file. */
export function addFileBodyOf(patch: ParsedPatch): string | null {
	if (!patch.isAddFile) return null;
	const lines: string[] = [];
	for (const hunk of patch.hunks) {
		for (const line of hunk.lines) {
			if (line.kind !== '+') return null;
			lines.push(line.text);
		}
	}
	return `${lines.join('\n')}\n`;
}
