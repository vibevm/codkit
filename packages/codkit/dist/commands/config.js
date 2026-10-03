import { EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, patchesRoot } from '../lib/command.js';
import { applyConfigMigration, readConfigMigration } from '../lib/configMigration.js';
import { acquireLock } from '../lib/lock.js';
const WRITE = '--write';
async function run(ctx) {
    const patchesDir = patchesRoot(ctx);
    const current = readConfigMigration(patchesDir);
    const write = commandFlagGiven(ctx.commandFlags, WRITE);
    if (write && current.plan.changed) {
        const lock = acquireLock(patchesDir, 'cycle-global', 'config migrate');
        try {
            applyConfigMigration(patchesDir, current.bytes, lock);
        }
        finally {
            lock.release();
        }
    }
    ctx.out.info(current.plan.changed
        ? `config migration: ${current.plan.from} -> 3, ${write ? 'written' : 'preview; use --write to apply'}`
        : 'config migration: already schema 3');
    ctx.out.setData({
        from: current.plan.from,
        to: 3,
        discipline: current.plan.config.discipline ?? null,
        changed: current.plan.changed,
        written: write && current.plan.changed
    });
    return EXIT_OK;
}
export const configCommand = {
    name: 'config',
    summary: 'configuration migration namespace',
    namespace: true,
    configMode: 'none',
    maxArgs: 0,
    run: async () => EXIT_ENVIRONMENT
};
export const configMigrateCommand = {
    name: 'config migrate',
    summary: 'preview or explicitly migrate config v2 to v3',
    configMode: 'none',
    maxArgs: 0,
    commandFlags: [WRITE],
    run
};
