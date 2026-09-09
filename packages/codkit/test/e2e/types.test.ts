// The type of a patch set as the CLI shows it and refuses over it (PROP-016
// ##CMD-TYPES, ##TYPE-VERBS-UNIVERSAL, ##TYPE-UNKNOWN, ##TYPE-CAPABILITY-REFUSAL,
// modules/codkit/PROP-003 ##CFG-SCHEMA-1-IS-REFUSED).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

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
		const { run, envelope } = fixture.json(['types']);

		expect(run.status).toBe(0);
		const rows = envelope.data['types'] as readonly { id: string; package: string; installed: boolean; capabilities: string[] }[];
		expect(rows.map((row) => row.id)).toEqual(['vscode']);
		expect(rows[0]?.package).toBe('@codkit/type-vscode');
		expect(rows[0]?.installed).toBe(true);
		expect(rows[0]?.capabilities).toContain('brand-images');
	});
});

describe('the project type in the output of the roster', () => {
	it('where names the type and the envelope carries it', () => {
		const fixture = makeCliFixture('types-where');
		const { run, envelope } = fixture.json(['where']);

		expect(run.status).toBe(0);
		expect(envelope.codkit.type).toBe('vscode');
		expect(envelope.data['type']).toBe('vscode');
		expect(run.stderr).toContain('project type: vscode');
	});
});

describe('what the configuration refuses', () => {
	it('refuses a type the registry does not know, naming the identifier and what it does carry', () => {
		const fixture = makeCliFixture('types-unknown');
		editConfig(fixture, (config) => {
			config['type'] = 'theia';
		});
		const { run, envelope } = fixture.json(['status']);

		expect(run.status).toBe(2);
		expect(envelope.errors[0]?.code).toBe('CK-E-TYPE-UNKNOWN');
		expect(envelope.errors[0]?.message).toContain('theia');
		expect(envelope.errors[0]?.hint).toContain('vscode');
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
		expect(envelope.errors[0]?.message).toContain('src/vs/');
	});
});
