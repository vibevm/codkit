/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { describe, expect, it, vi } from 'vitest';
import type { CodkitConfig } from '../../src/lib/configFile.ts';
import type { ForkDirResolution } from '../../src/lib/paths.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';

const mocks = vi.hoisted(() => ({
	down: vi.fn(async (_root: string, channel: string) => Promise.reject(new Error(`cannot stop ${channel}`)))
}));

vi.mock('../../src/lib/buildWrap.ts', () => ({
	loadBuildWatch: () => ({ channels: [{ name: 'transpile' }, { name: 'typecheck' }] }),
	downChannel: mocks.down
}));

vi.mock('../../src/lib/verifyEngine.ts', () => ({
	runVerify: () => ({ findings: [], warnings: [], counts: {}, inventory: null, checked: 0 })
}));

vi.mock('../../src/lib/ciEngine.ts', () => ({
	runCi: async () => ({ exitCode: 0, profile: 'build', steps: [], branchTip: null, effectiveDiff: null })
}));

describe('concrete cycle stabilization cleanup', () => {
	it('keeps every daemon cleanup failure in deterministic channel order', async () => {
		const { runConcreteStabilization } = await import('../../src/lib/cycleStabilize.ts');
		const config = {
			codkitConfig: 2,
			pin: { tag: 't2', sha: '2'.repeat(40), date: '2026-08-02' },
			upstreamAnchorCommit: '1'.repeat(40),
			type: 'stub',
			typeConfig: { ownRoot: 'source/own' },
			generatedBranchPrefix: 'codkit/applied/',
			cycleBranchPrefix: 'codkit/cycle/',
			releaseRefPrefix: 'codkit/release/',
			publishRemoteUrl: null,
			buildWatchFile: null,
			conventionsExtensionFile: null
		} satisfies CodkitConfig;
		const resolution = { path: '/tree', source: 'flag', exists: true, warning: null } satisfies ForkDirResolution;

		const result = await runConcreteStabilization({ patchesDir: '/patchset', resolution, config, type: stubProjectType });

		expect(mocks.down.mock.calls.map((call) => call[1])).toEqual(['transpile', 'typecheck']);
		expect(result.cleanupErrors.map((error) => error.message)).toEqual(['cannot stop transpile', 'cannot stop typecheck']);
		expect(result.errors).toEqual([]);
		expect(result.runnerFailure).toBeNull();
	});
});
