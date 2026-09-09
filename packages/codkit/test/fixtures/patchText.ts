// The text machinery both pseudo-patchsets share: reading a file at a pin,
// generating a normalized unified diff the way PROP-004 sec. 5 prescribes, and
// refusing to hand out a patch that does not apply at that pin.
//
// A fixture that only looks like a patch would let a broken engine pass, so
// every generated patch is checked with `git apply --cached --check` against a
// temporary index holding the pin's tree - never against the work tree, which
// sits at a later commit.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runGit } from '../../src/lib/gitx.ts';
import { ckError } from '../../src/lib/messages.ts';

/** The file as of a commit, read from git objects - never from the work tree. */
export function showAtPin(dir: string, sha: string, path: string): string {
	const result = runGit({ args: ['show', `${sha}:${path}`], cwd: dir });
	if (result.status !== 0) {
		throw ckError('INTERNAL', `fixture: cannot read ${path} at ${sha}: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/**
 * `git diff --no-index` with the flags of PROP-004 ##GEN-DIFF-INVOCATION, then
 * the normalization: volatile headers dropped, --- / +++ rewritten to the
 * canonical upstream path.
 */
export function unifiedDiff(scratch: string, before: string, after: string, path: string): string {
	writeFileSync(join(scratch, 'a'), before, 'utf8');
	writeFileSync(join(scratch, 'b'), after, 'utf8');
	const result = runGit({
		args: [
			'-c',
			'diff.algorithm=myers',
			'-c',
			'diff.renames=false',
			'-c',
			'diff.mnemonicPrefix=false',
			'-c',
			'diff.noprefix=false',
			'diff',
			'--no-index',
			'-U3',
			'--no-color',
			'--no-ext-diff',
			'--no-textconv',
			'--',
			'a',
			'b'
		],
		cwd: scratch
	});
	// 0 = identical, 1 = differences; anything else is a real failure.
	if (result.status !== 1) {
		throw ckError('INTERNAL', `fixture: diff generation failed (status ${result.status}): ${result.stderr.trim()}`);
	}
	return normalizeDiff(result.stdout, path);
}

function normalizeDiff(raw: string, path: string): string {
	const out: string[] = [];
	let sawMinus = false;
	let sawPlus = false;
	for (const line of raw.split('\n')) {
		if (line.startsWith('diff --git ') || line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ')) {
			continue;
		}
		if (!sawMinus && line.startsWith('--- ')) {
			out.push(`--- a/${path}`);
			sawMinus = true;
			continue;
		}
		if (!sawPlus && line.startsWith('+++ ')) {
			out.push(`+++ b/${path}`);
			sawPlus = true;
			continue;
		}
		out.push(line);
	}
	if (!sawMinus || !sawPlus) {
		throw ckError('INTERNAL', 'fixture: generated diff has no file headers');
	}
	return out.join('\n');
}

/**
 * The generator refuses to hand out a patch that does not apply at the pin:
 * checked against a temporary index holding the pin's tree, so the work tree of
 * the fixture (which sits at a later commit) is not involved.
 */
export function assertApplies(
	scratch: string,
	upstreamDir: string,
	pin: { readonly tag: string; readonly sha: string },
	patch: string
): void {
	const patchFile = join(scratch, 'candidate.ckpatch');
	writeFileSync(patchFile, patch, 'utf8');
	const indexFile = join(scratch, 'pin-index');
	const env = { GIT_INDEX_FILE: indexFile };

	const read = runGit({ args: ['read-tree', pin.sha], cwd: upstreamDir, env });
	if (read.status !== 0) {
		throw ckError('INTERNAL', `fixture: cannot read the pin tree into a temporary index: ${read.stderr.trim()}`);
	}
	const check = runGit({ args: ['apply', '--cached', '--check', patchFile], cwd: upstreamDir, env });
	if (check.status !== 0) {
		throw ckError(
			'INTERNAL',
			`fixture: the generated patch does not apply at ${pin.tag}: ${check.stderr.trim()}`,
			'the fixture patch generator and the fixture upstream have drifted apart'
		);
	}
}

/** `src/a/b.ts` -> `src__a__b.ts` (PROP-004 sec. 4, patch file name encoding). */
export function encodePatchName(path: string): string {
	if (path.includes('__')) {
		throw ckError('INTERNAL', `fixture: path ${path} cannot be encoded as a patch name`);
	}
	return path.split('/').join('__');
}

export function writeJson(absolutePath: string, value: unknown): void {
	writeBytes(absolutePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeBytes(absolutePath: string, content: string | Uint8Array): void {
	mkdirSync(dirname(absolutePath), { recursive: true });
	writeFileSync(absolutePath, content);
}
