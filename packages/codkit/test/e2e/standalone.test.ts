/** @scope spec://codkit/modules/codkit/PROP-008#root */
// One end-to-end proof that the installed tool, patch set, fork, settings and
// caller cwd are five unrelated locations.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const launcher = join(toolRoot, 'bin', 'codkit.mjs');

afterAll(cleanupTempRoots);

describe('standalone Codkit roots', () => {
	it('syncs an arbitrary fork and patch set using only user settings', () => {
		const fixture = makeCliFixture('standalone-settings');
		const home = makeTempRoot('standalone-home');
		const settings = join(home, '.codkit', 'settings.json');
		mkdirSync(dirname(settings), { recursive: true });
		writeFileSync(
			settings,
			`${JSON.stringify({ codkitSettings: 1, patchesDir: fixture.patchesDir, forkDir: fixture.treeDir }, null, 2)}\n`,
			'utf8'
		);
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
		delete env['CODKIT_PATCHES_DIR'];
		delete env['CODKIT_FORK_DIR'];
		env['HOME'] = home;

		const run = spawnSync(process.execPath, [launcher, '--json', 'load'], {
			cwd: makeTempRoot('standalone-caller'),
			env,
			encoding: 'utf8'
		});

		expect(run.status, run.stderr).toBe(0);
		const envelope = JSON.parse(run.stdout) as {
			roots: { patches: { path: string; source: string }; fork: { path: string; source: string } };
			data: { status: string; branch: string };
		};
		expect(envelope.roots.patches).toMatchObject({ path: fixture.patchesDir, source: 'settings' });
		expect(envelope.roots.fork).toMatchObject({ path: fixture.treeDir, source: 'settings' });
		expect(envelope.data).toMatchObject({ status: 'applied', branch: fixture.branch });
	});
});
