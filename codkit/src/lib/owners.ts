/** @scope spec://codkit/modules/codkit/PROP-003#root */
// delta/owners.json: who answers for an intervention.
//
// The file maps an owner key to a contact and the paths that owner speaks for.
// Every artifact of the delta names one of those keys, and nothing else may
// appear there: an intervention whose owner is not declared has no reviewer and
// no routing (PROP-006 ##INVENTORY-ROUTING), which is CK-E-OWNER-UNKNOWN.
//
// Only the key set is read here. The contacts and the path globs belong to the
// routing that the cycle builds from the inventory, not to validation.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ckError } from './messages.ts';

/** The owners file, relative to the patchset root. */
export const OWNERS_PATH = 'delta/owners.json';

/**
 * The declared owner keys, or null when the repository carries no owners file.
 *
 * Null is not an empty list: an absent file means "this delta does not declare
 * owners yet", and a caller that would otherwise reject every owner has to be
 * able to tell that apart from a file that declares none.
 */
export function loadOwnerKeys(patchesDir: string): readonly string[] | null {
	const path = join(patchesDir, ...OWNERS_PATH.split('/'));
	if (!existsSync(path)) {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'));
	} catch (error) {
		throw ckError(
			'CONFIG',
			`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			'owners.json is plain JSON without comments',
			OWNERS_PATH
		);
	}
	return ownerKeysOf(raw);
}

/** The keys of the `owners` object of a decoded document. Exposed for tests. */
export function ownerKeysOf(raw: unknown): readonly string[] | null {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		return null;
	}
	const owners = (raw as Record<string, unknown>)['owners'];
	if (owners === null || owners === undefined || typeof owners !== 'object' || Array.isArray(owners)) {
		return null;
	}
	return Object.keys(owners as Record<string, unknown>);
}
