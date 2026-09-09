// The section of `codkit.json` this type owns (PROP-016 ##TYPE-CONFIG-FIELD).

import { describe, expect, it } from 'vitest';
import { argvOf, configSchema } from '../src/index.ts';

/** The first refusal of a section, as the engine would name the field. */
function refusal(section: unknown): string {
	const parsed = configSchema.safeParse(section);
	expect(parsed.success).toBe(false);
	const issue = parsed.success ? undefined : parsed.error.issues[0];
	return `${(issue?.path ?? []).join('.')}: ${issue?.message ?? ''}`;
}

describe('what the section accepts', () => {
	it('takes an own root alone', () => {
		expect(configSchema.safeParse({ ownRoot: 'own' }).success).toBe(true);
	});

	it('takes every declaration the type answers from', () => {
		const parsed = configSchema.safeParse({
			ownRoot: 'src/own',
			commands: {
				install: 'npm ci',
				lint: ['npm run lint', ['npm', 'run', 'typecheck']],
				compile: [{ script: 'watch', passStart: ['^Starting$'], passEnd: ['^Done$'], errorLine: ['^(.+)$'] }],
				test: { command: 'npm test', ownGlobArg: '--glob' }
			},
			overlayTargets: ['app.json'],
			cleanupWhitelist: ['build/'],
			identity: { manifest: { path: 'app.json', nameField: 'name' } }
		});
		expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
	});
});

describe('what the section refuses, naming the field', () => {
	it('refuses a section with no own root', () => {
		expect(refusal({})).toContain('ownRoot');
	});

	it('refuses an own root outside the tree', () => {
		expect(refusal({ ownRoot: '../escape' })).toContain('dot-dot');
	});

	it('refuses an unknown key rather than ignoring it', () => {
		expect(refusal({ ownRoot: 'own', ownDirName: 'own' })).toContain('ownDirName');
		expect(refusal({ ownRoot: 'own', commands: { build: 'make' } })).toContain('commands');
	});

	it('refuses an overlay target that is not a repository-relative path', () => {
		expect(refusal({ ownRoot: 'own', overlayTargets: ['/etc/passwd'] })).toContain('overlayTargets.0');
		expect(refusal({ ownRoot: 'own', overlayTargets: ['../outside.json'] })).toContain('overlayTargets.0');
	});

	it('refuses a watch channel with no pass boundaries: the tool never guesses them', () => {
		expect(refusal({ ownRoot: 'own', commands: { compile: [{ script: 'watch' }] } })).toContain('passStart');
		expect(refusal({ ownRoot: 'own', commands: { compile: [{ script: 'watch', passStart: ['^a$'], passEnd: ['^b$'] }] } })).toContain(
			'errorLine'
		);
	});

	it('refuses an empty command', () => {
		expect(refusal({ ownRoot: 'own', commands: { install: [] } })).toContain('commands.install');
		expect(refusal({ ownRoot: 'own', commands: { install: '' } })).toContain('commands.install');
	});
});

describe('the argv of a declared command', () => {
	it('splits a string on whitespace and keeps an array as written', () => {
		expect(argvOf('npm run lint')).toEqual(['npm', 'run', 'lint']);
		expect(argvOf('  npm   ci  ')).toEqual(['npm', 'ci']);
		expect(argvOf(['npm', 'run', 'a b'])).toEqual(['npm', 'run', 'a b']);
	});
});
