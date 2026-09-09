/** @scope spec://codkit/modules/codkit/PROP-014#LIC-ANNOTATE */
// Giving a file its licence carrier (PROP-014 sec. 3).
//
// ##LIC-ANNOTATE: a header in the comment style of the file's extension, placed
// after whatever prelude the format requires, or a sidecar for a binary and for
// any format that cannot carry a comment. Idempotent by construction: a file
// that already resolves to a carrier is left alone, so running the command
// twice leaves `git diff` empty.
//
// ##LIC-COMMENT-STYLES: the table below is the whole vocabulary. Adding an
// extension is an edit here and in the spec together - a guess about an unknown
// format would put a comment marker into a file that does not have comments.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
/** Bytes probed for a NUL when deciding whether a file is binary. */
const BINARY_PROBE_BYTES = 8192;
/** ##LIC-COMMENT-STYLES: extension (or bare file name) to comment style. */
const COMMENT_STYLES = new Map([
    ...['toml', 'yaml', 'yml', 'py', 'sh', 'bash', 'zsh', 'properties', 'ini', 'conf', 'rb', 'pl', 'r', 'ps1'].map((extension) => [extension, 'hash']),
    ...['Dockerfile', 'Makefile', 'gitignore', 'gitattributes', 'editorconfig'].map((name) => [name, 'hash']),
    ...[
        'java',
        'kt',
        'kts',
        'go',
        'js',
        'mjs',
        'cjs',
        'ts',
        'tsx',
        'jsx',
        'c',
        'h',
        'cpp',
        'hpp',
        'cs',
        'rs',
        'swift',
        'dart',
        'scala',
        'groovy',
        'gradle',
        'proto'
    ].map((extension) => [extension, 'slash']),
    ...['css', 'scss', 'less'].map((extension) => [extension, 'block']),
    ...['md', 'html', 'htm', 'xml', 'xsl', 'xsd', 'svg', 'xhtml', 'vue'].map((extension) => [extension, 'xml']),
    ...['sql', 'lua', 'hs'].map((extension) => [extension, 'dash']),
    ...['clj', 'cljs', 'edn', 'lisp', 'el'].map((extension) => [extension, 'semicolon']),
    ...['tex', 'sty'].map((extension) => [extension, 'percent']),
    ...['bat', 'cmd'].map((extension) => [extension, 'rem'])
]);
/** The comment style of a path, or null when the file needs a sidecar. */
export function commentStyleOf(relative) {
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    const byName = COMMENT_STYLES.get(name) ?? COMMENT_STYLES.get(name.replace(/^\./u, ''));
    if (byName !== undefined)
        return byName;
    const dot = name.lastIndexOf('.');
    if (dot <= 0)
        return null;
    return COMMENT_STYLES.get(name.slice(dot + 1)) ?? null;
}
/** The notice lines wrapped in the comment markers of one style. */
export function wrapNotice(style, lines) {
    switch (style) {
        case 'hash':
            return `${lines.map((line) => `# ${line}`).join('\n')}\n`;
        case 'slash':
            return `${lines.map((line) => `// ${line}`).join('\n')}\n`;
        case 'block':
            return `/*\n${lines.map((line) => ` * ${line}`).join('\n')}\n */\n`;
        case 'xml':
            return `<!--\n${lines.join('\n')}\n-->\n`;
        case 'dash':
            return `${lines.map((line) => `-- ${line}`).join('\n')}\n`;
        case 'semicolon':
            return `${lines.map((line) => `; ${line}`).join('\n')}\n`;
        case 'percent':
            return `${lines.map((line) => `% ${line}`).join('\n')}\n`;
        default:
            return `${lines.map((line) => `REM ${line}`).join('\n')}\n`;
    }
}
/**
 * How many leading lines of a file the header must sit after: a shebang, a
 * Python encoding line, an XML declaration, a doctype, or a YAML front matter
 * block. Everything else takes the header at line one.
 */
export function preludeLength(text) {
    const lines = text.split('\n');
    let index = 0;
    if (lines[0]?.startsWith('#!') === true)
        index += 1;
    if (lines[index]?.startsWith('<?xml') === true)
        index += 1;
    if (/^#.*coding[:=]/u.test(lines[index] ?? ''))
        index += 1;
    if (lines[index]?.toLowerCase().startsWith('<!doctype') === true)
        index += 1;
    if (index === 0 && lines[0] === '---') {
        const close = lines.indexOf('---', 1);
        if (close !== -1)
            index = close + 1;
    }
    return index;
}
/** Whether the bytes of a file rule out a comment header. */
export function needsSidecar(bytes, relative) {
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))
        return true;
    if (commentStyleOf(relative) === null)
        return true;
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return true;
    }
    return false;
}
/** Place a carrier on one file, or report that it already has one. */
export function annotateFile(options) {
    const { dir, relative, notice, dryRun } = options;
    if (options.alreadyCarried)
        return { path: relative, action: 'unchanged' };
    const absolute = join(dir, ...relative.split('/'));
    const bytes = readFileSync(absolute);
    if (needsSidecar(bytes, relative)) {
        if (!dryRun)
            writeFileSync(`${absolute}.license`, `${notice.join('\n')}\n`, 'utf8');
        return { path: `${relative}.license`, action: 'sidecar' };
    }
    const style = commentStyleOf(relative);
    // needsSidecar already refused a path with no style; this keeps the types
    // honest without a non-null assertion (the `unsafe` set is out of bounds).
    if (style === null) {
        if (!dryRun)
            writeFileSync(`${absolute}.license`, `${notice.join('\n')}\n`, 'utf8');
        return { path: `${relative}.license`, action: 'sidecar' };
    }
    const text = new TextDecoder('utf-8').decode(bytes);
    const lines = text.split('\n');
    const at = preludeLength(text);
    const updated = [...lines.slice(0, at), wrapNotice(style, notice).replace(/\n$/u, ''), ...lines.slice(at)].join('\n');
    if (!dryRun)
        writeFileSync(absolute, updated, 'utf8');
    return { path: relative, action: 'header' };
}
