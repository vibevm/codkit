/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	dependencyAdvisoryAcknowledgement,
	inspectDependencyAdvisory,
	isDependencyAdvisoryAcknowledged,
	shouldStopForDependencyAdvisory
} from '../../src/lib/cycleAdvisory.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

type Content = string | Uint8Array;
type Snapshot = Readonly<Record<string, Content>>;

const PATHS = ['.nvmrc', 'package.json', 'package-lock.json', 'build/npm/dirs.ts', 'product.json', 'build/lib/electron.ts'] as const;
const BASE: Snapshot = {
	'.nvmrc': '20.11.0\n',
	'package.json': json({
		name: 'fixture',
		engines: { node: '>=20' },
		devDependencies: { electron: '30.1.0', typescript: '5.9.0' }
	}),
	'package-lock.json': json({
		name: 'fixture',
		lockfileVersion: 3,
		packages: { '': { devDependencies: { electron: '30.1.0', typescript: '5.9.0' } } }
	}),
	'build/npm/dirs.ts': "export const dirs = ['build', 'extensions/a'];\n",
	'product.json': json({ builtInExtensions: [{ name: 'ms.example.one', version: '1.0.0', sha256: 'old' }], nameShort: 'Fixture' }),
	'build/lib/electron.ts': "export const electronVersion = '30.1.0';\n"
};

type Fixture = {
	readonly cwd: string;
	readonly oldPin: string;
	readonly newPin: string;
};

function json(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

function replace(snapshot: Snapshot, path: string, content: Content | null): Snapshot {
	const copy: Record<string, Content> = { ...snapshot };
	if (content === null) {
		delete copy[path];
	} else {
		copy[path] = content;
	}
	return copy;
}

function fixture(before: Snapshot = BASE, after: Snapshot = BASE, unmonitoredChange = true): Fixture {
	const cwd = makeTempRoot('cycle-advisory');
	fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
	writeSnapshot(cwd, before);
	write(cwd, 'README.md', 'old\n');
	const oldPin = fixtureCommit(cwd, 'fixture: old dependency inputs', '2026-01-01T03:00:00Z');
	for (const path of PATHS) {
		rmSync(join(cwd, path), { force: true });
	}
	writeSnapshot(cwd, after);
	if (unmonitoredChange) {
		write(cwd, 'README.md', 'new\n');
	}
	const newPin = fixtureCommit(cwd, 'fixture: new dependency inputs', '2026-01-01T03:01:00Z');
	return { cwd, oldPin, newPin };
}

function writeSnapshot(cwd: string, snapshot: Snapshot): void {
	for (const [path, content] of Object.entries(snapshot)) {
		write(cwd, path, content);
	}
}

function write(cwd: string, path: string, content: Content): void {
	const absolute = join(cwd, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

function report(fixtureValue: Fixture) {
	return inspectDependencyAdvisory({ cwd: fixtureValue.cwd, oldPin: fixtureValue.oldPin, newPin: fixtureValue.newPin });
}

function codeOf(run: () => unknown): string {
	try {
		run();
		throw new Error('expected CkError');
	} catch (error) {
		expect(error).toBeInstanceOf(CkError);
		return (error as CkError).code;
	}
}

describe('dependency advisory', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('returns an empty report when monitored values do not change', () => {
		const value = report(fixture());

		expect(value.changedFiles).toEqual([]);
		expect(value.semanticChanges).toEqual([]);
		expect(dependencyAdvisoryAcknowledgement(value)).toBeNull();
		expect(isDependencyAdvisoryAcknowledged(value, null)).toBe(true);
		expect(shouldStopForDependencyAdvisory(value, { ci: false })).toBe(false);
	});

	it.each([
		{
			name: 'Node version',
			path: '.nvmrc',
			after: replace(BASE, '.nvmrc', '22.14.0\n'),
			kinds: ['node-version']
		},
		{
			name: 'package manifest',
			path: 'package.json',
			after: replace(
				BASE,
				'package.json',
				json({ name: 'fixture', engines: { node: '>=20' }, devDependencies: { electron: '30.1.0', typescript: '6.0.0' } })
			),
			kinds: ['package-manifest']
		},
		{
			name: 'package lock',
			path: 'package-lock.json',
			after: replace(
				BASE,
				'package-lock.json',
				json({ lockfileVersion: 3, packages: { '': { devDependencies: { electron: '30.1.0', typescript: '6.0.0' } } } })
			),
			kinds: ['package-lock']
		},
		{
			name: 'npm directory list',
			path: 'build/npm/dirs.ts',
			after: replace(BASE, 'build/npm/dirs.ts', "export const dirs = ['build', 'extensions/a', 'extensions/b'];\n"),
			kinds: ['npm-directories']
		},
		{
			name: 'built-in extension set',
			path: 'product.json',
			after: replace(
				BASE,
				'product.json',
				json({ builtInExtensions: [{ name: 'ms.example.one', version: '2.0.0', sha256: 'new' }], nameShort: 'Fixture' })
			),
			kinds: ['built-in-extensions']
		},
		{
			name: 'Electron source version',
			path: 'build/lib/electron.ts',
			after: replace(BASE, 'build/lib/electron.ts', "export const electronVersion = '31.2.0';\n"),
			kinds: ['electron-versions']
		},
		{
			name: 'Electron package version',
			path: 'package.json',
			after: replace(
				BASE,
				'package.json',
				json({ name: 'fixture', engines: { node: '>=20' }, devDependencies: { electron: '31.2.0', typescript: '5.9.0' } })
			),
			kinds: ['package-manifest', 'electron-versions']
		}
	])('reports the $name signal from real commits', ({ path, after, kinds }) => {
		const value = report(fixture(BASE, after));

		expect(value.changedFiles).toEqual([{ path, change: 'modified' }]);
		expect(value.semanticChanges.map((change) => change.kind)).toEqual(kinds);
	});

	it('extracts only the static npm directory initializer and ignores imports, regexes, templates and unrelated strings', () => {
		const before = `import { existsSync } from 'ignore/import';
const matcher = /ignore\\/regex/;
const noise = ['ignore/array', 'ignore/other'];
const message = \`ignore/${'${noise.length}'}\`;
export const dirs = ['build', 'extensions/a'];
if (existsSync(\`${'${import.meta.dirname}'}/ignore/runtime\`)) dirs.push('ignore/push');
`;
		const after = before.replace("'extensions/a'", "'extensions/a', 'test/scenario'");
		const value = report(fixture(replace(BASE, 'build/npm/dirs.ts', before), replace(BASE, 'build/npm/dirs.ts', after)));
		const change = value.semanticChanges.find((candidate) => candidate.kind === 'npm-directories');

		expect(change).toEqual({
			kind: 'npm-directories',
			path: 'build/npm/dirs.ts',
			before: ['build', 'extensions/a'],
			after: ['build', 'extensions/a', 'test/scenario']
		});
	});

	it('accepts a relevant directories property in a top-level object initializer', () => {
		const before = "export const npm = { metadata: 'ignore/noise', nested: { directories: ['build'] } };\n";
		const after = "export const npm = { metadata: 'ignore/changed', nested: { directories: ['build', 'remote'] } };\n";
		const value = report(fixture(replace(BASE, 'build/npm/dirs.ts', before), replace(BASE, 'build/npm/dirs.ts', after)));

		expect(value.semanticChanges).toContainEqual({
			kind: 'npm-directories',
			path: 'build/npm/dirs.ts',
			before: ['build'],
			after: ['build', 'remote']
		});
	});

	it('returns every signal and file in fixed report order', () => {
		let after = replace(BASE, '.nvmrc', '22.0.0\n');
		after = replace(
			after,
			'package.json',
			json({ name: 'fixture', engines: { node: '>=22' }, devDependencies: { electron: '32.0.0', typescript: '6.0.0' } })
		);
		after = replace(after, 'package-lock.json', json({ lockfileVersion: 4, packages: { '': { engines: { node: '>=22' } } } }));
		after = replace(after, 'build/npm/dirs.ts', "export const dirs = ['build', 'extensions/new'];\n");
		after = replace(after, 'product.json', json({ builtInExtensions: [{ name: 'ms.example.two', version: '1.0.0' }] }));
		after = replace(after, 'build/lib/electron.ts', "export const electronVersion = '32.0.0';\n");

		const value = report(fixture(BASE, after));
		expect(value.changedFiles.map((change) => change.path)).toEqual(PATHS);
		expect(value.semanticChanges.map((change) => change.kind)).toEqual([
			'node-version',
			'package-manifest',
			'package-lock',
			'npm-directories',
			'built-in-extensions',
			'electron-versions'
		]);
	});

	it('ignores unrelated product.json edits when builtInExtensions stay equal', () => {
		const after = replace(
			BASE,
			'product.json',
			json({ builtInExtensions: [{ name: 'ms.example.one', version: '1.0.0', sha256: 'old' }], nameShort: 'Renamed' })
		);
		expect(report(fixture(BASE, after))).toMatchObject({ changedFiles: [], semanticChanges: [] });
	});

	it.each([
		['package.json', '{broken\n'],
		['package-lock.json', '[]\n'],
		['product.json', '{"builtInExtensions": {}}\n']
	] as const)('rejects malformed semantic JSON in %s', (path, content) => {
		const value = fixture(BASE, replace(BASE, path, content));
		expect(codeOf(() => report(value))).toBe('ARTIFACT-BROKEN');
	});

	it('rejects binary and malformed TypeScript advisory sources loudly', () => {
		const binary = fixture(BASE, replace(BASE, '.nvmrc', new Uint8Array([0x32, 0x30, 0x00, 0x0a])));
		expect(codeOf(() => report(binary))).toBe('ENCODING');

		const malformed = fixture(BASE, replace(BASE, 'build/npm/dirs.ts', "export const dirs = ['unterminated];\n"));
		expect(codeOf(() => report(malformed))).toBe('ARTIFACT-BROKEN');
	});

	it.each([
		"export const dirs = ['build', process.env.EXTRA];\n",
		"export const dirs = ['build', `extensions/${name}`];\n",
		"export const dirs = [...baseDirs, 'build'];\n"
	])('rejects a dynamic relevant npm directory initializer: %s', (source) => {
		const value = fixture(BASE, replace(BASE, 'build/npm/dirs.ts', source));
		expect(codeOf(() => report(value))).toBe('ARTIFACT-BROKEN');
	});

	it('reports deleted inputs with null or empty semantic after-values', () => {
		const value = report(fixture(BASE, {}));

		expect(value.changedFiles).toEqual(PATHS.map((path) => ({ path, change: 'deleted' })));
		expect(value.semanticChanges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'node-version', after: null }),
				expect.objectContaining({ kind: 'package-manifest', after: null }),
				expect.objectContaining({ kind: 'package-lock', after: null }),
				expect.objectContaining({ kind: 'npm-directories', after: null }),
				expect.objectContaining({ kind: 'built-in-extensions', after: null }),
				expect.objectContaining({ kind: 'electron-versions', after: [] })
			])
		);
	});

	it('is deterministic, leaves HEAD and the worktree untouched, and rejects stale acknowledgements', () => {
		const fixtureValue = fixture(BASE, replace(BASE, '.nvmrc', '22.0.0\n'));
		const headBefore = runGit({ args: ['rev-parse', 'HEAD'], cwd: fixtureValue.cwd }).stdout;
		const statusBefore = runGit({ args: ['status', '--porcelain'], cwd: fixtureValue.cwd }).stdout;
		const first = report(fixtureValue);
		const second = report(fixtureValue);
		const acknowledgement = dependencyAdvisoryAcknowledgement(first);

		expect(second).toEqual(first);
		expect(acknowledgement).toMatch(/^deps-advisory-v1:[0-9a-f]{40}:[0-9a-f]{64}$/);
		expect(shouldStopForDependencyAdvisory(first, { ci: false })).toBe(true);
		expect(shouldStopForDependencyAdvisory(first, { ci: false, acknowledgement: 'stale' })).toBe(true);
		expect(shouldStopForDependencyAdvisory(first, { ci: false, acknowledgement })).toBe(false);
		expect(shouldStopForDependencyAdvisory(first, { ci: true })).toBe(false);
		expect(isDependencyAdvisoryAcknowledged(first, acknowledgement)).toBe(true);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixtureValue.cwd }).stdout).toBe(headBefore);
		expect(runGit({ args: ['status', '--porcelain'], cwd: fixtureValue.cwd }).stdout).toBe(statusBefore);
	});

	it('ignores refs/replace through the default isolated Git runner', () => {
		const fixtureValue = fixture(BASE, replace(BASE, '.nvmrc', '22.0.0\n'));
		write(fixtureValue.cwd, '.nvmrc', '99.0.0\n');
		const replacement = fixtureCommit(fixtureValue.cwd, 'fixture: malicious replacement tree', '2026-01-01T03:02:00Z');
		fixtureGit(fixtureValue.cwd, ['replace', fixtureValue.oldPin, replacement]);

		expect(report(fixtureValue).semanticChanges).toContainEqual({
			kind: 'node-version',
			path: '.nvmrc',
			before: '20.11.0',
			after: '22.0.0'
		});
	});

	it('treats an absent monitored path as unavailable but a missing blob as a Git/object failure', () => {
		const absent = fixture({}, {}, true);
		expect(report(absent).changedFiles).toEqual([]);

		const damaged = fixture(BASE, replace(BASE, '.nvmrc', '22.0.0\n'));
		const blob = fixtureGit(damaged.cwd, ['rev-parse', `${damaged.oldPin}:.nvmrc`]).stdout.trim();
		const objectPath = join(damaged.cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
		rmSync(objectPath);
		expect(codeOf(() => report(damaged))).toBe('ARTIFACT-BROKEN');
	});

	it('rejects unreachable and unsafe refs before advisory reads', () => {
		const fixtureValue = fixture();
		expect(codeOf(() => inspectDependencyAdvisory({ cwd: fixtureValue.cwd, oldPin: 'missing', newPin: fixtureValue.newPin }))).toBe(
			'PIN-UNREACHABLE'
		);
		expect(codeOf(() => inspectDependencyAdvisory({ cwd: fixtureValue.cwd, oldPin: '-bad', newPin: fixtureValue.newPin }))).toBe('CONFIG');
	});
});
