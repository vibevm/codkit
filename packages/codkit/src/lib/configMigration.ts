/** @scope spec://codkit/modules/codkit/PROP-003#SCHEMA-MIGRATION-RULE */
// Explicit, pure v2-to-v3 planning. Reading/writing a legacy config does not migrate it.
import { parseBaseConfig, serializeBaseConfig, CONFIG_FILE_NAME } from './configFile.ts';
import type { CodkitConfig } from './configFile.ts';
import { MINIMAL_DISCIPLINE } from './discipline.ts';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { parseConfigBytes } from './configFile.ts';
import { assertOwnedLockHandle, lockPath } from './lock.ts';
import type { LockHandle } from './lock.ts';
import { ckError } from './messages.ts';
import { readSyncTransaction } from './syncTransaction.ts';
import { readCycleState } from './cycleState.ts';
import { listRebasePendingRecords } from './rebaseOntoPinPending.ts';

export type ConfigMigrationPlan = {
	readonly from: number;
	readonly to: 3;
	readonly changed: boolean;
	readonly config: CodkitConfig;
	readonly contents: string;
};

export function planConfigMigration(raw: unknown): ConfigMigrationPlan {
	const previous = parseBaseConfig(raw, CONFIG_FILE_NAME);
	const config: CodkitConfig = { ...previous, codkitConfig: 3, discipline: MINIMAL_DISCIPLINE };
	return { from: previous.codkitConfig, to: 3, changed: previous.codkitConfig !== 3, config, contents: serializeBaseConfig(config) };
}

export function readConfigMigration(patchesDir: string): { readonly bytes: Uint8Array; readonly plan: ConfigMigrationPlan } {
	const read = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
	if (read.state === 'absent') throw ckError('CONFIG', 'codkit.json does not exist', 'select a configured patchset before migration');
	return { bytes: read.bytes, plan: planConfigMigration(parseConfigBytes(read.bytes)) };
}

/** The same cycle-global capability and compare-before-replace rule as pin writes. */
export function applyConfigMigration(
	patchesDir: string,
	expected: Uint8Array,
	lock: LockHandle,
	beforeReplace?: () => void
): ConfigMigrationPlan {
	assertOwnedLockHandle(lock, lockPath(patchesDir, 'cycle-global'));
	if (readSyncTransaction(patchesDir) !== null || readCycleState(patchesDir) !== null || listRebasePendingRecords(patchesDir).length > 0)
		throw ckError(
			'CONFIG',
			'config migration refuses an active sync, cycle or rebase record',
			'complete or recover the active operation first'
		);
	const current = readConfigMigration(patchesDir);
	if (!bytesEqual(current.bytes, expected))
		throw ckError('LOCKED', 'codkit.json changed after migration planning', 're-read the configuration; newer bytes were preserved');
	if (!current.plan.changed) return current.plan;
	beforeReplace?.();
	const confirmed = readConfigMigration(patchesDir);
	assertOwnedLockHandle(lock, lockPath(patchesDir, 'cycle-global'));
	if (!bytesEqual(current.bytes, confirmed.bytes))
		throw ckError('LOCKED', 'codkit.json changed before migration replacement', 're-read the configuration; newer bytes were preserved');
	writeContainedFileAtomic(patchesDir, CONFIG_FILE_NAME, { bytes: encodeUtf8(current.plan.contents), what: CONFIG_FILE_NAME });
	return current.plan;
}
