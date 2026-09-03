#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const blockerOutcomes = new Set(['conflict', 'target-deleted', 'rule-broken', 'contract-failed']);
const args = values(process.argv.slice(2));
const entryArg = args.get('--entry');
if (entryArg === undefined || entryArg === '') fail('usage: append-journal.mjs --entry <repository-relative.json>');
if (entryArg !== '.codkit/agent-journal-entry.json') fail('entry file must be .codkit/agent-journal-entry.json');

const whereArgs = [resolve(toolRoot, 'codkit/bin/codkit.mjs'), 'where', '--json'];
const explicitPatches = args.get('--patches-dir');
if (explicitPatches !== undefined) whereArgs.push('--patches-dir', explicitPatches);
const where = spawnSync(process.execPath, whereArgs, {
	cwd: process.cwd(),
	env: process.env,
	encoding: 'utf8'
});
if (where.status !== 0) fail(`codkit where failed: ${where.stderr.trim()}`);
let root;
let tree;
try {
	const envelope = JSON.parse(where.stdout);
	root = envelope?.roots?.patches?.path;
	tree = envelope?.roots?.fork?.path;
} catch {
	fail('codkit where returned malformed JSON');
}
if (typeof root !== 'string' || root === '') fail('codkit where returned no patch-set path');
if (typeof tree !== 'string' || tree === '') fail('codkit where returned no fork path');
const entryPath = resolve(root, entryArg);
const inside = relative(root, entryPath);
if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) fail('entry file must be below the patchset root');

const rawEntry = readRuntimeJson('agent-journal-entry.json');
const task = readRuntimeJson('agent-task.json');
if (!validTask(task)) fail('agent task is malformed or is not one resolve assignment');
const result = readRuntimeJson('agent-task-result.json');
const resultProblem = validateResult(result, task);
if (resultProblem !== null) fail(resultProblem);

const [{ cycleJournalEntrySchema, appendCycleJournalEntry }, { readCycleState }, { treeId }, { withLock }] = await Promise.all([
	load('codkit/src/lib/cycleJournal.ts'),
	load('codkit/src/lib/cycleState.ts'),
	load('codkit/src/lib/fingerprint.ts'),
	load('codkit/src/lib/lock.ts')
]);
const parsed = cycleJournalEntrySchema.safeParse(rawEntry);
if (!parsed.success) fail(`journal entry failed validation: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}`);

try {
	withLock(root, treeId(tree), 'ck-resolve journal', () => {
		const state = readCycleState(root);
		if (state === null || state.phase !== 'resolve') throw new Error('cycle must be in resolve before an agent appends a journal entry');
		if (task.targetTag !== state.targetPin.tag || task.actor !== parsed.data.by) throw new Error('agent task identity differs from cycle or journal actor');
		const taskBlocker = task.blockers.find((item) => item.artifact === parsed.data.artifact && item.outcome === parsed.data.outcome);
		if (taskBlocker === undefined) {
			throw new Error('journal artifact/outcome is outside the assigned task perimeter');
		}
		const resultBlocker = result.blockers.find((item) => item.artifact === parsed.data.artifact && item.outcome === parsed.data.outcome);
		if (resultBlocker?.resolution !== parsed.data.resolution || JSON.stringify(result.verifications) !== JSON.stringify(parsed.data.verified)) {
			throw new Error('journal resolution or verification differs from the accepted task result');
		}
		if (!state.artifacts[parsed.data.outcome].includes(parsed.data.artifact)) {
			throw new Error('journal artifact/outcome is not one current cycle blocker');
		}
		appendCycleJournalEntry(root, state.targetPin.tag, parsed.data);
	});
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

process.stdout.write(`${JSON.stringify({ ok: true, artifact: parsed.data.artifact, by: parsed.data.by })}\n`);

async function load(path) {
	return import(pathToFileURL(resolve(toolRoot, path)).href);
}

function values(argv) {
	const found = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if ((name !== '--entry' && name !== '--patches-dir') || value === undefined || found.has(name)) {
			fail('usage: append-journal.mjs --entry <repository-relative.json> [--patches-dir <path>]');
		}
		found.set(name, value);
	}
	return found;
}

function validTask(value) {
	if (!(
		value !== null &&
		typeof value === 'object' &&
		value.codkitAgentTask === 1 &&
		value.kind === 'resolve' &&
		typeof value.targetTag === 'string' &&
		value.targetTag !== '' &&
		typeof value.actor === 'string' &&
		value.actor.startsWith('agent:') &&
		Array.isArray(value.blockers) &&
		value.blockers.length > 0 &&
		value.blockers.every(
			(item) =>
				item !== null &&
				typeof item === 'object' &&
				safeTaskPath(item.artifact) &&
				blockerOutcomes.has(item.outcome) &&
				Array.isArray(item.paths) &&
				item.paths.length > 0 &&
				new Set(item.paths).size === item.paths.length &&
				item.paths.every(safeTaskPath)
		)
	)) return false;
	const keys = value.blockers.map((item) => `${item.artifact}\0${item.outcome}`);
	return new Set(keys).size === keys.length;
}

function validateResult(value, task) {
	if (
		value === null ||
		typeof value !== 'object' ||
		value.codkitAgentTaskResult !== 1 ||
		value.targetTag !== task.targetTag ||
		value.actor !== task.actor ||
		value.status !== 'resolved' ||
		value.reason !== null ||
		!Array.isArray(value.blockers) ||
		!Array.isArray(value.changedPaths) ||
		value.changedPaths.length === 0 ||
		!Array.isArray(value.verifications) ||
		value.verifications.length === 0
	) {
		return 'agent task result is malformed, stopped, or differs from the assigned task';
	}
	const allowedPaths = new Set(task.blockers.flatMap((item) => item.paths));
	if (
		new Set(value.changedPaths).size !== value.changedPaths.length ||
		value.changedPaths.some((path) => !safeTaskPath(path) || !allowedPaths.has(path)) ||
		value.verifications.some(
			(item) => item === null || typeof item !== 'object' || typeof item.command !== 'string' || item.command === '' || item.exitCode !== 0
		)
	) {
		return 'agent task result paths or verifications are outside the green task perimeter';
	}
	if (value.blockers.length !== task.blockers.length) return 'agent task result does not cover every assigned blocker exactly once';
	const resultKeys = new Set();
	for (const blocker of value.blockers) {
		if (
			blocker === null ||
			typeof blocker !== 'object' ||
			blocker.status !== 'resolved' ||
			typeof blocker.resolution !== 'string' ||
			blocker.resolution === '' ||
			('reason' in blocker && blocker.reason !== null)
		) {
			return 'agent task result contains an unresolved or malformed blocker';
		}
		const key = `${blocker.artifact}\0${blocker.outcome}`;
		if (resultKeys.has(key)) return 'agent task result contains duplicate blockers';
		resultKeys.add(key);
	}
	for (const blocker of task.blockers) {
		if (!resultKeys.has(`${blocker.artifact}\0${blocker.outcome}`)) return 'agent task result blocker identities differ from the task';
	}
	return null;
}

function readRuntimeJson(name) {
	const runtime = resolve(root, '.codkit');
	const path = resolve(runtime, name);
	try {
		const runtimeStat = lstatSync(runtime);
		const stat = lstatSync(path);
		if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) {
			fail(`.codkit/${name} is not a safe bounded regular runtime file`);
		}
		return JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		fail(`cannot read .codkit/${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function safeTaskPath(value) {
	return (
		typeof value === 'string' &&
		value !== '' &&
		!value.includes('\\') &&
		!value.includes('\0') &&
		!isAbsolute(value) &&
		value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
	);
}

function fail(message) {
	process.stderr.write(`ck-resolve journal: ${message}\n`);
	process.exit(1);
}
