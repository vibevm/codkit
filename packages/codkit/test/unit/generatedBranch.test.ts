// The complete generated history used by CI and future publish. A local load has
// a deliberately different contract and is checked here against regressions.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCi } from '../../src/lib/ciEngine.ts';
import { loadConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { checkoutPatchSetRef } from '../../src/lib/inventory.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { buildGeneratedTip, runSync } from '../../src/lib/syncEngine.ts';
import { fixtureCommit } from '../fixtures/makeUpstream.ts';
import { OVERLAY_ID, OWN_UNIT_ID, PATCH_FILE_NAME, PATCH_ID, RESOURCE_ID } from '../fixtures/makePatchSet.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

afterAll(cleanupTempRoots);

describe('complete generated branch objects', () => {
	it('orders patches, one aggregate own commit, overlays, then resources deterministically', () => {
		const fixture = makeSyncFixture('generated-order');
		const beforeHead = gitOut(fixture.treeDir, ['rev-parse', 'HEAD']);
		const first = buildGenerated(fixture);
		const second = buildGenerated(fixture);

		expect(second).toBe(first);
		expect(gitOut(fixture.treeDir, ['rev-parse', 'HEAD'])).toBe(beforeHead);
		expect(gitOut(fixture.treeDir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');

		const commits = gitOut(fixture.treeDir, ['rev-list', '--reverse', `${fixture.upstream.t1.sha}..${first}`]).split('\n');
		expect(commits).toHaveLength(4);
		const subjects = commits.map((commit) => gitOut(fixture.treeDir, ['show', '-s', '--format=%s', commit]));
		expect(subjects).toEqual([
			expect.stringContaining(PATCH_ID),
			'codkit: own code src/vs/patchset',
			expect.stringContaining(OVERLAY_ID),
			expect.stringContaining(RESOURCE_ID)
		]);

		const ownCommit = commits[1];
		expect(ownCommit).toBeDefined();
		const ownPaths = gitOut(fixture.treeDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', ownCommit ?? '']).split('\n');
		expect(ownPaths).toEqual(['src/vs/patchset/hello.ts', 'src/vs/patchset/test/fixture.test.ts']);
		expect(gitOut(fixture.treeDir, ['show', `${first}:src/vs/patchset/hello.ts`])).toBe(
			readFileSync(join(fixture.patchesDir, 'delta', 'own', 'hello.ts'), 'utf8').trimEnd()
		);
		expect(runGit({ args: ['cat-file', '-e', `${first}:src/vs/patchset/patchset.delta.json`], cwd: fixture.treeDir }).status).not.toBe(0);

		const body = gitOut(fixture.treeDir, ['show', '-s', '--format=%B', ownCommit ?? '']);
		expect(body).toContain(`Codkit-Patchset-Commit: ${gitOut(fixture.patchesDir, ['rev-parse', 'HEAD'])}`);
		expect(body).toContain(`Codkit-Upstream-Pin: t1@${fixture.upstream.t1.sha}`);
		const pinDate = gitOut(fixture.treeDir, ['show', '-s', '--format=%cI', fixture.upstream.t1.sha]);
		for (const commit of commits) {
			expect(gitOut(fixture.treeDir, ['show', '-s', '--format=%an <%ae>', commit])).toBe('codkit <codkit@patchset.invalid>');
			expect(gitOut(fixture.treeDir, ['show', '-s', '--format=%cI', commit])).toBe(pinDate);
		}
	});

	it('makes own-code changes visible in the effective tree diff', () => {
		const fixture = makeSyncFixture('generated-effective-own');
		const base = buildGenerated(fixture);
		const own = join(fixture.patchesDir, 'delta', 'own', 'hello.ts');
		writeFileSync(own, `${readFileSync(own, 'utf8')}\nexport const generatedDiffProbe = true;\n`, 'utf8');
		fixtureCommit(fixture.patchesDir, 'fixture: change own code', '2026-02-02T00:00:00Z');
		const current = buildGenerated(fixture);

		expect(current).not.toBe(base);
		expect(gitOut(fixture.treeDir, ['diff', '--name-only', base, current])).toBe('src/vs/patchset/hello.ts');
	});

	it('skips the own atom when the delivered own layer is empty', () => {
		const fixture = makeSyncFixture('generated-empty-own');
		rmSync(join(fixture.patchesDir, 'delta', 'own', 'hello.ts'));
		rmSync(join(fixture.patchesDir, 'delta', 'own', 'test'), { recursive: true });
		fixtureCommit(fixture.patchesDir, 'fixture: empty own layer', '2026-02-03T00:00:00Z');

		const first = buildGenerated(fixture);
		expect(buildGenerated(fixture)).toBe(first);
		const subjects = gitOut(fixture.treeDir, ['log', '--reverse', '--format=%s', `${fixture.upstream.t1.sha}..${first}`]).split('\n');
		expect(subjects).toHaveLength(3);
		expect(subjects.some((subject) => subject.includes('own code'))).toBe(false);
		expect(runGit({ args: ['cat-file', '-e', `${first}:src/vs/patchset/hello.ts`], cwd: fixture.treeDir }).status).not.toBe(0);
	});

	it('refuses another layer targeting delivered own code before cleanup or commit', async () => {
		const fixture = makeSyncFixture('generated-own-collision');
		const mapPath = join(fixture.patchesDir, 'delta', 'resources', 'map.json');
		const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { entries: { target: string }[] };
		const entry = map.entries[0];
		expect(entry).toBeDefined();
		if (entry !== undefined) entry.target = 'src/vs/patchset/hello.ts';
		writeFileSync(mapPath, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
		const litter = join(fixture.treeDir, 'collision-preflight-litter.txt');
		writeFileSync(litter, 'must survive failed --fresh preflight\n', 'utf8');
		const out = output();

		const result = runSync({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: fixture.config,
			type: vscodeType,
			out,
			fresh: true,
			dryRun: false,
			verbose: false,
			generatedBranch: true
		});

		expect(result.exitCode).toBe(1);
		expect(result.status).toBe('broken');
		const [error] = out.buildEnvelope(result.exitCode).errors;
		expect(error?.code).toBe('CK-E-ARTIFACT-BROKEN');
		expect(error?.message).toContain('src/vs/patchset/hello.ts');
		expect(error?.message).toContain('resource layer');
		expect(error?.message).toContain('own layer');
		expect(existsSync(litter)).toBe(true);
		expect(runGit({ args: ['rev-parse', '--verify', 'refs/heads/codkit/applied/t1'], cwd: fixture.treeDir }).status).not.toBe(0);

		const ciOut = output();
		const ci = await runCi({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: fixture.config,
			type: vscodeType,
			out: ciOut,
			profile: 'verify',
			effectiveDiffBase: null,
			pinGuardBase: null,
			verbose: false
		});
		expect(ci.exitCode).toBe(1);
		expect(ci.steps.at(-1)).toMatchObject({ name: 'fresh apply', state: 'failed' });
		expect(ciOut.buildEnvelope(ci.exitCode).errors.some((finding) => finding.code === 'CK-E-ARTIFACT-BROKEN')).toBe(true);
	});

	it.each([
		['unit', OWN_UNIT_ID],
		['serviceOverride', 'CK-workbench-999']
	] as const)('rejects a patch id already claimed by an own %s before cleanup', (kind, duplicateId) => {
		const fixture = makeSyncFixture(`generated-own-id-${kind}`);
		if (kind === 'serviceOverride') {
			const manifestPath = join(fixture.patchesDir, 'delta', 'own', 'patchset.delta.json');
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { serviceOverrides: unknown[] };
			manifest.serviceOverrides.push({
				id: duplicateId,
				serviceId: 'fixtureService',
				module: 'hello.ts',
				owner: 'workbench-core',
				reason: 'fixture duplicate generated id',
				link: 'none',
				cause: 'none',
				pin: `${fixture.upstream.t1.tag}@${fixture.upstream.t1.sha}`,
				contractTests: ['fixture.unit.hello']
			});
			writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
		}
		const patch = join(fixture.patchesDir, 'delta', 'patches', PATCH_FILE_NAME);
		writeFileSync(patch, readFileSync(patch, 'utf8').replace(`# id: ${PATCH_ID}`, `# id: ${duplicateId}`), 'utf8');
		const litter = join(fixture.treeDir, `own-id-${kind}-litter.txt`);
		writeFileSync(litter, 'must survive duplicate id preflight\n', 'utf8');
		const out = output();

		const result = runSync({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: fixture.config,
			type: vscodeType,
			out,
			fresh: true,
			dryRun: false,
			verbose: false,
			generatedBranch: true
		});

		expect(result.exitCode).toBe(1);
		const [error] = out.buildEnvelope(result.exitCode).errors;
		expect(error?.code).toBe('CK-E-ARTIFACT-BROKEN');
		expect(error?.message).toContain(`generated artifact id ${duplicateId}`);
		expect(error?.message).toContain(`patchset.delta.json ${kind}`);
		expect(existsSync(litter)).toBe(true);
		expect(runGit({ args: ['rev-parse', '--verify', 'refs/heads/codkit/applied/t1'], cwd: fixture.treeDir }).status).not.toBe(0);
	});
});

describe('full and local load modes', () => {
	it('is the branch capability selected by CI verify', async () => {
		const fixture = makeSyncFixture('generated-ci');
		const result = await runCi({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: fixture.config,
			type: vscodeType,
			out: output(),
			profile: 'verify',
			effectiveDiffBase: null,
			pinGuardBase: null,
			verbose: false
		});

		expect(result.exitCode).toBe(0);
		expect(gitOut(fixture.treeDir, ['ls-files', 'src/vs/patchset'])).toBe(
			['src/vs/patchset/hello.ts', 'src/vs/patchset/test/fixture.test.ts'].join('\n')
		);
		expect(
			gitOut(fixture.treeDir, ['log', '--format=%s', `${fixture.upstream.t1.sha}..HEAD`])
				.split('\n')
				.filter((subject) => subject === 'codkit: own code src/vs/patchset')
		).toHaveLength(1);
	});

	it('tracks own code in full mode without poisoning the local fast path', () => {
		const fixture = makeSyncFixture('generated-sync-mode');
		const full = runFullSync(fixture);
		const nonPatchTargets = ['product.json', 'resources/app-icon.bin', 'src/vs/patchset/hello.ts', 'src/vs/patchset/test/fixture.test.ts'];

		expect(full.status).toBe('applied');
		expect(full.nonPatchTargets).toEqual(nonPatchTargets);
		expect(gitOut(fixture.treeDir, ['ls-files', 'src/vs/patchset'])).toBe(
			['src/vs/patchset/hello.ts', 'src/vs/patchset/test/fixture.test.ts'].join('\n')
		);
		expect(gitOut(fixture.treeDir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
		expect(runFullSync(fixture).status).toBe('up-to-date');

		const local = fixture.sync();
		expect(local.status).toBe('applied');
		expect(local.nonPatchTargets).toEqual(nonPatchTargets);
		expect(gitOut(fixture.treeDir, ['ls-files', 'src/vs/patchset'])).toBe('');
		expect(readFileSync(join(fixture.treeDir, 'src', 'vs', 'patchset', 'hello.ts'), 'utf8')).toContain('export function hello');
		expect(gitOut(fixture.treeDir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
		const localSubjects = gitOut(fixture.treeDir, ['log', '--reverse', '--format=%s', `${fixture.upstream.t1.sha}..HEAD`]).split('\n');
		expect(localSubjects).toHaveLength(2);
		expect(localSubjects.some((subject) => subject.includes('own code'))).toBe(false);
	});

	it('invalidates the full fast path on chmod-only own changes and preserves scratch-checkout modes', () => {
		const fixture = makeSyncFixture('generated-own-modes');
		expect(runFullSync(fixture).status).toBe('applied');
		expect(runFullSync(fixture).status).toBe('up-to-date');

		const source = 'delta/own/hello.ts';
		gitOk(fixture.patchesDir, ['update-index', '--chmod=+x', '--', source]);
		commitIndex(fixture.patchesDir, 'fixture: make own file executable', '2026-02-04T00:00:00Z');
		const changed = runFullSync(fixture);
		expect(changed.status).toBe('applied');
		expect(gitOut(fixture.treeDir, ['ls-tree', changed.branchTip ?? '', '--', 'src/vs/patchset/hello.ts'])).toMatch(/^100755 /);

		const patchSetCommit = gitOut(fixture.patchesDir, ['rev-parse', 'HEAD']);
		const checkout = checkoutPatchSetRef(fixture.patchesDir, patchSetCommit);
		try {
			const config = loadConfig(checkout.dir);
			expect(config).not.toBeNull();
			const scratchTip = buildGeneratedTip({
				patchesDir: checkout.dir,
				resolution: fixture.resolution,
				config: config ?? fixture.config,
				type: vscodeType,
				out: output(),
				verbose: false,
				patchSetCommit,
				patchesRepositoryRoot: fixture.patchesDir
			});
			expect(gitOut(fixture.treeDir, ['ls-tree', scratchTip, '--', 'src/vs/patchset/hello.ts'])).toMatch(/^100755 /);
		} finally {
			checkout.release();
		}
	});
});

function buildGenerated(fixture: SyncFixture): string {
	return buildGeneratedTip({
		patchesDir: fixture.patchesDir,
		resolution: fixture.resolution,
		config: fixture.config,
		type: vscodeType,
		out: output(),
		verbose: false
	});
}

function runFullSync(fixture: SyncFixture) {
	return runSync({
		patchesDir: fixture.patchesDir,
		resolution: fixture.resolution,
		config: fixture.config,
		type: vscodeType,
		out: output(),
		fresh: false,
		dryRun: false,
		verbose: false,
		generatedBranch: true
	});
}

function output(): Output {
	return new Output({ command: 'generated-branch-test', version: 'test', jsonMode: true, streams: { writeOut() {}, writeErr() {} } });
}

function gitOut(cwd: string, args: readonly string[]): string {
	const result = runGit({ args, cwd });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trimEnd();
}

function gitOk(cwd: string, args: readonly string[]): void {
	const result = runGit({ args, cwd });
	expect(result.status, result.stderr).toBe(0);
}

function commitIndex(cwd: string, message: string, date: string): void {
	const result = runGit({
		args: ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--message', message],
		cwd,
		env: {
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date
		}
	});
	expect(result.status, result.stderr).toBe(0);
}
