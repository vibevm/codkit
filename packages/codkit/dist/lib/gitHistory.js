/** @scope spec://codkit/modules/codkit/PROP-008#root */
// Build deterministic objects in one Git process. The private import branch is
// reset before the import finishes: no ref, index or working file is changed.
import { randomUUID } from 'node:crypto';
import { gitOk } from './gitx.js';
import { ckError } from './messages.js';
/** One NUL-delimited listing, including directories, independent of path quoting. */
export function readTreeEntries(treeDir, ref) {
    const listed = gitOk({ args: ['ls-tree', '-r', '-t', '-z', '--full-tree', ref], cwd: treeDir }, { code: 'ARTIFACT-BROKEN', message: `cannot read the tree of ${ref}` }).stdout;
    const entries = new Map();
    for (const record of listed.split('\0')) {
        if (record === '')
            continue;
        const tab = record.indexOf('\t');
        const [mode, , oid] = record.slice(0, tab).split(' ');
        if (tab < 0 || mode === undefined || oid === undefined)
            throw ckError('INTERNAL', 'invalid git ls-tree record');
        entries.set(record.slice(tab + 1), { mode, oid });
    }
    return entries;
}
/** Return every commit id, with the same bytes as successive commit-tree -m calls. */
export function writeHistory(options) {
    if (options.commits.length === 0)
        return [];
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.parent))
        throw ckError('INTERNAL', 'invalid generated history parent');
    const seconds = Date.parse(options.dateIso) / 1000;
    const zone = /(?:([+-]\d\d):(\d\d)|Z)$/.exec(options.dateIso);
    if (!Number.isInteger(seconds) || zone === null || /[\r\n\0<>]/.test(options.authorName + options.authorEmail)) {
        throw ckError('INTERNAL', 'invalid generated commit identity or date');
    }
    const offset = zone[1] === undefined ? '+0000' : `${zone[1]}${zone[2] ?? ''}`;
    const identity = `${options.authorName} <${options.authorEmail}> ${seconds} ${offset}`;
    const ref = `refs/codkit/import/${randomUUID()}`;
    const chunks = [];
    const line = (text) => {
        chunks.push(Buffer.from(`${text}\n`, 'utf8'));
    };
    const data = (bytes) => {
        line(`data ${bytes.byteLength}`);
        chunks.push(bytes);
        line('');
    };
    options.commits.forEach((commit, index) => {
        line(`commit ${ref}`);
        line(`mark :${index + 1}`);
        line(`author ${identity}`);
        line(`committer ${identity}`);
        data(Buffer.from(commit.message.endsWith('\n') ? commit.message : `${commit.message}\n`, 'utf8'));
        line(`from ${index === 0 ? options.parent : `:${index}`}`);
        for (const change of commit.changes) {
            const path = quotePath(change.path);
            if ('remove' in change)
                line(`D ${path}`);
            else {
                if (!/^(100644|100755|120000)$/.test(change.mode))
                    throw ckError('ARTIFACT-BROKEN', `unsupported file mode ${change.mode}`);
                line(`M ${change.mode} inline ${path}`);
                data(change.bytes);
            }
        }
        line('');
    });
    options.commits.forEach((_, index) => line(`get-mark :${index + 1}`));
    line(`reset ${ref}`);
    line('');
    line('done');
    const result = gitOk({
        args: ['fast-import', '--quiet', '--done', '--date-format=raw'],
        cwd: options.treeDir,
        input: Buffer.concat(chunks)
    }, { code: 'ARTIFACT-BROKEN', message: 'cannot write the generated history' });
    const commits = result.stdout.trim().split('\n');
    if (commits.length !== options.commits.length || commits.some((sha) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha))) {
        throw ckError('INTERNAL', 'git fast-import did not return every generated commit');
    }
    return commits;
}
/** Git C quoting, including byte escapes that JSON's Unicode quoting cannot express. */
function quotePath(path) {
    if (path === '' || path.includes('\0') || path.split('/').some((part) => part === '' || part === '.' || part === '..')) {
        throw ckError('ARTIFACT-BROKEN', `invalid generated path ${JSON.stringify(path)}`);
    }
    let quoted = '"';
    for (const byte of Buffer.from(path, 'utf8')) {
        if (byte === 34 || byte === 92)
            quoted += `\\${String.fromCharCode(byte)}`;
        else if (byte < 32 || byte >= 127)
            quoted += `\\${byte.toString(8).padStart(3, '0')}`;
        else
            quoted += String.fromCharCode(byte);
    }
    return `${quoted}"`;
}
