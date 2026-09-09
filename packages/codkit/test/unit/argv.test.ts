import { describe, expect, it } from 'vitest';
import { parseArgv } from '../../src/lib/argv.ts';

describe('root flags', () => {
	it('accepts both root flags before or after the command', () => {
		const parsed = parseArgv(['--patches-dir', 'patches', 'where', '--fork-dir=fork']);
		expect(parsed).toEqual({
			ok: true,
			value: {
				flags: { patchesDir: 'patches', forkDir: 'fork', json: false, ci: false, verbose: false },
				commandFlags: new Map(),
				positional: ['where']
			}
		});
	});

	it('reports a missing patches-dir value as usage failure', () => {
		expect(parseArgv(['where', '--patches-dir'])).toEqual({
			ok: false,
			problem: { error: 'flag --patches-dir needs a path', hint: 'usage: --patches-dir <path>' }
		});
	});
});
