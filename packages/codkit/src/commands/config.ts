/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Explicit configuration migration, with preview as the default.
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, patchesRoot } from '../lib/command.ts';
import { applyConfigMigration, readConfigMigration } from '../lib/configMigration.ts';
import { acquireLock } from '../lib/lock.ts';

const WRITE = '--write';
async function run(ctx: CommandContext): Promise<number> {
	const patchesDir = patchesRoot(ctx);
	const current = readConfigMigration(patchesDir);
	const write = commandFlagGiven(ctx.commandFlags, WRITE);
	if (write && current.plan.changed) {
		const lock = acquireLock(patchesDir, 'cycle-global', 'config migrate');
		try {
			applyConfigMigration(patchesDir, current.bytes, lock);
		} finally {
			lock.release();
		}
	}
	ctx.out.info(
		current.plan.changed
			? `config migration: ${current.plan.from} -> 4, ${write ? 'written' : 'preview; use --write to apply'}`
			: 'config migration: already schema 4'
	);
	ctx.out.setData({
		from: current.plan.from,
		to: 4,
		discipline: current.plan.config.discipline ?? null,
		changed: current.plan.changed,
		written: write && current.plan.changed
	});
	return EXIT_OK;
}

export const configCommand: CommandDefinition = {
	name: 'config',
	summary: 'configuration migration namespace',
	namespace: true,
	configMode: 'none',
	maxArgs: 0,
	run: async () => EXIT_ENVIRONMENT
};
export const configMigrateCommand: CommandDefinition = {
	name: 'config migrate',
	summary: 'preview or explicitly migrate config v2/v3 to v4',
	configMode: 'none',
	maxArgs: 0,
	commandFlags: [WRITE],
	run
};
