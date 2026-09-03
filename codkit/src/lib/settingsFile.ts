/** @scope spec://codkit/modules/codkit/PROP-003#root */
/** User-level Codkit location settings from ~/.codkit/settings.json. */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { ckError } from './messages.ts';

export const SETTINGS_SCHEMA_VERSION = 1;

export type CodkitSettings = {
	readonly codkitSettings: 1;
	readonly forkDir?: string | undefined;
	readonly patchesDir?: string | undefined;
};

const absolutePath = z
	.string()
	.min(1)
	.refine((value) => isAbsolute(value), { message: 'must be an absolute path' });

export function settingsFilePath(home: string = homedir()): string {
	return join(home, '.codkit', 'settings.json');
}

export type SettingsFields = { readonly forkDir: boolean; readonly patchesDir: boolean };

const allSettingsFields: SettingsFields = { forkDir: true, patchesDir: true };

export function loadSettings(path: string = settingsFilePath(), fields: SettingsFields = allSettingsFields): CodkitSettings {
	if (!existsSync(path)) return { codkitSettings: SETTINGS_SCHEMA_VERSION };
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
	} catch (error) {
		throw ckError('CONFIG', `cannot read ${path}: ${messageOf(error)}`, 'write valid JSON or remove the settings file', path);
	}
	const selectedSchema = z
		.object({
			codkitSettings: z.literal(SETTINGS_SCHEMA_VERSION),
			forkDir: fields.forkDir ? absolutePath.optional() : z.unknown().optional(),
			patchesDir: fields.patchesDir ? absolutePath.optional() : z.unknown().optional()
		})
		.strict();
	const parsed = selectedSchema.safeParse(raw);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const field = issue?.path.map(String).join('.') || 'document';
		throw ckError(
			'CONFIG',
			`${field}: ${issue?.message ?? 'invalid Codkit settings'}`,
			`use {"codkitSettings":${SETTINGS_SCHEMA_VERSION},"forkDir":"/absolute/path","patchesDir":"/absolute/path"}`,
			path
		);
	}
	return {
		codkitSettings: SETTINGS_SCHEMA_VERSION,
		...(fields.forkDir && typeof parsed.data.forkDir === 'string' ? { forkDir: parsed.data.forkDir } : {}),
		...(fields.patchesDir && typeof parsed.data.patchesDir === 'string' ? { patchesDir: parsed.data.patchesDir } : {})
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
