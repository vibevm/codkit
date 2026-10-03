/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import { pinKey } from './pinIdentity.js';
// Cryptographically bound finalization planning and retry-safe application.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { bytesEqual, decodeUtf8Strict, encodeUtf8 } from './bytes.js';
import { assertCycleJournalComplete, cycleJournalEntrySchema, parseCycleJournal, serializeCycleJournalEntry } from './cycleJournal.js';
import { canonicalFinalizationInventory, CYCLE_METRICS_PATH, cycleDurationSeconds, updateCycleMetricsDocument } from './cycleFinalizeCsv.js';
import { CYCLE_ARTIFACT_OUTCOMES, CYCLE_BLOCKER_OUTCOMES, CYCLE_STATE_PATH, cycleStateSchema, nodeCycleStateFileSystem, serializeCycleState } from './cycleState.js';
import { runGit } from './gitx.js';
import { ckError, isCkError } from './messages.js';
import { resolveContainedPath, safeBasenameProblem } from './pathSafety.js';
export { CYCLE_METRICS_HEADER, CYCLE_METRICS_PATH } from './cycleFinalizeCsv.js';
export const CYCLE_FINALIZATION_CHECKLIST = [
    'recheck forbiddenServiceIds on the target pin',
    'recheck build-daemon pass-boundary markers on the target pin',
    'commit the human log, metrics row, and cycle/state.json deletion',
    'merge the cycle branch without squashing'
];
export function renderCycleHumanLog(state, entries) {
    const validState = validatedState(state);
    const validEntries = validatedEntries(entries);
    const latest = new Map();
    validEntries.forEach((entry, index) => latest.set(entry.artifact, index));
    const lines = [
        `# codkit cycle ${pinKey(validState.targetPin)}`,
        '',
        `- Source: \`${pinKey(validState.sourcePin)}@${validState.sourcePin.sha}\``,
        `- Target: \`${pinKey(validState.targetPin)}@${validState.targetPin.sha}\``,
        `- Started: \`${validState.startedAt}\``,
        `- Completed: \`${validState.updatedAt}\``,
        `- Duration: \`${cycleDurationSeconds(validState)}\` seconds`,
        '',
        '## Outcomes',
        '',
        '| Outcome | Count |',
        '| --- | ---: |',
        ...CYCLE_ARTIFACT_OUTCOMES.map((outcome) => `| ${outcome} | ${validState.artifacts[outcome].length} |`),
        '',
        `Resolved blockers: ${validState.resolved.length}; renames: ${validState.renames.length}.`,
        '',
        '## Journal',
        '',
        '| # | Timestamp | Artifact | Outcome | Resolution | Cause | By | Verification | Latest |',
        '| ---: | --- | --- | --- | --- | --- | --- | --- | --- |'
    ];
    validEntries.forEach((entry, index) => {
        const verification = entry.verified.map((item) => `${JSON.stringify(item.command)} => ${item.exitCode}`).join('; ');
        lines.push(`| ${index + 1} | ${cell(entry.ts)} | ${cell(entry.artifact)} | ${entry.outcome} | ${cell(entry.resolution)} | ` +
            `${entry.cause.sha} (${entry.cause.approx ? 'approx' : 'exact'}) | ${cell(entry.by)} | ${cell(verification)} | ` +
            `${latest.get(entry.artifact) === index ? 'yes' : 'no'} |`);
    });
    return `${lines.join('\n')}\n`;
}
export function planCycleFinalization(options) {
    const fs = options.fileSystem ?? nodeCycleStateFileSystem;
    const tag = pinKey(validatedState(options.state).targetPin);
    const journalPath = journalRelativePath(tag);
    const journal = readRequiredJournal(options.patchesDir, journalPath, fs);
    const authority = canonicalAuthority(options.state, parseCycleJournal(journal, journalPath), options.inventory);
    return deriveBoundPlan(authority, {
        human: readText(options.patchesDir, humanLogRelativePath(tag), fs),
        journal,
        metrics: readText(options.patchesDir, CYCLE_METRICS_PATH, fs),
        state: readText(options.patchesDir, CYCLE_STATE_PATH, fs)
    });
}
/** Git-only preflight; caller holds the cycle lock. It never stages or mutates. */
export function assertCycleFinalizationGitPreflight(patchesDir, targetTag, git = defaultGit) {
    const paths = finalizationPaths(targetTag);
    const top = git(patchesDir, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || resolve(top.stdout.trim()) !== resolve(patchesDir))
        throw finalizationError('finalization root is not the Git worktree root');
    for (const path of paths) {
        const exists = regularPathExists(patchesDir, path);
        if (path === journalRelativePath(targetTag) && !exists)
            throw finalizationError(`cycle journal does not exist: ${path}`, path);
        const tracked = git(patchesDir, ['ls-files', '--error-unmatch', '--', path]);
        if (tracked.status !== 0 && tracked.status !== 1)
            throw gitError(`inspect tracked path ${path}`, tracked);
        const ignored = git(patchesDir, ['check-ignore', '--quiet', '--no-index', '--', path]);
        if (ignored.status !== 0 && ignored.status !== 1)
            throw gitError(`inspect ignore rules for ${path}`, ignored);
        if (tracked.status !== 0 && ignored.status === 0)
            throw finalizationError(`finalization path is ignored and untracked: ${path}`, path);
        if (tracked.status !== 0 && exists) {
            const stageable = git(patchesDir, ['add', '--dry-run', '--', path]);
            if (stageable.status !== 0)
                throw gitError(`prove ${path} is stageable`, stageable);
        }
    }
}
export function applyCycleFinalizationPlan(patchesDir, plan, options = {}) {
    const expected = deriveBoundPlan(plan.authority, plan.basis);
    if (JSON.stringify(plan) !== JSON.stringify(expected))
        throw finalizationError('finalization plan binding, digest, or canonical outputs do not match');
    assertCycleFinalizationGitPreflight(patchesDir, expected.targetTag, options.git ?? defaultGit);
    const fs = options.fileSystem ?? nodeCycleStateFileSystem;
    const journalPath = journalRelativePath(expected.targetTag);
    const currentJournal = readBytes(patchesDir, journalPath, fs);
    if (currentJournal === null || !bytesEqual(currentJournal, encodeUtf8(expected.basis.journal)))
        throw finalizationError(`concurrent change at ${journalPath}`, journalPath);
    const currentWrites = new Map();
    for (const write of expected.writes) {
        const bytes = readBytes(patchesDir, write.path, fs);
        const before = write.previous === null ? null : encodeUtf8(write.previous);
        const after = encodeUtf8(write.contents);
        if (!sameNullable(bytes, before) && !sameNullable(bytes, after))
            throw finalizationError(`concurrent change at ${write.path}`, write.path);
        currentWrites.set(write.path, bytes);
    }
    const deletion = expected.deletions[0];
    if (deletion === undefined)
        throw finalizationError('finalization plan has no state deletion');
    const currentState = readBytes(patchesDir, deletion.path, fs);
    if (currentState === null) {
        if (expected.writes.some((write) => !sameNullable(currentWrites.get(write.path) ?? null, encodeUtf8(write.contents))))
            throw finalizationError('cycle state is missing before every required output is exact', CYCLE_STATE_PATH);
        return;
    }
    if (!bytesEqual(currentState, encodeUtf8(deletion.expected)))
        throw finalizationError(`concurrent change at ${deletion.path}`, deletion.path);
    for (const write of expected.writes) {
        if (!sameNullable(currentWrites.get(write.path) ?? null, encodeUtf8(write.contents))) {
            atomicWrite(patchesDir, write.path, write.contents, fs, options.temporarySuffix);
            options.checkpoint?.('write', write.path);
        }
    }
    fs.remove(containedPath(patchesDir, deletion.path));
    options.checkpoint?.('delete', deletion.path);
}
function canonicalAuthority(state, entries, inventory) {
    assertCycleJournalComplete(state, entries);
    const validState = validatedState(state);
    const validEntries = validatedEntries(entries);
    assertTerminalState(validState);
    return { state: validState, entries: validEntries, inventory: canonicalFinalizationInventory(inventory) };
}
function deriveBoundPlan(authorityInput, basisInput) {
    const authority = canonicalAuthority(authorityInput.state, authorityInput.entries, authorityInput.inventory);
    const tag = pinKey(authority.state.targetPin);
    const humanPath = humanLogRelativePath(tag);
    const human = renderCycleHumanLog(authority.state, authority.entries);
    const stateDocument = serializeCycleState(authority.state);
    const basis = canonicalBasis(basisInput, humanPath, human, stateDocument, authority.entries, tag);
    const metrics = updateCycleMetricsDocument(basis.metrics, authority.state, authority.entries, authority.inventory);
    if (basis.state === null && (basis.human !== human || basis.metrics !== metrics))
        throw finalizationError('cycle state is missing before every required output is exact', CYCLE_STATE_PATH);
    const deletion = { path: CYCLE_STATE_PATH, expected: stateDocument };
    const bound = {
        codkitCycleFinalization: 1,
        targetTag: tag,
        authority,
        basis,
        writes: [
            { path: humanPath, previous: basis.human, contents: human },
            { path: CYCLE_METRICS_PATH, previous: basis.metrics, contents: metrics }
        ],
        deletions: [deletion],
        checklist: CYCLE_FINALIZATION_CHECKLIST
    };
    return { ...bound, digest: digest(bound) };
}
function canonicalBasis(input, humanPath, human, state, entries, tag) {
    const journalPath = journalRelativePath(tag);
    for (const [path, value] of [
        [humanPath, input.human],
        [journalPath, input.journal],
        [CYCLE_METRICS_PATH, input.metrics],
        [CYCLE_STATE_PATH, input.state]
    ])
        if (value !== null)
            strictText(value, path);
    if (input.human !== null && input.human !== human)
        throw finalizationError(`existing ${humanPath} conflicts with the deterministic terminal report`, humanPath);
    if (input.state !== null && input.state !== state)
        throw finalizationError('cycle state bytes differ from the authoritative finalization state', CYCLE_STATE_PATH);
    const journalEntries = parseCycleJournal(input.journal, journalPath);
    const canonicalJournal = journalEntries.map(serializeCycleJournalEntry).join('');
    if (input.journal !== canonicalJournal || JSON.stringify(journalEntries) !== JSON.stringify(entries))
        throw finalizationError('cycle journal bytes do not match the authoritative entries', journalPath);
    return { human: input.human, journal: input.journal, metrics: input.metrics, state: input.state };
}
function assertTerminalState(state) {
    if (state.phase !== 'done')
        throw finalizationError(`cycle phase is ${state.phase}, not done`, CYCLE_STATE_PATH);
    if (state.transaction !== null)
        throw finalizationError('cycle still has an active transaction', CYCLE_STATE_PATH);
    const resolved = new Set(state.resolved);
    const missing = CYCLE_BLOCKER_OUTCOMES.flatMap((outcome) => state.artifacts[outcome]).filter((artifact) => !resolved.has(artifact));
    if (missing.length > 0)
        throw finalizationError(`unresolved blockers: ${missing.join(', ')}`, CYCLE_STATE_PATH);
}
function validatedState(state) {
    const parsed = cycleStateSchema.safeParse(state);
    if (!parsed.success)
        throw finalizationError(`cycle state is invalid: ${parsed.error.issues[0]?.message ?? 'schema failure'}`, CYCLE_STATE_PATH);
    return JSON.parse(serializeCycleState(parsed.data));
}
function validatedEntries(entries) {
    return entries.map((entry, index) => {
        const parsed = cycleJournalEntrySchema.safeParse(entry);
        if (!parsed.success)
            throw finalizationError(`journal entry ${index + 1} is invalid: ${parsed.error.issues[0]?.message ?? 'schema failure'}`);
        return parsed.data;
    });
}
function readText(patchesDir, relative, fs) {
    const bytes = readBytes(patchesDir, relative, fs);
    if (bytes === null)
        return null;
    const text = decodeUtf8Strict(bytes);
    if (text === null)
        throw finalizationError(`${relative} is not UTF-8`, relative);
    strictText(text, relative);
    return text;
}
function readRequiredJournal(patchesDir, relative, fs) {
    const bytes = readBytes(patchesDir, relative, fs);
    if (bytes === null)
        throw journalError(`required cycle journal does not exist: ${relative}`, relative);
    const text = decodeUtf8Strict(bytes);
    if (text === null)
        throw journalError('cycle journal is not valid UTF-8', relative);
    return text;
}
function strictText(text, path) {
    if (text.startsWith('\ufeff') || text.includes('\r') || !text.endsWith('\n') || text.endsWith('\n\n'))
        throw finalizationError(`${path} is not strict UTF-8/LF text`, path);
}
function readBytes(patchesDir, relative, fs) {
    try {
        return fs.readBytes(containedPath(patchesDir, relative));
    }
    catch (error) {
        throw finalizationError(`cannot read ${relative}: ${messageOf(error)}`, relative);
    }
}
function atomicWrite(patchesDir, relative, contents, fs, suffixFactory) {
    let path = containedPath(patchesDir, relative);
    fs.makeDirectory(dirname(path));
    path = containedPath(patchesDir, relative);
    const suffix = (suffixFactory ?? (() => randomUUID()))(relative);
    if (suffix === '' || suffix.includes('/') || suffix.includes('\\'))
        throw finalizationError('temporary suffix is not one file-name segment');
    const temporary = `${path}.${suffix}.tmp`;
    let renamed = false;
    try {
        fs.writeBytes(temporary, encodeUtf8(contents));
        fs.rename(temporary, path);
        renamed = true;
    }
    catch (error) {
        if (isCkError(error))
            throw error;
        throw finalizationError(`cannot atomically write ${relative}: ${messageOf(error)}`, relative);
    }
    finally {
        if (!renamed)
            try {
                fs.remove(temporary);
            }
            catch {
                // Preserve the primary failure; the uniquely named complete temp is inert.
            }
    }
}
function containedPath(patchesDir, relative) {
    const resolved = resolveContainedPath(patchesDir, relative, { allowMissing: true });
    if (!resolved.ok)
        throw finalizationError(`unsafe ${relative}: ${resolved.reason}`, relative);
    return resolved.absolute;
}
function humanLogRelativePath(tag) {
    if (safeBasenameProblem(tag) !== null)
        throw finalizationError(`unsafe target tag ${JSON.stringify(tag)}`);
    return `cycle/log/${tag}.md`;
}
function journalRelativePath(tag) {
    if (safeBasenameProblem(tag) !== null)
        throw finalizationError(`unsafe target tag ${JSON.stringify(tag)}`);
    return `cycle/log/${tag}.jsonl`;
}
function regularPathExists(patchesDir, relative) {
    const path = containedPath(patchesDir, relative);
    try {
        if (!lstatSync(path).isFile())
            throw finalizationError(`finalization path is not a regular file: ${relative}`, relative);
        return true;
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return false;
        if (isCkError(error))
            throw error;
        throw finalizationError(`cannot inspect finalization path ${relative}: ${messageOf(error)}`, relative);
    }
}
function finalizationPaths(tag) {
    return [humanLogRelativePath(tag), journalRelativePath(tag), CYCLE_METRICS_PATH, CYCLE_STATE_PATH];
}
function digest(value) {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}
function cell(value) {
    return JSON.stringify(value).replaceAll('|', '\\|');
}
function sameNullable(left, right) {
    return left === null || right === null ? left === right : bytesEqual(left, right);
}
function defaultGit(cwd, args) {
    return runGit({ cwd, args });
}
function gitError(action, result) {
    return finalizationError(`cannot ${action}: ${result.stderr.trim() || result.stdout.trim() || `git exit ${result.status}`}`);
}
function finalizationError(message, file) {
    return ckError('CONFIG', message, 'restore canonical cycle finalization inputs and retry', file);
}
function journalError(message, file) {
    return ckError('LOG-INCOMPLETE', message, 'restore the canonical non-empty cycle JSONL journal and retry', file);
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
