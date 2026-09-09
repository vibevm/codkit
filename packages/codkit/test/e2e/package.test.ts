// e2e: `codkit package` through the real launcher (PROP-007 sec. 27
// ##CMD-PACKAGE, FEAT-002 S77-S79).
//
// The fixture's packager is two npm scripts of the pseudo-upstream: each one
// asserts that the overlay target was materialized and prints the stamps it was
// handed, then writes a file into every output the stub type declares. So the
// suite proves the order of the run - overlay, stamps, build, distributable -
// from the packager's side, and the state of the tree afterwards from codkit's.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

type Step = { name: string; state: string; detail: string };
type PackageData = {
	steps: Step[];
	materialized: string[];
	restored: string[];
	stamps: Record<string, string>;
	commands: string[];
	outputs: string[];
};

let fixture: CliFixture;

function data(envelope: { data: Record<string, unknown> }): PackageData {
	return envelope.data as unknown as PackageData;
}

/** The bytes the pin carries for the overlay target: what a dev tree has. */
function manifestAtPin(): string {
	return fixture.git(['show', `${fixture.upstream.t1.sha}:manifest.json`]).stdout;
}

function manifestInTree(): string {
	return readFileSync(fixture.treePath('manifest.json'), 'utf8');
}

function removeArtifacts(): void {
	rmSync(fixture.treePath('.build/package'), { recursive: true, force: true });
	rmSync(fixture.treePath('.build/app-1.tar'), { force: true });
}

beforeAll(() => {
	fixture = makeCliFixture('package');
	expect(fixture.run(['load']).status).toBe(0);
});

afterAll(() => {
	cleanupTempRoots();
});

describe('codkit package', () => {
	it('materializes the overlay, stamps the build, runs both halves and puts the tree back', () => {
		removeArtifacts();
		const { run, envelope } = fixture.json(['package']);

		expect(run.status).toBe(0);
		expect(envelope.errors).toEqual([]);
		const report = data(envelope);
		expect(report.steps.map((step) => step.name)).toEqual([
			'drift guard',
			'overlay apply',
			'stamps',
			'package build',
			'package distributable',
			'outputs',
			'restore'
		]);
		expect(report.steps.every((step) => step.state === 'ok')).toBe(true);

		// The stamps of the stub type, filled from the tree head and the pin tag.
		expect(report.stamps['BUILD_SOURCE_VERSION']).toBe(fixture.git(['rev-parse', 'HEAD']).stdout.trim());
		expect(report.stamps['BUILD_QUALITY']).toBe(fixture.upstream.t1.tag);
		expect(run.stderr).toContain(`build: BUILD_QUALITY=${fixture.upstream.t1.tag}`);
		expect(run.stderr).toContain('distributable: fixture packaging finished');

		// Both halves ran, in that order, and the packager saw the materialized
		// target - it exits 1 otherwise.
		expect(report.commands).toEqual(['npm run package', 'npm run package-distributable']);

		// What it made, where the type said it would be.
		expect(report.outputs).toEqual(['.build/package/', '.build/app-1.tar']);
		expect(existsSync(fixture.treePath('.build/app-1.tar'))).toBe(true);

		// And the tree is a dev tree again: the target is the pin's, the dev
		// channel is back, and `status` is clean.
		expect(report.materialized).toEqual(['manifest.json']);
		expect(report.restored).toEqual(['manifest.json']);
		expect(manifestInTree()).toBe(manifestAtPin());
		expect(existsSync(fixture.treePath('manifest.overrides.json'))).toBe(true);
		expect(fixture.run(['status']).status).toBe(0);
	});

	it('leaves the materialized targets in the tree under --keep-overlay, and load --fresh takes them back', () => {
		removeArtifacts();
		const { run, envelope } = fixture.json(['package', '--keep-overlay']);

		expect(run.status).toBe(0);
		const report = data(envelope);
		expect(report.steps.map((step) => step.name)).not.toContain('restore');
		expect(report.restored).toEqual([]);
		expect(manifestInTree()).not.toBe(manifestAtPin());
		expect(manifestInTree()).toContain('Fixture PatchSet');

		// The tree is now in packaging state, which an ordinary load refuses and
		// `load --fresh` is the way out of (##OVERLAY-KNOWN-MATERIALIZATION).
		expect(fixture.run(['load']).status).toBe(1);
		expect(fixture.run(['load', '--fresh']).status).toBe(0);
		expect(manifestInTree()).toBe(manifestAtPin());
	});

	it('runs only the product half under --skip-type-build', () => {
		removeArtifacts();
		const { run, envelope } = fixture.json(['package', '--skip-type-build']);

		expect(run.status).toBe(0);
		const report = data(envelope);
		expect(report.steps.map((step) => step.name)).not.toContain('package build');
		expect(report.commands).toEqual(['npm run package-distributable']);
		expect(run.stderr).toContain('skip-type-build');
		expect(readFileSync(fixture.treePath('.build/package/app.bin'), 'utf8')).toBe('distributable\n');
		expect(manifestInTree()).toBe(manifestAtPin());
	});

	it('reports the failing half with CK-E-PACKAGE-FAILED and still puts the tree back', () => {
		removeArtifacts();
		const { run, envelope } = fixture.json(['package'], { STUB_PACKAGE_MODE: 'fail-build' });

		expect(run.status).toBe(1);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-PACKAGE-FAILED']);
		expect(envelope.errors[0]?.message).toContain('package: exited 3');
		// The tail of what the packager printed travels with the code.
		expect(envelope.errors[0]?.message).toContain('build: fixture packaging failed');
		expect(envelope.errors[0]?.hint).toContain('npm run package');

		const report = data(envelope);
		// The distributable half never started, and the restore still happened.
		expect(report.commands).toEqual(['npm run package']);
		expect(report.restored).toEqual(['manifest.json']);
		expect(manifestInTree()).toBe(manifestAtPin());
		expect(fixture.run(['status']).status).toBe(0);
	});

	it('refuses over a fork tree that carries unextracted work, before it materializes anything', () => {
		removeArtifacts();
		const target = fixture.treePath('source/base/common/util.ts');
		const before = readFileSync(target, 'utf8');
		writeFileSync(target, `${before}// an edit nobody extracted\n`, 'utf8');
		try {
			const { run, envelope } = fixture.json(['package']);

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
			expect(envelope.errors[0]?.hint).toContain('packaging never gives up work of the tree on its own');
			expect(data(envelope).materialized).toEqual([]);
			expect(manifestInTree()).toBe(manifestAtPin());
		} finally {
			writeFileSync(target, before, 'utf8');
		}
	});

	it('takes no --discard: giving up work is not a flag of this command', () => {
		const outcome = fixture.run(['package', '--discard']);

		expect(outcome.status).toBe(2);
		expect(outcome.stderr).toContain("flag --discard is not a flag of command 'package'");
	});
});
