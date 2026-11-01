// FEAT-002 ##S93 through the real launcher: `codkit license annotate --own`
// gives the own files of the fixture patch set their carriers from the fixture
// profile (PROP-019 ##ANNOTATE-OWN, PROP-007 ##CMD-LICENSE-ANNOTATE) - the
// actions, the exit codes, the retired posture against a third party's notice,
// the refusals of the package form's flags, and the two environments the
// command cannot run in: no declaration, no trusted profile.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CliFixture, Envelope } from '../support/cliFixture.ts';
import { makeCliFixture, runCli, withStubType } from '../support/cliFixture.ts';
import {
	FIXTURE_RETIRED_NOTICE,
	FIXTURE_YEAR,
	FOREIGN_HOLDER,
	fixtureBlockHeaderLines,
	installLicensingProfile
} from '../support/licensingFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const SAMPLE = 'delta/own/sample';
const A_TS = `${SAMPLE}/a.ts`;
const DATA_JSON = `${SAMPLE}/data.json`;
const OLD_TS = `${SAMPLE}/old.ts`;
const THEIRS_TS = `${SAMPLE}/theirs.ts`;

/** The product's pre-campaign block: a holder the parser reads as foreign, and the retired posture. */
const RETIRED_BLOCK = [
	`/*${'-'.repeat(93)}`,
	` *  Copyright (c) 2025 ${FOREIGN_HOLDER}. All rights reserved.`,
	` *  Licensed under the ${FIXTURE_RETIRED_NOTICE} terms of the previous edition.`,
	' *  SPDX-License-Identifier: LicenseRef-Previous',
	` *${'-'.repeat(92)}*/`,
	'',
	'export const old = 1;',
	''
].join('\n');

/** Somebody else's notice without a retired phrase. */
const THEIRS = [`// Copyright (c) 2024 ${FOREIGN_HOLDER}`, '// SPDX-License-Identifier: MIT', '', 'export const theirs = 1;', ''].join(
	'\n'
);

type OwnData = { scope: string; dir: string; files: { path: string; action: string }[] };

function write(fixture: CliFixture, relative: string, content: string): void {
	const absolute = fixture.patchesPath(relative);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content, 'utf8');
}

function read(fixture: CliFixture, relative: string): string {
	return readFileSync(fixture.patchesPath(relative), 'utf8');
}

function dataOf(envelope: Envelope): OwnData {
	return envelope.data as OwnData;
}

function actionsOf(envelope: Envelope): Record<string, string> {
	return Object.fromEntries(dataOf(envelope).files.map((file) => [file.path, file.action]));
}

/** A fixture with the profile installed and the three files of S93 in its own layer. */
function s93Fixture(label: string): { fixture: CliFixture; env: Readonly<Record<string, string>> } {
	const fixture = makeCliFixture(label);
	const lic = installLicensingProfile(label, fixture.patchesDir);
	write(fixture, A_TS, 'export const a = 1;\n');
	write(fixture, DATA_JSON, '{"a":1}\n');
	write(fixture, OLD_TS, RETIRED_BLOCK);
	return { fixture, env: lic.env };
}

describe('codkit license annotate --own (S93)', () => {
	it('heads the sources, sidecars the data, reports the retired file, replaces it on request, then changes nothing', () => {
		const { fixture, env } = s93Fixture('annotate-own');

		const first = fixture.json(['license', 'annotate', '--own'], env);
		expect(first.run.status, first.run.stderr).toBe(1);
		const data = dataOf(first.envelope);
		expect(data.scope).toBe('own');
		expect(data.dir).toBe(first.envelope.roots.patches?.path);
		expect(first.envelope.codkit.type).toBe('stub');
		expect(actionsOf(first.envelope)).toMatchObject({ [A_TS]: 'header', [DATA_JSON]: 'sidecar', [OLD_TS]: 'foreign-holder' });
		expect(first.envelope.errors.map((error) => error.code)).toEqual(['CK-E-LICENSE-HEADER']);
		expect(first.envelope.errors[0]?.file).toBe(OLD_TS);
		const paths = data.files.map((file) => file.path);
		expect(paths).toEqual([...paths].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))));
		expect(paths.some((path) => path.startsWith('delta/own/codkit/') || path.startsWith('delta/resources/'))).toBe(false);
		expect(paths).not.toContain('delta/own/patchset.delta.json');
		expect(read(fixture, A_TS)).toBe([...fixtureBlockHeaderLines(), '', 'export const a = 1;', ''].join('\n'));
		expect(read(fixture, `${DATA_JSON}.license`)).toBe(
			`Copyright (c) ${FIXTURE_YEAR} Fixture Org\nSPDX-License-Identifier: LicenseRef-FIXTURE-Private-1.0\n`
		);
		expect(read(fixture, OLD_TS)).toBe(RETIRED_BLOCK);

		const second = fixture.json(['license', 'annotate', '--own', '--replace-retired'], env);
		expect(second.run.status, second.run.stderr).toBe(0);
		expect(actionsOf(second.envelope)).toMatchObject({ [A_TS]: 'unchanged', [DATA_JSON]: 'unchanged', [OLD_TS]: 'replaced' });
		expect(second.envelope.errors).toEqual([]);
		expect(read(fixture, OLD_TS)).toBe([...fixtureBlockHeaderLines(), '', 'export const old = 1;', ''].join('\n'));

		const third = fixture.json(['license', 'annotate', '--own', '--replace-retired'], env);
		expect(third.run.status, third.run.stderr).toBe(0);
		expect(dataOf(third.envelope).files.every((file) => file.action === 'unchanged')).toBe(true);
		expect(dataOf(third.envelope).files.map((file) => file.path)).toEqual(paths);
	});

	it("leaves a third party's notice alone under --replace-retired until a registry declares it", () => {
		const fixture = makeCliFixture('annotate-own-theirs');
		const lic = installLicensingProfile('annotate-own-theirs', fixture.patchesDir);
		write(fixture, THEIRS_TS, THEIRS);

		const flagged = fixture.json(['license', 'annotate', '--own', '--replace-retired'], lic.env);
		expect(flagged.run.status, flagged.run.stderr).toBe(1);
		expect(actionsOf(flagged.envelope)[THEIRS_TS]).toBe('foreign-holder');
		expect(read(fixture, THEIRS_TS)).toBe(THEIRS);

		write(
			fixture,
			`${SAMPLE}/REUSE.toml`,
			[
				'version = 1',
				'',
				'[[annotations]]',
				'path = "theirs.ts"',
				`SPDX-FileCopyrightText = "2024 ${FOREIGN_HOLDER}"`,
				'SPDX-License-Identifier = "MIT"',
				'SPDX-FileComment = "third-party; a fixture pack the product derives from"',
				''
			].join('\n')
		);
		const declared = fixture.json(['license', 'annotate', '--own', '--replace-retired'], lic.env);
		expect(declared.run.status, declared.run.stderr).toBe(0);
		expect(actionsOf(declared.envelope)[THEIRS_TS]).toBe('unchanged');
		expect(read(fixture, THEIRS_TS)).toBe(THEIRS);
	});

	it('prints one line per file and writes nothing under --dry-run', () => {
		const { fixture, env } = s93Fixture('annotate-own-dry');

		const run = fixture.run(['license', 'annotate', '--own', '--dry-run', SAMPLE], env);

		expect(run.status, run.stderr).toBe(1);
		expect(run.stdout).toContain(`  ${'header'.padEnd(14)}  ${A_TS}`);
		expect(run.stdout).toContain(`  ${'sidecar'.padEnd(14)}  ${DATA_JSON}`);
		expect(run.stdout).toContain(`  ${'foreign-holder'.padEnd(14)}  ${OLD_TS}`);
		expect(run.stderr).toContain(`error CK-E-LICENSE-HEADER: ${OLD_TS}:`);
		expect(read(fixture, A_TS)).toBe('export const a = 1;\n');
		expect(read(fixture, 'delta/own/hello.ts')).not.toContain('SPDX-License-Identifier');
	});

	it("refuses the package form's flags, a year that is not the profile's, and a run without a patch set", () => {
		const { fixture, env } = s93Fixture('annotate-own-flags');

		for (const args of [
			['--dir', 'x'],
			['--third-party'],
			['--holder', 'x'],
			['--license', 'MIT'],
			['--source', 'x'],
			['--year', '2027']
		]) {
			const refused = fixture.json(['license', 'annotate', '--own', ...args], env);
			expect(refused.run.status, args.join(' ')).toBe(2);
			expect(
				refused.envelope.errors.map((error) => error.code),
				args.join(' ')
			).toEqual(['CK-E-CONFIG']);
		}
		expect(read(fixture, A_TS)).toBe('export const a = 1;\n');

		// The profile's own year agrees with the profile.
		const agreed = fixture.json(['license', 'annotate', '--own', '--year', FIXTURE_YEAR, A_TS], env);
		expect(agreed.run.status, agreed.run.stderr).toBe(0);
		expect(actionsOf(agreed.envelope)).toEqual({ [A_TS]: 'header' });

		// No root at all: the resolver names none, and `--own` has nothing to walk.
		const cwd = makeTempRoot('annotate-own-nowhere');
		const rootless = runCli(cwd, ['--json', 'license', 'annotate', '--own'], withStubType(env));
		expect(rootless.status).toBe(2);
		expect((JSON.parse(rootless.stdout) as Envelope).errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
	});

	it('exits 2 without a declaration and when the machine does not carry the profile', () => {
		const undeclared = makeCliFixture('annotate-own-undeclared');
		write(undeclared, A_TS, 'export const a = 1;\n');
		const noDeclaration = undeclared.json(['license', 'annotate', '--own']);
		expect(noDeclaration.run.status).toBe(2);
		expect(noDeclaration.envelope.errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
		expect(noDeclaration.envelope.errors[0]?.message).toContain('codkit.licensing.json');
		expect(read(undeclared, A_TS)).toBe('export const a = 1;\n');

		const { fixture, env } = s93Fixture('annotate-own-no-store');
		const lic = installLicensingProfile('annotate-own-no-store-again', fixture.patchesDir);
		lic.removeStore();
		const noProfile = fixture.json(['license', 'annotate', '--own'], lic.env);
		expect(noProfile.run.status).toBe(2);
		expect(noProfile.envelope.errors.map((error) => error.code)).toEqual(['CK-E-LICENSE-PROFILE']);
		expect(read(fixture, A_TS)).toBe('export const a = 1;\n');
		void env;
	});
});
