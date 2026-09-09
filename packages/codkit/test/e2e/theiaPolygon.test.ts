// The third polygon end to end: a patch set of type `theia` over a synthetic
// Eclipse Theia monorepo (FEAT-002 S70-S75; FEAT-001 ##POLYGON-THEIA-COVERAGE).
//
// What it proves is the model of the type, not the framework: the fingerprints
// of a healthy tree, the own package materialized as a workspace package, the
// application manifest as the overlay target, the `rebind` verified together
// with the dependency edge that makes it win, the refusal of a layer this
// family does not have, and the cycle onto the second pin with the advisory
// that names the version of the monorepo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	APPLICATION_ENTRY,
	APPLICATION_NAME,
	APPLICATION_NOTICE,
	APPLICATION_UNIT_ID,
	ENTRY_MODULE_PATCH_NAME,
	OVERRIDE_ID,
	OVERRIDE_MODULE,
	OWN_PACKAGE_NAME,
	OWN_ROOT,
	PATCH_ID,
	writeEntryModulePatch
} from '../fixtures/makeTheiaPatchSet.ts';
import { APPLICATION_MANIFEST, APPLICATION_ROOT, CORE_MODULE_PATH, NEW_VERSION, OLD_VERSION } from '../fixtures/makeTheiaUpstream.ts';
import { excludeTheiaRuntimeState, makeTheiaFixture, provideTheiaTreeDependencies } from '../support/theiaFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** The application manifest as it stands in the fork tree right now. */
function applicationManifest(fixture: ReturnType<typeof makeTheiaFixture>): Record<string, unknown> {
	return JSON.parse(readFileSync(fixture.treePath(APPLICATION_MANIFEST), 'utf8')) as Record<string, unknown>;
}

describe('S70 - the tree is proved by the fingerprints of the family and by the pin', () => {
	it('names the type and passes every check of check-tree', () => {
		const fixture = makeTheiaFixture('theia-check');

		const where = fixture.json(['where']);
		expect(where.run.status, where.run.stderr).toBe(0);
		expect(where.envelope.codkit.type).toBe('theia');

		const tree = fixture.json(['check-tree']);
		expect(tree.run.status, tree.run.stderr).toBe(0);
		const checks = tree.envelope.data['checks'] as readonly { id: string; ok: boolean }[];
		expect(checks.map((check) => check.id)).toContain('fingerprints');
		expect(checks.every((check) => check.ok)).toBe(true);
	}, 30_000);

	it('refuses a tree whose core package disagrees with lerna.json about the version', () => {
		// ##THEIA-TREE-FINGERPRINT: the version of the monorepo is one literal,
		// and a tree in the middle of a bump is not a tree to work on.
		const fixture = makeTheiaFixture('theia-check-broken');
		const manifest = fixture.treePath('packages/core/package.json');
		writeFileSync(manifest, readFileSync(manifest, 'utf8').replace(OLD_VERSION, '1.74.0'), 'utf8');

		const tree = fixture.json(['check-tree']);
		expect(tree.run.status).toBe(2);
		expect(tree.envelope.errors[0]?.code).toBe('CK-E-NOT-UPSTREAM');
		expect(tree.envelope.errors[0]?.message).toContain('packages/core/package.json');
		expect(tree.envelope.errors[0]?.message).toContain(OLD_VERSION);
	}, 30_000);
});

describe('S71 - load materializes the own package, and the overlay writes the application manifest', () => {
	it('mirrors the whole own package into its workspace directory', () => {
		const fixture = makeTheiaFixture('theia-load');
		const loaded = fixture.json(['load']);
		expect(loaded.run.status, loaded.run.stderr).toBe(0);

		// ##THEIA-OWN-PACKAGE-SHAPE: the manifest, the lint and compiler
		// configuration and the sources, at a workspace package directory.
		const manifest = JSON.parse(readFileSync(fixture.treePath(`${OWN_ROOT}/package.json`), 'utf8')) as Record<string, unknown>;
		expect(manifest['name']).toBe(OWN_PACKAGE_NAME);
		expect(manifest['theiaExtensions']).toBeDefined();
		expect(readFileSync(fixture.treePath(`${OWN_ROOT}/${OVERRIDE_MODULE}`), 'utf8')).toContain('rebind(EditorManager)');
		expect(readFileSync(fixture.treePath(`${OWN_ROOT}/.eslintrc.js`), 'utf8')).toContain('tsconfigRootDir');

		// ##THEIA-OWN-IS-INCLUDED-BY-DEPENDENCY: nothing was patched to *include*
		// own code - the one patch of this delta is a hook of its own, and the
		// application reaches the own package through its dependency list.
		expect(readFileSync(fixture.treePath(CORE_MODULE_PATH), 'utf8')).toContain(`// codkit:begin ${PATCH_ID}`);

		// The overlay has no development channel in this family, so the target is
		// still upstream's until it is applied, and nothing sits beside it.
		expect(applicationManifest(fixture)['productName']).toBe('Theia Electron Example');

		const status = fixture.json(['status']);
		expect(status.run.status, status.run.stderr).toBe(0);
	}, 30_000);

	it('writes the identity of the product into the application manifest', () => {
		// ##THEIA-OVERLAY-TARGET, ##THEIA-IDENTITY-FUNNEL: one key, not a graft.
		const fixture = makeTheiaFixture('theia-overlay');
		expect(fixture.json(['load']).run.status).toBe(0);

		const applied = fixture.json(['overlay', 'apply', APPLICATION_MANIFEST]);
		expect(applied.run.status, applied.run.stderr).toBe(0);
		const manifest = applicationManifest(fixture);
		expect(manifest['productName']).toBe(APPLICATION_NAME);
		const theia = manifest['theia'] as { frontend: { config: { applicationName: string } } };
		expect(theia.frontend.config.applicationName).toBe(APPLICATION_NAME);
		const dependencies = manifest['dependencies'] as Record<string, string>;
		expect(dependencies[OWN_PACKAGE_NAME]).toBe(OLD_VERSION);

		const checked = fixture.json(['overlay', 'check', APPLICATION_MANIFEST]);
		expect(checked.run.status, checked.run.stderr).toBe(0);
		expect(checked.envelope.data['materialized']).toBe(true);
	}, 30_000);

	it('explains every generated path exactly once in the inventory', () => {
		const fixture = makeTheiaFixture('theia-inventory');
		expect(fixture.json(['load']).run.status).toBe(0);

		const inventory = fixture.json(['inventory']);
		expect(inventory.run.status, inventory.run.stderr).toBe(0);
		const data = inventory.envelope.data as { inventory: { entries: readonly { id: string; layer: string }[] } };
		const ids = data.inventory.entries.map((row) => row.id);
		expect(new Set(ids).size).toBe(ids.length);
		// Two own units: the own package, and the files of the second owned
		// directory - the product's application (PROP-016 ##TYPE-AREA-LAYOUT).
		expect(data.inventory.entries.map((row) => row.layer).sort()).toEqual(['config-overlay', 'own', 'own', 'patch', 'service-override']);
		expect(ids).toContain(APPLICATION_UNIT_ID);
	}, 30_000);
});

describe('S72 - the service override is the rebind and the dependency edge together', () => {
	it('accepts the override the own package declares', () => {
		const fixture = makeTheiaFixture('theia-verify');
		expect(fixture.json(['load']).run.status).toBe(0);

		const verified = fixture.json(['verify']);
		expect(verified.run.status, verified.run.stderr).toBe(0);
	}, 30_000);

	it('refuses the same rebind when the own package does not depend on the package that binds the service', () => {
		// ##THEIA-OVERRIDE-VERIFIER: without the edge the collector may load the
		// own module first, and the rebind is overridden itself.
		const fixture = makeTheiaFixture('theia-verify-no-edge');
		const manifestPath = fixture.patchesPath('delta/own/package.json');
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
		manifest['dependencies'] = {};
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

		const verified = fixture.json(['verify']);
		expect(verified.run.status).toBe(1);
		const findings = verified.envelope.data['findings'] as readonly { code: string; message: string }[];
		const finding = findings.find((entry) => entry.message.includes(OVERRIDE_ID));
		expect(finding?.message).toContain('@theia/core');
		expect(finding?.message).toContain('load');
	}, 30_000);
});

describe('S73 - a layer this family does not have is refused', () => {
	it('refuses an entry-module artifact with CK-E-TYPE-CAPABILITY', () => {
		// ##THEIA-NO-ENTRY-MODULE: there is no entry to graft into, because own
		// code is included by a dependency line.
		const fixture = makeTheiaFixture('theia-entry-module');
		writeEntryModulePatch(fixture.patchesDir, fixture.upstream);

		const verified = fixture.json(['verify']);
		expect(verified.run.status).toBe(2);
		expect(verified.envelope.errors[0]?.code).toBe('CK-E-TYPE-CAPABILITY');
		expect(verified.envelope.errors[0]?.message).toContain('entry-module');
		expect(verified.envelope.errors[0]?.message).toContain(ENTRY_MODULE_PATCH_NAME);
		expect(verified.envelope.errors[0]?.message).toContain('theia');
	}, 30_000);

	it('refuses every verb whose capability this family does not declare', () => {
		const fixture = makeTheiaFixture('theia-refusals');
		for (const [args, capability] of [
			[['imageset', 'gen'], 'brand-images'],
			[['gen', 'brand'], 'gen-brand'],
			[['runtime', 'load'], 'runtime-library'],
			[['runtime', 'check'], 'runtime-library']
		] as const) {
			const outcome = fixture.json([...args]);
			expect(outcome.run.status, `${args.join(' ')}: ${outcome.run.stderr}`).toBe(2);
			expect(outcome.envelope.errors[0]?.code, args.join(' ')).toBe('CK-E-TYPE-CAPABILITY');
			expect(outcome.envelope.errors[0]?.message, args.join(' ')).toContain(capability);
			expect(outcome.envelope.errors[0]?.message, args.join(' ')).toContain('theia');
		}
	}, 60_000);

	it('answers build, which this family does declare', () => {
		// ##THEIA-BUILD-CHANNELS: two channels, named after the two compilers.
		const fixture = makeTheiaFixture('theia-build-status');
		const status = fixture.json(['build', 'status', '--channel', 'all']);
		expect(status.run.status, status.run.stderr).toBe(0);
		const channels = status.envelope.data['channels'] as readonly { channel: string }[];
		expect(channels.map((channel) => channel.channel).sort()).toEqual(['bundle', 'typecheck']);
	}, 30_000);
});

describe('S74 - the cycle onto the second pin, with the advisory of this family', () => {
	it('stops for the advisory that names the version of the monorepo, then completes', () => {
		const fixture = makeTheiaFixture('theia-cycle');
		excludeTheiaRuntimeState(fixture);
		provideTheiaTreeDependencies(fixture);
		expect(fixture.json(['load']).run.status).toBe(0);

		// Without --ci the advisory is a stop for a person: the version of the
		// monorepo moved, and every @theia/* literal moves with it
		// (##THEIA-ADVISORY-READERS).
		const started = fixture.json(['cycle', 'start', fixture.upstream.v2.tag]);
		expect(started.run.status, started.run.stderr).toBe(3);
		expect(started.envelope.data['stop']).toBe('dependency-advisory');

		// The report the cycle wrote onto its own branch is where the advisory
		// stands, and it names the readers of this family that changed.
		const commits = started.envelope.data['commits'] as readonly string[];
		const head = commits[commits.length - 1] ?? '';
		const report = fixture.patchGit(['show', `${head}:cycle/report/deps-advisory.json`]).stdout;
		expect(report).toContain('monorepo-version');
		expect(report).toContain('lerna.json');
		expect(report).toContain(NEW_VERSION);
		// The entry kinds of a theiaExtensions array changed too, and that is the
		// second thing this family's advisory has an opinion about.
		expect(report).toContain('extension-entry-kinds');

		// The gates of the upstream run over the tree the cycle built: a red lint
		// stops it where a person has to look, and the journal of the cycle is
		// what carries that stop to the next run.
		const red = fixture.json(['cycle', 'continue', '--ci'], { STUB_LINT_MODE: 'fail' });
		expect(red.run.status, red.run.stderr).toBe(3);
		expect(red.envelope.data['stop']).toBe('stabilize-red');

		const resumed = fixture.json(['cycle', 'continue', '--ci']);
		expect(resumed.run.status, `${resumed.run.stderr}\n${JSON.stringify(resumed.envelope.data)}`).toBe(0);
		expect(resumed.envelope.data['status']).toBe('completed');

		const config = JSON.parse(readFileSync(fixture.patchesPath('codkit.json'), 'utf8')) as { pin: { tag: string } };
		expect(config.pin.tag).toBe(fixture.upstream.v2.tag);
	}, 180_000);
});

describe('S75 - the second owned directory, and the build output inside an owned one', () => {
	it('materializes the application beside the own package, and leaves upstream files in it alone', () => {
		// ##THEIA-APPLICATION-ROOT, PROP-005 ##OWN-ROOTS-IN-THE-DELTA: the delta
		// owns two directories, and inside the application the pin is the
		// boundary - its manifest is upstream's file and the overlay's target.
		const fixture = makeTheiaFixture('theia-owned');
		expect(fixture.json(['load']).run.status).toBe(0);

		expect(readFileSync(fixture.treePath(`${APPLICATION_ROOT}/${APPLICATION_ENTRY}`), 'utf8')).toContain('src-gen/frontend');
		expect(readFileSync(fixture.treePath(`${APPLICATION_ROOT}/${APPLICATION_NOTICE}`), 'utf8')).toContain('Acme Studio');
		expect(applicationManifest(fixture)['productName']).toBe('Theia Electron Example');

		// A second load over the materialized tree is the daily case: neither
		// directory carries unextracted work, and the manifest the pin ships is
		// not read as an own file the delta lost.
		const again = fixture.json(['load']);
		expect(again.run.status, again.run.stderr).toBe(0);

		const status = fixture.json(['status']);
		expect(status.run.status, status.run.stderr).toBe(0);
		const own = status.envelope.data['own'] as { changed: number };
		expect(own.changed).toBe(0);

		const verified = fixture.json(['verify']);
		expect(verified.run.status, verified.run.stderr).toBe(0);
	}, 60_000);

	it('does not read a compiled package as changed own code, and a fresh pass removes the output', () => {
		// ##THEIA-OWN-ROOT-CARRIES-ITS-BUILD-OUTPUT: `tsc -b` writes lib/ next to
		// the sources inside the owned directory. This is the defect P5 measured
		// on a real clone, and the whole point of the build outputs of the type.
		const fixture = makeTheiaFixture('theia-compiled');
		provideTheiaTreeDependencies(fixture);
		expect(fixture.json(['load']).run.status).toBe(0);

		compile(fixture);
		const status = fixture.json(['status']);
		expect(status.run.status, status.run.stderr).toBe(0);
		const own = status.envelope.data['own'] as { changed: number };
		expect(own.changed).toBe(0);

		// A load over the compiled tree passes and leaves the output where the
		// build put it: nothing recompiles for a load.
		const loaded = fixture.json(['load']);
		expect(loaded.run.status, loaded.run.stderr).toBe(0);
		expect(existsSync(fixture.treePath(`${OWN_ROOT}/lib/browser/acme-editor-manager.js`))).toBe(true);

		// An edit of own code is extracted; the build output beside it is not.
		const source = fixture.treePath(`${OWN_ROOT}/src/browser/acme-editor-manager.ts`);
		writeFileSync(source, `${readFileSync(source, 'utf8')}// a line the tree added\n`, 'utf8');
		const saved = fixture.json(['save']);
		expect(saved.run.status, saved.run.stderr).toBe(0);
		expect(readFileSync(fixture.patchesPath('delta/own/src/browser/acme-editor-manager.ts'), 'utf8')).toContain('a line the tree added');
		expect(existsSync(fixture.patchesPath('delta/own/lib'))).toBe(false);
		expect(existsSync(fixture.patchesPath('delta/own/tsconfig.tsbuildinfo'))).toBe(false);

		// The fresh pass is the run that removes it (##THEIA-CLEANUP-WHITELIST).
		const fresh = fixture.json(['load', '--fresh']);
		expect(fresh.run.status, fresh.run.stderr).toBe(0);
		expect(existsSync(fixture.treePath(`${OWN_ROOT}/lib/browser/acme-editor-manager.js`))).toBe(false);
		expect(existsSync(fixture.treePath(`${OWN_ROOT}/src/browser/acme-editor-manager.ts`))).toBe(true);
	}, 60_000);
});

/** What `tsc -b` of this family leaves inside the owned directory of the package. */
function compile(fixture: ReturnType<typeof makeTheiaFixture>): void {
	const output = fixture.treePath(`${OWN_ROOT}/lib/browser/acme-editor-manager.js`);
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(output, '"use strict";\n// compiled by the fixture\n', 'utf8');
	writeFileSync(fixture.treePath(`${OWN_ROOT}/tsconfig.tsbuildinfo`), '{"version":"1"}\n', 'utf8');
	writeFileSync(fixture.treePath(`${OWN_ROOT}/.eslintcache`), '[]\n', 'utf8');
}
