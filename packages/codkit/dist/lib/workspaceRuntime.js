/** @scope spec://codkit/modules/codkit/PROP-020#WORKSPACE-CLOSED-RUNTIME */
// Only recognized, closed runtime documents are archived as removable exact paths.
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { z } from 'zod';
import { workspaceIdSchema } from './workspaceRegistry.js';
import { workspaceConfig } from './workspaceConfig.js';
import { readCycleState } from './cycleState.js';
import { readCycleTerminalRecord, CYCLE_TERMINAL_RECORD_PATH } from './cycleEngineTerminal.js';
import { assertCommittedTerminal } from './cycleEngineTransactions.js';
import { readCycleControlRecord, CYCLE_CONTROL_RECORD_PATH } from './cycleControlRecord.js';
import { readCycleTransitionRecord, CYCLE_TRANSITION_RECORD_PATH } from './cycleEngineTransition.js';
import { readCycleApplyRecord, CYCLE_APPLY_RECORD_PATH } from './cycleEngineRecord.js';
import { depsRecordSchema, DEPS_HASH_PATH } from './ciEngine.js';
import { parseComponentRelease, COMPONENT_RELEASE_DIRECTORY } from './componentRelease.js';
import { treeId } from './fingerprint.js';
import { readContainedFile, writeContainedFileExclusive, hashContainedFile } from './containedFile.js';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { resolveContainedPath, repoRelativePathProblem } from './pathSafety.js';
import { runGit } from './gitx.js';
import { ckError } from './messages.js';
const sha = z.string().regex(/^[0-9a-f]{64}$/);
export const workspaceClosedRuntimeSchema = z.strictObject({
    codkitWorkspaceClosedRuntime: z.literal(1),
    id: workspaceIdSchema,
    patchsetCommit: z.string().regex(/^[0-9a-f]{40}$/),
    forkCommit: z.string().regex(/^[0-9a-f]{40}$/),
    files: z.array(z.strictObject({
        path: z
            .string()
            .refine((path) => repoRelativePathProblem(path) === null &&
            ([
                CYCLE_TERMINAL_RECORD_PATH,
                CYCLE_CONTROL_RECORD_PATH,
                CYCLE_TRANSITION_RECORD_PATH,
                CYCLE_APPLY_RECORD_PATH,
                DEPS_HASH_PATH
            ].includes(path) ||
                /^\.codkit\/releases\/[0-9a-f]{64}\.json$/.test(path))),
        sha256: sha,
        bytes: z.number().int().nonnegative()
    }))
});
export function captureWorkspaceRuntime(authority, record, config) {
    const root = record.patchset.path;
    if (readCycleState(root) !== null)
        throw ckError('CONFIG', 'complete or restart the active cycle before workspace finish');
    const paths = [];
    const terminal = readCycleTerminalRecord(root);
    if (terminal !== null) {
        assertCommittedTerminal(root, workspaceConfig(config, record, authority), terminal);
        paths.push(CYCLE_TERMINAL_RECORD_PATH);
    }
    const control = readCycleControlRecord(root);
    if (control !== null) {
        if (control.status !== 'done')
            throw ckError('CONFIG', 'workspace cycle restart is still running');
        paths.push(CYCLE_CONTROL_RECORD_PATH);
    }
    const transition = readCycleTransitionRecord(root);
    if (transition !== null) {
        if (transition.checkpoint !== 'committed')
            throw ckError('CONFIG', 'workspace cycle transition is not closed');
        paths.push(CYCLE_TRANSITION_RECORD_PATH);
    }
    const apply = readCycleApplyRecord(root);
    if (apply !== null) {
        if (apply.checkpoint !== 'committed')
            throw ckError('CONFIG', 'workspace cycle apply is not closed');
        paths.push(CYCLE_APPLY_RECORD_PATH);
    }
    const deps = readContainedFile(root, DEPS_HASH_PATH, { what: 'workspace dependency runtime' });
    if (deps.state === 'ok') {
        const parsed = depsRecordSchema.strict().safeParse(json(deps.bytes));
        if (!parsed.success || parsed.data.treeId !== treeId(record.fork.path) || parsed.data.treePath !== record.fork.path)
            throw ckError('CONFIG', 'workspace dependency runtime is malformed or foreign');
        paths.push(DEPS_HASH_PATH);
    }
    for (const name of names(root, COMPONENT_RELEASE_DIRECTORY)) {
        if (!/^[0-9a-f]{64}\.json$/.test(name))
            throw ckError('CONFIG', 'workspace release filename is invalid');
        const path = `${COMPONENT_RELEASE_DIRECTORY}/${name}`;
        const read = readContainedFile(root, path, { what: 'workspace release runtime' });
        const parsed = read.state === 'ok' ? parseComponentRelease(read.bytes) : null;
        if (parsed === null || !parsed.ok || name !== `${parsed.value.descriptorSha256}.json`)
            throw ckError('CONFIG', 'workspace release runtime is invalid');
        paths.push(path);
    }
    const files = paths.sort().map((path) => {
        const read = readContainedFile(root, path, { what: 'closed workspace runtime' });
        if (read.state !== 'ok')
            throw ckError('CONFIG', 'closed workspace runtime disappeared');
        const sha256 = hash(read.bytes);
        immutable(authority, blobPath(sha256), read.bytes);
        return { path, sha256, bytes: read.bytes.length };
    });
    const data = workspaceClosedRuntimeSchema.parse({
        codkitWorkspaceClosedRuntime: 1,
        id: record.id,
        patchsetCommit: head(root),
        forkCommit: head(record.fork.path),
        files
    });
    const bytes = encodeUtf8(`${JSON.stringify(data, null, 2)}\n`);
    immutable(authority, `workspace-runtime/${record.id}/${hash(bytes)}.json`, bytes);
    return files.map((file) => file.path);
}
export function workspaceRuntimePaths(authority, record) {
    const root = record.patchset.path;
    const patchsetCommit = record.finished?.patchsetCommit ?? head(root), forkCommit = record.finished?.forkCommit ?? head(record.fork.path);
    const allowed = new Set();
    for (const name of names(authority, `workspace-runtime/${record.id}`)) {
        if (!/^[0-9a-f]{64}\.json$/.test(name))
            throw ckError('CONFIG', 'workspace runtime receipt filename is invalid');
        const read = readContainedFile(authority, `workspace-runtime/${record.id}/${name}`, { what: 'workspace runtime receipt' });
        if (read.state !== 'ok' || name !== `${hash(read.bytes)}.json`)
            throw ckError('CONFIG', 'workspace runtime receipt digest differs');
        const parsed = workspaceClosedRuntimeSchema.safeParse(json(read.bytes));
        if (!parsed.success || parsed.data.id !== record.id)
            throw ckError('CONFIG', 'workspace runtime receipt is invalid or foreign');
        if (parsed.data.patchsetCommit !== patchsetCommit || parsed.data.forkCommit !== forkCommit)
            continue;
        for (const file of parsed.data.files) {
            const saved = hashContainedFile(authority, blobPath(file.sha256), { what: 'retained runtime document' });
            const current = hashContainedFile(root, file.path, { what: 'workspace runtime compare barrier' });
            if (saved.state !== 'ok' ||
                saved.sha256 !== file.sha256 ||
                saved.bytes !== file.bytes ||
                current.state !== 'ok' ||
                current.sha256 !== file.sha256 ||
                current.bytes !== file.bytes)
                throw ckError('DIRTY-TREE', 'workspace runtime or its retained archive changed');
            allowed.add(file.path);
        }
    }
    return [...allowed];
}
function names(root, path) {
    const dir = resolveContainedPath(root, path, { allowMissing: true });
    if (!dir.ok)
        throw ckError('CONFIG', 'workspace runtime directory custody moved');
    try {
        return readdirSync(dir.absolute);
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return [];
        throw error;
    }
}
function json(bytes) {
    try {
        const text = decodeUtf8Strict(bytes);
        if (text === null)
            throw new Error();
        return JSON.parse(text);
    }
    catch {
        throw ckError('CONFIG', 'workspace runtime is not UTF-8 JSON');
    }
}
function head(root) {
    const result = runGit({ cwd: root, args: ['rev-parse', 'HEAD'] });
    if (result.status !== 0)
        throw ckError('CONFIG', 'workspace HEAD is unavailable');
    return result.stdout.trim();
}
function blobPath(sha256) {
    return `workspace-runtime-bytes/${sha256}.bin`;
}
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function immutable(root, path, bytes) {
    if (writeContainedFileExclusive(root, path, { what: 'workspace runtime evidence', bytes }))
        return;
    const old = readContainedFile(root, path, { what: 'workspace runtime evidence' });
    if (old.state !== 'ok' || !bytesEqual(old.bytes, bytes))
        throw ckError('CONFIG', 'workspace runtime archive is foreign');
}
