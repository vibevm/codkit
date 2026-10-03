/** @scope spec://codkit/modules/codkit/PROP-010#root */
// The watch-daemon wrapper of the fork tree: channels, their processes, their
// logs, and the pass boundaries inside those logs.
//
// Contract: PROP-010 section 2. codkit starts the tree's own npm scripts as
// detached processes and captures their stdout and stderr into
// `.codkit/build/<channel>.log`; the record in `.codkit/build/<channel>.json`
// is a claim, never sufficient truth: exclusive `starting`, proven `living`,
// proven `dead`, and fail-closed `unknown` are distinct states. A compiling
// channel commonly empties its output directory when it starts, so a living
// channel is never restarted, and a watcher started by somebody else over the
// same tree makes `up` refuse rather than compete with it.
//
// Where the boundaries of a pass are is data, not code: `config/build-watch.json`
// carries the patterns, this module only applies them.
//
// The daemon files live under the patchset root, next to the other `.codkit/`
// state (locks, per-tree caches, generated documents), because the fork tree
// must stay clean for git and survive `--fresh` cleanup. Which tree a daemon
// serves is therefore part of the record instead of the path.

import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, sep, win32 } from 'node:path';
import type { ProjectType } from '@codkit/type-api';
import { z } from 'zod';
import { loadBaseConfig } from './configFile.ts';
import { validateChannelSet } from './buildChannel.ts';
import { readContainedFile } from './containedFile.ts';
import { errnoOf, sameEffectivePath } from './containedPath.ts';
import type { ProcessInvocation } from './processInvocation.ts';
import {
	DAEMON_RECORD_SCHEMA_VERSION,
	closeLog,
	createReservation,
	daemonRecordBytes,
	finalizeReservation,
	logPath,
	openLogAppend,
	readLog as readRuntimeLog,
	readRecordState,
	recordPath,
	removeRecord,
	rotateLog
} from './buildRuntime.ts';
import type { DaemonRecord } from './buildRuntime.ts';
import { acquireDaemonChannelLock, assertDaemonChannelLock } from './daemonChannelLock.ts';
import type { DaemonChannelLock } from './daemonChannelLock.ts';
import { ckError, isCkError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';

export {
	BUILD_DIR,
	DAEMON_RECORD_SCHEMA_VERSION,
	buildDir,
	logPath,
	recordPath,
	removeRecord,
	rotateLog,
	rotatedLogPath
} from './buildRuntime.ts';
export type { DaemonRecord } from './buildRuntime.ts';

// ---------------------------------------------------------------------------
// Channel configuration
// ---------------------------------------------------------------------------

/** How the pass-boundary profile is named in a diagnostic. */
export const BUILD_WATCH_RELATIVE_PATH = 'config/build-watch.json';

/** The word that stands for "every channel" in `--channel`. */
export const ALL_CHANNELS = 'all';

export type ChannelConfig = {
	readonly name: string;
	/** npm script of the fork tree that starts the daemon. */
	readonly script: string;
	readonly passStart: readonly RegExp[];
	readonly passEnd: readonly RegExp[];
	readonly errorLine: readonly RegExp[];
	/** Lines carrying the authoritative error count of a pass in group 1. */
	readonly errorCountLine: readonly RegExp[];
	/** Lines that look like the end of a pass and are not. */
	readonly falseEndGuards: readonly RegExp[];
};

export type BuildWatch = {
	/** Channels in the order the configuration lists them. */
	readonly channels: readonly ChannelConfig[];
};

const patternList = z.array(z.string().min(1));

const channelSchema = z
	.object({
		_doc: z.string().optional(),
		script: z.string().min(1),
		passStart: patternList.min(1),
		passEnd: patternList.min(1),
		errorLine: patternList.default([]),
		errorCountLine: patternList.default([]),
		falseEndGuards: patternList.default([])
	})
	.strict()
	.refine((channel) => channel.errorLine.length > 0 || channel.errorCountLine.length > 0, {
		message: 'at least one of errorLine or errorCountLine must contain a detector',
		path: ['errorLine']
	});

const buildWatchSchema = z
	.object({
		codkitBuildWatch: z.literal(1),
		_doc: z.string().optional(),
		channels: z.record(z.string(), channelSchema)
	})
	.strict();

const watchCache = new Map<string, BuildWatch>();

/**
 * Read the shipped pass-boundary profile, or a strict profile explicitly
 * declared by the selected patch set. A same-named undeclared file never wins.
 * Both locations are read through the contained regular-file reader (PROP-002
 * ##CONTAINED-FILE-IO): a symlinked leaf or parent refuses instead of being
 * followed, with no check-then-open window.
 */
export function loadBuildWatch(type: ProjectType, patchesDir?: string): BuildWatch {
	const location = buildWatchLocation(type, patchesDir);
	// A type whose channels come from `typeConfig` answers the profile as data
	// instead of a path (##TYPE-CONFIGURED); it is cached under the type's
	// identifier, which is what such a profile varies with.
	const path = location === null ? `type:${type.id}` : join(location.root, ...location.relative.split('/'));
	const cached = watchCache.get(path);
	if (cached !== undefined) return cached;
	// Which document a refusal names: the shipped profile, or the section of
	// `codkit.json` a configured type built its channels from.
	const document = location === null ? 'codkit.json' : BUILD_WATCH_RELATIVE_PATH;
	let raw: unknown;
	if (location === null) {
		raw = type.build.watchProfile;
	} else {
		try {
			const read = readContainedFile(location.root, location.relative, { what: BUILD_WATCH_RELATIVE_PATH });
			if (read.state === 'absent') {
				throw new Error('the file does not exist');
			}
			raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
		} catch (error) {
			throw ckError(
				'CONFIG',
				`cannot be read: ${messageOf(error)}`,
				'build-watch.json ships with codkit; restore it from the repository',
				BUILD_WATCH_RELATIVE_PATH
			);
		}
	}
	const parsed = buildWatchSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
		throw ckError(
			'CONFIG',
			`${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`,
			'see PROP-010 section 2 for the pass-boundary data',
			document
		);
	}
	validateChannelSet(Object.keys(parsed.data.channels));
	// A count detector is validated before any log is read: a pattern that
	// cannot capture the count in group 1 would match a count line and still
	// report no summary, silently falling back to the parsed diagnostics -
	// zero, for a channel that parses none. That is a configuration error
	// (PROP-010 ##PASS-BOUNDARIES-ARE-DATA).
	for (const [name, channel] of Object.entries(parsed.data.channels)) {
		for (const pattern of channel.errorCountLine) {
			const problem = countPatternProblem(pattern);
			if (problem !== null) {
				throw ckError(
					'CONFIG',
					`channels.${name}.errorCountLine: ${JSON.stringify(pattern)} ${problem}`,
					'capture the error count in group 1, e.g. "Found (\\\\d+) errors"',
					document
				);
			}
		}
	}

	const channels: ChannelConfig[] = [];
	for (const [name, channel] of Object.entries(parsed.data.channels)) {
		channels.push({
			name,
			script: channel.script,
			passStart: compileAll(name, 'passStart', channel.passStart),
			passEnd: compileAll(name, 'passEnd', channel.passEnd),
			errorLine: compileAll(name, 'errorLine', channel.errorLine),
			errorCountLine: compileAll(name, 'errorCountLine', channel.errorCountLine),
			falseEndGuards: compileAll(name, 'falseEndGuards', channel.falseEndGuards)
		});
	}
	if (channels.length === 0) {
		throw ckError('CONFIG', 'channels: at least one channel is required', 'see PROP-010 section 2', document);
	}
	const watch: BuildWatch = { channels };
	watchCache.set(path, watch);
	return watch;
}

/**
 * Where the profile is read from, as root plus contained relative path, or null
 * when the type answers the profile as data instead of a file.
 */
function buildWatchLocation(
	type: ProjectType,
	patchesDir: string | undefined
): { readonly root: string; readonly relative: string } | null {
	// The default profile is the type's: the channels and their pass boundaries
	// are facts about one family of upstreams, and the engine only reads them
	// (##TYPE-AREA-BUILD). A patch set may declare a stricter profile of its own.
	const shippedPath = type.build.watchProfilePath;
	const shipped = shippedPath === null ? null : { root: dirname(shippedPath), relative: basename(shippedPath) };
	if (shipped === null && type.build.watchProfile === undefined) {
		throw ckError(
			'CONFIG',
			`the project type ${type.id} declares no pass-boundary profile for its watch channels`,
			`declare buildWatchFile in codkit.json, or run a verb this type answers (run: codkit types)`,
			BUILD_WATCH_RELATIVE_PATH
		);
	}
	if (patchesDir === undefined) return shipped;
	const configured = loadBaseConfig(patchesDir)?.buildWatchFile ?? null;
	if (configured === null) return shipped;
	const resolved = resolveContainedPath(patchesDir, configured);
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`buildWatchFile is unsafe or unreadable: ${resolved.reason}`,
			'point buildWatchFile at a real non-symlink JSON file inside the patch-set repository',
			'codkit.json'
		);
	}
	return { root: patchesDir, relative: configured };
}

function compileAll(channel: string, field: string, patterns: readonly string[]): readonly RegExp[] {
	return patterns.map((pattern) => {
		try {
			return new RegExp(pattern);
		} catch (error) {
			throw ckError(
				'CONFIG',
				`channels.${channel}.${field}: ${pattern} is not a valid regular expression (${messageOf(error)})`,
				'fix the pattern; the wrapper compiles every pattern of the file before it reads a log',
				BUILD_WATCH_RELATIVE_PATH
			);
		}
	});
}

/** The channel of that name, or null when the configuration has none. */
export function channelByName(watch: BuildWatch, name: string): ChannelConfig | null {
	return watch.channels.find((channel) => channel.name === name) ?? null;
}

/**
 * Resolve `--channel`: absent means `fallback`, `all` means every channel, and
 * a name means that channel. An unknown name is a diagnosed condition.
 */
export function selectChannels(watch: BuildWatch, requested: string | null, fallback: readonly string[]): readonly ChannelConfig[] {
	const names =
		requested === null
			? defaultChannelNames(watch, fallback)
			: requested === ALL_CHANNELS
				? watch.channels.map((channel) => channel.name)
				: [requested];
	return names.map((name) => {
		const channel = channelByName(watch, name);
		if (channel === null) {
			throw ckError(
				'CONFIG',
				`unknown build channel: ${name}`,
				`known channels: ${watch.channels.map((known) => known.name).join(', ')}, or ${ALL_CHANNELS}`,
				BUILD_WATCH_RELATIVE_PATH
			);
		}
		return channel;
	});
}

/**
 * The channels a bare `build up` starts. The default of PROP-007 ##CMD-BUILD is
 * a pair of names, and it was written when there was one project type; a type
 * whose profile declares neither of them would otherwise refuse the default of
 * the command rather than start what it has. So the default is the declared
 * channels the fallback names, and every declared channel when it names none.
 */
function defaultChannelNames(watch: BuildWatch, fallback: readonly string[]): readonly string[] {
	const declared = new Set(watch.channels.map((channel) => channel.name));
	const named = fallback.filter((name) => declared.has(name));
	return named.length > 0 ? named : [...declared];
}

// ---------------------------------------------------------------------------
// Locations and records
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Probing the process table
// ---------------------------------------------------------------------------

export type ProcessInfo = {
	readonly pid: number;
	/** Process group on POSIX; parent pid on Windows, where process groups are unavailable. */
	readonly pgid: number;
	readonly args: readonly string[];
	/** Working directory when the platform tells (Linux); null otherwise. */
	readonly cwd: string | null;
};

export type ProcessRunResult = {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly error?: Error;
};

/** Injectable seam for native process probes; production uses spawnSync. */
export type ProcessRunner = (command: string, args: readonly string[]) => ProcessRunResult;

/**
 * The fork tree a mutating or certifying build command acts on.
 *
 * It is a separate required type, not two optional probe fields, because the
 * one call site that forgot to pass them signalled and deleted another tree's
 * daemon: `statusOf` cannot distinguish "no expectation" from "matches", so an
 * unbound `down` read a foreign record as its own. Requiring the binding makes
 * that call impossible to write rather than something review has to catch.
 */
export type TreeBinding = {
	readonly expectedTreeId: string;
	readonly expectedTreePath: string;
};

export type BoundProbe = ProcessProbeOptions & TreeBinding;

export type ProcessProbeOptions = {
	readonly platform?: NodeJS.Platform;
	readonly run?: ProcessRunner;
	/**
	 * Observe/replace the native signal target in tests. Returning `false`
	 * expresses a native teardown that did not succeed - the Windows
	 * `taskkill /t` shape - which nothing else could express, leaving the
	 * refusal that depends on it unpinnable on every platform.
	 */
	readonly signal?: (target: number, signal: 'SIGTERM' | 'SIGKILL') => void | boolean;
	readonly termGraceMs?: number;
	/** Observe/replace the bounded settle wait of a teardown over a `starting` record in tests. */
	readonly settleWait?: (ms: number) => Promise<void>;
	readonly afterLock?: () => void;
	readonly afterRecordRead?: () => void;
	readonly beforeTerm?: () => void;
	readonly beforeKill?: () => void;
	readonly beforeRemove?: () => void;
	readonly afterTermCompare?: () => void;
	readonly afterKillCompare?: () => void;
	readonly afterRemoveCompare?: () => void;
	readonly expectedTreeId?: string;
	readonly expectedTreePath?: string;
	/**
	 * Where the Linux process table is read from (test seam). The `/proc`
	 * branch is the primary one on this platform and had no seam at all, so
	 * every classification it feeds - group ownership above all - was
	 * unreachable from a test and deletable with the suite green. A fake root
	 * exercises the real readers, not a stand-in for them.
	 */
	readonly procRoot?: string;
	/** Where an operational warning goes; see `UpContext.onWarn`. */
	readonly onWarn?: (text: string) => void;
};

const PROC = '/proc';
const POWERSHELL = 'powershell.exe';

function procAvailable(platform: NodeJS.Platform, root: string): boolean {
	return platform === 'linux' && existsSync(root);
}

function defaultProcessRunner(command: string, args: readonly string[]): ProcessRunResult {
	const result = spawnSync(command, [...args], {
		encoding: 'utf8',
		shell: false,
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024
	});
	const base = {
		status: result.status,
		stdout: result.stdout ?? '',
		stderr: result.stderr ?? ''
	};
	return result.error === undefined ? base : { ...base, error: result.error };
}

function probeOptions(options: ProcessProbeOptions): { readonly platform: NodeJS.Platform; readonly run: ProcessRunner } {
	return { platform: options.platform ?? process.platform, run: options.run ?? defaultProcessRunner };
}

function probeUnavailable(probe: string, result: ProcessRunResult): never {
	const detail = result.error?.message ?? (result.stderr.trim() || `exit ${result.status ?? 'unknown'}`);
	throw ckError(
		'INTERNAL',
		`cannot inspect ${probe}: ${detail}`,
		'install or repair the native process probe (PowerShell on Windows, ps on macOS) and retry; daemon records were left untouched'
	);
}

/**
 * argv of a live process, or null when there is no such process. `/proc` is the
 * primary source; macOS uses `ps`, and native Windows uses Get-CimInstance.
 * Failure to start the platform probe is raised instead of being confused with
 * a missing process: callers must not retire the record of a daemon they could
 * not inspect.
 */
export function processArgs(pid: number, options: ProcessProbeOptions = {}): readonly string[] | null {
	if (pid <= 0) {
		return null;
	}
	const probe = probeOptions(options);
	const root = options.procRoot ?? PROC;
	if (procAvailable(probe.platform, root)) {
		return readProcArgs(pid, root);
	}
	if (probe.platform === 'win32') {
		return windowsProcessArgs(pid, probe.run);
	}
	const result = probe.run('ps', ['-o', 'args=', '-p', String(pid)]);
	if (result.error !== undefined) {
		probeUnavailable(`process ${pid}`, result);
	}
	if (result.status !== 0) {
		return null;
	}
	const line = result.stdout.trim();
	return line === '' ? null : splitArgs(line);
}

function readProcArgs(pid: number, root: string): readonly string[] | null {
	try {
		const raw = readFileSync(join(root, String(pid), 'cmdline'), 'utf8');
		const args = raw.split('\0').filter((part) => part !== '');
		// A kernel thread has an empty cmdline; it exists, and it is not ours.
		return args;
	} catch (error) {
		// ENOENT is the only errno that means "no such process". EACCES/EPERM -
		// `hidepid`, a different uid - mean the process exists and is not visible
		// to us, which must never be read as gone: that would retire a live
		// daemon's record and let the next `up` start a second watcher over the
		// tree. The `ps` and Windows probes already fail closed here.
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw ckError(
			'INTERNAL',
			`cannot inspect process ${pid}: ${messageOf(error)}`,
			'the process exists but its command line is not readable by this user; run as the owner of the daemon or repair /proc visibility. Daemon records were left untouched'
		);
	}
}

/**
 * Whether a command line still carries the token the record expects.
 *
 * Two forms have to be accepted, because npm rewrites its own process title:
 * the argv it was started with (`npm`, `run`, `<script>`) and the single string
 * it replaces argv with (`npm run <script>`). Both are compared word by word,
 * never as substrings - one script name is often a prefix of another, and
 * probing one must never accept the other.
 */
export function argsMatch(args: readonly string[], expected: string): boolean {
	return args.some((arg) => arg === expected || arg.split(/\s+/).includes(expected));
}

/** Every process the platform lets us see, for the foreign-watcher scan. */
export function processTable(options: ProcessProbeOptions = {}): readonly ProcessInfo[] {
	const probe = probeOptions(options);
	const root = options.procRoot ?? PROC;
	if (procAvailable(probe.platform, root)) {
		return procTable(root);
	}
	return probe.platform === 'win32' ? windowsProcessTable(probe.run) : psTable(probe.run);
}

function procTable(root: string): readonly ProcessInfo[] {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return [];
	}
	const table: ProcessInfo[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) {
			continue;
		}
		const pid = Number.parseInt(name, 10);
		const args = readProcArgs(pid, root);
		if (args === null || args.length === 0) {
			continue;
		}
		table.push({ pid, pgid: readProcPgid(pid, root) ?? pid, args, cwd: readProcCwd(pid, root) });
	}
	return table;
}

/**
 * Field 5 of `/proc/<pid>/stat` is the process group. The executable name in
 * field 2 may itself contain spaces and parentheses, so the fields are counted
 * from after its closing parenthesis.
 */
function readProcPgid(pid: number, root: string): number | null {
	let text: string;
	try {
		text = readFileSync(join(root, String(pid), 'stat'), 'utf8');
	} catch {
		return null;
	}
	const close = text.lastIndexOf(')');
	if (close === -1) {
		return null;
	}
	const fields = text
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	// After the name: state, ppid, pgrp.
	const pgrp = fields[2];
	if (pgrp === undefined) {
		return null;
	}
	const value = Number.parseInt(pgrp, 10);
	return Number.isNaN(value) ? null : value;
}

function readProcCwd(pid: number, root: string): string | null {
	try {
		return readlinkSync(join(root, String(pid), 'cwd'));
	} catch {
		// Another user's process: it is visible, its cwd is not.
		return null;
	}
}

function psTable(run: ProcessRunner): readonly ProcessInfo[] {
	const result = run('ps', ['-eo', 'pid=,pgid=,args=']);
	if (result.error !== undefined || result.status !== 0) {
		probeUnavailable('process table', result);
	}
	const table: ProcessInfo[] = [];
	for (const line of result.stdout.split('\n')) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (match === null) {
			continue;
		}
		const pid = Number.parseInt(match[1] ?? '', 10);
		const pgid = Number.parseInt(match[2] ?? '', 10);
		const args = splitArgs(match[3] ?? '');
		if (Number.isNaN(pid) || args.length === 0) {
			continue;
		}
		table.push({ pid, pgid: Number.isNaN(pgid) ? pid : pgid, args, cwd: null });
	}
	return table;
}

type WindowsProcess = {
	readonly pid: number;
	readonly parentPid: number;
	readonly commandLine: string;
};

const WINDOWS_PROCESS_SELECT =
	"Select-Object @{Name='pid';Expression={[int]$_.ProcessId}}," +
	"@{Name='parentPid';Expression={[int]$_.ParentProcessId}}," +
	"@{Name='commandLineBase64';Expression={if ($null -eq $_.CommandLine) {$null} else {[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.CommandLine))}}}";

function powershellProcessQuery(query: string): readonly string[] {
	return [
		'-NoLogo',
		'-NoProfile',
		'-NonInteractive',
		'-Command',
		`$ErrorActionPreference='Stop'; ${query} | ${WINDOWS_PROCESS_SELECT} | ConvertTo-Json -Compress`
	];
}

function windowsProcessArgs(pid: number, run: ProcessRunner): readonly string[] | null {
	const result = run(POWERSHELL, powershellProcessQuery(`Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`));
	if (result.error !== undefined || result.status !== 0) {
		probeUnavailable(`process ${pid}`, result);
	}
	if (result.stdout.trim() === '') {
		return null;
	}
	const rows = parseWindowsProcesses(result.stdout, `process ${pid}`);
	if (rows[0] === undefined) {
		probeUnavailable(`process ${pid}`, {
			status: 0,
			stdout: result.stdout,
			stderr: 'PowerShell found the process but returned no readable command line'
		});
	}
	return [rows[0].commandLine];
}

function windowsProcessTable(run: ProcessRunner): readonly ProcessInfo[] {
	const result = run(POWERSHELL, powershellProcessQuery('Get-CimInstance Win32_Process'));
	if (result.error !== undefined || result.status !== 0) {
		probeUnavailable('process table', result);
	}
	return parseWindowsProcesses(result.stdout, 'process table').map((row) => ({
		pid: row.pid,
		// A recorded daemon pid identifies itself, while this parent relationship
		// also keeps its direct npm child out of the foreign-watcher scan.
		pgid: row.parentPid > 0 ? row.parentPid : row.pid,
		args: [row.commandLine],
		cwd: null
	}));
}

function parseWindowsProcesses(stdout: string, probe: string): readonly WindowsProcess[] {
	const text = stdout.trim();
	if (text === '') {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		probeUnavailable(probe, {
			status: 0,
			stdout,
			stderr: `PowerShell returned invalid JSON: ${messageOf(error)}`
		});
	}
	const rows = Array.isArray(parsed) ? parsed : [parsed];
	const processes: WindowsProcess[] = [];
	for (const row of rows) {
		if (!isRecord(row)) {
			continue;
		}
		const pid = row['pid'];
		const parentPid = row['parentPid'];
		const commandLineBase64 = row['commandLineBase64'];
		if (
			typeof pid !== 'number' ||
			!Number.isInteger(pid) ||
			pid <= 0 ||
			typeof commandLineBase64 !== 'string' ||
			commandLineBase64.trim() === ''
		) {
			continue;
		}
		const commandLine = Buffer.from(commandLineBase64, 'base64').toString('utf8');
		if (commandLine.trim() === '') continue;
		processes.push({
			pid,
			parentPid: typeof parentPid === 'number' && Number.isInteger(parentPid) ? parentPid : pid,
			commandLine
		});
	}
	return processes;
}

function splitArgs(line: string): readonly string[] {
	return line
		.trim()
		.split(/\s+/)
		.filter((part) => part !== '');
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export type ChannelState = 'starting' | 'living' | 'dead' | 'unknown';

export type ChannelStatus = {
	readonly channel: string;
	readonly state: ChannelState;
	readonly record: DaemonRecord | null;
	readonly recordBytes?: Uint8Array;
	readonly treeMatches: boolean | null;
	/** Evidence behind the state; printed after the verdict. */
	readonly detail: string;
};

/**
 * Probe one channel. Mismatching identity is unknown/starting, never dead:
 * Codkit must not signal a reused pid whose ownership it cannot prove.
 */
export function statusOf(patchesDir: string, channel: string, probe: ProcessProbeOptions = {}): ChannelStatus {
	const observed = readRecordState(patchesDir, channel);
	if (observed.state === 'absent') {
		return { channel, state: 'dead', record: null, treeMatches: null, detail: 'no daemon record' };
	}
	if (observed.state === 'invalid') {
		return {
			channel,
			state: 'unknown',
			record: null,
			treeMatches: null,
			detail: `daemon record is unreadable or invalid: ${observed.detail}`
		};
	}
	const { record, bytes: recordBytes } = observed;
	// null is "nobody asked", never "it matches": a caller that did not bind a
	// tree must not be handed a verdict that reads like proof of ownership.
	const treeMatches =
		probe.expectedTreeId === undefined && probe.expectedTreePath === undefined
			? null
			: probe.expectedTreeId === record.treeId &&
				probe.expectedTreePath !== undefined &&
				sameEffectivePath(probe.expectedTreePath, record.treePath, probe.platform);
	if (treeMatches === false) {
		return {
			channel,
			state: 'unknown',
			record,
			recordBytes,
			treeMatches,
			detail: `daemon record belongs to another tree (${record.treePath}, id ${record.treeId})`
		};
	}
	if (record.pid === 0) {
		return {
			channel,
			state: 'starting',
			record,
			recordBytes,
			treeMatches,
			detail: 'an exclusively owned daemon start reservation is in progress'
		};
	}
	const args = processArgs(record.pid, probe);
	if (args === null) {
		// On POSIX npm is only the detached process-group leader. It may exit
		// before the shell/compiler children it started (and, during shutdown,
		// commonly does). The group id cannot be reused while any old member is
		// alive, so a surviving member still belongs to this recorded daemon even
		// though /proc/<leader> is already gone. Calling the channel dead here used
		// to discard its only kill handle and leaked watchers across test/CI runs.
		if ((probe.platform ?? process.platform) === 'win32') {
			return {
				channel,
				state: 'unknown',
				record,
				recordBytes,
				treeMatches,
				// No retry can settle this: the root stays absent. What is left is the
				// operator's native proof, so the detail says what to do after it.
				detail:
					`pid ${record.pid} is absent; Windows cannot prove that its descendant process tree is gone. ` +
					`Once no process of that tree is left, remove ${recordPath(patchesDir, channel)} by hand`
			};
		}
		if (processGroupAlive(record.pid, probe)) {
			// A pid is reusable once our group has emptied, and a reused pid that
			// calls setsid leads a group with the same id. Group membership alone
			// is therefore not proof of ownership: something in the group must
			// still be working in the tree this record names. Where that
			// corroboration is positively against us the honest answer is
			// `unknown`, which refuses both the signal and a duplicate start.
			// Where it is merely absent - `unproven`, the cross-uid case where no
			// member has a readable working directory - the group stays
			// `living` on the group id alone: calling it dead would discard the
			// only kill handle of a real daemon and leak the watcher across runs.
			// The residual - signalling a group that belongs to another uid - is
			// closed further down: the signal is refused, the group survives it,
			// and teardown fails closed with the record preserved.
			const corroboration = groupOwnership(record.pid, record.treePath, probe);
			if (corroboration === 'foreign') {
				return {
					channel,
					state: 'unknown',
					record,
					recordBytes,
					treeMatches,
					detail: `process group ${record.pid} is alive but every member with a readable working directory is outside ${record.treePath}; ownership is not proven`
				};
			}
			return {
				channel,
				state: 'living',
				record,
				recordBytes,
				treeMatches,
				detail:
					corroboration === 'ours'
						? `process group ${record.pid} still has living members working in ${record.treePath}`
						: `process group ${record.pid} still has living members; ownership rests on the group id alone`
			};
		}
		if (!olderThan(record.startedAt, PROCESS_START_SETTLE_MS)) {
			return {
				channel,
				state: 'starting',
				record,
				recordBytes,
				treeMatches,
				detail: `pid ${record.pid} has not published a process identity yet${futureNote(record.startedAt)}`
			};
		}
		return { channel, state: 'dead', record, recordBytes, treeMatches, detail: `pid ${record.pid} is gone` };
	}
	if (!argsMatch(args, record.cmdline)) {
		if (!olderThan(record.startedAt, PROCESS_START_SETTLE_MS)) {
			return {
				channel,
				state: 'starting',
				record,
				recordBytes,
				treeMatches,
				detail: `pid ${record.pid} has not published the expected argv identity yet${futureNote(record.startedAt)}`
			};
		}
		return {
			channel,
			state: 'unknown',
			record,
			recordBytes,
			treeMatches,
			detail: `pid ${record.pid} belongs to another process; identity is not proven`
		};
	}
	return { channel, state: 'living', record, recordBytes, treeMatches, detail: `pid ${record.pid}` };
}

// ---------------------------------------------------------------------------
// Foreign watchers
// ---------------------------------------------------------------------------

/**
 * Command-line fragments of the watchers the upstream tree starts by itself
 * (PROP-010 section 2). They are mutually exclusive with our channels: two
 * watchers over one tree fight over `out/`.
 */
/**
 * Argv fragments that mean somebody else's watcher already runs over the tree.
 * Which fragments those are is the type's answer (##TYPE-AREA-BUILD): they name
 * the watch scripts of one family of upstreams.
 */
export function foreignWatcherMarkers(type: ProjectType): readonly string[] {
	return type.build.foreignWatcherMarkers;
}

export type ForeignWatcher = { readonly pid: number; readonly commandLine: string };

/**
 * Watch processes over `treeDir` that codkit did not start. Everything in the
 * process groups of our own live channels is ours by construction - a daemon we
 * started leads its group, and the compiler it runs is inside it.
 */
export function foreignWatchers(
	type: ProjectType,
	treeDir: string,
	ourGroups: ReadonlySet<number>,
	probe: ProcessProbeOptions = {}
): readonly ForeignWatcher[] {
	const markers = foreignWatcherMarkers(type);
	const found: ForeignWatcher[] = [];
	const platform = probe.platform ?? process.platform;
	const table = processTable(probe);
	const parents = new Map(table.map((info) => [info.pid, info.pgid]));
	const belongsToUs = (info: ProcessInfo): boolean => {
		if (ourGroups.has(info.pid) || ourGroups.has(info.pgid)) return true;
		if (platform !== 'win32') return false;
		// Windows has parent pids rather than POSIX process groups. Follow only
		// this native snapshot; a missing ancestor or cycle remains foreign.
		const visited = new Set<number>();
		let ancestor = info.pgid;
		while (ancestor > 0 && !visited.has(ancestor)) {
			if (ourGroups.has(ancestor)) return true;
			visited.add(ancestor);
			const parent = parents.get(ancestor);
			if (parent === undefined) return false;
			ancestor = parent;
		}
		return false;
	};
	for (const info of table) {
		if (info.pid === process.pid || belongsToUs(info)) {
			continue;
		}
		const commandLine = info.args.join(' ');
		if (!markers.some((marker) => commandLine.includes(marker))) {
			continue;
		}
		if (!concernsTree(info, commandLine, treeDir, platform)) {
			continue;
		}
		found.push({ pid: info.pid, commandLine });
	}
	return found;
}

function concernsTree(info: ProcessInfo, commandLine: string, treeDir: string, platform: NodeJS.Platform): boolean {
	if (info.cwd !== null && (info.cwd === treeDir || info.cwd.startsWith(treeDir + sep))) {
		return true;
	}
	// Win32_Process exposes argv but not cwd. A normal watcher command therefore
	// carries no tree path at all. Missing it would allow two writers over out/;
	// conservatively treating a matching foreign watcher as relevant is safer
	// than corrupting the active tree. Our own daemon family is excluded above by
	// pid/parent ownership before this branch.
	if (platform === 'win32' && info.cwd === null) {
		return true;
	}
	return commandLine.includes(treeDir);
}

// ---------------------------------------------------------------------------
// The environment contract of the daemons on Linux
// ---------------------------------------------------------------------------

/** Where the kernel states the per-user watch limit. */
export const INOTIFY_LIMIT_PATH = '/proc/sys/fs/inotify/max_user_watches';

/**
 * Below this the wrapper warns (PROP-010 sec. 2, the inotify environment requirement): a watch over
 * the ~18k files of the tree needs far more descriptors than the usual default,
 * and a compiling daemon that runs out of them finishes its first pass and then
 * dies on ENOSPC while installing watchers - which reads as "the build stopped
 * for no reason" unless somebody says so first.
 */
export const INOTIFY_MIN_WATCHES = 262_144;

/** What the remedy sets it to; the measured requirement is above the minimum. */
export const INOTIFY_RECOMMENDED_WATCHES = 524_288;

/** Reads the limit; returns null when the file is absent or unreadable. */
export type WatchLimitReader = () => string | null;

function readInotifyLimit(): string | null {
	try {
		return readFileSync(INOTIFY_LIMIT_PATH, 'utf8');
	} catch {
		return null;
	}
}

/**
 * The warning `build up` prints before starting a channel, or null when there is
 * nothing to say. Never a refusal: the limit is a machine setting of the owner,
 * codkit does not change it, and a single CI pass is usable even below it
 * (the pass finishes before the watchers fail).
 */
export function inotifyWarning(options: { readonly platform?: string; readonly read?: WatchLimitReader } = {}): string | null {
	const platform = options.platform ?? process.platform;
	if (platform !== 'linux') {
		return null;
	}
	const raw = (options.read ?? readInotifyLimit)();
	if (raw === null) {
		return null;
	}
	const value = Number.parseInt(raw.trim(), 10);
	if (Number.isNaN(value) || value >= INOTIFY_MIN_WATCHES) {
		return null;
	}
	return (
		`fs.inotify.max_user_watches is ${value}; the watch daemons of the fork tree need at least ` +
		`${INOTIFY_MIN_WATCHES} (measured requirement: ${INOTIFY_RECOMMENDED_WATCHES}). The first pass will finish and ` +
		'the daemon will then fail with ENOSPC while installing watchers. Fix it on this machine: ' +
		`sudo sysctl fs.inotify.max_user_watches=${INOTIFY_RECOMMENDED_WATCHES} ` +
		`(and echo fs.inotify.max_user_watches=${INOTIFY_RECOMMENDED_WATCHES} into /etc/sysctl.d/99-codkit.conf to keep it)`
	);
}

// ---------------------------------------------------------------------------
// up
// ---------------------------------------------------------------------------

export type UpContext = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly treeId: string;
	/**
	 * Where an operational warning goes. A lock that could not retire its own
	 * generation is the one this path produces: harmless on its own - the next
	 * command recovers it - but silent, and a lock file nobody was told about is
	 * a lock file nobody inspects.
	 */
	readonly onWarn?: (text: string) => void;
	readonly runtime?: {
		readonly spawn?: (treeDir: string, channel: ChannelConfig) => SpawnedDaemon;
		readonly afterReservation?: () => void;
		readonly beforeFinalize?: () => void;
		readonly afterFinalizeCompare?: () => void;
		readonly afterLock?: () => void;
		/** Fires after the stale record is read and before it is retired (test seam). */
		readonly afterStaleRead?: () => void;
	};
};

export type SpawnedDaemon = { readonly pid: number; readonly terminate: () => void };

export type UpResult =
	| {
			readonly ok: true;
			readonly channel: string;
			readonly action: 'started' | 'already-running';
			readonly pid: number;
			readonly log: string;
	  }
	| { readonly ok: false; readonly channel: string; readonly reason: string };

export const PROCESS_START_SETTLE_MS = 2_000;
/**
 * How far ahead of this machine's clock a record may be dated before it is a
 * refused skew instead of a waited-out one. Two hosts sharing a patch set
 * routinely disagree by a fraction of a second; refusing on that turns every
 * teardown on the trailing host into a hard failure where the correct answer
 * was to wait the window out. Beyond the band the skew is unbounded and the
 * refusal stands: it is fail-closed, and it names the one thing a human can
 * fix.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 1_000;

function olderThan(iso: string, ms: number): boolean {
	const started = Date.parse(iso);
	return Number.isNaN(started) || Date.now() - started > ms;
}

/** How far `iso` is dated into the future right now; 0 when it is not. */
function futureSkewMs(iso: string): number {
	return Math.max(0, Date.parse(iso) - Date.now());
}

/**
 * The clock clause of a `starting` verdict. A future-dated record stays
 * `starting` for the whole duration of the skew, and `up` - which never waits -
 * would otherwise report a "not yet" that never becomes yet, in words that
 * sound transient while the state is a clock disagreement.
 */
function futureNote(iso: string): string {
	const skew = futureSkewMs(iso);
	return skew > 0 ? `; the record is dated ${skew} ms into the future, so this machine's clock is behind the one that wrote it` : '';
}

/**
 * The bounded wait of a teardown over a `starting` record: how much of the
 * settle window the record still owes. It is derived from the record's own
 * `startedAt` and PROCESS_START_SETTLE_MS - there is no separate timeout to
 * configure - and it is one delay, never a poll: the caller re-probes once
 * when it returns. A daemon that vanished mid-start needs no wait to be
 * resolved; the re-probe reads its absence as the answer.
 */
async function waitStartSettle(startedAt: string, probe: ProcessProbeOptions): Promise<void> {
	const remaining = PROCESS_START_SETTLE_MS - (Date.now() - Date.parse(startedAt));
	if (remaining <= 0) {
		return;
	}
	if (remaining > PROCESS_START_SETTLE_MS + CLOCK_SKEW_TOLERANCE_MS) {
		// The record was written ahead of this machine's clock - a backward NTP
		// step, or a tree shared with a host whose clock disagrees - by more
		// than the tolerance band. The arithmetic above measures distance from
		// `startedAt`, so the skew is added to the wait: this teardown would
		// hold the channel operation lock for the whole skew - potentially an
		// hour - refusing every other operation on the channel while it slept.
		// Refuse instead of waiting: it is bounded, it is fail-closed (no
		// unproven signal is sent, the record is preserved), and it names the
		// one thing a human can fix.
		const skew = remaining - PROCESS_START_SETTLE_MS;
		throw ckError(
			'INTERNAL',
			`the daemon record is dated ${skew} ms into the future (startedAt ${startedAt}); refusing to hold the channel lock for a skewed clock`,
			'fix the clock of the machine that wrote the record, or remove the record by hand once its process is known to be gone'
		);
	}
	// `olderThan` is strict, so one extra millisecond guarantees the re-probe
	// sees an aged record instead of landing exactly on the boundary.
	await (probe.settleWait ?? delay)(remaining + 1);
}

/**
 * Start one channel unless it is already living.
 *
 * The record file is created with 'wx' before the process exists, so two `up`
 * runs racing over the same channel are decided by the filesystem: the loser
 * refuses instead of starting a second daemon.
 */
export function upChannel(ctx: UpContext, channel: ChannelConfig, runtime = ctx.runtime): UpResult {
	let lock: DaemonChannelLock;
	try {
		lock = acquireDaemonChannelLock(ctx.patchesDir, channel.name, `build up ${channel.name}`, {
			...(ctx.onWarn === undefined ? {} : { onWarn: ctx.onWarn })
		});
	} catch (error) {
		if (isCkError(error) && error.code === 'LOCKED') return { ok: false, channel: channel.name, reason: error.message };
		throw error;
	}
	try {
		runtime?.afterLock?.();
		return upChannelLocked(ctx, channel, lock, runtime);
	} finally {
		lock.release();
	}
}

function upChannelLocked(ctx: UpContext, channel: ChannelConfig, lock: DaemonChannelLock, runtime = ctx.runtime): UpResult {
	assertDaemonChannelLock(lock, ctx.patchesDir, channel.name);
	const status = statusOf(ctx.patchesDir, channel.name, { expectedTreeId: ctx.treeId, expectedTreePath: ctx.treeDir });
	if (status.state === 'unknown' || status.state === 'starting') {
		return {
			ok: false,
			channel: channel.name,
			reason: `${status.detail}; the existing daemon record is retained and this start is refused`
		};
	}
	if (status.state === 'living') {
		const record = status.record;
		if (record !== null && record.treeId !== ctx.treeId) {
			return {
				ok: false,
				channel: channel.name,
				reason:
					`the ${channel.name} daemon (pid ${record.pid}) is running for another fork tree, ${record.treePath}; ` +
					'stop it there first: codkit build down --channel ' +
					channel.name
			};
		}
		return {
			ok: true,
			channel: channel.name,
			action: 'already-running',
			pid: record?.pid ?? 0,
			log: logPath(ctx.patchesDir, channel.name)
		};
	}

	const missing = missingScript(ctx.treeDir, channel.script);
	if (missing !== null) {
		return { ok: false, channel: channel.name, reason: missing };
	}

	const reservation: DaemonRecord = {
		codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
		channel: channel.name,
		script: channel.script,
		pid: 0,
		cmdline: channel.script,
		startedAt: new Date().toISOString(),
		treeId: ctx.treeId,
		treePath: ctx.treeDir,
		nonce: randomUUID()
	};
	runtime?.afterStaleRead?.();
	if (status.recordBytes !== undefined && !removeRecord(ctx.patchesDir, channel.name, lock, status.recordBytes)) {
		return { ok: false, channel: channel.name, reason: 'the prior daemon record changed before stale-record retirement' };
	}
	if (!createReservation(ctx.patchesDir, reservation, lock)) {
		return {
			ok: false,
			channel: channel.name,
			reason: `another codkit process is starting the ${channel.name} daemon right now (${recordPath(ctx.patchesDir, channel.name)})`
		};
	}
	const reserved = readRecordState(ctx.patchesDir, channel.name);
	if (reserved.state !== 'valid' || reserved.record.nonce !== reservation.nonce || reserved.record.pid !== 0) {
		return { ok: false, channel: channel.name, reason: 'the exclusive daemon reservation could not be verified' };
	}
	let spawned: SpawnedDaemon | null = null;
	try {
		runtime?.afterReservation?.();
		// Rotation happens only after the exclusive reservation, and a failure
		// removes that exact reservation instead of leaving a phantom start.
		rotateLog(ctx.patchesDir, channel.name, lock);
		spawned = (runtime?.spawn ?? ((tree, selected) => spawnDaemon(ctx.patchesDir, tree, selected, lock)))(ctx.treeDir, channel);
		runtime?.beforeFinalize?.();
		if (!finalizeReservation(ctx.patchesDir, reservation, spawned.pid, lock, runtime?.afterFinalizeCompare)) {
			// The catch below is the single place that stops the child, so a
			// displaced transition cannot terminate it twice and a newly added
			// failure path cannot forget to terminate it at all.
			throw ckError(
				'LOCKED',
				`the ${channel.name} reservation was displaced before its pid transition`,
				'the spawned daemon was terminated; inspect the preserved record before retrying'
			);
		}
	} catch (error) {
		// Anything that throws after the spawn leaves a detached watcher over the
		// tree. Retiring the reservation without killing it would leave a process
		// no record names: `status` would report nothing, `down` would report
		// not-running, and the next `up` would start a second watcher over the
		// same tree. The child dies first, and only then is the reservation
		// retired - and a termination that itself fails is reported, not
		// swallowed under the original error.
		if (spawned !== null) {
			try {
				spawned.terminate();
			} catch (terminationError) {
				throw ckError(
					'INTERNAL',
					`the ${channel.name} daemon was started but could not be stopped after ${messageOf(error)}: ${messageOf(terminationError)}`,
					`find and stop the process group of pid ${spawned.pid} manually; its reservation was preserved`
				);
			}
		}
		const current = readRecordState(ctx.patchesDir, channel.name);
		if (current.state === 'valid' && Buffer.from(current.bytes).equals(Buffer.from(daemonRecordBytes(reservation)))) {
			removeRecord(ctx.patchesDir, channel.name, lock, current.bytes);
		}
		throw error;
	}
	return { ok: true, channel: channel.name, action: 'started', pid: spawned.pid, log: logPath(ctx.patchesDir, channel.name) };
}

/**
 * `npm run <script>` with cwd = the tree, detached, output appended to the log.
 * The node that runs the daemon is the node running codkit: its directory goes
 * first on PATH, which is the whole of what the tree's launcher needs to agree
 * with us about the runtime.
 */
function spawnDaemon(patchesDir: string, treeDir: string, channel: ChannelConfig, lock: DaemonChannelLock): SpawnedDaemon {
	const fd = openLogAppend(patchesDir, channel.name, lock);
	try {
		const invocation = daemonInvocation(channel.script);
		const child = spawn(invocation.command, [...invocation.args], {
			cwd: treeDir,
			detached: true,
			stdio: ['ignore', fd, fd],
			env: daemonEnv(),
			shell: false,
			windowsHide: true
		});
		// The daemon outlives this command; nothing here waits for it, and a
		// failure to even start it must not surface as an unhandled event.
		child.on('error', () => undefined);
		const pid = child.pid;
		if (pid === undefined) {
			throw ckError('INTERNAL', `cannot start the ${channel.name} daemon: npm did not start`, 'install npm and make sure it is on PATH');
		}
		child.unref();
		return { pid, terminate: () => terminateSpawnedDaemon(pid, channel.script) };
	} finally {
		closeLog(fd);
	}
}

/**
 * The argv that starts `npm run <script>` as a detached daemon.
 *
 * Detached on every platform. On POSIX it makes npm the leader of the process
 * group that `down` signals. On Windows it is the only way to outlive
 * `build up`: libuv places every attached child in a job object that kills it
 * when codkit exits, so an attached daemon died with the command that started
 * it and left an empty log.
 *
 * Windows also runs npm's own entry point on this node instead of `npm.cmd`. A
 * detached `cmd.exe` has no console, so the npm it starts is given a fresh one
 * and loses the log handles: the daemon ran, and its log stayed empty. Node
 * started directly receives the log handles itself and passes them on
 * (PROP-010 ##DAEMON-WINDOWS-LAUNCH).
 */
export function daemonInvocation(
	script: string,
	platform: NodeJS.Platform = process.platform,
	execPath: string = process.execPath,
	exists: (path: string) => boolean = existsSync
): ProcessInvocation {
	if (platform !== 'win32') {
		return { command: 'npm', args: ['run', script] };
	}
	const npmCli = win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
	if (!exists(npmCli)) {
		throw ckError(
			'INTERNAL',
			`cannot start the ${script} daemon: npm is not installed next to ${execPath}`,
			`install npm with this node so that ${npmCli} exists`
		);
	}
	return { command: execPath, args: [npmCli, 'run', script] };
}

/**
 * Stop the child this command just spawned, after proving it is still that
 * child.
 *
 * "We spawned this pid milliseconds ago" is not proof. Once the child exits and
 * is reaped its pid is reusable, and a reused pid that calls `setsid` leads a
 * process group with the same id - so a cleanup that kills `-pid` on the
 * strength of the spawn alone can kill a stranger's whole group. Every other
 * signal site in this module proves identity first; this one now does too,
 * using the same argv comparison.
 *
 * The three answers are distinct on purpose. Gone is silence: there is nothing
 * to stop. Proven is the group kill the leak prevention needs. Unproven is a
 * loud refusal naming the pid - never a silent skip, because skipping is how
 * the watcher leak this path exists to prevent comes back, and never a kill,
 * because killing is how a stranger's group dies.
 *
 * Residual, stated rather than hidden: between `fork` and `exec` the child's
 * argv is not yet the daemon's, so a cleanup that raced that window would
 * report unproven for a process that is genuinely ours. It cannot reach that
 * window in practice - every caller has already completed a record comparison
 * and an atomic write - and the failure it produces is a report, not a stray
 * kill.
 */
export function terminateSpawnedDaemon(pid: number, script: string, probe: ProcessProbeOptions = {}): void {
	const args = processArgs(pid, probe);
	if (args === null) {
		return;
	}
	if (!argsMatch(args, script)) {
		throw ckError(
			'INTERNAL',
			`pid ${pid} no longer runs ${script}; refusing to signal a process group codkit cannot prove is its own`,
			`inspect pid ${pid} and stop the ${script} daemon manually if it is still running; nothing was signalled`
		);
	}
	if ((probe.platform ?? process.platform) === 'win32') {
		spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], { encoding: 'utf8', shell: false, windowsHide: true });
		return;
	}
	if (probe.signal !== undefined) {
		probe.signal(-pid, 'SIGKILL');
		return;
	}
	try {
		process.kill(-pid, 'SIGKILL');
	} catch {
		// The owned child exited between the proof and the signal.
	}
}

function daemonEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	const nodeDir = dirname(process.execPath);
	const path = env['PATH'] ?? env['Path'] ?? '';
	env['PATH'] = path === '' ? nodeDir : `${nodeDir}${delimiter}${path}`;
	return env;
}

/** Diagnosis when the tree does not carry the npm script a channel names. */
function missingScript(treeDir: string, script: string): string | null {
	const manifest = join(treeDir, 'package.json');
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(manifest, 'utf8'));
	} catch {
		// No readable manifest: let npm produce the diagnosis instead of guessing.
		return null;
	}
	const scripts = isRecord(raw) ? raw['scripts'] : undefined;
	if (!isRecord(scripts)) {
		return null;
	}
	if (typeof scripts[script] === 'string') {
		return null;
	}
	return `the fork tree has no npm script "${script}" (${manifest}); the channel cannot be started from this tree`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// down
// ---------------------------------------------------------------------------

export type DownResult = {
	readonly channel: string;
	readonly action: 'stopped' | 'killed' | 'not-running';
	readonly pid: number;
};

/** How long a channel is given to stop on SIGTERM before it is killed. */
export const TERM_GRACE_MS = 2_000;

const KILL_POLL_MS = 50;

/**
 * Stop a channel by its process group. A detached daemon leads its own group,
 * so the group is the daemon plus everything the npm script started - which is
 * where the compiler actually lives.
 */
export async function downChannel(patchesDir: string, channel: string, probe: BoundProbe): Promise<DownResult> {
	const lock = acquireDaemonChannelLock(patchesDir, channel, `build down ${channel}`, {
		...(probe.onWarn === undefined ? {} : { onWarn: probe.onWarn })
	});
	try {
		probe.afterLock?.();
		return await downChannelLocked(patchesDir, channel, lock, probe);
	} finally {
		lock.release();
	}
}

async function downChannelLocked(patchesDir: string, channel: string, lock: DaemonChannelLock, probe: BoundProbe): Promise<DownResult> {
	assertDaemonChannelLock(lock, patchesDir, channel);
	let status = statusOf(patchesDir, channel, probe);
	probe.afterRecordRead?.();
	if (status.state === 'starting' && status.record !== null) {
		// `starting` is transient: within the settle window the record resolves
		// into living, dead or unknown, so a teardown that races a fresh spawn
		// waits the window out and re-probes once instead of refusing a daemon
		// it merely caught mid-start. What the resolved state says then happens
		// below unchanged - including the refusal, when it resolved to unknown
		// or the reservation nobody finished. No pid is signalled while its
		// identity is unproven: the wait is for proof, not a discarded check.
		await waitStartSettle(status.record.startedAt, probe);
		status = statusOf(patchesDir, channel, probe);
	}
	if (status.state === 'unknown' || status.state === 'starting') {
		throw ckError(
			'INTERNAL',
			`${channel}: ${status.detail}; refusing to discard daemon record ${recordPath(patchesDir, channel)}`,
			status.record === null
				? 'repair or remove the invalid record manually only after proving no daemon owns it'
				: `inspect recorded pid ${status.record.pid}; retry only after startup or native teardown is proven`
		);
	}
	if (status.state !== 'living' || status.record === null) {
		// No daemon record at all is not a conflict: there is no daemon and
		// nothing to retire, so the channel is simply not running. Refusing here
		// turned "absent" into "changed under the operation" - a conflict that
		// never happened - and made every `down` over a never-started channel
		// fail. The refusal below stays reserved for a record that exists and
		// either changed under this operation or could not be retired.
		if (status.recordBytes === undefined) {
			return { channel, action: 'not-running', pid: 0 };
		}
		probe.beforeRemove?.();
		if (!removeRecord(patchesDir, channel, lock, status.recordBytes, probe.afterRemoveCompare)) {
			throw ckError(
				'LOCKED',
				`${channel}: daemon record changed before dead-record retirement`,
				'retry after inspecting the current record'
			);
		}
		return { channel, action: 'not-running', pid: status.record?.pid ?? 0 };
	}

	const pid = status.record.pid;
	probe.beforeTerm?.();
	assertRecordGeneration(patchesDir, channel, status.recordBytes, probe.afterTermCompare);
	let teardownProven = signalGroup(pid, 'SIGTERM', probe);
	let action: 'stopped' | 'killed' = 'stopped';
	const grace = probe.termGraceMs ?? TERM_GRACE_MS;
	if (!(await waitGroupGone(pid, grace, probe))) {
		probe.beforeKill?.();
		assertRecordGeneration(patchesDir, channel, status.recordBytes, probe.afterKillCompare);
		teardownProven = signalGroup(pid, 'SIGKILL', probe);
		if (!(await waitGroupGone(pid, grace, probe))) {
			// Keep the record: losing it would make the still-live group
			// unmanageable on the next `build down`, exactly the cross-run leak this
			// path exists to prevent.
			throw ckError(
				'INTERNAL',
				`process group ${pid} for ${channel} is still alive after SIGKILL`,
				`inspect process group ${pid}; the daemon record was preserved for a retry`
			);
		}
		action = 'killed';
	}
	if ((probe.platform ?? process.platform) === 'win32' && !teardownProven) {
		throw ckError(
			'INTERNAL',
			`${channel}: the recorded Windows root disappeared without a successful native tree teardown`,
			`inspect descendants of recorded pid ${pid}; the daemon record was preserved`
		);
	}
	probe.beforeRemove?.();
	assertRecordGeneration(patchesDir, channel, status.recordBytes);
	if (status.recordBytes === undefined || !removeRecord(patchesDir, channel, lock, status.recordBytes, probe.afterRemoveCompare)) {
		throw ckError('LOCKED', `${channel}: daemon record changed before completed teardown`, 'inspect the current record; it was preserved');
	}
	return { channel, action, pid };
}

function assertRecordGeneration(patchesDir: string, channel: string, expected: Uint8Array | undefined, afterCompare?: () => void): void {
	const current = readRecordState(patchesDir, channel);
	if (expected === undefined || current.state !== 'valid' || !Buffer.from(current.bytes).equals(Buffer.from(expected))) {
		throw ckError(
			'LOCKED',
			`${channel}: daemon record generation changed during the locked operation`,
			'no later signal or removal was attempted'
		);
	}
	afterCompare?.();
	const confirmed = readRecordState(patchesDir, channel);
	if (confirmed.state !== 'valid' || !Buffer.from(confirmed.bytes).equals(Buffer.from(current.bytes))) {
		throw ckError('LOCKED', `${channel}: daemon record generation changed after comparison`, 'no later signal or removal was attempted');
	}
}

function signalGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL', probe: ProcessProbeOptions): boolean {
	const platform = probe.platform ?? process.platform;
	const target = platform === 'win32' ? pid : -pid;
	if (probe.signal !== undefined) {
		return probe.signal(target, signal) !== false;
	}
	if (platform === 'win32') {
		// Windows has no process groups to signal; the tree of the pid is what
		// taskkill takes.
		const result = spawnSync('taskkill', ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], {
			encoding: 'utf8',
			shell: false,
			windowsHide: true
		});
		return result.status === 0;
	}
	try {
		process.kill(target, signal);
		return true;
	} catch (error) {
		// ESRCH: the group is already gone, which is the outcome we wanted.
		// Anything else - EPERM for a group that belongs to another uid, EINVAL
		// for a target this platform refuses - is a refused signal, not a
		// delivered one. Reporting it as success would let a teardown believe
		// it had proven a kill it never sent; `teardownProven` is load-bearing
		// on exactly that belief.
		if (errnoOf(error) === 'ESRCH') return true;
		throw ckError(
			'INTERNAL',
			`cannot signal process group ${pid} with ${signal}: ${messageOf(error)}`,
			'inspect the process group; the daemon record was preserved for a retry'
		);
	}
}

/**
 * What a surviving process group says about its own ownership.
 *
 * Once our group empties, its id is reusable, and a reused pid that calls
 * `setsid` leads a group with the same id - so membership alone is not proof.
 * The daemon and everything its npm script starts inherit the tree as their
 * working directory, which is the cheapest corroboration available.
 *
 * The three answers are deliberately distinct. `foreign` is positive evidence
 * against us and downgrades the channel to `unknown`, which refuses both the
 * signal and a duplicate start. `unproven` is the absence of evidence - the
 * platform probe carries no working directory at all (macOS `ps`, Windows), or
 * every member belongs to another user - and keeps the group living, because
 * calling it dead would discard the only kill handle of a real daemon and leak
 * the watcher across runs. That residual is stated, not hidden.
 */
function groupOwnership(pid: number, treePath: string, probe: ProcessProbeOptions): 'ours' | 'foreign' | 'unproven' {
	const platform = probe.platform ?? process.platform;
	const members = processTable(probe).filter((process) => process.pgid === pid);
	const readable = members.filter((process) => process.cwd !== null);
	if (readable.length === 0) return 'unproven';
	return readable.some((process) => sameEffectivePath(process.cwd ?? '', treePath, platform)) ? 'ours' : 'foreign';
}

/**
 * Whether any member of a POSIX daemon process group is still alive. Exported
 * for the process-probe contract tests; Windows uses taskkill /t and has no
 * process-group identity to query.
 */
export function processGroupAlive(pid: number, probe: ProcessProbeOptions = {}): boolean {
	if ((probe.platform ?? process.platform) === 'win32') {
		return processArgs(pid, probe) !== null;
	}
	return processTable(probe).some((process) => process.pgid === pid);
}

async function waitGroupGone(pid: number, timeoutMs: number, probe: ProcessProbeOptions): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (!processGroupAlive(pid, probe)) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await delay(KILL_POLL_MS);
	}
}

export function delay(ms: number): Promise<void> {
	return new Promise((done) => {
		setTimeout(done, ms);
	});
}

// ---------------------------------------------------------------------------
// Reading the log: ANSI, passes, errors
// ---------------------------------------------------------------------------

// Colour sequences (CSI) and window-title sequences (OSC). The daemons write
// them whether or not anything is attached to the terminal, so every line is
// stripped before it is matched (PROP-010 section 2).
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_OSC, '').replace(ANSI_CSI, '');
}

/**
 * Log content as lines, ANSI removed, without the trailing empty one. A bare
 * carriage return separates lines too: a daemon that redraws a progress line
 * writes one, and what follows it is a new line for every purpose here.
 */
export function logLines(text: string): readonly string[] {
	const lines = stripAnsi(text).split(/\r\n|\n|\r/);
	if (lines.length > 0 && lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

export type Pass = {
	readonly startIndex: number;
	readonly endIndex: number;
	readonly lines: readonly string[];
};

function matchesAny(line: string, patterns: readonly RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(line));
}

/** Whether a line really closes a pass: an end that a guard vetoes does not. */
export function isPassEnd(line: string, channel: ChannelConfig): boolean {
	if (matchesAny(line, channel.falseEndGuards)) {
		return false;
	}
	return matchesAny(line, channel.passEnd);
}

/**
 * The last pass of the log: the last `passStart` and the first real end after
 * it (PROP-010 section 2). Null while the daemon is still inside the pass, or
 * has not started one.
 */
export function findLastPass(lines: readonly string[], channel: ChannelConfig): Pass | null {
	let startIndex = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		const line = lines[index];
		if (line !== undefined && matchesAny(line, channel.passStart)) {
			startIndex = index;
			break;
		}
	}
	if (startIndex === -1) {
		return null;
	}
	for (let index = startIndex + 1; index < lines.length; index += 1) {
		const line = lines[index];
		if (line !== undefined && isPassEnd(line, channel)) {
			return { startIndex, endIndex: index, lines: lines.slice(startIndex, index + 1) };
		}
	}
	return null;
}

/**
 * The newest pass in the log that really ended: the last end line, and the start
 * that opened it.
 *
 * `findLastPass` answers a different question - has the pass the daemon is
 * currently inside finished - and is null while a new one is running, which is
 * what makes it the right thing to wait on. This one is for a daemon that will
 * never answer again: whatever it started last and did not finish, the newest
 * finished pass is still the result of the tree as the daemon last saw it.
 */
export function findLastFinishedPass(lines: readonly string[], channel: ChannelConfig): Pass | null {
	for (let endIndex = lines.length - 1; endIndex >= 0; endIndex -= 1) {
		const end = lines[endIndex];
		if (end === undefined || !isPassEnd(end, channel)) {
			continue;
		}
		for (let startIndex = endIndex - 1; startIndex >= 0; startIndex -= 1) {
			const start = lines[startIndex];
			if (start !== undefined && matchesAny(start, channel.passStart)) {
				return { startIndex, endIndex, lines: lines.slice(startIndex, endIndex + 1) };
			}
		}
		// An end with no start before it: the log begins in the middle of a pass
		// (a rotation, a truncation), and there is no pass to report.
		return null;
	}
	return null;
}

export type ParsedError = {
	readonly file: string;
	readonly line: number | null;
	readonly column: number | null;
	/** Diagnostic code when the daemon prints one (TS1234), null otherwise. */
	readonly code: string | null;
	readonly message: string;
	readonly raw: string;
};

/**
 * Diagnostics inside a pass. The shape of a match is read from the groups
 * rather than from a per-channel branch: group 1 is the file, numeric groups
 * are the position, a TSnnnn group is the code and the last group is the text.
 */
export function parseErrorLines(lines: readonly string[], channel: ChannelConfig): readonly ParsedError[] {
	const parsed: ParsedError[] = [];
	for (const line of lines) {
		for (const pattern of channel.errorLine) {
			const match = pattern.exec(line);
			if (match === null) {
				continue;
			}
			parsed.push(errorOf(match, line));
			break;
		}
	}
	return parsed;
}

function errorOf(match: RegExpExecArray, raw: string): ParsedError {
	const groups = match.slice(1).map((group) => group ?? '');
	const file = groups[0] ?? '';
	const numbers: number[] = [];
	let code: string | null = null;
	for (const group of groups.slice(1)) {
		if (/^\d+$/.test(group) && numbers.length < 2) {
			numbers.push(Number.parseInt(group, 10));
			continue;
		}
		if (/^TS\d+$/.test(group)) {
			code = group;
		}
	}
	const message = groups.length > 1 ? (groups[groups.length - 1] ?? '') : raw;
	return {
		file,
		line: numbers[0] ?? null,
		column: numbers[1] ?? null,
		code,
		message,
		raw
	};
}

/**
 * Why an errorCountLine pattern cannot be a count detector: group 1 must be
 * able to capture the number, because that is the only group `errorCountFrom`
 * reads. A pattern with no capturing group matches the count line and yields
 * nothing - the false-green shape REPAIR-006 closed.
 */
export function countPatternProblem(pattern: string): string | null {
	let escaped = false;
	let inClass = false;
	let capturing = false;
	for (let index = 0; index < pattern.length; index += 1) {
		const character = pattern[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (inClass) {
			if (character === ']') {
				inClass = false;
			}
			continue;
		}
		if (character === '[') {
			inClass = true;
			continue;
		}
		if (character !== '(') {
			continue;
		}
		const next = pattern[index + 1];
		if (next === undefined || next === ':' || next === '=' || next === '!') {
			continue;
		}
		if (next === '<') {
			const after = pattern[index + 2];
			if (after === '=' || after === '!') {
				continue;
			}
		}
		capturing = true;
	}
	return capturing ? null : 'has no capturing group for the error count (group 1)';
}

/**
 * The error count a pass states about itself, or null when it states none. The
 * typecheck channel needs it: the counter in its end line is a flag (0 or 1),
 * so the only real number is the one on its own line.
 *
 * A pattern that MATCHES a line but cannot state the number (group 1 absent or
 * not numeric) is a malformed detector, and that is a configuration error -
 * never an absent summary that silently falls back to the parsed diagnostics.
 */
export function errorCountFrom(lines: readonly string[], channel: ChannelConfig): number | null {
	let count: number | null = null;
	for (const line of lines) {
		for (const pattern of channel.errorCountLine) {
			const match = pattern.exec(line);
			if (match === null) {
				continue;
			}
			const captured = match[1];
			if (captured === undefined || !/^\d+$/.test(captured)) {
				throw ckError(
					'CONFIG',
					`channels.${channel.name}.errorCountLine: ${pattern.source} matched a count line but group 1 ` +
						(captured === undefined ? 'captured nothing' : `captured ${JSON.stringify(captured)} instead of the number`),
					'fix the pattern so group 1 captures the error count; a matched count line without the number is a configuration error, not an absent summary',
					BUILD_WATCH_RELATIVE_PATH
				);
			}
			count = Number.parseInt(captured, 10);
		}
	}
	if (count === null && channel.errorCountLine.length > 0 && channel.errorLine.length === 0) {
		throw ckError(
			'CONFIG',
			`channels.${channel.name}.errorCountLine did not match the completed pass, and the channel has no diagnostic detector to fall back to`,
			'update the count pattern for the current log wording; missing required count evidence is not zero',
			BUILD_WATCH_RELATIVE_PATH
		);
	}
	return count;
}

// ---------------------------------------------------------------------------
// --mine: which diagnostics are about code this delta owns
// ---------------------------------------------------------------------------

/**
 * Tree-relative POSIX form of the path a diagnostic names. Daemons print both
 * absolute and tree-relative paths; the comparison needs one form.
 */
export function treeRelativePath(file: string, treeDir: string): string {
	const posix = file.split('\\').join('/');
	const treePosix = treeDir.split('\\').join('/');
	let relative = posix;
	if (isAbsolute(file) && (posix === treePosix || posix.startsWith(`${treePosix}/`))) {
		relative = posix.slice(treePosix.length + 1);
	}
	while (relative.startsWith('./')) {
		relative = relative.slice(2);
	}
	return relative;
}

/**
 * What `inventoryTargets` needs of an inventory. Structural on purpose: the
 * filter is about paths and layers, and stating that keeps it testable without
 * a whole generated document.
 */
export type InventoryTargetSource = {
	readonly entries: readonly { readonly layer: string; readonly files: readonly string[] }[];
};

/**
 * Paths of the tree the delta touches, as `--mine` understands them: every file
 * an inventory entry names, with the own layers mapped from their place inside
 * `delta/own/` to where they land in the tree.
 */
export function inventoryTargets(inventory: InventoryTargetSource, ownRoot: string): ReadonlySet<string> {
	const targets = new Set<string>();
	for (const entry of inventory.entries) {
		const inOwn = entry.layer === 'own' || entry.layer === 'service-override';
		for (const file of entry.files) {
			targets.add(inOwn ? `${ownRoot}/${file}` : file);
		}
	}
	return targets;
}

/** Own code by construction, or a file the inventory names (PROP-007 section 13). */
export function isMine(relativePath: string, ownRoot: string, targets: ReadonlySet<string>): boolean {
	return relativePath.startsWith(`${ownRoot}/`) || targets.has(relativePath);
}

// ---------------------------------------------------------------------------
// build errors
// ---------------------------------------------------------------------------

export const DEFAULT_ERRORS_TIMEOUT_MS = 600_000;

/** Interval of the file poll while a pass is still running (PROP-010 section 2). */
export const POLL_INTERVAL_MS = 500;

export type PassReport = {
	readonly channel: string;
	readonly lines: readonly string[];
	readonly errors: readonly ParsedError[];
	/** What the pass says about itself, or the number of parsed diagnostics. */
	readonly errorCount: number;
	/** True when the count came from the pass' own summary line. */
	readonly countFromSummary: boolean;
};

export type PassOutcome =
	| { readonly state: 'ok'; readonly report: PassReport }
	| { readonly state: 'timeout' }
	/** The daemon stopped while the pass was still running. */
	| { readonly state: 'gone' };

export type WaitOptions = {
	readonly timeoutMs: number;
	readonly pollMs?: number;
	readonly probe: BoundProbe;
	readonly afterSnapshot?: () => void;
	readonly beforeCertify?: () => void;
};

/**
 * Wait for the current pass of a channel to finish and report it: every line of
 * the pass, the diagnostics parsed out of them, and the count the pass states.
 */
export async function readPass(patchesDir: string, channel: ChannelConfig, options: WaitOptions): Promise<PassOutcome> {
	const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
	const deadline = Date.now() + options.timeoutMs;
	const snapshot = readRecordState(patchesDir, channel.name);
	if (snapshot.state === 'invalid') throw invalidRecordRefusal(patchesDir, channel.name, snapshot.detail);
	if (snapshot.state === 'absent') return { state: 'gone' };
	assertSnapshotTree(snapshot.record, options.probe);
	options.afterSnapshot?.();
	for (;;) {
		assertSameRecordSnapshot(patchesDir, channel.name, snapshot.bytes);
		const status = statusOf(patchesDir, channel.name, options.probe);
		if (status.state === 'unknown') {
			throw ckError(
				'INTERNAL',
				`${channel.name}: ${status.detail}; refusing to read or certify the existing log`,
				'finish or repair daemon ownership first'
			);
		}
		if (status.state === 'starting') {
			if (Date.now() >= deadline) return { state: 'timeout' };
			await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
			continue;
		}
		// The log first: a daemon that finished a pass and then died still has an
		// answer to give.
		const pass = findLastPass(logLines(readRuntimeLog(patchesDir, channel.name)), channel);
		if (pass !== null) {
			options.beforeCertify?.();
			assertSameRecordSnapshot(patchesDir, channel.name, snapshot.bytes);
			return { state: 'ok', report: reportOf(channel, pass) };
		}
		if (status.state !== 'living') {
			return { state: 'gone' };
		}
		if (Date.now() >= deadline) {
			return { state: 'timeout' };
		}
		await delay(Math.min(pollMs, Math.max(0, deadline - Date.now())));
	}
}

/**
 * The last finished pass of a channel as its log has it, without waiting for
 * anything and without asking whether a daemon is running. `errors` reads it
 * when the channel is dead: a daemon that finished a pass and then went away
 * still has that result to give (PROP-007 sec. 13), and only a log without a
 * finished pass leaves the command with nothing to say.
 */
export function readFinishedPass(
	patchesDir: string,
	channel: ChannelConfig,
	options: { readonly probe: BoundProbe; readonly afterSnapshot?: () => void; readonly beforeCertify?: () => void }
): PassReport | null {
	const snapshot = readRecordState(patchesDir, channel.name);
	if (snapshot.state === 'invalid') throw invalidRecordRefusal(patchesDir, channel.name, snapshot.detail);
	if (snapshot.state === 'absent') return null;
	assertSnapshotTree(snapshot.record, options.probe);
	options.afterSnapshot?.();
	assertSameRecordSnapshot(patchesDir, channel.name, snapshot.bytes);
	const pass = findLastFinishedPass(logLines(readRuntimeLog(patchesDir, channel.name)), channel);
	if (pass === null) return null;
	options.beforeCertify?.();
	assertSameRecordSnapshot(patchesDir, channel.name, snapshot.bytes);
	return reportOf(channel, pass);
}

/**
 * An unreadable or schema-invalid record is an environment failure for every
 * log reader. Collapsing it into `gone`/`null` would let a stale finished pass
 * certify a channel whose ownership codkit cannot prove (PROP-010).
 */
function invalidRecordRefusal(patchesDir: string, channel: string, detail: string): Error {
	return ckError(
		'INTERNAL',
		`${channel}: daemon record is unreadable or invalid: ${detail}; refusing to read or certify the existing log`,
		`repair or remove ${recordPath(patchesDir, channel)} manually only after proving no daemon owns it`
	);
}

function assertSameRecordSnapshot(patchesDir: string, channel: string, expected: Uint8Array): void {
	const current = readRecordState(patchesDir, channel);
	if (current.state !== 'valid' || !Buffer.from(current.bytes).equals(Buffer.from(expected))) {
		throw ckError(
			'LOCKED',
			`${channel}: daemon record/log generation changed while errors was reading it`,
			'retry against one stable daemon generation'
		);
	}
}

function assertSnapshotTree(record: DaemonRecord, probe: ProcessProbeOptions): void {
	if (
		(probe.expectedTreeId !== undefined && record.treeId !== probe.expectedTreeId) ||
		(probe.expectedTreePath !== undefined && !sameEffectivePath(record.treePath, probe.expectedTreePath, probe.platform))
	) {
		throw ckError(
			'CONFIG',
			`daemon record belongs to another tree (${record.treePath}, id ${record.treeId})`,
			'run build commands against the recorded tree'
		);
	}
}

function reportOf(channel: ChannelConfig, pass: Pass): PassReport {
	const errors = parseErrorLines(pass.lines, channel);
	const stated = errorCountFrom(pass.lines, channel);
	return {
		channel: channel.name,
		lines: pass.lines,
		errors,
		errorCount: stated ?? errors.length,
		countFromSummary: stated !== null
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
