// The advisory readers of this type: what each one reads out of the files it
// declared, and what it says a difference means
// (modules/vscode/PROP-005 ##VSCODE-ADVISORY-READERS).
//
// A reader is a pure function of the text of its own files, so it is proved
// here without a repository: the cycle's frame - the diff between two pins, the
// report, the acknowledgement - is the engine's and is proved there.

import { describe, expect, it } from 'vitest';
import { isBrokenArtifact } from '@codkit/type-api';
import type { AdvisoryFiles, AdvisoryValue } from '@codkit/type-api';
import { ADVISORY_PATHS, readers } from '../src/advisory.ts';

const reader = (id: string) => readers.find((candidate) => candidate.id === id) ?? missing(id);

function missing(id: string): never {
	throw new Error(`no advisory reader ${id}`);
}

function files(entries: Readonly<Record<string, string | null>>): AdvisoryFiles {
	return new Map(Object.entries(entries));
}

function json(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

function read(id: string, entries: Readonly<Record<string, string | null>>): AdvisoryValue {
	return reader(id).read(files(entries));
}

function refusal(run: () => unknown): { message: string; hint: string } {
	try {
		run();
	} catch (error) {
		if (isBrokenArtifact(error)) {
			return { message: error.message, hint: error.hint };
		}
		throw error;
	}
	throw new Error('expected the reader to refuse');
}

describe('the reader set', () => {
	it('names the files of the toolchain once each, in a stable order', () => {
		expect(readers.map((candidate) => candidate.id)).toEqual([
			'node-version',
			'package-manifest',
			'package-lock',
			'npm-directories',
			'built-in-extensions',
			'electron-versions'
		]);
		expect(ADVISORY_PATHS).toEqual([
			'.nvmrc',
			'package.json',
			'package-lock.json',
			'build/npm/dirs.ts',
			'product.json',
			'build/lib/electron.ts'
		]);
	});

	it('calls a change news by itself only for the files an install is built from', () => {
		expect(readers.filter((candidate) => candidate.changeIsNews).map((candidate) => candidate.id)).toEqual([
			'node-version',
			'package-manifest',
			'package-lock',
			'npm-directories'
		]);
	});

	it('gives every difference a sentence, so none of them is reported without a meaning', () => {
		for (const candidate of readers) {
			expect(candidate.meaning(null, 'anything'), candidate.id).not.toBeNull();
		}
	});

	it('reads an absent file as null instead of refusing', () => {
		for (const candidate of readers) {
			const absent = new Map(candidate.paths.map((path) => [path, null] as const));
			expect(() => candidate.read(absent), candidate.id).not.toThrow();
		}
	});
});

describe('the node version', () => {
	it('is the single trimmed line of the version file', () => {
		expect(read('node-version', { '.nvmrc': '20.11.0\n' })).toBe('20.11.0');
		expect(read('node-version', { '.nvmrc': null })).toBeNull();
	});

	it('refuses a version file that is empty or carries more than one word', () => {
		expect(refusal(() => read('node-version', { '.nvmrc': '\n' })).message).toMatch(/exactly one nonempty version/);
		expect(refusal(() => read('node-version', { '.nvmrc': '20 22\n' })).message).toMatch(/exactly one nonempty version/);
	});
});

describe('the package manifest', () => {
	it('keeps the fields that decide what an install produces and drops the rest', () => {
		const value = read('package-manifest', {
			'package.json': json({ name: 'fixture', description: 'ignored', engines: { node: '>=20' }, devDependencies: { electron: '30.1.0' } })
		});
		expect(value).toEqual({ engines: { node: '>=20' }, devDependencies: { electron: '30.1.0' } });
	});

	it('refuses text that is not one JSON object', () => {
		expect(refusal(() => read('package-manifest', { 'package.json': '{broken\n' })).message).toMatch(/invalid JSON in package\.json/);
		expect(refusal(() => read('package-manifest', { 'package.json': '[]\n' })).message).toMatch(/must contain one JSON object/);
	});
});

describe('the package lock', () => {
	it('keeps the lock version and the resolved dependencies of the root package', () => {
		const value = read('package-lock', {
			'package-lock.json': json({
				name: 'fixture',
				lockfileVersion: 3,
				packages: { '': { devDependencies: { electron: '30.1.0' } }, 'node_modules/x': { version: '1.0.0' } }
			})
		});
		expect(value).toEqual({ lockfileVersion: 3, root: { devDependencies: { electron: '30.1.0' } } });
	});
});

describe('the npm directory list', () => {
	it('takes only the static initializer and ignores imports, regexes, templates and unrelated strings', () => {
		const source = `import { existsSync } from 'ignore/import';
const matcher = /ignore\\/regex/;
const noise = ['ignore/array', 'ignore/other'];
const message = \`ignore/\${noise.length}\`;
export const dirs = ['build', 'extensions/a'];
if (existsSync(\`\${import.meta.dirname}/ignore/runtime\`)) dirs.push('ignore/push');
`;
		expect(read('npm-directories', { 'build/npm/dirs.ts': source })).toEqual(['build', 'extensions/a']);
	});

	it('accepts a relevant directories property in a top-level object initializer', () => {
		const source = "export const npm = { metadata: 'ignore/noise', nested: { directories: ['build', 'remote'] } };\n";
		expect(read('npm-directories', { 'build/npm/dirs.ts': source })).toEqual(['build', 'remote']);
	});

	it.each([
		"export const dirs = ['build', process.env.EXTRA];\n",
		'export const dirs = [...baseDirs, 1];\n',
		"export const dirs = ['unterminated];\n"
	])('refuses an initializer it cannot read statically: %s', (source) => {
		expect(refusal(() => read('npm-directories', { 'build/npm/dirs.ts': source })).message).toMatch(/build\/npm\/dirs\.ts/);
	});
});

describe('the built-in extensions', () => {
	it('is the declared set and nothing else of the product manifest', () => {
		const entries = [{ name: 'ms.example.one', version: '1.0.0' }];
		expect(read('built-in-extensions', { 'product.json': json({ builtInExtensions: entries, nameShort: 'Fixture' }) })).toEqual(entries);
		expect(read('built-in-extensions', { 'product.json': json({ nameShort: 'Fixture' }) })).toBeNull();
	});

	it('refuses a declaration that is not an array', () => {
		expect(refusal(() => read('built-in-extensions', { 'product.json': '{"builtInExtensions": {}}\n' })).message).toMatch(
			/must be an array/
		);
	});
});

describe('the Electron versions', () => {
	it('collects every version the distribution states, from both places it states them', () => {
		const value = read('electron-versions', {
			'package.json': json({ devDependencies: { electron: '30.1.0', typescript: '5.9.0' } }),
			'build/lib/electron.ts': "export const electronVersion = '30.1.0';\n"
		});
		expect(value).toEqual([
			{ path: 'build/lib/electron.ts', locator: 'version-literal', value: '30.1.0' },
			{ path: 'package.json', locator: '/devDependencies/electron', value: '30.1.0' }
		]);
	});

	it('is an empty list when both files are gone, which is itself the news', () => {
		expect(read('electron-versions', { 'package.json': null, 'build/lib/electron.ts': null })).toEqual([]);
	});
});
