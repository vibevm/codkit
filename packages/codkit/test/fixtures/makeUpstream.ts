// Pseudo-upstream fixture: a repository of the layout the stub type declares
// (PROP-013 ##FIXTURE-UPSTREAM, PROP-016 ##TYPE-ENGINE-TESTS).
//
// It reproduces the *shape* the engine cares about, and that shape is the stub
// type's answer rather than any product's tree - a shell part with a
// constructor and a create* method, a style file with a stable class, the JSON
// manifest that is the overlay target, watch-daemon scripts, a binary resource,
// a toolchain pin - and the history the upgrade cycle has to survive between
// two pins:
//
//   c1 (anchor, root)                      the commit ##ID-CHECK-ORIGIN looks for
//   c2                             -> t1   "old pin"
//   c3   examplePart, away from the hook   an edit the patch must not collide with
//   c4   examplePart, in the constructor   the future conflict case
//   c5   statusPart.ts -> statusbarPart.ts rename with a small edit
//   c6   obsolete/oldThing.ts deleted -> t2 "new pin"
//
// Everything is deterministic: fixed author, fixed committer, fixed dates one
// minute apart, so the commit shas are identical on every machine and run.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { gitOk } from '../../src/lib/gitx.ts';
import type { GitEnv } from '../../src/lib/gitx.ts';

export type UpstreamRef = {
	readonly tag: string;
	readonly sha: string;
	/** Commit date of the tagged commit, ISO-8601 UTC. */
	readonly dateIso: string;
};

export type UpstreamFixture = {
	/** Absolute path of the generated work tree. */
	readonly dir: string;
	/** Root commit: what PROP-008 ##ID-CHECK-ORIGIN checks for. */
	readonly anchorSha: string;
	readonly t1: UpstreamRef;
	readonly t2: UpstreamRef;
};

/** Target of the sample patch and of the sample rewrite rule. */
export const EXAMPLE_PART_PATH = 'source/app/browser/parts/example/examplePart.ts';
/** Exact line the sample patch hooks after (a create* method, never the constructor). */
export const EXAMPLE_AREA_ANCHOR = '\tprotected createExampleArea(parent: FixtureElement): void {';
/** Exact line the sample rewrite rule matches. */
export const EXAMPLE_TOOLBAR_ANCHOR = '\tprotected createExampleToolbar(parent: FixtureElement): void {';
/** Renamed between t1 and t2. */
export const STATUS_PART_PATH = 'source/app/browser/parts/status/statusPart.ts';
export const STATUSBAR_PART_PATH = 'source/app/browser/parts/status/statusbarPart.ts';
/** Deleted between t1 and t2. */
export const OBSOLETE_PATH = 'source/app/obsolete/oldThing.ts';
/** Stable style class the fixture contract tests can assert on. */
export const STATUS_CSS_CLASS = 'fixture-status-item';

const AUTHOR_NAME = 'fixture';
const AUTHOR_EMAIL = 'fixture@example.invalid';

/** First commit date; every later commit is one minute after the previous one. */
const FIRST_COMMIT_ISO = '2026-01-01T00:00:00Z';

/**
 * Generate the fixture into `dir` (created if absent, expected to be empty).
 * Returns the anchor and both pins.
 */
export function makeUpstream(dir: string): UpstreamFixture {
	mkdirSync(dir, { recursive: true });
	fixtureGit(dir, ['init', '--quiet', '--initial-branch=main', '.']);

	let clock = 0;

	writeAll(dir, rootCommitFiles());
	const anchorSha = fixtureCommit(dir, 'fixture: initial upstream tree', commitDate(clock));
	clock += 1;

	writeAll(dir, secondCommitFiles());
	const t1Date = commitDate(clock);
	const t1Sha = fixtureCommit(dir, 'fixture: titlebar part and example service', t1Date);
	fixtureGit(dir, ['tag', 't1']);
	clock += 1;

	// c3: an edit far away from where the patch lands.
	writeFile(dir, EXAMPLE_PART_PATH, examplePartAfterLayoutEdit());
	fixtureCommit(dir, 'fixture: trace layout of the example part', commitDate(clock));
	clock += 1;

	// c4: an edit inside the constructor - the classic upstream drift that
	// collides with a hook someone put there instead of in a create* method.
	writeFile(dir, EXAMPLE_PART_PATH, examplePartAfterConstructorEdit());
	fixtureCommit(dir, 'fixture: log construction of the example part', commitDate(clock));
	clock += 1;

	// c5: rename with a small edit, the R096 analogue (similarity above 90).
	fixtureGit(dir, ['mv', STATUS_PART_PATH, STATUSBAR_PART_PATH]);
	writeFile(dir, STATUSBAR_PART_PATH, statusbarPartAfterRename());
	fixtureCommit(dir, 'fixture: rename statusPart to statusbarPart', commitDate(clock));
	clock += 1;

	// c6: a deleted file - the target-deleted case of the classifier.
	fixtureGit(dir, ['rm', '--quiet', OBSOLETE_PATH]);
	const t2Date = commitDate(clock);
	const t2Sha = fixtureCommit(dir, 'fixture: drop the obsolete module', t2Date);
	fixtureGit(dir, ['tag', 't2']);

	return {
		dir,
		anchorSha,
		t1: { tag: 't1', sha: t1Sha, dateIso: t1Date },
		t2: { tag: 't2', sha: t2Sha, dateIso: t2Date }
	};
}

/** `YYYY-MM-DD` of an ISO-8601 timestamp: the form codkit.json wants for pin.date. */
/**
 * The three paths the `vscode` type names as the fingerprints of a healthy tree
 * (PROP-008 ##ID-CHECK-FINGERPRINTS). `makeUpstream` writes them as part of its
 * own root commit; a suite that hand-rolls a smaller tree of the same type
 * writes them with this, so that `check-tree` recognizes the family it declares.
 */
export function writeFingerprintFiles(dir: string): void {
	writeFile(dir, 'package.json', '{\n\t"name": "fixture-app"\n}\n');
	writeFile(dir, 'manifest.json', '{\n\t"displayName": "Fixture"\n}\n');
	writeFile(dir, 'source/base/common/fixture.ts', 'export const FIXTURE = true;\n');
}

export function pinDate(dateIso: string): string {
	return dateIso.slice(0, 10);
}

function commitDate(minute: number): string {
	const base = Date.parse(FIRST_COMMIT_ISO) + minute * 60_000;
	return new Date(base).toISOString().replace('.000Z', 'Z');
}

/**
 * Stage everything and commit it with the fixture identity and a fixed date.
 * Shared with makePatchSet so both fixture repositories have the same determinism.
 */
export function fixtureCommit(dir: string, message: string, dateIso: string): string {
	fixtureGit(dir, ['add', '--all']);
	fixtureGit(dir, ['commit', '--quiet', '--message', message], identity(dateIso));
	return fixtureGit(dir, ['rev-parse', 'HEAD']).stdout.trim();
}

function identity(dateIso: string): GitEnv {
	return {
		GIT_AUTHOR_NAME: AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
		GIT_AUTHOR_DATE: dateIso,
		GIT_COMMITTER_NAME: AUTHOR_NAME,
		GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
		GIT_COMMITTER_DATE: dateIso
	};
}

/** git for fixture generation: a failure here is a bug in the fixtures. */
export function fixtureGit(dir: string, args: readonly string[], env?: GitEnv): { stdout: string } {
	const options = env === undefined ? { args, cwd: dir } : { args, cwd: dir, env };
	return gitOk(options, {
		code: 'INTERNAL',
		message: `fixture git failed in ${dir}: git ${args.join(' ')}`,
		hint: 'this is a bug in the codkit test fixtures, not in the tree under test'
	});
}

type FileMap = ReadonlyMap<string, string | Uint8Array>;

function writeAll(dir: string, files: FileMap): void {
	for (const [relative, content] of files) {
		writeFile(dir, relative, content);
	}
}

function writeFile(dir: string, relative: string, content: string | Uint8Array): void {
	const absolute = join(dir, relative);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
	if (relative.endsWith('.mjs')) {
		chmodSync(absolute, 0o755);
	}
}

function rootCommitFiles(): FileMap {
	return new Map<string, string | Uint8Array>([
		['.nvmrc', '24.18.0\n'],
		['.gitignore', GITIGNORE],
		['README.md', README],
		['package.json', PACKAGE_JSON],
		['manifest.json', MANIFEST_JSON],
		['build/stub-ci-step.mjs', STUB_CI_STEP],
		['build/stub-watch.mjs', STUB_WATCH],
		['resources/app-icon.bin', APP_ICON],
		['source/base/common/util.ts', UTIL_TS],
		['source/base/common/lifecycle.ts', LIFECYCLE_TS],
		['source/base/common/event.ts', EVENT_TS],
		['source/base/browser/dom.ts', DOM_TS],
		['source/platform/log/common/log.ts', LOG_TS],
		['source/platform/instantiation/common/instantiation.ts', INSTANTIATION_TS],
		['source/app/common/contributions.ts', CONTRIBUTIONS_TS],
		['source/app/browser/shell.ts', SHELL_TS],
		[EXAMPLE_PART_PATH, EXAMPLE_PART_T1],
		['source/app/browser/parts/example/examplePart.css', EXAMPLE_PART_CSS],
		[STATUS_PART_PATH, STATUS_PART_T1],
		['source/app/browser/parts/status/statusPart.css', STATUS_PART_CSS],
		[OBSOLETE_PATH, OLD_THING_TS]
	]);
}

function secondCommitFiles(): FileMap {
	return new Map<string, string | Uint8Array>([
		['source/app/browser/parts/titlebar/titlebarPart.ts', TITLEBAR_PART_TS],
		['source/app/services/example/browser/exampleService.ts', EXAMPLE_SERVICE_TS]
	]);
}

// ---------------------------------------------------------------------------
// File bodies. Tabs are the indentation, LF the line ending, ASCII the alphabet
// - the same rules codkit enforces on the real upstream.
// ---------------------------------------------------------------------------

// manifest.overrides.json is ignored upstream too: it is the dev channel of the
// config-overlay layer (PROP-005 ##OVERLAY-TWO-CHANNELS), written into the tree by
// `load`, and the tree has to stay clean with it in place.
const GITIGNORE = `.build/
node_modules/
out/
manifest.overrides.json
`;

const README = `# Fixture Upstream

A miniature stand-in for an upstream tree, generated by the codkit test
fixtures. It exists to have the shape codkit cares about, not to run.
`;

const PACKAGE_JSON = `{
	"name": "fixture-upstream",
	"version": "1.0.0",
	"private": true,
	"scripts": {
		"hygiene": "node build/stub-ci-step.mjs hygiene",
		"eslint": "node build/stub-ci-step.mjs eslint",
		"test-own": "node build/stub-ci-step.mjs product-tests",
		"watch-transpile": "node build/stub-watch.mjs transpile",
		"watch-compile": "node build/stub-watch.mjs typecheck",
		"watch-addons": "node build/stub-watch.mjs addons",
		"watch-extras": "node build/stub-watch.mjs extras"
	}
}
`;

const STUB_CI_STEP = `#!/usr/bin/env node
// Executable fixture counterparts of the upstream hygiene, lint and own-test
// runners. Besides selectable red verdicts, they assert the ordering fixed by
// PROP-011: hygiene sees the pin manifest.json, product tests see its materialized
// overlay and receive the exact own-test runGlob.

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const step = process.argv[2];
const product = JSON.parse(readFileSync('manifest.json', 'utf8'));
mkdirSync('.build', { recursive: true });
appendFileSync('.build/ci-steps.log', step + '\\n', 'utf8');

if (step === 'hygiene' || step === 'eslint') {
	if (product.displayName !== 'Fixture Upstream' || Object.hasOwn(product, 'patchsetUpstreamPin')) {
		console.error(step + ': overlay target was materialized before upstream hygiene');
		process.exit(1);
	}
	if ((step === 'hygiene' && process.env.STUB_HYGIENE_MODE === 'fail') ||
		(step === 'eslint' && process.env.STUB_ESLINT_MODE === 'fail')) {
		console.error(step + ': fixture check failed');
		process.exit(1);
	}
	console.log(step + ': fixture check passed before overlay materialization');
	process.exit(0);
}

if (step === 'product-tests') {
	const runGlobAt = process.argv.indexOf('--runGlob');
	const runGlob = runGlobAt === -1 ? undefined : process.argv[runGlobAt + 1];
	if (runGlob !== 'own/**/test/{common,node}/**/*.test.js') {
		console.error('product-tests: expected the own-test --runGlob, got ' + String(runGlob));
		process.exit(1);
	}
	const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
	const expectedPin = branch.slice(branch.lastIndexOf('/') + 1);
	if (product.displayName !== 'Fixture PatchSet' || product.patchsetUpstreamPin !== expectedPin) {
		console.error('product-tests: overlay target was not materialized before the tests');
		process.exit(1);
	}
	readFileSync('source/own/test/fixture.test.ts', 'utf8');
	if (process.env.STUB_PRODUCT_TEST_MODE === 'fail') {
		console.error('product-tests: fixture assertion failed');
		process.exit(1);
	}
	console.log('product-tests: fixture own and contract tests passed');
	process.exit(0);
}

console.error('unknown fixture CI step: ' + String(step));
process.exit(2);
`;

// addonGallery is nested on purpose: the dev channel of the config-overlay
// layer has to seed a top-level key from the pin before writing into it, or the
// flat merge upstream performs would drop the sibling keys (PROP-005
// ##OVERLAY-TWO-CHANNELS).
const MANIFEST_JSON = `{
	"displayName": "Fixture Upstream",
	"descriptiveName": "Fixture Upstream App",
	"dataFolderName": ".fixture-upstream-app",
	"applicationName": "fixture-app",
	"version": "1.0.0",
	"addonGallery": {
		"serviceUrl": "https://gallery.fixture.invalid/api",
		"itemUrl": "https://gallery.fixture.invalid/item"
	}
}
`;

const STUB_WATCH = `#!/usr/bin/env node
// Stand-in for the upstream watch daemons: prints the pass boundary lines codkit
// parses, then stays alive the way a real watcher does.
//
// The channel name (argv[2]) picks the wording of the boundaries; STUB_MODE picks
// what the pass looks like, so a test can produce a slow pass, a pass that never
// ends, a false end or coloured output without waiting for anything real:
//
//   ok         start, end after 200 ms, then a new pass every two seconds
//   errors     two diagnostics, the real count line, and an end whose own
//              counter is the 0/1 flag it is upstream
//   never-end  a start and no end at all
//   false-end  a code-generation marker that looks like an end, then the real one
//   ansi       like ok, with the colour and title sequences around every line
//   live-green exact sanitized timestamped watch-compile green pass
//   live-ts7027 exact sanitized timestamped watch-compile TS7027 pass
//   live-ext-green exact sanitized timestamped watch-addons green pass
//   live-ext-red   timestamped watch-addons pass: two diagnostics and
//                  per-project summaries, the last of which reports zero

import { appendFileSync } from 'node:fs';

const CHANNELS = {
	transpile: {
		start: 'Starting transpilation...',
		end: 'Finished transpilation with 0 errors after 200 ms',
		endWithErrors: 'Finished transpilation with 1 errors after 200 ms',
		falseEnd: 'Finished transpilation of addons with 0 errors after 12 ms'
	},
	typecheck: {
		start: 'Starting compilation...',
		end: 'Finished compilation with 0 errors after 200 ms',
		endWithErrors: 'Finished compilation with 1 errors after 200 ms',
		falseEnd: 'Finished compilation api-proposal-names with 0 errors after 12 ms'
	},
	addons: {
		start: 'Starting compilation',
		end: 'Finished compilation',
		endWithErrors: 'Finished compilation',
		falseEnd: 'Finished compilation api-proposal-names with 0 errors after 12 ms'
	},
	extras: {
		start: '[watch] build started',
		end: '[watch] build finished',
		endWithErrors: '[watch] build finished',
		falseEnd: 'Finished compilation api-proposal-names with 0 errors after 12 ms'
	}
};

// One diagnostic under the own directory and one upstream, so a --mine filter has
// something to keep and something to drop; the count line carries the real number,
// which the counter of the end line does not.
const ERROR_LINES = [
	'source/own/hello.ts(12,7): error TS2322: Type number is not assignable to type string.',
	'source/base/common/util.ts(4,2): error TS2345: Argument of type string is not assignable.',
	'Finished compile-noEmit fixture with 2 errors.'
];

const LIVE_GREEN = {
	start: '[05:56:09] Starting compilation...',
	count: '[05:56:22] Finished compile-noEmit /workspace/fork/src/tsconfig.json with 0 errors.',
	end: '[05:56:22] Finished compilation with 0 errors after 12110 ms'
};

const LIVE_TS7027 = {
	start: LIVE_GREEN.start,
	error: '[05:43:37] source/own/test/node/patchset.resources.test.ts(80,4): error TS7027: Unreachable code detected.',
	count: '[05:43:37] Finished compile-noEmit /workspace/fork/src/tsconfig.json with 1 errors.',
	end: '[05:43:37] Finished compilation with 1 errors after 12353 ms'
};

// Sanitized shapes of the live watch-addons daemon: every line carries the
// [HH:mm:ss] prefix, and the per-project summaries are not a pass total - the
// red pass ends with a zero from a later project on purpose, so a
// last-count-wins reading of it cannot pass as green.
const LIVE_EXT_GREEN = {
	start: '[05:55:35] Starting compilation',
	projects: ['[05:55:36] Finished addons types with 0 errors.', '[05:55:36] Finished addons sample-pack with 0 errors.'],
	end: '[05:55:37] Finished compilation'
};

const LIVE_EXT_RED = {
	start: LIVE_EXT_GREEN.start,
	errors: [
		'[05:55:36] source/own/hello.ts(12,7): error TS2322: Type number is not assignable to type string.',
		'[05:55:36] source/base/common/util.ts(4,2): error TS2345: Argument of type string is not assignable.'
	],
	projects: ['[05:55:36] Finished addons sample-pack with 2 errors.', '[05:55:37] Finished addons types with 0 errors.'],
	end: LIVE_EXT_GREEN.end
};

const channel = CHANNELS[process.argv[2]] ?? CHANNELS.transpile;
const mode = process.env.STUB_MODE || 'ok';
const pidLog = process.env.CODKIT_TEST_DAEMON_PID_LOG;
if (pidLog) {
	appendFileSync(pidLog, String(process.pid) + '\\n', 'utf8');
}

function say(line) {
	const decorated = mode === 'ansi' ? '\\u001b]0;watch\\u0007\\u001b[1m\\u001b[32m' + line + '\\u001b[0m' : line;
	process.stdout.write(decorated + '\\n');
}

// Keep the process alive, like the real watcher waiting for the next change.
function stayAlive() {
	setInterval(() => {}, 60000);
}

say(
	mode === 'live-green'
		? LIVE_GREEN.start
		: mode === 'live-ts7027'
			? LIVE_TS7027.start
			: mode === 'live-ext-green' || mode === 'live-ext-red'
				? LIVE_EXT_GREEN.start
				: channel.start
);

if (mode === 'never-end') {
	stayAlive();
} else if (mode === 'live-green') {
	setTimeout(() => {
		say(LIVE_GREEN.count);
		say(LIVE_GREEN.end);
		stayAlive();
	}, 100);
} else if (mode === 'live-ts7027') {
	setTimeout(() => {
		say(LIVE_TS7027.error);
		say(LIVE_TS7027.count);
		say(LIVE_TS7027.end);
		stayAlive();
	}, 100);
} else if (mode === 'live-ext-green') {
	setTimeout(() => {
		for (const line of LIVE_EXT_GREEN.projects) {
			say(line);
		}
		say(LIVE_EXT_GREEN.end);
		stayAlive();
	}, 100);
} else if (mode === 'live-ext-red') {
	setTimeout(() => {
		for (const line of LIVE_EXT_RED.errors) {
			say(line);
		}
		for (const line of LIVE_EXT_RED.projects) {
			say(line);
		}
		say(LIVE_EXT_RED.end);
		stayAlive();
	}, 100);
} else if (mode === 'errors') {
	setTimeout(() => {
		for (const line of ERROR_LINES) {
			say(line);
		}
		say(channel.endWithErrors);
		stayAlive();
	}, 100);
} else if (mode === 'false-end') {
	setTimeout(() => {
		say(channel.falseEnd);
		setTimeout(() => {
			say(channel.end);
			stayAlive();
		}, 300);
	}, 100);
} else {
	setTimeout(() => {
		say(channel.end);
		setInterval(() => {
			say(channel.start);
			setTimeout(() => {
				say(channel.end);
			}, 200);
		}, 2000);
	}, 200);
}
`;

/** The resource-file target of the fixture delta. */
export const APP_ICON_PATH = 'resources/app-icon.bin';

/** A short binary blob: NUL and high bytes, so it is never mistaken for text. */
export const APP_ICON = new Uint8Array([0x00, 0x01, 0x02, 0x7f, 0x80, 0xfe, 0xff, 0x00, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0xff]);

const UTIL_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

export function isDefined<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined;
}

export function clamp(value: number, low: number, high: number): number {
	if (value < low) {
		return low;
	}
	if (value > high) {
		return high;
	}
	return value;
}
`;

const LIFECYCLE_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

export interface IDisposable {
	dispose(): void;
}

export class Disposable implements IDisposable {

	private readonly toDispose: IDisposable[] = [];

	protected register<T extends IDisposable>(item: T): T {
		this.toDispose.push(item);
		return item;
	}

	dispose(): void {
		while (this.toDispose.length > 0) {
			const item = this.toDispose.pop();
			if (item !== undefined) {
				item.dispose();
			}
		}
	}
}
`;

const EVENT_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

import { IDisposable } from './lifecycle.ts';

export type Listener<T> = (event: T) => void;

export class Emitter<T> {

	private readonly listeners: Listener<T>[] = [];

	on(listener: Listener<T>): IDisposable {
		this.listeners.push(listener);
		return {
			dispose: () => {
				const at = this.listeners.indexOf(listener);
				if (at !== -1) {
					this.listeners.splice(at, 1);
				}
			}
		};
	}

	fire(event: T): void {
		for (const listener of this.listeners.slice()) {
			listener(event);
		}
	}
}
`;

const DOM_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

export interface FixtureElement {
	tag: string;
	className: string;
	width: number;
	height: number;
	children: FixtureElement[];
}

export function append(parent: FixtureElement, tag: string, className: string): FixtureElement {
	const child: FixtureElement = { tag, className, width: 0, height: 0, children: [] };
	parent.children.push(child);
	return child;
}
`;

const LOG_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

export interface ILogService {
	trace(message: string): void;
	error(message: string): void;
}

export const ILogService = 'logService';

export class ConsoleLogService implements ILogService {

	trace(message: string): void {
		this.write('trace', message);
	}

	error(message: string): void {
		this.write('error', message);
	}

	private write(level: string, message: string): void {
		process.stdout.write(level + ': ' + message + '\\n');
	}
}
`;

const INSTANTIATION_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

export interface ServicesAccessor {
	get<T>(id: string): T;
}

export class InstantiationService implements ServicesAccessor {

	private readonly services = new Map<string, unknown>();

	set(id: string, service: unknown): void {
		this.services.set(id, service);
	}

	get<T>(id: string): T {
		const service = this.services.get(id);
		if (service === undefined) {
			throw new Error('unknown service: ' + id);
		}
		return service as T;
	}
}
`;

const CONTRIBUTIONS_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.ts';

export interface IShellContribution {
	start(accessor: ServicesAccessor): void;
}

const contributions: IShellContribution[] = [];

export function registerShellContribution(contribution: IShellContribution): void {
	contributions.push(contribution);
}

export function startContributions(accessor: ServicesAccessor): void {
	for (const contribution of contributions) {
		contribution.start(accessor);
	}
}
`;

const SHELL_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

import { FixtureElement } from '../../base/browser/dom.ts';
import { ConsoleLogService, ILogService } from '../../platform/log/common/log.ts';
import { InstantiationService } from '../../platform/instantiation/common/instantiation.ts';
import { startContributions } from '../common/contributions.ts';
import { ExamplePart } from './parts/example/examplePart.ts';

export function createShell(container: FixtureElement): void {
	const instantiationService = new InstantiationService();
	const logService = new ConsoleLogService();
	instantiationService.set(ILogService, logService);

	const example = new ExamplePart('example', logService);
	example.create(container);

	startContributions(instantiationService);
}
`;

const EXAMPLE_PART_CSS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

.fixture-example-area {
	display: flex;
	flex: 1 1 auto;
}

.fixture-example-toolbar {
	display: flex;
	height: 28px;
}
`;

const STATUS_PART_CSS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

.fixture-status-bar {
	display: flex;
	height: 22px;
}

.fixture-status-item {
	display: inline-flex;
	padding: 0 5px;
}
`;

const OLD_THING_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests. Deleted between t1 and t2 on purpose.
 *--------------------------------------------------------------------------------------------*/

export function oldThing(): string {
	return 'this module goes away in t2';
}
`;

const TITLEBAR_PART_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

import { FixtureElement, append } from '../../../../base/browser/dom.ts';

export class TitlebarPart {

	private title: FixtureElement | null = null;

	createTitleArea(parent: FixtureElement): void {
		this.title = append(parent, 'div', 'fixture-titlebar-title');
	}

	setTitle(text: string): void {
		if (this.title !== null) {
			this.title.tag = text;
		}
	}
}
`;

const EXAMPLE_SERVICE_TS = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.ts';

export const IExampleService = 'exampleService';

export interface IExampleService {
	readonly onDidChange: Emitter<string>;
	describe(): string;
}

export class ExampleService implements IExampleService {

	readonly onDidChange = new Emitter<string>();

	describe(): string {
		return 'fixture example service';
	}
}
`;

// --- examplePart.ts, in its three states ------------------------------------
//
// t1 is the state the sample patch is generated against. The two later states
// change the file away from the hook (layout) and inside the constructor, so a
// patch anchored at createExampleArea still applies and a patch anchored at the
// constructor does not.

const EXAMPLE_PART_T1 = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests. Shaped like a shell part of the layout.
 *--------------------------------------------------------------------------------------------*/

import { FixtureElement, append } from '../../../../base/browser/dom.ts';
import { Disposable } from '../../../../base/common/lifecycle.ts';
import { ILogService } from '../../../../platform/log/common/log.ts';

export const EXAMPLE_PART_ID = 'fixture.parts.example';

export class ExamplePart extends Disposable {

	private area: FixtureElement | null;
	private toolbar: FixtureElement | null;

	constructor(
		private readonly title: string,
		private readonly logService: ILogService
	) {
		super();
		this.area = null;
		this.toolbar = null;
	}

	get partId(): string {
		return EXAMPLE_PART_ID;
	}

	create(parent: FixtureElement): void {
		this.createExampleArea(parent);
		this.createExampleToolbar(parent);
	}

	protected createExampleArea(parent: FixtureElement): void {
		this.doCreateExampleArea(parent);
	}

	protected createExampleToolbar(parent: FixtureElement): void {
		this.doCreateExampleToolbar(parent);
	}

	private doCreateExampleArea(parent: FixtureElement): void {
		this.area = append(parent, 'div', 'fixture-example-area');
		this.logService.trace('example part: area of ' + this.title);
	}

	private doCreateExampleToolbar(parent: FixtureElement): void {
		this.toolbar = append(parent, 'div', 'fixture-example-toolbar');
		this.logService.trace('example part: toolbar of ' + this.title);
	}

	layout(width: number, height: number): void {
		if (this.area === null) {
			return;
		}
		this.area.width = width;
		this.area.height = height;
	}
}
`;

/** c3: one line added at the far end of the file, nowhere near the hook. */
function examplePartAfterLayoutEdit(): string {
	return EXAMPLE_PART_T1.replace(
		'\t\tthis.area.width = width;\n\t\tthis.area.height = height;\n',
		"\t\tthis.area.width = width;\n\t\tthis.area.height = height;\n\t\tthis.logService.trace('example part: laid out');\n"
	);
}

/** c4: one line added inside the constructor - the future conflict. */
function examplePartAfterConstructorEdit(): string {
	return examplePartAfterLayoutEdit().replace(
		'\t\tthis.area = null;\n\t\tthis.toolbar = null;\n',
		"\t\tthis.area = null;\n\t\tthis.toolbar = null;\n\t\tthis.logService.trace('example part: constructed');\n"
	);
}

const STATUS_PART_T1 = `/*---------------------------------------------------------------------------------------------
 *  Fixture file for codkit tests. Renamed to statusbarPart.ts between t1 and t2.
 *--------------------------------------------------------------------------------------------*/

import { FixtureElement, append } from '../../../../base/browser/dom.ts';
import { Disposable } from '../../../../base/common/lifecycle.ts';

export const STATUS_PART_ID = 'fixture.parts.status';

export class StatusPart extends Disposable {

	private bar: FixtureElement | null = null;

	createStatusArea(parent: FixtureElement): void {
		this.bar = append(parent, 'div', 'fixture-status-bar');
	}

	addItem(text: string): FixtureElement | null {
		if (this.bar === null) {
			return null;
		}
		const item = append(this.bar, 'span', 'fixture-status-item');
		item.tag = text;
		return item;
	}

	setItemText(item: FixtureElement, text: string): void {
		item.tag = text;
	}

	itemCount(): number {
		return this.bar === null ? 0 : this.bar.children.length;
	}

	layout(width: number): void {
		if (this.bar !== null) {
			this.bar.width = width;
		}
	}

	clear(): void {
		if (this.bar !== null) {
			this.bar.children.length = 0;
		}
	}
}
`;

/** c5: the rename carries one changed line, so similarity stays above 90. */
function statusbarPartAfterRename(): string {
	return STATUS_PART_T1.replace(
		' *  Fixture file for codkit tests. Renamed to statusbarPart.ts between t1 and t2.\n',
		' *  Fixture file for codkit tests. Renamed here from statusPart.ts.\n'
	);
}
