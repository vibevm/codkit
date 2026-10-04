/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-INPUT-DELIVERY */
// External delivery receipts prevent cache hints from granting cleanup ownership.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import { storedInputSchema } from './inputsStore.js';
import { workspaceIdSchema } from './workspaceRegistry.js';
import { readContainedFile, writeContainedFileExclusive } from './containedFile.js';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { repoRelativePathProblem } from './pathSafety.js';
import { hasGitSegment } from './inputsDeclaration.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
export const workspaceInputDeliverySchema = z
    .strictObject({
    codkitWorkspaceInputDelivery: z.literal(1),
    id: workspaceIdSchema,
    treePath: z.string().min(1),
    input: storedInputSchema
})
    .superRefine((value, ctx) => {
    if (repoRelativePathProblem(value.input.to) !== null || hasGitSegment(value.input.to))
        ctx.addIssue({ code: 'custom', message: 'unsafe input destination' });
    const paths = new Set();
    for (const path of Object.keys(value.input.files)) {
        if (repoRelativePathProblem(path) !== null || hasGitSegment(path) || paths.has(path.toLowerCase()))
            ctx.addIssue({ code: 'custom', message: 'unsafe or duplicate input output path' });
        paths.add(path.toLowerCase());
    }
});
export function workspaceInputMatches(treeDir, input, context) {
    const expected = receipt(treeDir, input, context);
    const read = readContainedFile(context.registryRoot, receiptPath(expected), { what: 'workspace input delivery receipt' });
    if (read.state === 'absent')
        return false;
    const text = decodeUtf8Strict(read.bytes);
    if (text === null)
        throw ckError('CONFIG', 'workspace input receipt is not UTF-8');
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw ckError('CONFIG', 'workspace input receipt is not JSON');
    }
    const parsed = workspaceInputDeliverySchema.safeParse(raw);
    if (!parsed.success)
        throw ckError('CONFIG', 'workspace input delivery receipt is invalid or unsupported');
    return canonical(parsed.data) === canonical(expected);
}
export function recordWorkspaceInput(treeDir, input, context) {
    const data = receipt(treeDir, input, context);
    for (const blob of new Set(Object.values(data.input.files))) {
        if (git(treeDir, ['cat-file', '-t', blob]) !== 'blob')
            throw ckError('CONFIG', 'workspace input backing object is not a blob');
        const ref = inputBlobRef(context.record.id, blob);
        const previous = runGit({ cwd: treeDir, args: ['rev-parse', '--verify', ref] });
        if (previous.status === 0) {
            if (previous.stdout.trim() !== blob)
                throw ckError('CONFIG', 'workspace input backing ref is foreign');
        }
        else
            git(treeDir, ['update-ref', ref, blob, '0'.repeat(blob.length)]);
    }
    const bytes = encodeUtf8(`${canonical(data)}\n`);
    const path = receiptPath(data);
    if (!writeContainedFileExclusive(context.registryRoot, path, { what: 'workspace input delivery receipt', bytes })) {
        const previous = readContainedFile(context.registryRoot, path, { what: 'workspace input delivery receipt' });
        if (previous.state !== 'ok' || !bytesEqual(previous.bytes, bytes))
            throw ckError('CONFIG', 'workspace input delivery receipt is foreign');
    }
}
export function inputBlobRef(id, blob) {
    workspaceIdSchema.parse(id);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(blob))
        throw ckError('CONFIG', 'workspace input blob ID is invalid');
    return `refs/codkit/workspace/${id}/input-blobs/${blob}`;
}
function receipt(treeDir, input, context) {
    const files = Object.fromEntries(Object.entries(input.files).sort(([left], [right]) => left.localeCompare(right, 'en')));
    return workspaceInputDeliverySchema.parse({
        codkitWorkspaceInputDelivery: 1,
        id: context.record.id,
        treePath: realpathSync(treeDir),
        input: { ...input, files }
    });
}
function canonical(data) {
    return JSON.stringify({
        ...data,
        input: {
            ...data.input,
            files: Object.fromEntries(Object.entries(data.input.files).sort(([left], [right]) => left.localeCompare(right, 'en')))
        }
    }, null, 2);
}
function receiptPath(data) {
    const key = createHash('sha256').update(canonical(data)).digest('hex');
    return `workspace-inputs/${data.id}/${key}.json`;
}
function git(root, args) {
    const result = runGit({ cwd: root, args });
    if (result.status !== 0)
        throw ckError('CONFIG', result.stderr.trim());
    return result.stdout.trim();
}
