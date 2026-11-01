// The type of a patch set as the CLI shows it and refuses over it: FEAT-002
// S63 (schema 1 is refused, and the migrated patch set behaves as before), S64
// (`codkit types`) and the second half of S65 (a type the registry does not
// know). The refusals of a capability a type lacks are proved over the generic
// polygon, in `genericPolygon.test.ts` (PROP-016
// ##CMD-TYPES, ##TYPE-VERBS-UNIVERSAL, ##TYPE-UNKNOWN, ##TYPE-CAPABILITY-REFUSAL,
// modules/codkit/PROP-003 ##CFG-SCHEMA-1-IS-REFUSED).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCliFixture, runCli, STUB_TYPE_ENV } from '../support/cliFixture.ts';
import type { CliFixture, Envelope } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

/** A row of `codkit types` as the envelope carries it. */
type TypeRow = {
	id: string;
	package: string;
	installed: boolean;
	capabilities: string[];
	configurableCapabilities: string[];
};

/** `codkit types` without the seam of the fixtures: the shipped registry alone. */
function typesOfARealRun(fixture: CliFixture): { status: number; rows: readonly TypeRow[] } {
	const outcome = runCli(fixture.patchesDir, ['--patches-dir', fixture.patchesDir, '--json', 'types']);
	const envelope = JSON.parse(outcome.stdout) as Envelope;
	return { status: outcome.status, rows: envelope.data['types'] as readonly TypeRow[] };
}

afterAll(cleanupTempRoots);

/** Rewrite `codkit.json` of the fixture through one edit of its parsed body. */
function editConfig(fixture: CliFixture, edit: (config: Record<string, unknown>) => void): void {
	const path = join(fixture.patchesDir, 'codkit.json');
	const config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
	edit(config);
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

describe('codkit types', () => {
	it('lists the registered types, their package and their capabilities, without a patch set', () => {
		const fixture = makeCliFixture('types-list');
		const { status, rows } = typesOfARealRun(fixture);

		expect(status).toBe(0);
		expect(rows.map((row) => row.id)).toEqual(['vscode', 'generic', 'theia', 'vscode-extension']);
		expect(rows[0]?.package).toBe('@codkit/type-vscode');
		expect(rows[0]?.installed).toBe(true);
		expect(rows[0]?.capabilities).toContain('brand-images');
		expect(rows[1]?.package).toBe('@codkit/type-generic');
		expect(rows[1]?.capabilities).toEqual([]);
		expect(rows[1]?.configurableCapabilities).toEqual(['build-channels', 'config-overlay']);
		// The second real type: four capabilities for every patch set of the
		// family, and six absences that are answers of their own.
		expect(rows[2]?.package).toBe('@codkit/type-theia');
		expect(rows[2]?.capabilities).toEqual(['build-channels', 'config-overlay', 'service-override', 'upgrade-advisory']);
		expect(rows[2]?.configurableCapabilities).toEqual([]);
		// The fourth type: six capabilities for every patch set of the family, the
		// first `preview` among them, and five absences that are answers of their own.
		expect(rows[3]?.package).toBe('@codkit/type-vscode-extension');
		expect(rows[3]?.installed).toBe(true);
		expect(rows[3]?.capabilities).toEqual(['build-channels', 'config-overlay', 'entry-module', 'gen-brand', 'preview', 'upgrade-advisory']);
		expect(rows[3]?.configurableCapabilities).toEqual([]);
	});
});

describe('the test seam of the registry (PROP-016 ##TYPE-TEST-SEAM)', () => {
	it('adds the one type a test build names, and no production run ever sees it', () => {
		const fixture = makeCliFixture('types-seam');

		// The engine's own e2e run: the seam is on, and the stub is a row.
		const seen = fixture.json(['types']);
		expect(seen.run.status).toBe(0);
		expect((seen.envelope.data['types'] as readonly TypeRow[]).map((row) => row.id)).toEqual([
			'vscode',
			'generic',
			'theia',
			'vscode-extension',
			'stub'
		]);

		// The same installation without the build condition: four rows, and the
		// variable alone changes nothing, exactly as S33 proves for the standards
		// source.
		expect(typesOfARealRun(fixture).rows.map((row) => row.id)).toEqual(['vscode', 'generic', 'theia', 'vscode-extension']);
	});

	it('ignores the variable outside the test build, and the patch set is then of an unknown type', () => {
		const fixture = makeCliFixture('types-seam-leak');
		const leaked = runCli(fixture.patchesDir, ['--patches-dir', fixture.patchesDir, '--json', 'status'], {
			CODKIT_TEST_TYPE_PACKAGE: STUB_TYPE_ENV['CODKIT_TEST_TYPE_PACKAGE'] ?? ''
		});
		const envelope = JSON.parse(leaked.stdout) as Envelope;

		expect(leaked.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-TYPE-UNKNOWN');
		expect(envelope.errors[0]?.message).toContain('"stub"');
		expect(envelope.errors[0]?.hint).not.toContain('stub,');
	});

	it('ignores a value that is not an identifier and an absolute module path', () => {
		const fixture = makeCliFixture('types-seam-malformed');
		for (const value of ['stub', 'stub=relative/path.ts', '=/tmp/x.ts', 'a/b=/tmp/x.ts']) {
			const outcome = runCli(fixture.patchesDir, ['--patches-dir', fixture.patchesDir, '--json', 'types'], {
				CODKIT_E2E_TEST_BUILD: '1',
				CODKIT_TEST_TYPE_PACKAGE: value
			});
			const envelope = JSON.parse(outcome.stdout) as Envelope;
			expect(
				(envelope.data['types'] as readonly TypeRow[]).map((row) => row.id),
				value
			).toEqual(['vscode', 'generic', 'theia', 'vscode-extension']);
		}
	});
});

describe('the project type in the output of the roster', () => {
	it('where names the type and the envelope carries it', () => {
		const fixture = makeCliFixture('types-where');
		const { run, envelope } = fixture.json(['where']);

		expect(run.status).toBe(0);
		expect(envelope.codkit.type).toBe('stub');
		expect(envelope.data['type']).toBe('stub');
		expect(run.stderr).toContain('project type: stub');
	});
});

describe('what the configuration refuses', () => {
	it('refuses a type the registry does not know, naming the identifier and what it does carry', () => {
		const fixture = makeCliFixture('types-unknown');
		editConfig(fixture, (config) => {
			config['type'] = 'kettle';
		});
		const { run, envelope } = fixture.json(['status']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-TYPE-UNKNOWN');
		expect(envelope.errors[0]?.message).toContain('kettle');
		expect(envelope.errors[0]?.hint).toContain('vscode');
		expect(envelope.errors[0]?.hint).toContain('generic');
	});

	it('refuses a schema-1 configuration naming the two fields to add and nothing else', () => {
		const fixture = makeCliFixture('types-schema-one');
		editConfig(fixture, (config) => {
			config['codkitConfig'] = 1;
			delete config['type'];
			delete config['typeConfig'];
			config['ownDirName'] = 'patchset';
		});
		const { run, envelope } = fixture.json(['status']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(envelope.errors[0]?.message).toContain('schema 1');
		expect(envelope.errors[0]?.hint).toContain('"type"');
		expect(envelope.errors[0]?.hint).toContain('"ownRoot"');
	});

	it('refuses an own root outside the bounds the type states, naming the constraint', () => {
		const fixture = makeCliFixture('types-own-root');
		editConfig(fixture, (config) => {
			config['typeConfig'] = { ownRoot: 'packages/patchset' };
		});
		const { run, envelope } = fixture.json(['status']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-CONFIG');
		expect(envelope.errors[0]?.message).toContain('typeConfig.ownRoot');
		expect(envelope.errors[0]?.message).toContain('source/');
	});
});
