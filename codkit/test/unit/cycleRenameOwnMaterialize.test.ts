/** @scope spec://codkit/modules/codkit/PROP-009#phases */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/configFile.ts';
import { startCycle } from '../../src/lib/cycleControl.ts';
import { continueCycle } from '../../src/lib/cycleEngine.ts';
import { readCycleApplyRecord } from '../../src/lib/cycleEngineRecord.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { regeneratePatch } from '../../src/lib/patchGenerate.ts';
import { encodePatchName } from '../../src/lib/patchFormat.ts';
import { STATUS_PART_PATH, STATUSBAR_PART_PATH, fixtureCommit } from '../fixtures/makeUpstream.ts';
import { makeCliFixture, provideTreeDependencies } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const REFERENCE = 'delta/own/test/rename-path.test.ts';
const MATERIALIZED_REFERENCE = 'src/vs/patchset/test/rename-path.test.ts';

afterAll(cleanupTempRoots);

describe('cycle rename own materialization', () => {
	it('resumes exact own delivery after the canonical rename commit crash boundary', async () => {
		const fixture = preparedFixture();
		const config = requiredConfig(fixture);
		const materialized = fixture.treePath(MATERIALIZED_REFERENCE);
		expect(readFileSync(materialized, 'utf8')).toContain(STATUS_PART_PATH);
		expect((await continueFixture(fixture, config)).stop).toBe('rename-review');

		await expect(continueFixture(fixture, config, 'renames-committed')).rejects.toThrow('renames-committed');
		const committed = readCycleApplyRecord(fixture.patchesDir);
		expect(committed?.renameCommit).toMatch(/^[0-9a-f]{40}$/);
		expect(readFileSync(fixture.patchesPath(REFERENCE), 'utf8')).toContain(STATUSBAR_PART_PATH);
		expect(readFileSync(materialized, 'utf8')).toContain(STATUS_PART_PATH);

		const resumed = await continueFixture(fixture, config);
		expect(resumed.state?.phase).toBe('deps-advisory');
		expect(readFileSync(materialized, 'utf8')).toBe(readFileSync(fixture.patchesPath(REFERENCE), 'utf8'));
	});
});

function preparedFixture(): CliFixture {
	const fixture = makeCliFixture('cycle-rename-own-commit-crash');
	writeFileSync(join(fixture.patchesDir, '.git', 'info', 'exclude'), '.codkit/\ncodkit.local.json\n', 'utf8');
	provideTreeDependencies(fixture);
	addRenamePatch(fixture);
	const synced = fixture.json(['sync']);
	if (synced.run.status !== 0) throw new Error(synced.run.stderr);
	startCycle({
		patchesDir: fixture.patchesDir,
		forkDir: fixture.treeDir,
		config: requiredConfig(fixture),
		target: fixture.upstream.t2.tag
	});
	return fixture;
}

function addRenamePatch(fixture: CliFixture): void {
	const source = fixture.git(['show', `${fixture.upstream.t1.sha}:${STATUS_PART_PATH}`]);
	if (source.status !== 0) throw new Error(source.stderr);
	const id = 'CK-workbench-905';
	const header = [
		'# codkit-patch: 2',
		`# id: ${id}`,
		'# type: hook',
		'# category: follow',
		'# owner: workbench-core',
		'# reason: rename own materialization crash fixture',
		'# link: none',
		'# cause: none',
		`# pin: ${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
		'# contract-tests: none',
		''
	].join('\n');
	const generated = regeneratePatch({
		targetPath: STATUS_PART_PATH,
		pinBytes: Buffer.from(source.stdout),
		pinExists: true,
		curBytes: Buffer.from(`${source.stdout}// codkit:begin ${id}\n// rename own hook\n// codkit:end ${id}\n`),
		header,
		existingBytes: null,
		tmpDir: makeTempRoot('cycle-rename-own-patch')
	});
	if (generated.unchanged) throw new Error('rename own patch generation produced no bytes');
	writeFileSync(fixture.patchesPath(`delta/patches/${encodePatchName(STATUS_PART_PATH)}`), generated.bytes);
	writeFileSync(fixture.patchesPath(REFERENCE), `const guardedUpstreamPath = '${STATUS_PART_PATH}';\nvoid guardedUpstreamPath;\n`, 'utf8');
	fixtureCommit(fixture.patchesDir, 'fixture: add rename own patch', '2026-02-06T00:00:00Z');
}

function requiredConfig(fixture: CliFixture) {
	const config = loadConfig(fixture.patchesDir);
	if (config === null) throw new Error('fixture config missing');
	return config;
}

function continueFixture(fixture: CliFixture, config: ReturnType<typeof requiredConfig>, crash?: string) {
	return continueCycle({
		patchesDir: fixture.patchesDir,
		resolution: { path: fixture.treeDir, source: 'flag', exists: true, warning: null },
		config,
		ci: true,
		out: new Output({
			command: 'cycle continue',
			version: 'test',
			jsonMode: true,
			streams: { writeOut() {}, writeErr() {} }
		}),
		...(crash === undefined
			? {}
			: {
					dependencies: {
						checkpoint(name: string) {
							if (name === crash) throw new Error(name);
						}
					}
				})
	});
}
