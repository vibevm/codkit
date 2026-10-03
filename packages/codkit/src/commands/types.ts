/** @scope spec://codkit/modules/codkit/PROP-016#CMD-TYPES */
// codkit types - the registered project types, their package and version, and
// the capability matrix (##CMD-TYPES).
//
// Read-only, and it needs no patch set: this is the command a person runs to
// find out which identifier `codkit.json` may declare and which verbs that
// identifier answers.

import { CAPABILITIES } from '@codkit/type-api';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_OK } from '../lib/command.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { registeredTypes } from '../types/registry.ts';

/** Width of the identifier column; the longest identifier plus two. */
const ID_COLUMN = 10;

async function run(ctx: CommandContext): Promise<number> {
	const rows = await registeredTypes();
	for (const row of rows) {
		const version = row.installed ? (row.version ?? 'installed') : 'not installed';
		ctx.out.info(`${row.id.padEnd(ID_COLUMN)}${row.package} ${version}`);
		ctx.out.info(
			`${''.padEnd(ID_COLUMN)}manifest: ${row.manifestVersion ?? 'unknown'}, contract: ${row.contractVersion ?? 'unknown'}, source: ${row.source}`
		);
		if (row.problem !== null) ctx.out.info(`${''.padEnd(ID_COLUMN)}problem: ${row.problem}`);
		ctx.out.info(`${''.padEnd(ID_COLUMN)}capabilities: ${row.capabilities.length === 0 ? 'none' : row.capabilities.join(', ')}`);
		if (row.configurableCapabilities.length > 0) {
			ctx.out.info(`${''.padEnd(ID_COLUMN)}from typeConfig: ${row.configurableCapabilities.join(', ')}`);
		}
	}
	ctx.out.info(`the capability names of the contract: ${CAPABILITIES.join(', ')}`);
	ctx.out.setData({
		types: rows.map((row): JsonValue => ({
			id: row.id,
			package: row.package,
			version: row.version,
			installed: row.installed,
			capabilities: [...row.capabilities],
			configurableCapabilities: [...row.configurableCapabilities],
			manifestVersion: row.manifestVersion,
			contractVersion: row.contractVersion,
			manifestSha256: row.manifestSha256,
			source: row.source,
			problem: row.problem
		}))
	});
	return EXIT_OK;
}

export const typesCommand: CommandDefinition = {
	name: 'types',
	summary: 'print the registered project types, their packages and their capabilities',
	configMode: 'none',
	roots: 'none',
	maxArgs: 0,
	run
};
