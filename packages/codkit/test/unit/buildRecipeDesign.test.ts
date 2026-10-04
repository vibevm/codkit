// Test-only translation examples for PROP-023, not a new runtime adapter/ABI.
import { expect, it } from 'vitest';
import type { BuildCommand } from '@codkit/type-api';
import { build } from '../../../type-vscode/src/build.ts';
import { projectTypeFor } from '../../../type-vscode/src/index.ts';
import { PLACEHOLDER_CONFIG } from '../../../type-vscode/src/configSchema.ts';
import { loadBuildWatch } from '../../src/lib/buildWrap.ts';

function oneShot(command: BuildCommand) {
	return { kind: 'one-shot', argv: [command.command, ...command.args], cwd: '.', environmentDiscovery: command.environment } as const;
}
it('represents current Node commands without changing argv or resolving environment early', () => {
	const commands = [...build.install, ...build.hygiene, ...build.packageBuild, build.ownTests('src/vs/patchset')!];
	for (const command of commands) {
		const action = oneShot(command);
		expect(action.argv).toEqual([command.command, ...command.args]);
		expect(action.environmentDiscovery).toBe(command.environment);
		expect(action.cwd).toBe('.');
	}
	expect(oneShot({ label: 'example', command: 'tool', args: ['', 'space name', '"quoted"', 'path__part'] }).argv).toEqual([
		'tool',
		'',
		'space name',
		'"quoted"',
		'path__part'
	]);
});
it('maps legacy Node watch scripts while retaining every pass-protocol field', () => {
	const watch = loadBuildWatch(projectTypeFor(PLACEHOLDER_CONFIG));
	for (const channel of watch.channels) {
		const { script, ...protocol } = channel;
		const action = { kind: 'daemon', argv: ['npm', 'run', script], cwd: '.', protocol };
		expect(action.argv).toEqual(['npm', 'run', channel.script]);
		expect({ ...action.protocol, script }).toEqual(channel);
		expect(action).not.toHaveProperty('script');
	}
});
