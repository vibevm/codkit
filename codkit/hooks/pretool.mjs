#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const INPUT_LIMIT = 1024 * 1024;
const TASK_LIMIT = 256 * 1024;
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function run() {
	try {
		const input = await readStdin();
		const locations = resolveLocations(toolRoot);
		const decision = evaluatePreTool(input, { toolRoot, patchesRoot: locations.patchesDir, treeRoot: locations.forkDir });
		if (decision !== null) process.stdout.write(`${JSON.stringify(decision)}\n`);
	} catch (error) {
		process.stdout.write(`${JSON.stringify(deny(`Codkit guard failed closed: ${safeMessage(error)}`))}\n`);
	}
}

export function evaluatePreTool(input, options) {
	if (!isRecord(input)) return deny('Codkit guard rejected malformed hook input.');
	if (input.hook_event_name !== 'PreToolUse') return deny('Codkit guard rejected malformed hook input: expected PreToolUse.');
	const tool = input.tool_name;
	const toolInput = input.tool_input;
	if (typeof tool !== 'string' || !isRecord(toolInput)) return deny('Codkit guard rejected malformed hook input.');

	const trustedToolRoot = canonicalExisting(options.toolRoot);
	const projectRoot = canonicalExisting(options.patchesRoot);
	const treeRoot = canonicalTarget(options.treeRoot);

	if (tool === 'Bash' || tool === 'PowerShell') {
		const command = toolInput.command;
		if (typeof command !== 'string') return deny('Codkit guard requires a shell command string.');
		let commandCwd;
		try {
			commandCwd = typeof input.cwd === 'string' && input.cwd !== '' ? canonicalExisting(input.cwd) : projectRoot;
		} catch (error) {
			return deny(`Shell cwd cannot be resolved safely: ${safeMessage(error)}`);
		}
		const violation = shellCommandProblem(command, trustedToolRoot, commandCwd);
		return violation === null ? null : deny(violation);
	}

	if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
		const rawPath = toolInput.file_path ?? toolInput.notebook_path;
		if (typeof rawPath !== 'string' || rawPath === '') return deny('Codkit guard requires an edit file path.');
		let target;
		try {
			const absolute =
				isAbsolute(rawPath)
					? rawPath
					: resolve(typeof input.cwd === 'string' && input.cwd !== '' ? canonicalExisting(input.cwd) : projectRoot, rawPath);
			target = canonicalTarget(absolute);
		} catch (error) {
			return deny(`Edit path cannot be resolved safely: ${safeMessage(error)}`);
		}
		const taskState = readResolveTask(projectRoot);
		if (taskState.error !== null) return deny(taskState.error);
		if (taskState.task === null) {
			return deny('Edit/Write requires a valid .codkit/agent-task.json; no-task writes fail closed.');
		}

		if (isAtOrWithin(treeRoot, target)) {
			if (target === treeRoot) return deny('Tree root is not an editable task file.');
			if (taskState.task.kind !== 'resolve') return deny('Only a resolve task may edit the fork tree.');
			let allowed;
			try {
				allowed = allowedTreeTargets(treeRoot, taskState.task);
			} catch (error) {
				return deny(`Agent task path is unsafe: ${safeMessage(error)}`);
			}
			if (!allowed.has(target)) return deny('Tree edit is outside blockers[].paths in .codkit/agent-task.json.');
			return null;
		}

		const outputs = allowedPatchSetOutputs(projectRoot, taskState.task);
		if (outputs.error !== null) return deny(outputs.error);
		if (!outputs.paths.has(target)) return deny('Write target is outside outputs[] of the active agent task.');
		return null;
	}

	return deny(`Codkit guard does not recognize matched tool ${tool}.`);
}

export function resolveLocations(installedToolRoot) {
	const result = spawnSync(process.execPath, [join(installedToolRoot, 'codkit', 'bin', 'codkit.mjs'), 'where', '--json'], {
		cwd: process.cwd(),
		env: process.env,
		encoding: 'utf8',
		timeout: 10_000,
		maxBuffer: 1024 * 1024
	});
	if (result.error) throw new Error(`codkit where --json did not start: ${result.error.message}`);
	if (result.status !== 0) throw new Error(`codkit where --json exited ${result.status ?? 'without status'}`);
	let envelope;
	try {
		envelope = JSON.parse(result.stdout);
	} catch {
		throw new Error('codkit where --json returned invalid JSON');
	}
	if (
		!isRecord(envelope) ||
		envelope.exitCode !== 0 ||
		!isRecord(envelope.codkit) ||
		envelope.codkit.command !== 'where' ||
		!isRecord(envelope.roots) ||
		!isRecord(envelope.roots.fork) ||
		typeof envelope.roots.fork.path !== 'string' ||
		!isAbsolute(envelope.roots.fork.path) ||
		!isRecord(envelope.roots.patches) ||
		typeof envelope.roots.patches.path !== 'string' ||
		!isAbsolute(envelope.roots.patches.path)
	) {
		throw new Error('codkit where --json returned an invalid envelope');
	}
	return { forkDir: envelope.roots.fork.path, patchesDir: envelope.roots.patches.path };
}

function readResolveTask(projectRoot) {
	const runtimeDir = join(projectRoot, '.codkit');
	const taskPath = join(runtimeDir, 'agent-task.json');
	try {
		let taskStat;
		try {
			taskStat = lstatSync(taskPath);
		} catch (error) {
			if (isErrorCode(error, 'ENOENT')) return { task: null, error: null };
			throw error;
		}
		const runtimeStat = lstatSync(runtimeDir);
		if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
			return { task: null, error: '.codkit must be a real directory for an agent task.' };
		}
		if (!taskStat.isFile() || taskStat.isSymbolicLink() || taskStat.size > TASK_LIMIT) {
			return { task: null, error: '.codkit/agent-task.json is not a safe regular task file.' };
		}
		const raw = JSON.parse(readFileSync(taskPath, 'utf8'));
		if (!validTask(raw)) return { task: null, error: '.codkit/agent-task.json does not match the supported agent task contract.' };
		return { task: raw, error: null };
	} catch (error) {
		return { task: null, error: `.codkit/agent-task.json is unreadable: ${safeMessage(error)}` };
	}
}

function validTask(value) {
	if (
		!isRecord(value) ||
		value.codkitAgentTask !== 1 ||
		typeof value.targetTag !== 'string' ||
		value.targetTag === '' ||
		typeof value.actor !== 'string' ||
		!value.actor.startsWith('agent:') ||
		value.actor.slice('agent:'.length).trim() === ''
	)
		return false;
	if (value.kind === 'resolve') {
		return (
			Array.isArray(value.blockers) &&
			value.blockers.length > 0 &&
			value.blockers.every(
				(blocker) =>
					isRecord(blocker) &&
					typeof blocker.artifact === 'string' &&
					blocker.artifact !== '' &&
					typeof blocker.outcome === 'string' &&
					blockerOutcomes.has(blocker.outcome) &&
					Array.isArray(blocker.paths) &&
					blocker.paths.length > 0 &&
					blocker.paths.every(safeTaskPath)
			) &&
			(value.outputs === undefined || (Array.isArray(value.outputs) && value.outputs.length === 0))
		);
	}
	if (!reportTaskKinds.has(value.kind) || !Array.isArray(value.outputs) || value.outputs.length === 0) return false;
	return new Set(value.outputs).size === value.outputs.length && value.outputs.every((path) => validReportOutput(value.kind, path));
}

const blockerOutcomes = new Set(['conflict', 'target-deleted', 'rule-broken', 'contract-failed']);
const reportTaskKinds = new Set(['scout', 'verify', 'review', 'cause']);

function safeTaskPath(value) {
	if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false;
	const parts = value.split('/');
	return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

function validReportOutput(kind, path) {
	if (!safeTaskPath(path)) return false;
	if (kind === 'cause') return /^\.codkit\/agent-cause-[A-Za-z0-9._-]+\.json$/.test(path);
	if (!path.startsWith('cycle/reports/') || !path.endsWith('.md')) return false;
	const name = path.slice('cycle/reports/'.length);
	if (kind === 'verify') return /^[A-Za-z0-9._-]+-verify-[1-9][0-9]*\.md$/.test(name);
	if (kind === 'review') return /^[A-Za-z0-9._-]+-review\.md$/.test(name);
	return kind === 'scout' && /^[A-Za-z0-9._-]+-scout-[A-Za-z0-9._-]+\.md$/.test(name);
}

function allowedTreeTargets(treeRoot, task) {
	const paths = task.blockers.flatMap((blocker) => blocker.paths);
	return new Set(
		paths.map((path) => {
			const lexical = resolve(treeRoot, ...path.split('/'));
			const canonical = canonicalTarget(lexical);
			if (canonical !== lexical) throw new Error(`${path} traverses a symlink component`);
			return canonical;
		})
	);
}

function allowedPatchSetOutputs(projectRoot, task) {
	const relativePaths =
		task.kind === 'resolve' ? ['.codkit/agent-task-result.json', '.codkit/agent-journal-entry.json'] : task.outputs;
	const paths = new Set();
	for (const relativePath of relativePaths) {
		const lexical = resolve(projectRoot, ...relativePath.split('/'));
		try {
			const current = lstatSync(lexical);
			if (!current.isFile() || current.isSymbolicLink()) {
				return { paths, error: `${relativePath} must be a regular non-symlink output file.` };
			}
		} catch (error) {
			if (!isErrorCode(error, 'ENOENT')) return { paths, error: `${relativePath} is unsafe: ${safeMessage(error)}` };
		}
		const canonical = canonicalTarget(lexical);
		if (canonical !== lexical || !isAtOrWithin(projectRoot, canonical) || canonical === projectRoot) {
			return { paths, error: `${relativePath} escapes the patchset project or traverses a symlink.` };
		}
		paths.add(canonical);
	}
	return { paths, error: null };
}

function shellCommandProblem(command, trustedToolRoot, commandCwd) {
	if (command.trim() === '') return 'Empty shell commands are denied.';
	if (/[\r\n;&|<>`]/.test(command) || command.includes('$') || command.includes('\0')) {
		return 'Shell operators, redirection, variables, and command substitution are denied; use one static allowed command.';
	}
	const tokens = shellTokens(command);
	if (tokens.length === 0 || tokens.some(isOperator)) return 'Only one static allowed command may run.';
	const executable = (tokens[0] ?? '').replaceAll('\\', '/');
	const name = commandName(executable);
	if (name === 'git') return executable === 'git' && allowedGit(tokens) ? null : 'Git command is not in the read-only allowlist.';
	if (name === 'rg') return executable === 'rg' && allowedRg(tokens.slice(1)) ? null : 'Ripgrep command is not in the static read-only allowlist.';
	if (name === 'grep') return executable === 'grep' ? null : 'Grep executable path is not trusted.';
	if (name === 'codkit')
		return allowedCodkitExecutable(executable, trustedToolRoot, commandCwd) && allowedCodkit(tokens.slice(1))
			? null
			: 'Codkit command is not in the agent read-only allowlist.';
	if (name === 'node')
		return executable === 'node' && allowedNodeHelper(tokens.slice(1), trustedToolRoot, commandCwd)
			? null
			: 'Node may run only the installed ck-resolve journal helper.';
	return `Shell executable ${name || '<dynamic>'} is not in the agent allowlist.`;
}

function allowedRg(tokens) {
	return !tokens.some((token) => token === '--pre' || token.startsWith('--pre=') || token === '--hostname-bin' || token.startsWith('--hostname-bin='));
}

function allowedCodkitExecutable(executable, trustedToolRoot, commandCwd) {
	const actual = canonicalCommandPath(executable, commandCwd);
	if (actual === null) return false;
	return [join(trustedToolRoot, 'bin', 'codkit'), join(trustedToolRoot, 'bin', 'codkit.ps1')].some(
		(candidate) => canonicalCommandPath(candidate, commandCwd) === actual
	);
}

const readOnlyGitVerbs = new Set([
	'blame',
	'cat-file',
	'describe',
	'diff',
	'diff-tree',
	'for-each-ref',
	'grep',
	'log',
	'ls-files',
	'ls-tree',
	'merge-base',
	'name-rev',
	'rev-list',
	'rev-parse',
	'show',
	'show-ref'
]);

function allowedGit(tokens) {
	const verb = gitVerb(tokens, 1);
	if (verb === '' || !readOnlyGitVerbs.has(verb)) return false;
	if (
		tokens.some(
			(token) =>
				token === '-c' ||
				token.startsWith('--config-env') ||
				token.startsWith('--exec-path') ||
				token.startsWith('--output') ||
				token === '--ext-diff' ||
				token === '--textconv' ||
				token.startsWith('--open-files-in-pager') ||
				token === '--paginate' ||
				token === '-p'
		)
	)
		return false;
	if (verb === 'cat-file' && tokens.includes('--filters')) return false;
	if (verb === 'diff' && !tokens.includes('--check') && !tokens.includes('--no-ext-diff')) return false;
	return true;
}

function allowedCodkit(tokens) {
	if (!tokens.includes('--json') || tokens.includes('--fork-dir') || tokens.includes('--patches-dir')) return false;
	const words = tokens.filter((token) => !token.startsWith('-'));
	const command = words[0] ?? '';
	const subcommand = words[1] ?? '';
	if (command === 'where' || command === 'status' || command === 'verify' || command === 'inventory' || command === 'check-tree') return true;
	if (command === 'cycle') return subcommand === 'status';
	if (command === 'build') return subcommand === 'status' || subcommand === 'errors';
	return false;
}

function allowedNodeHelper(tokens, trustedToolRoot, commandCwd) {
	const scriptIndex = tokens.findIndex((token) => token.endsWith('append-journal.mjs'));
	if (scriptIndex === -1) return false;
	const normalized = (tokens[scriptIndex] ?? '').replaceAll('\\', '/');
	const expected = canonicalCommandPath(join(trustedToolRoot, '.claude/skills/ck-resolve/scripts/append-journal.mjs'), commandCwd);
	const actual = canonicalCommandPath(tokens[scriptIndex] ?? '', commandCwd);
	if (actual !== expected || normalized.includes('/../')) return false;
	const allowedFlags = new Set(['--experimental-strip-types', '--disable-warning=ExperimentalWarning']);
	if (tokens.slice(0, scriptIndex).some((token) => !allowedFlags.has(token))) return false;
	const args = tokens.slice(scriptIndex + 1);
	for (let index = 0; index < args.length; index += 2) {
		if (args[index] !== '--entry' || args[index + 1] === undefined) return false;
	}
	return args.includes('--entry') && args[args.indexOf('--entry') + 1] === '.codkit/agent-journal-entry.json';
}

function canonicalCommandPath(executable, commandCwd) {
	try {
		if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) {
			return canonicalExisting(isAbsolute(executable) ? executable : resolve(commandCwd, executable));
		}
		for (const directory of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) {
			if (directory === '') continue;
			const candidate = resolve(directory, executable);
			if (existsSync(candidate)) return canonicalExisting(candidate);
		}
	} catch {
		return null;
	}
	return null;
}

function gitVerb(tokens, start) {
	for (let index = start; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (isOperator(token)) return '';
		if (token === '-C' || token === '-c' || token === '--git-dir' || token === '--work-tree' || token === '--namespace') {
			index += 1;
			continue;
		}
		if (token.startsWith('-')) continue;
		return token.toLowerCase();
	}
	return '';
}

function commandSegment(tokens, start) {
	const result = [];
	for (let index = start; index < tokens.length && !isOperator(tokens[index]); index += 1) result.push(tokens[index]);
	return result;
}

function shellTokens(command) {
	const matches = command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[;|()]|[^\s;|()]+/g) ?? [];
	return matches.map((token) => {
		if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) return token.slice(1, -1);
		return token;
	});
}

function commandName(token) {
	if (typeof token !== 'string' || token === '' || isOperator(token) || token.includes('=')) return '';
	return basename(token.replaceAll('\\', '/'))
		.replace(/\.(?:exe|ps1)$/i, '')
		.toLowerCase();
}

function isOperator(token) {
	return token === '&&' || token === '||' || token === ';' || token === '|' || token === '(' || token === ')';
}

function canonicalExisting(path) {
	return realpathSync(resolve(path));
}

function canonicalTarget(path) {
	const absolute = resolve(path);
	let cursor = absolute;
	const tail = [];
	while (!existsSync(cursor)) {
		const parent = dirname(cursor);
		if (parent === cursor) throw new Error(`no existing ancestor for ${absolute}`);
		tail.unshift(basename(cursor));
		cursor = parent;
	}
	const base = realpathSync(cursor);
	if (statSync(base).isFile() && tail.length > 0) throw new Error(`path descends through a file: ${absolute}`);
	return resolve(base, ...tail);
}

function isAtOrWithin(root, target) {
	const rel = relative(root, target);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function deny(reason) {
	return {
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			permissionDecision: 'deny',
			permissionDecisionReason: reason
		}
	};
}

function isRecord(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMessage(error) {
	return error instanceof Error ? error.message : String(error);
}

function isErrorCode(error, code) {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

async function readStdin() {
	const chunks = [];
	let size = 0;
	for await (const chunk of process.stdin) {
		size += chunk.length;
		if (size > INPUT_LIMIT) throw new Error('hook input exceeds size limit');
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString('utf8');
	if (text === '') throw new Error('hook input is empty');
	return JSON.parse(text);
}

if (import.meta.url === `file://${process.argv[1]}` || resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
	await run();
}
