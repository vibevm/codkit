// The section of `codkit.json` this type owns (PROP-002 ##VSX-TYPE-CONFIG,
// ##VSX-OWN-ROOT; PROP-016 ##TYPE-CONFIG-FIELD).

import { describe, expect, it } from 'vitest';
import { argvOf, configSchema, PLACEHOLDER_CONFIG } from '../src/index.ts';
import { FULL, MINIMAL } from './support/config.ts';

/** The first refusal of a section, as the engine would name the field. */
function refusal(section: unknown): string {
	const parsed = configSchema.safeParse(section);
	expect(parsed.success).toBe(false);
	const issue = parsed.success ? undefined : parsed.error.issues[0];
	return `${(issue?.path ?? []).join('.')}: ${issue?.message ?? ''}`;
}

describe('what the section accepts', () => {
	it('takes the two required answers alone: a repository that is one extension', () => {
		expect(configSchema.safeParse(MINIMAL).success).toBe(true);
		expect(configSchema.safeParse(PLACEHOLDER_CONFIG).success).toBe(true);
	});

	it('takes every declaration the type answers from', () => {
		const parsed = configSchema.safeParse(FULL);
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
		expect(parsed.data).toEqual(FULL);
	});

	it('takes the test runner exactly as the generic type takes it', () => {
		expect(configSchema.safeParse({ ...MINIMAL, scripts: { test: { command: ['node', '--test'] } } }).success).toBe(true);
		expect(configSchema.safeParse({ ...MINIMAL, scripts: { test: { command: 'npm test', ownGlobArg: '--glob' } } }).success).toBe(true);
	});

	it('takes a null host and a null workspace in the preview section', () => {
		expect(configSchema.safeParse({ ...MINIMAL, preview: { host: null, workspace: null } }).success).toBe(true);
		expect(configSchema.safeParse({ ...MINIMAL, preview: {} }).success).toBe(true);
	});
});

describe('what the section refuses, naming the field', () => {
	it('refuses a section without the extension root or the own root', () => {
		expect(refusal({ ownRoot: 'src/acme' })).toContain('extensionRoot');
		expect(refusal({ extensionRoot: '.' })).toContain('ownRoot');
	});

	it('refuses an own root outside <extensionRoot>/src/, naming the constraint', () => {
		// ##VSX-OWN-ROOT: the bundler reaches a module only from the activation entry.
		expect(refusal({ ...MINIMAL, ownRoot: 'own' })).toContain('ownRoot: must lie under src/');
		expect(refusal({ ...FULL, ownRoot: 'packages/other/src/own' })).toContain('ownRoot: must lie under packages/acme-sample/src/');
		expect(refusal({ ...FULL, ownRoot: 'packages/acme-sample/own' })).toContain('ownRoot');
		// The source directory itself is not an own root: it is upstream's.
		expect(refusal({ ...FULL, ownRoot: 'packages/acme-sample/src' })).toContain('ownRoot');
		expect(refusal({ ...MINIMAL, ownRoot: '../src/acme' })).toContain('dot-dot');
		expect(refusal({ ...MINIMAL, ownRoot: 'src\\acme' })).toContain('forward slashes');
	});

	it('refuses an extension root that is not a tree path', () => {
		expect(refusal({ ...MINIMAL, extensionRoot: '/abs' })).toContain('extensionRoot');
		expect(refusal({ ...MINIMAL, extensionRoot: '../outside' })).toContain('extensionRoot');
		expect(refusal({ ...MINIMAL, extensionRoot: 'packages/' })).toContain('extensionRoot');
	});

	it('refuses an unknown field rather than ignoring it', () => {
		expect(refusal({ ...MINIMAL, ownDirName: 'acme' })).toContain('ownDirName');
		expect(refusal({ ...MINIMAL, scripts: { compile: 'compile' } })).toContain('scripts');
		expect(refusal({ ...MINIMAL, preview: { mode: 'artifact' } })).toContain('preview');
	});

	it('refuses a tag pattern that does not compile', () => {
		// ##VSX-PIN-TAGS: a release train is declared as a regular expression.
		expect(refusal({ ...MINIMAL, tagPattern: '(' })).toContain('tagPattern');
		expect(refusal({ ...MINIMAL, tagPattern: '' })).toContain('tagPattern');
		expect(configSchema.safeParse({ ...MINIMAL, tagPattern: '^\\d+\\.\\d+$' }).success).toBe(true);
	});

	it('refuses a package manager the family does not run on', () => {
		expect(refusal({ ...MINIMAL, packageManager: 'cargo' })).toContain('packageManager');
	});

	it('refuses a watch channel with no pass boundaries: the tool never guesses them', () => {
		expect(refusal({ ...MINIMAL, watch: { channels: [{ script: 'watch' }] } })).toContain('passStart');
		expect(refusal({ ...MINIMAL, watch: { channels: [{ script: 'watch', passStart: ['^a$'], passEnd: ['^b$'] }] } })).toContain(
			'errorLine'
		);
		expect(refusal({ ...MINIMAL, watch: { channels: [] } })).toContain('watch.channels');
	});

	it('refuses an empty entry list and a locale manifest named twice or naming the manifest', () => {
		expect(refusal({ ...MINIMAL, entryModules: [] })).toContain('entryModules');
		expect(refusal({ ...MINIMAL, localeManifests: ['package.nls.json', 'package.nls.json'] })).toContain('localeManifests.1');
		expect(refusal({ ...MINIMAL, localeManifests: ['package.json'] })).toContain('localeManifests.0');
	});

	it('refuses a stamp that is not a variable with a value', () => {
		expect(refusal({ ...MINIMAL, stamps: [{ name: 'not a name', value: 'x' }] })).toContain('stamps.0.name');
		expect(refusal({ ...MINIMAL, stamps: [{ name: 'ACME' }] })).toContain('stamps.0.value');
	});
});

describe('the argv of a declared command', () => {
	it('splits a string on whitespace and keeps an array as written', () => {
		expect(argvOf('vitest run')).toEqual(['vitest', 'run']);
		expect(argvOf(['node', '--test', 'a b'])).toEqual(['node', '--test', 'a b']);
	});
});
