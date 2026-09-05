// Final global CLI registration smoke: every aligned command is visible, new
// flags keep their arity and confinement, and real launcher dispatch reaches
// each surface's own domain gate without performing network mutation.

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const COMMANDS = [
	'where',
	'check-tree',
	'clone',
	'load',
	'status',
	'save',
	'marker new',
	'reresolve',
	'inventory',
	'verify',
	'overlay apply',
	'overlay check',
	'build up',
	'build down',
	'build status',
	'build errors',
	'cycle',
	'forecast',
	'rebase-onto-pin',
	'ci',
	'publish',
	'hooks'
] as const;

afterAll(cleanupTempRoots);

describe('aligned command roster', () => {
	it('prints every command once with its declared flags', () => {
		const fixture = makeCliFixture('surface-help');
		const run = fixture.run([]);

		expect(run.status).toBe(0);
		for (const command of COMMANDS) {
			const prefix = `  ${command.padEnd(18)}`;
			expect(
				run.stdout.split('\n').filter((line) => line.startsWith(prefix)),
				command
			).toHaveLength(1);
		}
		expect(run.stdout).toContain('marker new');
		expect(run.stdout).toContain('--layer');
		expect(run.stdout).toContain('reresolve');
		expect(run.stdout).toContain('--patch');
		expect(run.stdout).toContain('forecast');
		expect(run.stdout).toContain('--ref');
		expect(run.stdout).toContain('publish');
		expect(run.stdout).toContain('--release');
		expect(run.stdout).toContain('--yes-i-am-publish-bot');
	});

	it('keeps each new flag confined to the command that declares it', () => {
		const fixture = makeCliFixture('surface-flags');
		for (const [flag, value] of [
			['--ref', 'HEAD'],
			['--release', '1.2.3']
		] as const) {
			const run = fixture.run(['where', flag, value]);
			expect(run.status).toBe(2);
			expect(run.stderr).toContain(`flag ${flag} is not a flag of command 'where'`);
		}
		const bot = fixture.run(['where', '--yes-i-am-publish-bot']);
		expect(bot.status).toBe(2);
		expect(bot.stderr).toContain("flag --yes-i-am-publish-bot is not a flag of command 'where'");
		expect(fixture.run(['forecast', '--ref']).stderr).toContain('flag --ref needs a value');
		expect(fixture.run(['publish', 'HEAD', '--release']).stderr).toContain('flag --release needs a value');
	});
});

describe('real launcher surface dispatch', () => {
	it('reaches forecast --ci immutable-ref gate', () => {
		const fixture = makeCliFixture('surface-forecast');
		const { run, envelope } = fixture.json(['forecast', '--ci']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(envelope.errors[0]?.message).toContain('forecast --ci requires an explicit --ref');
	});

	it('reaches the rebase graph gate rather than unknown-command dispatch', () => {
		const fixture = makeCliFixture('surface-rebase');
		const { run, envelope } = fixture.json(['rebase-onto-pin']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.message).toContain('HEAD must have exactly two parents');
		expect(run.stderr).not.toContain('unknown command');
	});

	it.each([
		['forecast', ['forecast', '--ref', 'HEAD']],
		['rebase-onto-pin', ['rebase-onto-pin']]
	] as const)('%s rejects a repository without the configured upstream anchor before domain work', (_name, args) => {
		const fixture = makeCliFixture(`surface-identity-${_name}`);
		const configPath = fixture.patchesPath('codkit.json');
		const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
		config['upstreamAnchorCommit'] = 'f'.repeat(40);
		writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

		const { run, envelope } = fixture.json(args);
		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-NOT-UPSTREAM');
		expect(envelope.errors[0]?.message).toContain('upstream anchor commit');
	});

	it('parses publish release/bot flags and stops before network', () => {
		const fixture = makeCliFixture('surface-publish');
		const missingBot = fixture.json(['publish', 'HEAD', '--release', '1.2.3']);
		expect(missingBot.run.status).toBe(2);
		expect(missingBot.envelope.errors[0]?.message).toContain('--yes-i-am-publish-bot');

		const ci = fixture.json(['publish', 'HEAD', '--release=1.2.3', '--yes-i-am-publish-bot', '--ci']);
		expect(ci.run.status).toBe(2);
		expect(ci.envelope.errors[0]?.code).toBe('CK-E-NET-FORBIDDEN');
	});
});
