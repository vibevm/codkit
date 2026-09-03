/** @scope spec://codkit/modules/codkit/PROP-004#root */
// Deterministic patch generation, "pin -> file" (PROP-004 sec. 5).
//
// The whole point of this module is that the same two inputs always produce the
// same bytes, on every machine and in every repository (##DOUBLE-REGEN-INVARIANT).
// That is why the diff is taken with explicit algorithm and prefix settings,
// through fixed temporary file names, with the volatile headers stripped: an
// `index` line carries abbreviated hashes whose length depends on how many
// objects the repository happens to hold.
//
// Nothing here writes the patch file. The caller gets bytes and a verdict, so
// the "identical bytes are not rewritten, mtime is not touched" rule
// (##GEN-BYTE-COMPARE) stays where the file system is.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesEqual, containsByte, CR_BYTE, decodeUtf8Strict, encodeUtf8, endsWithNewline, NUL_BYTE } from './bytes.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
/** Fixed names, so an absolute path never reaches the diff output. */
const PIN_FILE = 'a';
const CUR_FILE = 'b';
/** Config that pins git's diff behaviour regardless of the machine. */
const DIFF_CONFIG = [
    '-c',
    'diff.algorithm=myers',
    '-c',
    'core.autocrlf=false',
    '-c',
    'diff.renames=false',
    '-c',
    'diff.mnemonicPrefix=false',
    '-c',
    'diff.noprefix=false'
];
const DIFF_ARGS = [
    'diff',
    '--no-index',
    '-U3',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '--',
    PIN_FILE,
    CUR_FILE
];
/** Volatile lines the normalization removes (##GEN-DIFF-INVOCATION). */
const VOLATILE_PREFIXES = ['diff --git ', 'index ', 'old mode ', 'new mode ', 'new file mode ', 'deleted file mode '];
const DEV_NULL = '/dev/null';
/**
 * Regenerate the body of a .ckpatch and assemble the file. Refuses before
 * diffing anything when the target file violates one of the byte predicates.
 */
export function regeneratePatch(options) {
    checkBytePredicates(options.targetPath, options.pinBytes, options.curBytes);
    const body = diffBody(options);
    if (body === null) {
        return { unchanged: true, empty: true };
    }
    const header = options.header.endsWith('\n') ? options.header : `${options.header}\n`;
    const bytes = encodeUtf8(`${header}${body}`);
    if (options.existingBytes !== null && bytesEqual(options.existingBytes, bytes)) {
        return { unchanged: true, empty: false };
    }
    return { unchanged: false, empty: false, bytes };
}
/**
 * The byte predicates of ##GEN-BYTE-PREDICATES, in the order that produces the
 * most useful diagnostic: a binary file is named as binary rather than as an
 * encoding failure, because a NUL byte is what makes it binary and it is also
 * valid UTF-8 on its own.
 */
export function checkBytePredicates(targetPath, pinBytes, curBytes) {
    if (containsByte(curBytes, NUL_BYTE)) {
        throw ckError('FORBIDDEN-TARGET', `${targetPath} contains NUL bytes: a binary target cannot be carried by a patch`, 'binary targets belong to the resource-file layer: record the replacement in delta/resources/map.json', targetPath);
    }
    if (decodeUtf8Strict(curBytes) === null) {
        throw ckError('ENCODING', `${targetPath} is not valid UTF-8`, 'codkit reads and writes UTF-8 only; re-save the file as UTF-8 without a byte order mark', targetPath);
    }
    if (containsByte(curBytes, CR_BYTE)) {
        throw ckError('CRLF', `${targetPath} has a carriage return in it`, 'codkit works on LF only; set core.autocrlf=false, delete the file and check it out again', targetPath);
    }
    if (endsWithNewline(pinBytes) && curBytes.length > 0 && !endsWithNewline(curBytes)) {
        throw ckError('EOF-NEWLINE', `${targetPath} lost the newline at the end of the file it has at the pin`, 'restore the final newline; an editor that strips it turns every later diff into noise', targetPath);
    }
}
/**
 * Run the diff and normalize it, or return null when the target equals the pin.
 * The result always ends with a single line feed.
 */
function diffBody(options) {
    mkdirSync(options.tmpDir, { recursive: true });
    writeFileSync(join(options.tmpDir, PIN_FILE), options.pinBytes);
    writeFileSync(join(options.tmpDir, CUR_FILE), options.curBytes);
    const result = runGit({ args: [...DIFF_CONFIG, ...DIFF_ARGS], cwd: options.tmpDir });
    // `git diff --no-index` reports differences with status 1; that is a verdict,
    // not a failure. Anything else is a real problem.
    if (result.status === 0) {
        return null;
    }
    if (result.status !== 1) {
        throw ckError('INTERNAL', `git diff --no-index failed for ${options.targetPath} (status ${result.status}): ${result.stderr.trim()}`, 'this is a codkit bug or a broken git installation; re-run with --verbose');
    }
    return normalizeDiff(result.stdout, options.targetPath, !(options.pinExists ?? options.pinBytes.length > 0));
}
/**
 * Drop the volatile headers and rewrite the file headers to the canonical
 * upstream path. Everything else - hunk headers, context, added and removed
 * lines, the "\ No newline at end of file" markers - is passed through byte for
 * byte (##PB-BYTES-VERBATIM).
 */
function normalizeDiff(raw, targetPath, isAddFile) {
    const out = [];
    let sawMinus = false;
    let sawPlus = false;
    let inBody = false;
    for (const line of raw.split('\n')) {
        if (!inBody && isVolatile(line)) {
            continue;
        }
        if (!sawMinus && line.startsWith('--- ')) {
            out.push(isAddFile ? `--- ${DEV_NULL}` : `--- a/${targetPath}`);
            sawMinus = true;
            continue;
        }
        if (sawMinus && !sawPlus && line.startsWith('+++ ')) {
            out.push(`+++ b/${targetPath}`);
            sawPlus = true;
            inBody = true;
            continue;
        }
        out.push(line);
    }
    if (!sawMinus || !sawPlus) {
        throw ckError('INTERNAL', `the generated diff for ${targetPath} has no file headers`, 'this is a codkit bug: git produced a diff codkit cannot normalize');
    }
    // git's output ends with a line feed, which split() turns into one trailing
    // empty element. Exactly one is removed: a context line for an empty source
    // line is written as a single space, never as an empty line, so a second
    // empty element would be content and must not be silently dropped.
    if (out.length > 0 && out[out.length - 1] === '') {
        out.pop();
    }
    return `${out.join('\n')}\n`;
}
function isVolatile(line) {
    return VOLATILE_PREFIXES.some((prefix) => line.startsWith(prefix));
}
