// codkit.json / codkit.local.json: schema, diagnostics and merge rules
// (PROP-003 sec. 1-2). The pin.sha text is fixed by ##CONFIG-INVALID-SAMPLE and
// is asserted verbatim.

import { existsSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CONFIG_FILE_NAME,
	LOCAL_CONFIG_FILE_NAME,
	loadConfig,
	mergeLocal,
	parseBaseConfig,
	parseLocalConfig,
	serializeBaseConfig
} from '../../src/lib/configFile.ts';
import type { PinConfig } from '../../src/lib/configFile.ts';
import { nodeConfigFileSystem, writeConfigPin } from '../../src/lib/configPin.ts';
import type { WriteConfigPinOptions } from '../../src/lib/configPin.ts';
import { acquireLock } from '../../src/lib/lock.ts';
import type { LockHandle } from '../../src/lib/lock.ts';
import { CkError, isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

/** The valid sample from PROP-003 sec. 2. */
const VALID_SAMPLE = {
	codkitConfig: 1,
	pin: { tag: '1.135.0', sha: '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5', date: '2026-08-25' },
	upstreamAnchorCommit: '0000000000000000000000000000000000000000',
	ownDirName: 'patchset',
	generatedBranchPrefix: 'codkit/applied/',
	cycleBranchPrefix: 'codkit/cycle/',
	releaseRefPrefix: 'codkit/release/',
	publishRemoteUrl: null
};

function writePin(root: string, pin: PinConfig, options: Omit<WriteConfigPinOptions, 'lock'> = {}): boolean {
	const lock = acquireLock(root, 'cycle-global', 'config test');
	try {
		return writeConfigPin(root, pin, { ...options, lock });
	} finally {
		lock.release();
	}
}

function catchCkError(run: () => unknown): CkError {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return error;
		}
		throw error;
	}
	throw new Error('expected a CkError, but nothing was thrown');
}

function writeJson(dir: string, name: string, body: unknown): void {
	writeFileSync(join(dir, name), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

afterEach(() => {
	cleanupTempRoots();
});

describe('parseBaseConfig', () => {
	it('accepts the valid sample from the spec', () => {
		const config = parseBaseConfig(VALID_SAMPLE, CONFIG_FILE_NAME);
		expect(config.pin.sha).toBe('08d4889f9ec4a1685d257b9b95de036c8e1ce1e5');
		expect(config.ownDirName).toBe('patchset');
		expect(config.buildWatchFile).toBeNull();
		expect(config.conventionsExtensionFile).toBeNull();
	});

	it('accepts only contained repository paths for explicit fork-specific data', () => {
		const config = parseBaseConfig(
			{ ...VALID_SAMPLE, buildWatchFile: 'config/watch.json', conventionsExtensionFile: 'config/conventions-extension.json' },
			CONFIG_FILE_NAME
		);
		expect(config.buildWatchFile).toBe('config/watch.json');
		expect(config.conventionsExtensionFile).toBe('config/conventions-extension.json');
		for (const buildWatchFile of ['../watch.json', '/tmp/watch.json', 'config\\watch.json']) {
			expect(() => parseBaseConfig({ ...VALID_SAMPLE, buildWatchFile }, CONFIG_FILE_NAME)).toThrow(CkError);
		}
	});

	it('reports a missing pin.sha with the text the spec fixes', () => {
		const broken = { ...VALID_SAMPLE, pin: { tag: '1.135.0' } };
		const error = catchCkError(() => parseBaseConfig(broken, CONFIG_FILE_NAME));

		expect(error.code).toBe('CONFIG');
		expect(error.file).toBe(CONFIG_FILE_NAME);
		expect(error.message).toContain('pin.sha is required (full 40-hex commit sha of the pin tag)');
		expect(error.hint).toBeTypeOf('string');
	});

	it('distinguishes a malformed pin.sha from a missing one', () => {
		const broken = { ...VALID_SAMPLE, pin: { ...VALID_SAMPLE.pin, sha: 'DEADBEEF' } };
		const error = catchCkError(() => parseBaseConfig(broken, CONFIG_FILE_NAME));

		expect(error.message).toContain('pin.sha must be a full 40-hex commit sha');
		expect(error.message).not.toContain('is required');
	});

	it('rejects a malformed pin.date', () => {
		const broken = { ...VALID_SAMPLE, pin: { ...VALID_SAMPLE.pin, date: '25.08.2026' } };
		expect(catchCkError(() => parseBaseConfig(broken, CONFIG_FILE_NAME)).message).toContain('YYYY-MM-DD');
	});

	it('rejects a pin tag that cannot be a portable cycle basename', () => {
		const broken = { ...VALID_SAMPLE, pin: { ...VALID_SAMPLE.pin, tag: 'CON' } };
		expect(catchCkError(() => parseBaseConfig(broken, CONFIG_FILE_NAME)).message).toContain('pin.tag');
	});

	it('refuses a schema version newer than the tool', () => {
		const newer = { ...VALID_SAMPLE, codkitConfig: 2 };
		const error = catchCkError(() => parseBaseConfig(newer, CONFIG_FILE_NAME));

		expect(error.code).toBe('CONFIG');
		expect(error.message).toContain('newer than this tool');
		expect(error.message).toContain('update codkit');
	});

	it('names an unknown field instead of silently dropping it', () => {
		const typo = { ...VALID_SAMPLE, forkdir: '/somewhere' };
		expect(catchCkError(() => parseBaseConfig(typo, CONFIG_FILE_NAME)).message).toContain('forkdir');
	});

	it.each(['../outside', 'nested/patchset', 'nested\\patchset', '.', '/absolute', 'CON', 'trailing.'])(
		'refuses unsafe ownDirName %j',
		(ownDirName) => {
			const error = catchCkError(() => parseBaseConfig({ ...VALID_SAMPLE, ownDirName }, CONFIG_FILE_NAME));

			expect(error.code).toBe('CONFIG');
			expect(error.message).toContain('ownDirName');
		}
	);
});

describe('parseLocalConfig', () => {
	it('rejects directory settings: they belong in the user settings file', () => {
		const error = catchCkError(() => parseLocalConfig({ forkDir: '/personal/tree' }, LOCAL_CONFIG_FILE_NAME));
		expect(error.code).toBe('CONFIG');
		expect(error.message).toContain('unknown field');
	});

	it('refuses to let the pin be overridden locally', () => {
		const error = catchCkError(() =>
			parseLocalConfig({ pin: { tag: 'x', sha: 'a'.repeat(40), date: '2026-01-01' } }, LOCAL_CONFIG_FILE_NAME)
		);

		expect(error.code).toBe('CONFIG');
		expect(error.message).toContain('pin cannot be overridden locally');
		expect(error.file).toBe(LOCAL_CONFIG_FILE_NAME);
	});

	it('refuses a local upstreamAnchorCommit and a local codkitConfig', () => {
		expect(catchCkError(() => parseLocalConfig({ upstreamAnchorCommit: 'a'.repeat(40) }, LOCAL_CONFIG_FILE_NAME)).message).toContain(
			'upstreamAnchorCommit cannot be overridden locally'
		);
		expect(catchCkError(() => parseLocalConfig({ codkitConfig: 1 }, LOCAL_CONFIG_FILE_NAME)).message).toContain(
			'codkitConfig cannot be overridden locally'
		);
	});

	it('refuses local overrides of shared fork-specific data declarations', () => {
		expect(catchCkError(() => parseLocalConfig({ buildWatchFile: 'other.json' }, LOCAL_CONFIG_FILE_NAME)).message).toContain(
			'buildWatchFile cannot be overridden locally'
		);
		expect(catchCkError(() => parseLocalConfig({ conventionsExtensionFile: 'other.json' }, LOCAL_CONFIG_FILE_NAME)).message).toContain(
			'conventionsExtensionFile cannot be overridden locally'
		);
	});

	it('refuses an unsafe local ownDirName override', () => {
		const error = catchCkError(() => parseLocalConfig({ ownDirName: '../../tree' }, LOCAL_CONFIG_FILE_NAME));

		expect(error.code).toBe('CONFIG');
		expect(error.message).toContain('ownDirName');
	});
});

describe('mergeLocal', () => {
	const base = parseBaseConfig(VALID_SAMPLE, CONFIG_FILE_NAME);

	it('lets a non-empty local field win', () => {
		expect(mergeLocal(base, { ownDirName: 'custom' }).ownDirName).toBe('custom');
	});

	it('keeps the base value for absent, null and empty local fields', () => {
		expect(mergeLocal(base, {}).publishRemoteUrl).toBeNull();
		expect(mergeLocal(base, { publishRemoteUrl: null }).publishRemoteUrl).toBeNull();
		expect(mergeLocal(base, { publishRemoteUrl: '' }).publishRemoteUrl).toBeNull();
	});

	it('never lets the merge touch the pin', () => {
		const merged = mergeLocal(base, { ownDirName: 'custom' });
		expect(merged.pin).toEqual(base.pin);
		expect(merged.upstreamAnchorCommit).toBe(base.upstreamAnchorCommit);
		expect(merged.codkitConfig).toBe(1);
	});
});

describe('loadConfig', () => {
	it('returns null when codkit.json is absent', () => {
		expect(loadConfig(makeTempRoot('patchset'))).toBeNull();
	});

	it('reads codkit.json alone', () => {
		const root = makeTempRoot('patchset');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		expect(loadConfig(root)?.pin.tag).toBe('1.135.0');
	});

	it('applies codkit.local.json on top', () => {
		const root = makeTempRoot('patchset');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		writeJson(root, LOCAL_CONFIG_FILE_NAME, { ownDirName: 'custom' });
		expect(loadConfig(root)?.ownDirName).toBe('custom');
	});

	it('fails when codkit.local.json carries a pin', () => {
		const root = makeTempRoot('patchset');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		writeJson(root, LOCAL_CONFIG_FILE_NAME, { pin: { tag: 'other' } });

		const error = catchCkError(() => loadConfig(root));
		expect(error.code).toBe('CONFIG');
		expect(error.file).toBe(LOCAL_CONFIG_FILE_NAME);
	});

	it('reports invalid JSON as a config error, not as a crash', () => {
		const root = makeTempRoot('patchset');
		writeFileSync(join(root, CONFIG_FILE_NAME), '{ "codkitConfig": 1,\n', 'utf8');

		const error = catchCkError(() => loadConfig(root));
		expect(error.code).toBe('CONFIG');
		expect(error.message).toContain('not valid JSON');
	});

	it('rejects an exact UTF-8 BOM and invalid UTF-8 through the contained reader', () => {
		const bomRoot = makeTempRoot('config-read-bom');
		writeFileSync(join(bomRoot, CONFIG_FILE_NAME), new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
		expect(() => loadConfig(bomRoot)).toThrow(/without BOM/);

		const invalidRoot = makeTempRoot('config-read-invalid-utf8');
		writeFileSync(join(invalidRoot, CONFIG_FILE_NAME), new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]));
		expect(() => loadConfig(invalidRoot)).toThrow(/valid UTF-8/);
	});

	it('refuses symlinked base and local config reads', () => {
		const outside = makeTempRoot('config-read-outside');
		writeJson(outside, CONFIG_FILE_NAME, VALID_SAMPLE);

		const baseRoot = makeTempRoot('config-read-base-symlink');
		symlinkSync(join(outside, CONFIG_FILE_NAME), join(baseRoot, CONFIG_FILE_NAME));
		expect(() => loadConfig(baseRoot)).toThrow(/regular non-symlink/);

		const localRoot = makeTempRoot('config-read-local-symlink');
		writeJson(localRoot, CONFIG_FILE_NAME, VALID_SAMPLE);
		writeJson(outside, LOCAL_CONFIG_FILE_NAME, { ownDirName: 'outside' });
		symlinkSync(join(outside, LOCAL_CONFIG_FILE_NAME), join(localRoot, LOCAL_CONFIG_FILE_NAME));
		expect(() => loadConfig(localRoot)).toThrow(/regular non-symlink/);
	});
});

describe('canonical pin updates', () => {
	it('requires a live cycle lock bound to this patch set', () => {
		const root = makeTempRoot('config-lock-capability');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		const pin = { tag: '1.136.0', sha: 'e'.repeat(40), date: '2026-09-01' };
		const forged = {
			path: 'forged',
			info: { pid: process.pid, startedAt: new Date().toISOString(), command: 'forged' },
			release() {}
		} as LockHandle;
		expect(() => writeConfigPin(root, pin, { lock: forged })).toThrow(/live lock handle/);

		const released = acquireLock(root, 'cycle-global', 'released config lock');
		released.release();
		expect(() => writeConfigPin(root, pin, { lock: released })).toThrow(/live lock handle/);

		const otherRoot = makeTempRoot('config-lock-foreign');
		const foreign = acquireLock(otherRoot, 'cycle-global', 'foreign config lock');
		try {
			expect(() => writeConfigPin(root, pin, { lock: foreign })).toThrow(/requires the live cycle-global lock/);
		} finally {
			foreign.release();
		}
	});

	it('preserves a newer external edit injected after compare and before replace', () => {
		const root = makeTempRoot('config-before-replace');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		const newer = { ...VALID_SAMPLE, ownDirName: 'newer-external-edit' };
		const lock = acquireLock(root, 'cycle-global', 'config compare barrier');
		try {
			expect(() =>
				writeConfigPin(
					root,
					{ tag: '1.136.0', sha: 'f'.repeat(40), date: '2026-09-01' },
					{
						lock,
						beforeReplace: () => writeJson(root, CONFIG_FILE_NAME, newer)
					}
				)
			).toThrow(/changed after compare/);
			expect(JSON.parse(readFileSync(join(root, CONFIG_FILE_NAME), 'utf8'))).toEqual(newer);
		} finally {
			lock.release();
		}
	});

	it('refuses a patch-set root swapped to an outside symlink after config open', () => {
		const root = makeTempRoot('config-write-parent-swap');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		const held = `${root}-held`;
		const outside = makeTempRoot('config-write-parent-swap-outside');
		writeJson(outside, CONFIG_FILE_NAME, VALID_SAMPLE);
		const outsideBefore = readFileSync(join(outside, CONFIG_FILE_NAME));

		try {
			expect(() =>
				writePin(
					root,
					{ tag: '1.136.0', sha: 'b'.repeat(40), date: '2026-09-01' },
					{
						afterOpen: () => {
							renameSync(root, held);
							symlinkSync(outside, root);
						}
					}
				)
			).toThrow(/outside|changed|prove/);
			expect(readFileSync(join(outside, CONFIG_FILE_NAME))).toEqual(outsideBefore);
		} finally {
			rmSync(root, { force: true });
			renameSync(held, root);
		}
	});

	it('serializes canonical key order and atomically updates only the shared base pin', () => {
		const root = makeTempRoot('config-write');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		writeJson(root, LOCAL_CONFIG_FILE_NAME, { ownDirName: 'custom' });
		const targetPin = { tag: '1.136.0', sha: 'b'.repeat(40), date: '2026-09-01' };

		expect(writePin(root, targetPin, { temporarySuffix: () => 'first' })).toBe(true);
		const base = JSON.parse(readFileSync(join(root, CONFIG_FILE_NAME), 'utf8')) as Record<string, unknown>;
		expect(Object.keys(base)).toEqual([
			'codkitConfig',
			'pin',
			'upstreamAnchorCommit',
			'ownDirName',
			'generatedBranchPrefix',
			'cycleBranchPrefix',
			'releaseRefPrefix',
			'publishRemoteUrl',
			'buildWatchFile',
			'conventionsExtensionFile'
		]);
		expect(base['pin']).toEqual(targetPin);
		expect(loadConfig(root)?.ownDirName).toBe('custom');
		expect(writePin(root, targetPin, { temporarySuffix: () => 'unused' })).toBe(false);
		expect(serializeBaseConfig(parseBaseConfig(base, CONFIG_FILE_NAME))).toBe(readFileSync(join(root, CONFIG_FILE_NAME), 'utf8'));
	});

	it('retains old bytes and removes the temp file when rename is interrupted', () => {
		const root = makeTempRoot('config-write-interrupt');
		writeJson(root, CONFIG_FILE_NAME, VALID_SAMPLE);
		const path = join(root, CONFIG_FILE_NAME);
		const before = readFileSync(path);
		const fileSystem = {
			...nodeConfigFileSystem,
			rename() {
				throw new Error('injected config interruption');
			}
		};
		const pin = { tag: '1.136.0', sha: 'c'.repeat(40), date: '2026-09-01' };

		expect(() => writePin(root, pin, { fileSystem, temporarySuffix: () => 'interrupted' })).toThrow(CkError);
		expect(readFileSync(path)).toEqual(before);
		expect(existsSync(`${path}.interrupted.tmp`)).toBe(false);
	});

	it('refuses a symlink config leaf instead of writing outside patchset', () => {
		const root = makeTempRoot('config-write-symlink');
		const outside = makeTempRoot('config-write-outside');
		const outsideConfig = join(outside, CONFIG_FILE_NAME);
		writeJson(outside, CONFIG_FILE_NAME, VALID_SAMPLE);
		symlinkSync(outsideConfig, join(root, CONFIG_FILE_NAME));

		expect(() => writePin(root, { tag: '1.136.0', sha: 'd'.repeat(40), date: '2026-09-01' })).toThrow(CkError);
		expect((JSON.parse(readFileSync(outsideConfig, 'utf8')) as { pin: { tag: string } }).pin.tag).toBe('1.135.0');
	});
});
