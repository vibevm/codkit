/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-MATERIALS */
// User-authority receipts bind removable copies to immutable saved source blobs.
import { createHash } from 'node:crypto';
import { relative } from 'node:path';
import { z } from 'zod';
import { hashContainedFile, readContainedFile, writeContainedFileExclusive } from './containedFile.js';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { repoRelativePathProblem } from './pathSafety.js';
import { ownedRootsOf, ownCodeFilter } from './ownedRoots.js';
import { listOwnFiles, ownSourceRoot, isDeliveredOwnFile } from './ownCopy.js';
import { materializerOf, ownExtensionFiles } from './layers/ownExtensions.js';
import { loadOwnManifest } from './layers/ownManifest.js';
import { devChannelFile, loadOverlays, renderDevChannel } from './layers/overlay.js';
import { overlayVarContext, pinCommitDate } from './syncEngine.js';
import { runGit, runGitBytes } from './gitx.js';
import { workspaceIdSchema, workspaceRecordSchema } from './workspaceRegistry.js';
import { ckError } from './messages.js';
const pathSchema = z.string().refine((value) => repoRelativePathProblem(value) === null && value !== '.git' && !value.startsWith('.git/'));
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const savedSource = z.strictObject({ source: pathSchema, sha256: digest });
const material = z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('source'), path: pathSchema, source: pathSchema, sha256: digest }),
    z.strictObject({
        kind: z.literal('dev-channel'),
        path: pathSchema,
        sha256: digest,
        text: z.string(),
        sources: z.array(savedSource).min(1)
    })
]);
export const workspaceMaterialsSchema = z
    .strictObject({
    codkitWorkspaceMaterials: z.literal(1),
    id: workspaceIdSchema,
    finished: workspaceRecordSchema.shape.finished.unwrap(),
    files: z.array(material)
})
    .superRefine((value, ctx) => {
    const seen = new Set();
    for (const file of value.files) {
        if (seen.has(file.path.toLowerCase()))
            ctx.addIssue({ code: 'custom', message: 'materialized paths must not repeat or case-alias' });
        seen.add(file.path.toLowerCase());
    }
});
export function captureWorkspaceMaterials(record, config, type, commit) {
    const pairs = [];
    for (const owned of ownedRootsOf(type, config.typeConfig, { treeDir: record.fork.path, pinSha: config.pin.sha })) {
        for (const file of listOwnFiles(ownSourceRoot(record.patchset.path, owned.deltaDir), {
            refuseSymlinks: true,
            keep: ownCodeFilter(owned)
        }))
            if (isDeliveredOwnFile(file))
                pairs.push({ path: `${owned.path}/${file}`, source: `${owned.deltaDir}/${file}` });
    }
    const materializer = materializerOf(type);
    if (materializer !== null)
        for (const file of ownExtensionFiles(materializer, record.patchset.path, loadOwnManifest(record.patchset.path).extensions))
            pairs.push({ path: file.target, source: relative(record.patchset.path, file.source).replaceAll('\\', '/') });
    const files = [];
    for (const pair of pairs) {
        pathSchema.parse(pair.path);
        pathSchema.parse(pair.source);
        const target = hashContainedFile(record.fork.path, pair.path, { what: 'materialized workspace copy' });
        if (target.state === 'absent')
            continue;
        const source = sourceHash(record.patchset.commonDirectory, commit, pair.source);
        if (source !== target.sha256)
            throw ckError('DIRTY-TREE', `materialized workspace file is not saved to its patchset: ${pair.path}`);
        files.push({ kind: 'source', ...pair, sha256: source });
    }
    const overlays = loadOverlays(record.patchset.path, type);
    const rendered = renderDevChannel(type, record.fork.path, overlays, overlayVarContext(config, pinCommitDate(record.fork.path, config.pin.sha), commit), config.pin.sha);
    const devPath = devChannelFile(type);
    const devPresent = devPath === null ? false : hashContainedFile(record.fork.path, devPath, { what: 'workspace dev-channel presence' }).state === 'ok';
    if (rendered.text !== null && devPresent) {
        const path = relative(record.fork.path, rendered.path).replaceAll('\\', '/');
        const actual = hashContainedFile(record.fork.path, path, { what: 'workspace dev-channel copy' });
        const sha256 = createHash('sha256').update(rendered.text).digest('hex');
        if (actual.state !== 'ok' || actual.sha256 !== sha256)
            throw ckError('DIRTY-TREE', 'workspace dev-channel bytes differ from the saved overlay recipe');
        const sources = [...new Set(['codkit.json', ...overlays.map((overlay) => overlay.artifactPath)])].map((source) => {
            const hash = sourceHash(record.patchset.commonDirectory, commit, source);
            const current = hashContainedFile(record.patchset.path, source, { what: 'workspace saved overlay recipe' });
            if (current.state !== 'ok' || current.sha256 !== hash)
                throw ckError('DIRTY-TREE', 'workspace overlay recipe is not saved to its sealed commit');
            return { source, sha256: hash };
        });
        files.push({ kind: 'dev-channel', path, sha256, text: rendered.text, sources });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}
export function writeWorkspaceMaterials(root, record, files) {
    const data = workspaceMaterialsSchema.parse({ codkitWorkspaceMaterials: 1, id: record.id, finished: record.finished, files });
    const bytes = encodeUtf8(`${JSON.stringify(data, null, 2)}\n`);
    const path = receiptPath(record);
    if (!writeContainedFileExclusive(root, path, { what: 'workspace saved-material receipt', bytes })) {
        const previous = readContainedFile(root, path, { what: 'workspace saved-material receipt' });
        if (previous.state !== 'ok' || !bytesEqual(previous.bytes, bytes))
            throw ckError('CONFIG', 'workspace material receipt is foreign');
    }
}
export function readWorkspaceMaterials(root, record) {
    const read = readContainedFile(root, receiptPath(record), { what: 'workspace saved-material receipt' });
    if (read.state === 'absent')
        return [];
    const text = decodeUtf8Strict(read.bytes);
    if (text === null)
        throw ckError('CONFIG', 'workspace material receipt is not UTF-8');
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw ckError('CONFIG', 'workspace material receipt is not valid JSON');
    }
    const parsed = workspaceMaterialsSchema.safeParse(raw);
    const finished = workspaceRecordSchema.shape.finished.unwrap().parse(record.finished);
    if (!parsed.success || parsed.data.id !== record.id || JSON.stringify(parsed.data.finished) !== JSON.stringify(finished))
        throw ckError('CONFIG', 'workspace material receipt differs from its finish proof');
    return parsed.data.files;
}
export function verifyWorkspaceMaterials(record, files) {
    if (record.finished === undefined)
        throw ckError('CONFIG', 'workspace finish proof is missing');
    for (const file of files) {
        const sources = file.kind === 'source' ? [{ source: file.source, sha256: file.sha256 }] : file.sources;
        for (const source of sources)
            if (sourceHash(record.patchset.commonDirectory, record.finished.patchsetCommit, source.source) !== source.sha256)
                throw ckError('CONFIG', 'workspace material receipt source differs from its saved Git blob');
        if (file.kind === 'dev-channel' && createHash('sha256').update(file.text).digest('hex') !== file.sha256)
            throw ckError('CONFIG', 'workspace generated material receipt digest differs from its retained bytes');
        const actual = hashContainedFile(record.fork.path, file.path, { what: 'workspace material compare barrier' });
        if (actual.state !== 'ok' || actual.sha256 !== file.sha256)
            throw ckError('DIRTY-TREE', `workspace material changed after finish: ${file.path}`);
    }
    return files.map((file) => file.path);
}
function receiptPath(record) {
    if (record.finished === undefined)
        throw ckError('CONFIG', 'workspace finish proof is missing');
    const key = createHash('sha256')
        .update(JSON.stringify({ id: record.id, finished: workspaceRecordSchema.shape.finished.unwrap().parse(record.finished) }))
        .digest('hex');
    return `workspace-materials/${record.id}/${key}.json`;
}
function sourceHash(common, commit, path) {
    const mode = git(common, ['--literal-pathspecs', 'ls-tree', '--format=%(objectmode)', commit, '--', path]);
    if (mode !== '100644' && mode !== '100755')
        throw ckError('CONFIG', `workspace material source is not a saved regular file: ${path}`);
    const blob = runGitBytes({ cwd: common, args: ['--git-dir', common, 'show', `${commit}:${path}`] });
    if (blob.status !== 0)
        throw ckError('CONFIG', 'workspace material source Git blob is unavailable');
    return createHash('sha256').update(blob.stdout).digest('hex');
}
function git(common, args) {
    const result = runGit({ cwd: common, args: ['--git-dir', common, ...args] });
    if (result.status !== 0)
        throw ckError('CONFIG', result.stderr.trim());
    return result.stdout.trim();
}
