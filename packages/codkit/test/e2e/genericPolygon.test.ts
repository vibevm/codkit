// The second polygon end to end: a patch set of type `generic` over a plain git
// upstream (FEAT-002 S65, S66; FEAT-001 ##POLYGON-GENERIC-COVERAGE).
//
// S66 asks for `load`, an edit, `save`, `verify`, the cycle onto the second pin
// and `ci --profile verify`, with the inventory explaining every generated path
// exactly once and no step naming a fact of another type. S65 asks for the
// refusals of the verbs this type does not answer.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { OWN_ROOT, PATCH_FILE_NAME, PATCH_ID, RULE_ID } from '../fixtures/makeGenericPatchSet.ts';
import { APP_MANIFEST_PATH, LOGO_PATH, PANEL_PATH } from '../fixtures/makeGenericUpstream.ts';
import { excludeGenericRuntimeState, makeGenericFixture, provideGenericTreeDependencies } from '../support/genericFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

describe('the generic polygon carries every layer a plain upstream has', () => {
	it('names the type, passes check-tree and materializes each layer with load', () => {
		const fixture = makeGenericFixture('generic-load');

		const where = fixture.json(['where']);
		expect(where.run.status, where.run.stderr).toBe(0);
		expect(where.envelope.codkit.type).toBe('generic');
		expect(where.envelope.data['type']).toBe('generic');

		const tree = fixture.json(['check-tree']);
		expect(tree.run.status, tree.run.stderr).toBe(0);

		const loaded = fixture.json(['load']);
		expect(loaded.run.status, loaded.run.stderr).toBe(0);

		// own code mirrored into the configured own root
		expect(readFileSync(fixture.treePath(`${OWN_ROOT}/badge.ts`), 'utf8')).toContain('export function badge');
		// the patch's marker block
		expect(readFileSync(fixture.treePath(PANEL_PATH), 'utf8')).toContain(`// codkit:begin ${PATCH_ID}`);
		// the resource file
		expect(readFileSync(fixture.treePath(LOGO_PATH))[0]).toBe(0xaa);
		// the overlay target is upstream's until it is applied: this type has no
		// development channel, so nothing is written beside the target either
		const pinned = JSON.parse(readFileSync(fixture.treePath(APP_MANIFEST_PATH), 'utf8')) as Record<string, unknown>;
		expect(pinned['displayName']).toBe('Fixture App');

		const status = fixture.json(['status']);
		expect(status.run.status, status.run.stderr).toBe(0);
	}, 30_000);

	it('materializes the overlay over the one JSON document the upstream has', () => {
		const fixture = makeGenericFixture('generic-overlay');
		expect(fixture.json(['load']).run.status).toBe(0);

		const applied = fixture.json(['overlay', 'apply', APP_MANIFEST_PATH]);
		expect(applied.run.status, applied.run.stderr).toBe(0);
		const manifest = JSON.parse(readFileSync(fixture.treePath(APP_MANIFEST_PATH), 'utf8')) as Record<string, unknown>;
		expect(manifest['displayName']).toBe('Fixture PatchSet');
		expect(manifest['patchsetPin']).toBe(fixture.upstream.v1.tag);

		const checked = fixture.json(['overlay', 'check', APP_MANIFEST_PATH]);
		expect(checked.run.status, checked.run.stderr).toBe(0);
		expect(checked.envelope.data['materialized']).toBe(true);
		expect(fixture.json(['load', '--fresh']).run.status).toBe(0);
	}, 30_000);

	it('explains every generated path exactly once in the inventory', () => {
		const fixture = makeGenericFixture('generic-inventory');
		expect(fixture.json(['load']).run.status).toBe(0);

		const inventory = fixture.json(['inventory']);
		expect(inventory.run.status, inventory.run.stderr).toBe(0);
		const data = inventory.envelope.data as { inventory: { entries: readonly { id: string; layer: string }[] } };
		const rows = data.inventory.entries;
		const ids = rows.map((row) => row.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain(RULE_ID);
		expect(rows.map((row) => row.layer).sort()).toEqual(['config-overlay', 'own', 'patch', 'resource-file', 'rewrite-rule']);
	}, 30_000);

	it('takes an edit of own code back out of the tree with save', () => {
		const fixture = makeGenericFixture('generic-save');
		expect(fixture.json(['load']).run.status).toBe(0);

		const inTree = fixture.treePath(`${OWN_ROOT}/badge.ts`);
		writeFileSync(inTree, `${readFileSync(inTree, 'utf8')}\nexport const EDITED = true;\n`, 'utf8');

		const saved = fixture.json(['save']);
		expect(saved.run.status, saved.run.stderr).toBe(0);
		expect(readFileSync(fixture.patchesPath('delta/own/badge.ts'), 'utf8')).toContain('EDITED');

		const verified = fixture.json(['verify']);
		expect(verified.run.status, verified.run.stderr).toBe(0);
	}, 30_000);

	it('regenerates a patch from an edit inside its marker block', () => {
		const fixture = makeGenericFixture('generic-save-patch');
		expect(fixture.json(['load']).run.status).toBe(0);

		const target = fixture.treePath(PANEL_PATH);
		const edited = readFileSync(target, 'utf8').replace(
			'// (hook body lives in own/badge.ts; this block only delegates)',
			'// (hook body lives in own/badge.ts; edited inside the marker block)'
		);
		writeFileSync(target, edited, 'utf8');

		const saved = fixture.json(['save']);
		expect(saved.run.status, saved.run.stderr).toBe(0);
		expect(readFileSync(fixture.patchesPath(`delta/patches/${PATCH_FILE_NAME}`), 'utf8')).toContain('edited inside the marker block');
		expect(fixture.json(['verify']).run.status).toBe(0);
	}, 30_000);

	it('passes ci --profile verify', () => {
		const fixture = makeGenericFixture('generic-ci');
		const ci = fixture.json(['ci', '--profile', 'verify']);
		expect(ci.run.status, ci.run.stderr).toBe(0);
		const steps = ci.envelope.data['steps'] as readonly { name: string; state: string }[];
		expect(steps.every((step) => step.state !== 'failed')).toBe(true);
	}, 60_000);

	it('publishes an immutable release ref to a local bare remote', () => {
		const fixture = makeGenericFixture('generic-publish');
		excludeGenericRuntimeState(fixture);
		const remote = join(makeTempRoot('generic-publish-remote'), 'publish.git');
		const cloned = runGit({
			args: ['clone', '--bare', '--quiet', fixture.upstream.dir, remote],
			cwd: fixture.patchesDir,
			netAllowed: true
		});
		expect(cloned.status, cloned.stderr).toBe(0);
		writeFileSync(fixture.patchesPath('codkit.local.json'), `${JSON.stringify({ publishRemoteUrl: remote }, null, 2)}\n`, 'utf8');

		const published = fixture.json(['publish', 'HEAD', '--yes-i-am-publish-bot', '--profile', 'verify']);
		expect(published.run.status, published.run.stderr).toBe(0);
		const refs = runGit({ args: ['for-each-ref', '--format=%(refname)', 'refs/heads/codkit/release/'], cwd: remote });
		expect(refs.stdout.trim().length).toBeGreaterThan(0);
	}, 60_000);

	it('runs the cycle onto the second pin, stopping only where the upgrade asks a person', () => {
		const fixture = makeGenericFixture('generic-cycle');
		excludeGenericRuntimeState(fixture);
		provideGenericTreeDependencies(fixture);
		expect(fixture.json(['load']).run.status).toBe(0);

		const started = fixture.json(['cycle', 'start', fixture.upstream.v2.tag, '--ci'], { STUB_LINT_MODE: 'fail' });
		expect(started.run.status, started.run.stderr).toBe(3);
		expect(started.envelope.data['status']).toBe('stopped');

		const resumed = fixture.json(['cycle', 'continue', '--ci']);
		expect(resumed.run.status, `${resumed.run.stderr}\n${JSON.stringify(resumed.envelope.data)}`).toBe(0);
		expect(resumed.envelope.data['status']).toBe('completed');
		expect(resumed.envelope.data['phase']).toBe('done');

		const config = JSON.parse(readFileSync(fixture.patchesPath('codkit.json'), 'utf8')) as { pin: { tag: string } };
		expect(config.pin.tag).toBe(fixture.upstream.v2.tag);
	}, 120_000);
});

describe('what a type with no product model refuses', () => {
	it('refuses every verb that needs a capability it does not declare, before any write', () => {
		const fixture = makeGenericFixture('generic-refusals');

		for (const [args, capability] of [
			[['imageset', 'gen'], 'brand-images'],
			[['imageset', 'index'], 'brand-images'],
			[['imageset', 'verify'], 'brand-images'],
			[['gen', 'brand'], 'gen-brand'],
			[['build', 'up'], 'build-channels'],
			[['build', 'status'], 'build-channels'],
			[['runtime', 'load'], 'runtime-library'],
			[['runtime', 'check'], 'runtime-library']
		] as const) {
			const outcome = fixture.json([...args]);
			expect(outcome.run.status, `${args.join(' ')}: ${outcome.run.stderr}`).toBe(2);
			expect(outcome.envelope.errors[0]?.code, args.join(' ')).toBe('CK-E-TYPE-CAPABILITY');
			expect(outcome.envelope.errors[0]?.message, args.join(' ')).toContain(capability);
			expect(outcome.envelope.errors[0]?.message, args.join(' ')).toContain('generic');
			expect(outcome.envelope.errors[0]?.hint ?? '', args.join(' ')).toContain('nothing was written');
		}
	}, 60_000);

	it('refuses an artifact of a layer this type does not have', () => {
		const fixture = makeGenericFixture('generic-layer-refusal');
		const manifestPath = fixture.patchesPath('delta/own/patchset.delta.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
		manifest['serviceOverrides'] = [
			{
				id: 'CK-app-904',
				layer: 'own',
				type: 'replace',
				category: 'own',
				owner: 'app-core',
				reason: 'a service override on an upstream that has no service registry',
				link: 'none',
				cause: 'none',
				pin: `${fixture.upstream.v1.tag}@${fixture.upstream.v1.sha}`,
				contractTests: ['fixture.generic.badge'],
				serviceId: 'IThingService',
				module: 'delta/own/badge.ts'
			}
		];
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

		const verified = fixture.json(['verify']);
		expect(verified.run.status).toBe(2);
		expect(verified.envelope.errors[0]?.code).toBe('CK-E-TYPE-CAPABILITY');
		expect(verified.envelope.errors[0]?.message).toContain('service-override');
	}, 30_000);
});
