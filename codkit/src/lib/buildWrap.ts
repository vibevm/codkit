/** @scope spec://codkit/modules/codkit/PROP-010#root */
// The watch-daemon wrapper of the fork tree: channels, their processes, their
// logs, and the pass boundaries inside those logs.
//
// Contract: PROP-010 section 2. codkit starts the tree's own npm scripts as
// detached processes and captures their stdout and stderr into
// `.codkit/build/<channel>.log`; the record in `.codkit/build/<channel>.json`
// is a hint, never the truth - a channel is living only when a process with the
// recorded pid exists AND its command line is still the one we started. The
// transpile channel empties `out/` when it starts, so a living channel is never
// restarted, and a watcher started by somebody else over the same tree makes
// `up` refuse rather than compete with it.
//
// Where the boundaries of a pass are is data, not code: `codkit/config/build-watch.json`
// carries the patterns, this module only applies them.
//
// The daemon files live under the patchset root, next to the other `.codkit/`
// state (locks, per-tree caches, generated documents), because the fork tree
// must stay clean for git and survive `--fresh` cleanup. Which tree a daemon
// serves is therefore part of the record instead of the path.

import { spawn, spawnSync } from 'node:child_process';
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { delimiter, dirname, isAbsolute, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { loadBaseConfig } from './configFile.ts';
import { ckError } from './messages.ts';
import { ownTargetRelativeDir } from './ownCopy.ts';
import { resolveContainedPath } from './pathSafety.ts';

// ---------------------------------------------------------------------------
// Channel configuration
// ---------------------------------------------------------------------------

export const BUILD_WATCH_RELATIVE_PATH = 'codkit/config/build-watch.json';

/** Channels `up` starts when no `--channel` is given (PROP-007 section 13). */
export const DEFAULT_UP_CHANNELS: readonly string[] = ['transpile', 'typecheck'];

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
		channels: z.record(z.string().min(1), channelSchema)
	})
	.strict();

/** Where this module sits, so the shipped configuration can be found from it. */
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const watchCache = new Map<string, BuildWatch>();

/**
 * Read the shipped pass-boundary profile, or a strict profile explicitly
 * declared by the selected patch set. A same-named undeclared file never wins.
 */
export function loadBuildWatch(patchesDir?: string): BuildWatch {
	const path = buildWatchPath(patchesDir);
	const cached = watchCache.get(path);
	if (cached !== undefined) return cached;
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot be read: ${messageOf(error)}`,
			'build-watch.json ships with codkit; restore it from the repository',
			BUILD_WATCH_RELATIVE_PATH
		);
	}
	const parsed = buildWatchSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
		throw ckError(
			'CONFIG',
			`${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`,
			'see PROP-010 section 2 for the pass-boundary data',
			BUILD_WATCH_RELATIVE_PATH
		);
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
		throw ckError('CONFIG', 'channels: at least one channel is required', 'see PROP-010 section 2', BUILD_WATCH_RELATIVE_PATH);
	}
	const watch: BuildWatch = { channels };
	watchCache.set(path, watch);
	return watch;
}

function buildWatchPath(patchesDir: string | undefined): string {
	if (patchesDir === undefined) return join(codkitRoot, 'config', 'build-watch.json');
	const configured = loadBaseConfig(patchesDir)?.buildWatchFile ?? null;
	if (configured === null) return join(codkitRoot, 'config', 'build-watch.json');
	const resolved = resolveContainedPath(patchesDir, configured);
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`buildWatchFile is unsafe or unreadable: ${resolved.reason}`,
			'point buildWatchFile at a real non-symlink JSON file inside the patch-set repository',
			'codkit.json'
		);
	}
	return resolved.absolute;
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
	const names = requested === null ? fallback : requested === ALL_CHANNELS ? watch.channels.map((channel) => channel.name) : [requested];
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

// ---------------------------------------------------------------------------
// Locations and records
// ---------------------------------------------------------------------------

/** Directory of daemon logs and records, relative to the patchset root. */
export const BUILD_DIR = '.codkit/build';

export function buildDir(patchesDir: string): string {
	return join(patchesDir, ...BUILD_DIR.split('/'));
}

export function logPath(patchesDir: string, channel: string): string {
	return join(buildDir(patchesDir), `${channel}.log`);
}

/** The single rotated generation kept beside the current log (PROP-012 section 2). */
export function rotatedLogPath(patchesDir: string, channel: string): string {
	return `${logPath(patchesDir, channel)}.1`;
}

export function recordPath(patchesDir: string, channel: string): string {
	return join(buildDir(patchesDir), `${channel}.json`);
}

export const DAEMON_RECORD_SCHEMA_VERSION = 1;

export type DaemonRecord = {
	readonly codkitBuildDaemon: number;
	readonly channel: string;
	readonly script: string;
	/** Process id, which is also the process-group id: 0 while a start is reserved. */
	readonly pid: number;
	/** The argv token the daemon's command line must carry to still be ours. */
	readonly cmdline: string;
	readonly startedAt: string;
	/** Which fork tree this daemon serves; the record path does not say. */
	readonly treeId: string;
	readonly treePath: string;
};

const recordSchema = z.object({
	codkitBuildDaemon: z.literal(DAEMON_RECORD_SCHEMA_VERSION),
	channel: z.string().min(1),
	script: z.string().min(1),
	pid: z.number().int().min(0),
	cmdline: z.string().min(1),
	startedAt: z.string().min(1),
	treeId: z.string().min(1),
	treePath: z.string().min(1)
});

/** The record of a channel, or null when it is absent or unreadable. */
export function readRecord(patchesDir: string, channel: string): DaemonRecord | null {
	const path = recordPath(patchesDir, channel);
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return null;
	}
	const parsed = recordSchema.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

function writeRecord(patchesDir: string, record: DaemonRecord): void {
	writeFileSync(recordPath(patchesDir, record.channel), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function removeRecord(patchesDir: string, channel: string): void {
	rmSync(recordPath(patchesDir, channel), { force: true });
}

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

export type ProcessProbeOptions = {
	readonly platform?: NodeJS.Platform;
	readonly run?: ProcessRunner;
};

const PROC = '/proc';
const POWERSHELL = 'powershell.exe';

function procAvailable(platform: NodeJS.Platform): boolean {
	return platform === 'linux' && existsSync(PROC);
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
	if (procAvailable(probe.platform)) {
		return readProcArgs(pid);
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

function readProcArgs(pid: number): readonly string[] | null {
	try {
		const raw = readFileSync(join(PROC, String(pid), 'cmdline'), 'utf8');
		const args = raw.split('\0').filter((part) => part !== '');
		// A kernel thread has an empty cmdline; it exists, and it is not ours.
		return args;
	} catch {
		return null;
	}
}

/**
 * Whether a command line still carries the token the record expects.
 *
 * Two forms have to be accepted, because npm rewrites its own process title:
 * the argv it was started with (`npm`, `run`, `watch-client`) and the single
 * string it replaces argv with (`npm run watch-client`). Both are compared word
 * by word, never as substrings - `watch-client` is a prefix of
 * `watch-client-transpile`, and probing one must never accept the other.
 */
export function argsMatch(args: readonly string[], expected: string): boolean {
	return args.some((arg) => arg === expected || arg.split(/\s+/).includes(expected));
}

/** Every process the platform lets us see, for the foreign-watcher scan. */
export function processTable(options: ProcessProbeOptions = {}): readonly ProcessInfo[] {
	const probe = probeOptions(options);
	if (procAvailable(probe.platform)) {
		return procTable();
	}
	return probe.platform === 'win32' ? windowsProcessTable(probe.run) : psTable(probe.run);
}

function procTable(): readonly ProcessInfo[] {
	let names: string[];
	try {
		names = readdirSync(PROC);
	} catch {
		return [];
	}
	const table: ProcessInfo[] = [];
	for (const name of names) {
		if (!/^\d+$/.test(name)) {
			continue;
		}
		const pid = Number.parseInt(name, 10);
		const args = readProcArgs(pid);
		if (args === null || args.length === 0) {
			continue;
		}
		table.push({ pid, pgid: readProcPgid(pid) ?? pid, args, cwd: readProcCwd(pid) });
	}
	return table;
}

/**
 * Field 5 of `/proc/<pid>/stat` is the process group. The executable name in
 * field 2 may itself contain spaces and parentheses, so the fields are counted
 * from after its closing parenthesis.
 */
function readProcPgid(pid: number): number | null {
	let text: string;
	try {
		text = readFileSync(join(PROC, String(pid), 'stat'), 'utf8');
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

function readProcCwd(pid: number): string | null {
	try {
		return readlinkSync(join(PROC, String(pid), 'cwd'));
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
	"@{Name='commandLine';Expression={$_.CommandLine}}";

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
		const commandLine = row['commandLine'];
		if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || typeof commandLine !== 'string' || commandLine.trim() === '') {
			continue;
		}
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

export type ChannelState = 'living' | 'dead';

export type ChannelStatus = {
	readonly channel: string;
	readonly state: ChannelState;
	readonly record: DaemonRecord | null;
	/** Why it is dead, or what it is: printed after the verdict. */
	readonly detail: string;
};

/**
 * Probe one channel. The truth is the process: a record naming a pid that is
 * gone, or a pid that is now something else entirely, describes a dead channel.
 */
export function statusOf(patchesDir: string, channel: string, probe: ProcessProbeOptions = {}): ChannelStatus {
	const record = readRecord(patchesDir, channel);
	if (record === null) {
		return { channel, state: 'dead', record: null, detail: 'no daemon record' };
	}
	if (record.pid === 0) {
		return { channel, state: 'dead', record, detail: 'a start is in progress' };
	}
	const args = processArgs(record.pid, probe);
	if (args === null) {
		return { channel, state: 'dead', record, detail: `pid ${record.pid} is gone` };
	}
	if (!argsMatch(args, record.cmdline)) {
		return { channel, state: 'dead', record, detail: `pid ${record.pid} is another process now` };
	}
	return { channel, state: 'living', record, detail: `pid ${record.pid}` };
}

// ---------------------------------------------------------------------------
// Foreign watchers
// ---------------------------------------------------------------------------

/**
 * Command-line fragments of the watchers the upstream tree starts by itself
 * (PROP-010 section 2). They are mutually exclusive with our channels: two
 * watchers over one tree fight over `out/`.
 */
export const FOREIGN_WATCHER_MARKERS: readonly string[] = ['build/next/index.ts transpile --watch', 'gulp watch-'];

export type ForeignWatcher = { readonly pid: number; readonly commandLine: string };

/**
 * Watch processes over `treeDir` that codkit did not start. Everything in the
 * process groups of our own live channels is ours by construction - a daemon we
 * started leads its group, and the compiler it runs is inside it.
 */
export function foreignWatchers(
	treeDir: string,
	ourGroups: ReadonlySet<number>,
	probe: ProcessProbeOptions = {}
): readonly ForeignWatcher[] {
	const found: ForeignWatcher[] = [];
	const platform = probe.platform ?? process.platform;
	for (const info of processTable(probe)) {
		if (info.pid === process.pid || ourGroups.has(info.pgid) || ourGroups.has(info.pid)) {
			continue;
		}
		const commandLine = info.args.join(' ');
		if (!FOREIGN_WATCHER_MARKERS.some((marker) => commandLine.includes(marker))) {
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
 * and a transpile daemon that runs out of them finishes its first pass and then
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
};

export type UpResult =
	| {
			readonly ok: true;
			readonly channel: string;
			readonly action: 'started' | 'already-running';
			readonly pid: number;
			readonly log: string;
	  }
	| { readonly ok: false; readonly channel: string; readonly reason: string };

/** How long a reserved but unfinished start stays an obstacle. */
const RESERVATION_STALE_MS = 60_000;

/**
 * Start one channel unless it is already living.
 *
 * The record file is created with 'wx' before the process exists, so two `up`
 * runs racing over the same channel are decided by the filesystem: the loser
 * refuses instead of starting a second daemon.
 */
export function upChannel(ctx: UpContext, channel: ChannelConfig): UpResult {
	const status = statusOf(ctx.patchesDir, channel.name);
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

	mkdirSync(buildDir(ctx.patchesDir), { recursive: true });
	const reservation: DaemonRecord = {
		codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
		channel: channel.name,
		script: channel.script,
		pid: 0,
		cmdline: channel.script,
		startedAt: new Date().toISOString(),
		treeId: ctx.treeId,
		treePath: ctx.treeDir
	};
	if (!reserve(ctx.patchesDir, reservation, status.record)) {
		return {
			ok: false,
			channel: channel.name,
			reason: `another codkit process is starting the ${channel.name} daemon right now (${recordPath(ctx.patchesDir, channel.name)})`
		};
	}

	// Rotation happens here and nowhere else: on a channel that is really about
	// to start. An `up` that changed nothing must not cost the log of the daemon
	// that is already running.
	rotateLog(ctx.patchesDir, channel.name);

	let pid: number;
	try {
		pid = spawnDaemon(ctx.treeDir, channel, logPath(ctx.patchesDir, channel.name));
	} catch (error) {
		removeRecord(ctx.patchesDir, channel.name);
		throw error;
	}
	writeRecord(ctx.patchesDir, { ...reservation, pid });
	return { ok: true, channel: channel.name, action: 'started', pid, log: logPath(ctx.patchesDir, channel.name) };
}

/** Create the record exclusively; an abandoned reservation is taken over. */
function reserve(patchesDir: string, record: DaemonRecord, previous: DaemonRecord | null): boolean {
	if (tryCreateRecord(patchesDir, record)) {
		return true;
	}
	// The file is there and the channel is not living: either a dead daemon's
	// record, which is stale by definition, or a reservation whose owner never
	// got to spawn.
	if (previous !== null && previous.pid === 0 && !olderThan(previous.startedAt, RESERVATION_STALE_MS)) {
		return false;
	}
	removeRecord(patchesDir, record.channel);
	return tryCreateRecord(patchesDir, record);
}

function tryCreateRecord(patchesDir: string, record: DaemonRecord): boolean {
	let handle: number;
	try {
		handle = openSync(recordPath(patchesDir, record.channel), 'wx');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
			return false;
		}
		throw error;
	}
	closeSync(handle);
	writeRecord(patchesDir, record);
	return true;
}

function olderThan(iso: string, ms: number): boolean {
	const started = Date.parse(iso);
	return Number.isNaN(started) || Date.now() - started > ms;
}

/** Rename the current log to its single kept generation (PROP-012 section 2). */
export function rotateLog(patchesDir: string, channel: string): void {
	const current = logPath(patchesDir, channel);
	if (!existsSync(current)) {
		return;
	}
	const rotated = rotatedLogPath(patchesDir, channel);
	rmSync(rotated, { force: true });
	renameSync(current, rotated);
}

/**
 * `npm run <script>` with cwd = the tree, detached, output appended to the log.
 * The node that runs the daemon is the node running codkit: its directory goes
 * first on PATH, which is the whole of what the tree's launcher needs to agree
 * with us about the runtime.
 */
function spawnDaemon(treeDir: string, channel: ChannelConfig, log: string): number {
	const fd = openSync(log, 'a');
	try {
		const child = spawn(npmCommand(), ['run', channel.script], {
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
		return pid;
	} finally {
		closeSync(fd);
	}
}

function npmCommand(): string {
	return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
export async function downChannel(patchesDir: string, channel: string, probe: ProcessProbeOptions = {}): Promise<DownResult> {
	const status = statusOf(patchesDir, channel, probe);
	if (status.state !== 'living' || status.record === null) {
		removeRecord(patchesDir, channel);
		return { channel, action: 'not-running', pid: status.record?.pid ?? 0 };
	}

	const pid = status.record.pid;
	signalGroup(pid, 'SIGTERM');
	let action: 'stopped' | 'killed' = 'stopped';
	if (!(await waitGone(pid, TERM_GRACE_MS, probe))) {
		signalGroup(pid, 'SIGKILL');
		await waitGone(pid, TERM_GRACE_MS, probe);
		action = 'killed';
	}
	removeRecord(patchesDir, channel);
	return { channel, action, pid };
}

function signalGroup(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
	if (process.platform === 'win32') {
		// Windows has no process groups to signal; the tree of the pid is what
		// taskkill takes.
		spawnSync('taskkill', ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], {
			encoding: 'utf8',
			shell: false,
			windowsHide: true
		});
		return;
	}
	try {
		process.kill(-pid, signal);
	} catch {
		// ESRCH: the group is already gone, which is the outcome we wanted.
	}
}

async function waitGone(pid: number, timeoutMs: number, probe: ProcessProbeOptions): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (processArgs(pid, probe) === null) {
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
 * The error count a pass states about itself, or null when it states none. The
 * typecheck channel needs it: the counter in its end line is a flag (0 or 1),
 * so the only real number is the one on its own line.
 */
export function errorCountFrom(lines: readonly string[], channel: ChannelConfig): number | null {
	let count: number | null = null;
	for (const line of lines) {
		for (const pattern of channel.errorCountLine) {
			const match = pattern.exec(line);
			const captured = match?.[1];
			if (captured !== undefined && /^\d+$/.test(captured)) {
				count = Number.parseInt(captured, 10);
			}
		}
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
export function inventoryTargets(inventory: InventoryTargetSource, ownDirName: string): ReadonlySet<string> {
	const ownRoot = ownTargetRelativeDir(ownDirName);
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
export function isMine(relativePath: string, ownDirName: string, targets: ReadonlySet<string>): boolean {
	const ownRoot = `${ownTargetRelativeDir(ownDirName)}/`;
	return relativePath.startsWith(ownRoot) || targets.has(relativePath);
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
};

/**
 * Wait for the current pass of a channel to finish and report it: every line of
 * the pass, the diagnostics parsed out of them, and the count the pass states.
 */
export async function readPass(patchesDir: string, channel: ChannelConfig, options: WaitOptions): Promise<PassOutcome> {
	const path = logPath(patchesDir, channel.name);
	const pollMs = options.pollMs ?? POLL_INTERVAL_MS;
	const deadline = Date.now() + options.timeoutMs;
	for (;;) {
		// The log first: a daemon that finished a pass and then died still has an
		// answer to give.
		const pass = findLastPass(logLines(readLog(path)), channel);
		if (pass !== null) {
			return { state: 'ok', report: reportOf(channel, pass) };
		}
		if (statusOf(patchesDir, channel.name).state !== 'living') {
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
export function readFinishedPass(patchesDir: string, channel: ChannelConfig): PassReport | null {
	const pass = findLastFinishedPass(logLines(readLog(logPath(patchesDir, channel.name))), channel);
	return pass === null ? null : reportOf(channel, pass);
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

function readLog(path: string): string {
	try {
		return readFileSync(path, 'utf8');
	} catch {
		// The daemon has not written anything yet, or was started elsewhere.
		return '';
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
