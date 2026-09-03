// unit: the parsing half of the build-daemon wrapper (PROP-013 sec. 3, buildWrap).
//
// Everything here is a pure function over lines of a log and over the data file
// that describes where a pass begins and ends, so nothing spawns a process and
// nothing sleeps. The daemons themselves are exercised by the e2e suite against
// the stub watcher of the fixture tree.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	BUILD_WATCH_RELATIVE_PATH,
	DAEMON_RECORD_SCHEMA_VERSION,
	DEFAULT_UP_CHANNELS,
	argsMatch,
	channelByName,
	downChannel,
	errorCountFrom,
	findLastFinishedPass,
	findLastPass,
	foreignWatchers,
	INOTIFY_MIN_WATCHES,
	INOTIFY_RECOMMENDED_WATCHES,
	inotifyWarning,
	inventoryTargets,
	isMine,
	isPassEnd,
	loadBuildWatch,
	logLines,
	parseErrorLines,
	processArgs,
	processTable,
	readRecord,
	recordPath,
	selectChannels,
	statusOf,
	stripAnsi,
	treeRelativePath
} from '../../src/lib/buildWrap.ts';
import type { ChannelConfig, ProcessRunner } from '../../src/lib/buildWrap.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** The configuration codkit ships, read through the real loader. */
const shipped = loadBuildWatch();

// Sanitized lines captured from the live watch-client daemon. Keeping these
// byte-exact catches drift between the data file and the real upstream logger.
const LIVE_GREEN_PASS = [
	'[05:56:09] Starting compilation...',
	'[05:56:22] Finished watch-client-noEmit /workspace/fork/src/tsconfig.json with 0 errors.',
	'[05:56:22] Finished compilation with 0 errors after 12110 ms'
] as const;

const LIVE_TS7027_PASS = [
	LIVE_GREEN_PASS[0],
	'[05:43:37] src/vs/patchset/test/node/patchset.resources.test.ts(80,4): error TS7027: Unreachable code detected.',
	'[05:43:37] Finished watch-client-noEmit /workspace/fork/src/tsconfig.json with 1 errors.',
	'[05:43:37] Finished compilation with 1 errors after 12353 ms'
] as const;

function channel(name: string): ChannelConfig {
	const found = channelByName(shipped, name);
	if (found === null) {
		throw new Error(`the shipped build-watch.json has no channel ${name}`);
	}
	return found;
}

/** A patchset root carrying the given build-watch.json, for the failure cases. */
function rootWith(label: string, document: string): string {
	const root = makeTempRoot(label);
	const path = join(root, ...BUILD_WATCH_RELATIVE_PATH.split('/'));
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, document, 'utf8');
	return root;
}

function declareBuildWatch(root: string): void {
	writeFileSync(
		join(root, 'codkit.json'),
		`${JSON.stringify({
			codkitConfig: 1,
			pin: { tag: '1.0.0', sha: '1'.repeat(40), date: '2026-01-01' },
			upstreamAnchorCommit: '0'.repeat(40),
			ownDirName: 'patchset',
			generatedBranchPrefix: 'codkit/applied/',
			cycleBranchPrefix: 'codkit/cycle/',
			releaseRefPrefix: 'codkit/release/',
			publishRemoteUrl: null,
			buildWatchFile: BUILD_WATCH_RELATIVE_PATH,
			conventionsExtensionFile: null
		})}\n`,
		'utf8'
	);
}

describe('build-watch.json', () => {
	it('carries the four channels of the fork tree with their npm scripts', () => {
		expect(shipped.channels.map((entry) => entry.name)).toEqual(['transpile', 'typecheck', 'extensions', 'copilot']);
		expect(channel('transpile').script).toBe('watch-client-transpile');
		expect(channel('typecheck').script).toBe('watch-client');
		expect(channel('extensions').script).toBe('watch-extensions');
		expect(channel('copilot').script).toBe('watch-copilot');
		expect(DEFAULT_UP_CHANNELS).toEqual(['transpile', 'typecheck']);
	});

	it('does not let a patch set replace the shipped process parser', () => {
		const root = rootWith('build-watch-override', JSON.stringify({ codkitBuildWatch: 2, channels: {} }));
		expect(loadBuildWatch(root)).toBe(shipped);
		expect(loadBuildWatch(root).channels.map((entry) => entry.name)).toEqual(['transpile', 'typecheck', 'extensions', 'copilot']);
	});

	it('loads a fork-specific process parser only through the explicit shared config field', () => {
		const root = rootWith(
			'build-watch-explicit',
			JSON.stringify({
				codkitBuildWatch: 1,
				channels: {
					custom: { script: 'watch-custom', passStart: ['^start$'], passEnd: ['^end$'], errorLine: ['^(.+?): ERROR: (.+)$'] }
				}
			})
		);
		declareBuildWatch(root);
		const custom = loadBuildWatch(root);
		expect(custom.channels.map((entry) => entry.name)).toEqual(['custom']);
		expect(custom.channels[0]?.script).toBe('watch-custom');
	});

	it('rejects a custom channel with no error detector or with an unknown field', () => {
		for (const [label, channel] of [
			['missing-detector', { script: 'watch-custom', passStart: ['^start$'], passEnd: ['^end$'] }],
			[
				'unknown-field',
				{ script: 'watch-custom', passStart: ['^start$'], passEnd: ['^end$'], errorCountLine: ['errors: (\\d+)'], typo: [] }
			]
		] as const) {
			const root = rootWith(`build-watch-${label}`, JSON.stringify({ codkitBuildWatch: 1, channels: { custom: channel } }));
			declareBuildWatch(root);
			expect(() => loadBuildWatch(root)).toThrow();
		}
	});

	it('resolves --channel: a name, all, the default, and an unknown one', () => {
		expect(selectChannels(shipped, null, DEFAULT_UP_CHANNELS).map((entry) => entry.name)).toEqual(['transpile', 'typecheck']);
		expect(selectChannels(shipped, 'all', DEFAULT_UP_CHANNELS).map((entry) => entry.name)).toEqual([
			'transpile',
			'typecheck',
			'extensions',
			'copilot'
		]);
		expect(selectChannels(shipped, 'copilot', DEFAULT_UP_CHANNELS).map((entry) => entry.name)).toEqual(['copilot']);
		expect(() => selectChannels(shipped, 'nope', DEFAULT_UP_CHANNELS)).toThrow(/unknown build channel/);
	});
});

describe('ANSI stripping', () => {
	it('removes colour and window-title sequences before anything is matched', () => {
		const coloured = '\u001b]0;watch\u0007\u001b[1m\u001b[32mStarting transpilation...\u001b[0m';
		expect(stripAnsi(coloured)).toBe('Starting transpilation...');
		expect(logLines(`${coloured}\n`)).toEqual(['Starting transpilation...']);
	});

	it('finds a pass whose lines are coloured', () => {
		const log = [
			'\u001b[32mStarting transpilation...\u001b[0m',
			'\u001b[31mFinished transpilation with 0 errors after 12 ms\u001b[0m'
		].join('\n');
		const pass = findLastPass(logLines(log), channel('transpile'));
		expect(pass?.lines).toEqual(['Starting transpilation...', 'Finished transpilation with 0 errors after 12 ms']);
	});

	it('drops a trailing carriage return but keeps the rest of the line', () => {
		expect(logLines('a\r\nb\r\n')).toEqual(['a', 'b']);
	});
});

describe('pass boundaries', () => {
	const transpile = channel('transpile');

	it('takes the last start and the first end after it', () => {
		const lines = [
			'Starting transpilation...',
			'Finished transpilation with 0 errors after 10 ms',
			'Starting transpilation...',
			'src/vs/patchset/hello.ts:2:1: ERROR: broken',
			'Finished transpilation with 1 errors after 20 ms'
		];
		const pass = findLastPass(lines, transpile);
		expect(pass?.startIndex).toBe(2);
		expect(pass?.endIndex).toBe(4);
		expect(pass?.lines).toHaveLength(3);
	});

	it('is null while the last pass is still running, and null with no start at all', () => {
		expect(findLastPass(['Starting transpilation...'], transpile)).toBeNull();
		expect(findLastPass(['Finished transpilation with 0 errors after 10 ms'], transpile)).toBeNull();
		expect(findLastPass([], transpile)).toBeNull();
	});

	it('finds the newest finished pass even when another one was started after it', () => {
		const lines = [
			'Starting transpilation...',
			'Finished transpilation with 0 errors after 10 ms',
			'Starting transpilation...',
			'src/vs/patchset/hello.ts:2:1: ERROR: broken',
			'Finished transpilation with 1 errors after 20 ms',
			'Starting transpilation...'
		];
		// This is the daemon that died mid-pass: the pass it was inside has no end,
		// and the one before it is still the answer.
		expect(findLastPass(lines, transpile)).toBeNull();
		const finished = findLastFinishedPass(lines, transpile);
		expect(finished?.startIndex).toBe(2);
		expect(finished?.endIndex).toBe(4);
		expect(finished?.lines).toHaveLength(3);
	});

	it('has no finished pass to give without an end, or without the start of one', () => {
		expect(findLastFinishedPass(['Starting transpilation...'], transpile)).toBeNull();
		expect(findLastFinishedPass(['Finished transpilation with 0 errors after 10 ms'], transpile)).toBeNull();
		expect(findLastFinishedPass([], transpile)).toBeNull();
	});

	it('recognizes the exact timestamped green watch-client pass while retaining bare fixture lines', () => {
		const typecheck = channel('typecheck');
		expect(findLastPass(LIVE_GREEN_PASS, typecheck)?.lines).toEqual(LIVE_GREEN_PASS);
		expect(findLastPass(['Starting compilation...', 'Finished compilation with 0 errors after 200 ms'], typecheck)?.lines).toEqual([
			'Starting compilation...',
			'Finished compilation with 0 errors after 200 ms'
		]);

		// The optional prefix has one exact shape and the line anchors stay strict.
		expect(findLastPass(['[05:56:09]Starting compilation...', LIVE_GREEN_PASS[2]], typecheck)).toBeNull();
		expect(findLastPass([LIVE_GREEN_PASS[0], `${LIVE_GREEN_PASS[2]} trailing`], typecheck)).toBeNull();
	});
});

describe('false ends of a pass', () => {
	const typecheck = channel('typecheck');
	const REAL_END = 'Finished compilation with 0 errors after 3000 ms';
	const CODEGEN = 'Finished compilation api-proposal-names with 0 errors after 12 ms';
	const LIVE_REAL_END = LIVE_GREEN_PASS[2];
	const LIVE_CODEGEN = '[05:56:13] Finished compilation api-proposal-names with 0 errors after 3095 ms';
	const LIVE_EXTENSION_CODEGEN = '[05:56:13] Finished compilation extension-point-names with 0 errors after 3095 ms';

	it('tells the end of the pass from the marker of a code-generation channel', () => {
		expect(isPassEnd(REAL_END, typecheck)).toBe(true);
		expect(isPassEnd(CODEGEN, typecheck)).toBe(false);
		// Both halves of the guard, stated directly: the guard matches the marker
		// with an id and never the bare line, whatever passEnd would say.
		expect(typecheck.falseEndGuards.some((guard) => guard.test(CODEGEN))).toBe(true);
		expect(typecheck.falseEndGuards.some((guard) => guard.test(REAL_END))).toBe(false);
		expect(
			typecheck.falseEndGuards.some((guard) => guard.test('Finished compilation extension-point-names with 2 errors after 4 ms'))
		).toBe(true);
		expect(isPassEnd(LIVE_REAL_END, typecheck)).toBe(true);
		expect(isPassEnd(LIVE_CODEGEN, typecheck)).toBe(false);
		expect(isPassEnd(LIVE_EXTENSION_CODEGEN, typecheck)).toBe(false);
		expect(typecheck.falseEndGuards.some((guard) => guard.test(`${LIVE_CODEGEN} trailing`))).toBe(false);
	});

	it('does not end a pass on a guarded line even when passEnd would match it', () => {
		// A deliberately naive passEnd, which is what the guards exist for.
		const naive: ChannelConfig = {
			name: 'naive',
			script: 'watch-client',
			passStart: [/^Starting compilation\.\.\.$/],
			passEnd: [/^Finished compilation/],
			errorLine: [],
			errorCountLine: [],
			falseEndGuards: typecheck.falseEndGuards
		};
		const lines = ['Starting compilation...', CODEGEN, REAL_END];
		expect(isPassEnd(CODEGEN, naive)).toBe(false);
		expect(findLastPass(lines, naive)?.endIndex).toBe(2);
	});

	it('waits for the real end: a pass that only has the false one is not finished', () => {
		expect(findLastPass(['Starting compilation...', CODEGEN], typecheck)).toBeNull();
	});

	it('applies the guards to the newest finished pass as well', () => {
		expect(findLastFinishedPass(['Starting compilation...', CODEGEN], typecheck)).toBeNull();
		expect(findLastFinishedPass(['Starting compilation...', CODEGEN, REAL_END], typecheck)?.endIndex).toBe(2);
	});

	it('waits past timestamped generator lines for the timestamped real end', () => {
		expect(findLastPass([LIVE_GREEN_PASS[0], LIVE_CODEGEN], typecheck)).toBeNull();
		expect(findLastPass([LIVE_GREEN_PASS[0], LIVE_CODEGEN, LIVE_REAL_END], typecheck)?.endIndex).toBe(2);
	});
});

describe('diagnostics of a pass', () => {
	it('parses the transpile form (file:line:col: ERROR: text)', () => {
		const errors = parseErrorLines(['src/vs/patchset/hello.ts:12:7: ERROR: Unexpected token'], channel('transpile'));
		expect(errors).toHaveLength(1);
		expect(errors[0]).toMatchObject({
			file: 'src/vs/patchset/hello.ts',
			line: 12,
			column: 7,
			code: null,
			message: 'Unexpected token'
		});
	});

	it('parses the tsc form (file(line,col): error TSnnnn: text)', () => {
		const errors = parseErrorLines(
			[
				'src/vs/patchset/hello.ts(12,7): error TS2322: Type number is not assignable to type string.',
				'not an error line at all',
				'src/vs/base/common/util.ts(4,2): error TS2345: Argument of type string is not assignable.'
			],
			channel('typecheck')
		);
		expect(errors.map((error) => error.file)).toEqual(['src/vs/patchset/hello.ts', 'src/vs/base/common/util.ts']);
		expect(errors[0]?.code).toBe('TS2322');
		expect(errors[0]?.line).toBe(12);
		expect(errors[0]?.column).toBe(7);
		expect(errors[1]?.message).toBe('Argument of type string is not assignable.');
	});

	it('takes the real count from the summary line, not from the 0/1 flag of the end line', () => {
		const typecheck = channel('typecheck');
		const lines = [
			'Starting compilation...',
			'src/vs/patchset/hello.ts(12,7): error TS2322: Type number is not assignable to type string.',
			'src/vs/base/common/util.ts(4,2): error TS2345: Argument of type string is not assignable.',
			'Finished watch-client-noEmit fixture with 7 errors.',
			'Finished compilation with 1 errors after 200 ms'
		];
		expect(errorCountFrom(lines, typecheck)).toBe(7);
		expect(parseErrorLines(lines, typecheck)).toHaveLength(2);
	});

	it('parses the exact timestamped TS7027 diagnostic and authoritative live count', () => {
		const typecheck = channel('typecheck');
		const pass = findLastPass(LIVE_TS7027_PASS, typecheck);
		expect(pass?.lines).toEqual(LIVE_TS7027_PASS);
		expect(parseErrorLines(pass?.lines ?? [], typecheck)).toEqual([
			{
				file: 'src/vs/patchset/test/node/patchset.resources.test.ts',
				line: 80,
				column: 4,
				code: 'TS7027',
				message: 'Unreachable code detected.',
				raw: LIVE_TS7027_PASS[1]
			}
		]);
		expect(errorCountFrom(pass?.lines ?? [], typecheck)).toBe(1);
	});

	it('states no count when the pass carries no summary line', () => {
		expect(errorCountFrom(['Finished compilation with 1 errors after 200 ms'], channel('typecheck'))).toBeNull();
		expect(errorCountFrom(['Finished transpilation with 0 errors after 10 ms'], channel('transpile'))).toBeNull();
	});

	it('reads the per-pass total of the extensions channel', () => {
		expect(errorCountFrom(['Finished extensions compilation with 3 errors.'], channel('extensions'))).toBe(3);
	});
});

describe('--mine', () => {
	// The shape of the fixture delta: a patch and a rewrite rule over one upstream
	// file, an overlay over product.json, a resource, and an own unit whose files
	// are named relative to delta/own/.
	const inventory = {
		entries: [
			{ layer: 'patch', files: ['src/vs/workbench/browser/parts/example/examplePart.ts'] },
			{ layer: 'config-overlay', files: ['product.json'] },
			{ layer: 'resource-file', files: ['resources/app-icon.bin'] },
			{ layer: 'own', files: ['hello.ts', 'test/fixture.test.ts'] }
		]
	};
	const targets = inventoryTargets(inventory, 'patchset');

	it('maps own files to where they land in the tree', () => {
		expect([...targets].sort()).toEqual([
			'product.json',
			'resources/app-icon.bin',
			'src/vs/patchset/hello.ts',
			'src/vs/patchset/test/fixture.test.ts',
			'src/vs/workbench/browser/parts/example/examplePart.ts'
		]);
	});

	it('keeps own code and inventory targets, and drops everything else', () => {
		expect(isMine('src/vs/patchset/anything/at/all.ts', 'patchset', new Set())).toBe(true);
		expect(isMine('src/vs/workbench/browser/parts/example/examplePart.ts', 'patchset', targets)).toBe(true);
		expect(isMine('product.json', 'patchset', targets)).toBe(true);
		expect(isMine('src/vs/base/common/util.ts', 'patchset', targets)).toBe(false);
		// A sibling directory whose name merely starts the same way is not own code.
		expect(isMine('src/vs/patchset-extra/thing.ts', 'patchset', targets)).toBe(false);
	});

	it('brings the path of a diagnostic to the tree-relative form first', () => {
		const tree = '/tmp/fork-tree';
		expect(treeRelativePath('/tmp/fork-tree/src/vs/patchset/hello.ts', tree)).toBe('src/vs/patchset/hello.ts');
		expect(treeRelativePath('./src/vs/patchset/hello.ts', tree)).toBe('src/vs/patchset/hello.ts');
		expect(treeRelativePath('src/vs/patchset/hello.ts', tree)).toBe('src/vs/patchset/hello.ts');
		// A path outside the tree stays as it is, and is nobody's.
		expect(treeRelativePath('/elsewhere/hello.ts', tree)).toBe('/elsewhere/hello.ts');
		expect(isMine(treeRelativePath('/elsewhere/hello.ts', tree), 'patchset', targets)).toBe(false);
	});
});

describe('probing a command line', () => {
	it('compares argv tokens, so one script name is not a prefix of another', () => {
		const transpileArgs = ['node', '/usr/lib/node_modules/npm/bin/npm-cli.js', 'run', 'watch-client-transpile'];
		expect(argsMatch(transpileArgs, 'watch-client-transpile')).toBe(true);
		expect(argsMatch(transpileArgs, 'watch-client')).toBe(false);
	});

	it('accepts the single-string title npm rewrites its own argv with', () => {
		// What /proc/<pid>/cmdline really holds once npm has renamed itself.
		const title = ['npm run watch-client-transpile'];
		expect(argsMatch(title, 'watch-client-transpile')).toBe(true);
		expect(argsMatch(title, 'watch-client')).toBe(false);
		expect(argsMatch(['npm run watch-client'], 'watch-client')).toBe(true);
	});

	it('reads one native Windows command line through Get-CimInstance', () => {
		const commandLine = '"C:\\Program Files\\nodejs\\node.exe" npm-cli.js run watch-client-transpile';
		const invoked: { command: string; args: readonly string[] }[] = [];
		const run: ProcessRunner = (command, args) => {
			invoked.push({ command, args });
			return {
				status: 0,
				stdout: JSON.stringify({ pid: 4242, parentPid: 17, commandLine }),
				stderr: ''
			};
		};

		expect(processArgs(4242, { platform: 'win32', run })).toEqual([commandLine]);
		expect(invoked[0]?.command).toBe('powershell.exe');
		expect(invoked[0]?.args).toContain('-NoProfile');
		expect(invoked[0]?.args.at(-1)).toContain('Get-CimInstance Win32_Process -Filter "ProcessId = 4242"');
		expect(argsMatch([commandLine], 'watch-client-transpile')).toBe(true);
	});

	it('reads the native Windows process table and carries parent pids for watcher ownership', () => {
		const rows = [
			{ pid: 101, parentPid: 50, commandLine: 'npm run watch-client-transpile' },
			{ pid: 102, parentPid: 101, commandLine: 'node build/next/index.ts transpile --watch C:\\fork tree' },
			// System processes whose command line CIM does not expose are irrelevant.
			{ pid: 4, parentPid: 0, commandLine: null }
		];
		const run: ProcessRunner = (command, args) => {
			expect(command).toBe('powershell.exe');
			expect(args.at(-1)).toContain('Get-CimInstance Win32_Process | Select-Object');
			return { status: 0, stdout: JSON.stringify(rows), stderr: '' };
		};

		expect(processTable({ platform: 'win32', run })).toEqual([
			{ pid: 101, pgid: 50, args: ['npm run watch-client-transpile'], cwd: null },
			{ pid: 102, pgid: 101, args: ['node build/next/index.ts transpile --watch C:\\fork tree'], cwd: null }
		]);
	});

	it('conservatively catches a Windows watcher whose cwd is unavailable', () => {
		const run: ProcessRunner = () => ({
			status: 0,
			stdout: JSON.stringify({ pid: 333, parentPid: 1, commandLine: 'node build/next/index.ts transpile --watch' }),
			stderr: ''
		});

		expect(foreignWatchers('C:\\fork tree', new Set(), { platform: 'win32', run })).toEqual([
			{ pid: 333, commandLine: 'node build/next/index.ts transpile --watch' }
		]);
	});

	it('raises an unavailable Windows probe and leaves a living daemon record untouched', async () => {
		const root = makeTempRoot('windows-probe-unavailable');
		const path = recordPath(root, 'transpile');
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(
			path,
			`${JSON.stringify(
				{
					codkitBuildDaemon: DAEMON_RECORD_SCHEMA_VERSION,
					channel: 'transpile',
					script: 'watch-client-transpile',
					pid: 4242,
					cmdline: 'watch-client-transpile',
					startedAt: '2026-08-31T00:00:00.000Z',
					treeId: 'fixture-tree',
					treePath: 'C:\\fork tree'
				},
				null,
				2
			)}\n`,
			'utf8'
		);
		const run: ProcessRunner = () => ({
			status: null,
			stdout: '',
			stderr: '',
			error: new Error('spawn powershell.exe ENOENT')
		});
		const probe = { platform: 'win32' as const, run };

		expect(() => statusOf(root, 'transpile', probe)).toThrow(/cannot inspect process 4242/);
		expect(() => processTable(probe)).toThrow(/cannot inspect process table/);
		await expect(downChannel(root, 'transpile', probe)).rejects.toThrow(/cannot inspect process 4242/);
		expect(readRecord(root, 'transpile')?.pid).toBe(4242);
	});

	it('does not call an existing Windows process dead when CIM hides its command line', () => {
		const run: ProcessRunner = () => ({
			status: 0,
			stdout: JSON.stringify({ pid: 4242, parentPid: 17, commandLine: null }),
			stderr: ''
		});

		expect(() => processArgs(4242, { platform: 'win32', run })).toThrow(/returned no readable command line/);
	});
});

describe('the inotify contract of the daemons', () => {
	it('warns below the minimum, with the command that fixes the machine', () => {
		const warning = inotifyWarning({ platform: 'linux', read: () => '65536\n' });

		expect(warning).not.toBeNull();
		expect(warning).toContain('65536');
		expect(warning).toContain(`sudo sysctl fs.inotify.max_user_watches=${INOTIFY_RECOMMENDED_WATCHES}`);
		expect(warning).toContain('ENOSPC');
	});

	it('says nothing at or above the minimum', () => {
		expect(inotifyWarning({ platform: 'linux', read: () => String(INOTIFY_MIN_WATCHES) })).toBeNull();
		expect(inotifyWarning({ platform: 'linux', read: () => `${INOTIFY_RECOMMENDED_WATCHES}\n` })).toBeNull();
	});

	it('says nothing off Linux, and nothing when the limit cannot be read', () => {
		// The file is a Linux interface; on macOS and Windows there is no verdict
		// to give, and an unreadable one is not evidence of anything either.
		expect(inotifyWarning({ platform: 'darwin', read: () => '1' })).toBeNull();
		expect(inotifyWarning({ platform: 'win32', read: () => '1' })).toBeNull();
		expect(inotifyWarning({ platform: 'linux', read: () => null })).toBeNull();
		expect(inotifyWarning({ platform: 'linux', read: () => 'not a number' })).toBeNull();
	});
});
