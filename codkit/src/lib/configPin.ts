/** @scope spec://codkit/modules/codkit/PROP-002#CONFIG-PIN-CAPABILITY */
// The one writer of `codkit.json`: the canonical pin update.
//
// It is a separate cell from the config schema because it carries a different
// kind of rule - not "what is a valid document" but "who is allowed to replace
// one, and against which bytes". The mutation requires the live cycle-global
// lock capability of this patch set, re-reads before replacing so a newer
// external edit survives, and writes through the contained atomic writer.

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { assertOwnedLockHandle, lockPath } from './lock.ts';
import type { LockHandle } from './lock.ts';
import { ckError, isCkError } from './messages.ts';
import { resolveContainedPath, safeBasenameProblem } from './pathSafety.ts';
import { CONFIG_FILE_NAME, messageOf, parseBaseConfig, parseConfigBytes, serializeBaseConfig } from './configFile.ts';
import type { PinConfig } from './configFile.ts';

export type ConfigFileSystem = {
	readonly readBytes: (path: string) => Uint8Array | null;
	readonly makeDirectory: (path: string) => void;
	readonly writeBytes: (path: string, bytes: Uint8Array) => void;
	readonly rename: (from: string, to: string) => void;
	readonly remove: (path: string) => void;
};
export const nodeConfigFileSystem: ConfigFileSystem = {
	readBytes(path) {
		try {
			return readFileSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw error;
		}
	},
	makeDirectory(path) {
		mkdirSync(path, { recursive: true });
	},
	writeBytes(path, bytes) {
		writeFileSync(path, bytes, { flag: 'wx' });
	},
	rename(from, to) {
		renameSync(from, to);
	},
	remove(path) {
		try {
			unlinkSync(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				throw error;
			}
		}
	}
};
export type WriteConfigPinOptions = {
	readonly lock: LockHandle;
	readonly fileSystem?: ConfigFileSystem;
	readonly temporarySuffix?: () => string;
	readonly afterOpen?: () => void;
	readonly beforeReplace?: () => void;
};
export function writeConfigPin(patchesDir: string, pin: PinConfig, options: WriteConfigPinOptions): boolean {
	assertOwnedLockHandle(options.lock, 'config pin update');
	if (options.lock.path !== lockPath(patchesDir, 'cycle-global')) {
		throw ckError('LOCKED', 'config pin update requires the live cycle-global lock for this patch set');
	}
	if (options.fileSystem === undefined) {
		return writeConfigPinContained(patchesDir, pin, options);
	}
	const fileSystem = options.fileSystem;
	let path = containedConfigPath(patchesDir);
	let existing: Uint8Array | null;
	try {
		existing = fileSystem.readBytes(path);
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot read ${CONFIG_FILE_NAME} before updating its pin: ${messageOf(error)}`,
			'make the file readable',
			CONFIG_FILE_NAME
		);
	}
	if (existing === null) {
		throw ckError(
			'CONFIG',
			`${CONFIG_FILE_NAME} does not exist`,
			'start a cycle only from a configured patchset checkout',
			CONFIG_FILE_NAME
		);
	}
	const base = parseBaseConfig(parseConfigBytes(existing), CONFIG_FILE_NAME);
	const next = encodeUtf8(serializeBaseConfig({ ...base, pin }));
	if (bytesEqual(existing, next)) {
		return false;
	}
	options.beforeReplace?.();
	// The same compare-before-replace rule as the contained path: an edit that
	// landed after the read above is newer than this update and must survive it.
	// Without this the injectable seam had weaker semantics than the branch it
	// stands in for, and a test seam that is safer than production is worthless.
	const reread = fileSystem.readBytes(containedConfigPath(patchesDir));
	if (reread === null || !bytesEqual(existing, reread)) {
		throw ckError(
			'LOCKED',
			`${CONFIG_FILE_NAME} changed after compare and before replace`,
			're-read the configuration and retry; the newer content was preserved',
			CONFIG_FILE_NAME
		);
	}
	try {
		fileSystem.makeDirectory(dirname(path));
		path = containedConfigPath(patchesDir);
	} catch (error) {
		throw ckError('CONFIG', `cannot prepare ${CONFIG_FILE_NAME}: ${messageOf(error)}`, 'make the patchset root writable', CONFIG_FILE_NAME);
	}
	const suffix = (options.temporarySuffix ?? randomUUID)();
	if (safeBasenameProblem(suffix) !== null) {
		throw ckError('INTERNAL', 'config temporary suffix must be one portable non-empty basename');
	}
	const temporary = `${path}.${suffix}.tmp`;
	let renamed = false;
	try {
		fileSystem.writeBytes(temporary, next);
		fileSystem.rename(temporary, path);
		renamed = true;
		return true;
	} catch (error) {
		throw ckError(
			'CONFIG',
			`cannot atomically update ${CONFIG_FILE_NAME}: ${messageOf(error)}`,
			'make the patchset root writable and retry',
			CONFIG_FILE_NAME
		);
	} finally {
		if (!renamed) {
			try {
				fileSystem.remove(temporary);
			} catch {
				// Preserve the primary error; complete unique temp files are ignored.
			}
		}
	}
}
function writeConfigPinContained(patchesDir: string, pin: PinConfig, options: WriteConfigPinOptions): boolean {
	const read = readContainedFile(patchesDir, CONFIG_FILE_NAME, {
		what: CONFIG_FILE_NAME,
		...(options.afterOpen === undefined ? {} : { afterOpen: options.afterOpen })
	});
	if (read.state === 'absent') {
		throw ckError(
			'CONFIG',
			`${CONFIG_FILE_NAME} does not exist`,
			'start a cycle only from a configured patchset checkout',
			CONFIG_FILE_NAME
		);
	}
	const existing = read.bytes;
	const base = parseBaseConfig(parseConfigBytes(existing), CONFIG_FILE_NAME);
	const next = encodeUtf8(serializeBaseConfig({ ...base, pin }));
	if (bytesEqual(existing, next)) return false;
	const current = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
	if (current.state !== 'ok' || !bytesEqual(current.bytes, existing)) {
		throw ckError('CONFIG', `${CONFIG_FILE_NAME} changed while its pin update was prepared`, 'retry the cycle start', CONFIG_FILE_NAME);
	}
	options.beforeReplace?.();
	const confirmed = readContainedFile(patchesDir, CONFIG_FILE_NAME, { what: CONFIG_FILE_NAME });
	if (confirmed.state !== 'ok' || !bytesEqual(confirmed.bytes, existing)) {
		throw ckError('LOCKED', `${CONFIG_FILE_NAME} changed after compare and before replace`, 'retry the cycle start', CONFIG_FILE_NAME);
	}
	try {
		writeContainedFileAtomic(patchesDir, CONFIG_FILE_NAME, { bytes: next, what: CONFIG_FILE_NAME });
		return true;
	} catch (error) {
		// A containment refusal keeps its own words and its own hint: a swapped
		// or symlinked parent is not a permissions problem, and rewrapping it
		// as one points the operator at the wrong repair.
		if (isCkError(error)) throw error;
		throw ckError(
			'CONFIG',
			`cannot atomically update ${CONFIG_FILE_NAME}: ${messageOf(error)}`,
			'make the patchset root writable and retry',
			CONFIG_FILE_NAME
		);
	}
}
function containedConfigPath(patchesDir: string): string {
	const resolved = resolveContainedPath(patchesDir, CONFIG_FILE_NAME, { allowMissing: true });
	if (!resolved.ok) {
		throw ckError(
			'CONFIG',
			`unsafe ${CONFIG_FILE_NAME} path: ${resolved.reason}`,
			'replace symlinks with a real file inside patchset',
			CONFIG_FILE_NAME
		);
	}
	return resolved.absolute;
}
