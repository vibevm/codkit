/** @scope spec://codkit/modules/codkit/PROP-003#LOCAL-CONFIG-RULE */
// The declaration of the bundles of a patch set (PROP-003 ##CFG-BUNDLES): the
// schema of the top-level `bundles` list of codkit.json, the one field
// codkit.local.json may set in an entry - the path of the archive, or null to
// switch the bundle off on this machine (##LOCAL-CONFIG-RULE) - and the rules
// that span entries. What a bundle is, where its unit lands and how its archive
// is read is the type's bundles layer (PROP-016 ##TYPE-AREA-LAYERS); nothing
// here names a kind of unit.

import { isAbsolute, posix, relative, resolve, win32 } from 'node:path';
import { z } from 'zod';

/**
 * One bundle of the patch set: the name of the unit as the manifest of the
 * family lists it, and the path of its archive - absolute, or relative to the
 * patch-set root with `/` separators.
 */
export type BundleConfig = {
	readonly name: string;
	readonly file: string;
	/** Set by codkit.local.json alone: the bundle is switched off on this machine. Never serialized. */
	readonly off?: boolean;
};

const CONTROL = /[\u0000-\u001f\u007f]/u;

/** A name is one portable token: letters, digits, `.`, `_` and `-`, opening with a letter or a digit. */
export const bundleName = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'must be a portable name of letters, digits, ".", "_" and "-"');

/** The problem with an archive path, or null when it is usable. */
export function bundleFileProblem(value: string): string | null {
	if (value === '') return 'must not be empty';
	if (CONTROL.test(value)) return 'must not contain control characters';
	if (value.includes('\\')) return 'must use forward slashes';
	if (value.endsWith('/')) return 'must name a file, not a directory';
	return null;
}

const bundleFile = z.string().superRefine((value, context) => {
	const problem = bundleFileProblem(value);
	if (problem !== null) context.addIssue({ code: 'custom', message: problem });
});

export const bundlesSchema = z.array(z.strictObject({ name: bundleName, file: bundleFile })).superRefine((bundles, context) => {
	bundles.forEach((bundle, index) => {
		if (bundles.slice(0, index).some((other) => other.name === bundle.name)) {
			context.addIssue({ code: 'custom', message: 'duplicate', path: [index, 'name'] });
		}
	});
});

/** codkit.local.json: the archive of a bundle on this machine, or null to switch it off here. */
export const localBundlesSchema = z
	.array(z.strictObject({ name: bundleName, file: bundleFile.nullable() }))
	.superRefine((bundles, context) => {
		bundles.forEach((bundle, index) => {
			if (bundles.slice(0, index).some((other) => other.name === bundle.name)) {
				context.addIssue({ code: 'custom', message: 'duplicate', path: [index, 'name'] });
			}
		});
	});

/** The fields of an entry of codkit.local.json `bundles`: its key and its archive. */
const LOCAL_BUNDLE_FIELDS: readonly string[] = ['name', 'file'];

/** ##LOCAL-CONFIG-RULE: the first field of a local `bundles` entry that is neither the key nor the archive, or null. */
export function localBundleContentField(bundles: unknown): string | null {
	if (!Array.isArray(bundles)) return null;
	for (const entry of bundles) {
		if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue;
		const field = Object.keys(entry).find((key) => !LOCAL_BUNDLE_FIELDS.includes(key));
		if (field !== undefined) return field;
	}
	return null;
}

/**
 * ##LOCAL-CONFIG-RULE: the archive of a bundle on this machine replaces the
 * shared one, and `null` switches the bundle off here; a local entry for a
 * name codkit.json does not declare changes nothing - `status` names it.
 */
export function locateBundles(
	bundles: readonly BundleConfig[],
	local: readonly { readonly name: string; readonly file: string | null }[] | undefined
): readonly BundleConfig[] {
	if (local === undefined) return bundles;
	return bundles.map((bundle) => {
		const entry = local.find((candidate) => candidate.name === bundle.name);
		if (entry === undefined) return bundle;
		return entry.file === null ? { ...bundle, off: true } : { ...bundle, file: entry.file };
	});
}

/** The names of local `bundles` entries that codkit.json does not declare. */
export function unmatchedLocalBundles(
	declared: readonly { readonly name: string }[],
	local: readonly { readonly name: string }[] | undefined
): readonly string[] {
	if (local === undefined) return [];
	const names = new Set(declared.map((bundle) => bundle.name));
	return local.map((entry) => entry.name).filter((name) => !names.has(name));
}

/** The absolute path of an archive: the declared path as it is, or resolved against the patch-set root. */
export function resolveBundleFile(patchesDir: string, file: string): string {
	return isAbsolute(file) || win32.isAbsolute(file) ? resolve(file) : resolve(patchesDir, ...file.split('/'));
}

/**
 * How `bundles add` writes a path into codkit.json: an absolute path as it was
 * given, with forward slashes; otherwise relative to the patch-set root, with
 * `..` segments where the archive lives beside the patch set.
 */
export function declaredBundleFile(patchesDir: string, absolute: string, asGiven: string): string {
	if (isAbsolute(asGiven) || win32.isAbsolute(asGiven)) return asGiven.split('\\').join('/');
	const relativePath = relative(patchesDir, absolute).split('\\').join('/');
	return relativePath === '' ? '.' : posix.normalize(relativePath);
}

type FieldDoc = { readonly required: string; readonly invalid: string; readonly hint: string };

/** The diagnostics of the fields of a bundle entry, keyed the way configDiagnostics addresses them. */
export const BUNDLE_FIELD_DOCS: Readonly<Record<string, FieldDoc>> = {
	bundles: {
		required: 'bundles is optional',
		invalid: 'bundles must be a list of { "name", "file" } objects, each name once',
		hint: 'set "bundles": [{ "name": "<unit>", "file": "<path to the archive>" }], or run codkit bundles add <archive>'
	},
	'bundles.name': {
		required: 'bundles.name is required (the name of the unit as the manifest of the family lists it)',
		invalid: 'bundles.name must be one portable name - letters, digits, ".", "_" and "-" - that no other bundle uses',
		hint: 'set "name": "<publisher.name>"'
	},
	'bundles.file': {
		required: 'bundles.file is required (the path of the archive, absolute or relative to the patch-set root)',
		invalid: 'bundles.file must be a path with forward slashes, absolute or relative to the patch-set root, naming a file',
		hint: 'set "file": "../bundles/<archive>"'
	}
};

/** The same table for codkit.local.json, where `file` may also be null. */
export const LOCAL_BUNDLE_FIELD_DOCS: Readonly<Record<string, FieldDoc>> = {
	bundles: {
		required: 'bundles is optional',
		invalid: 'bundles of codkit.local.json must be a list of { "name", "file" } objects, each name once; file is a path or null',
		hint: 'set "bundles": [{ "name": "<unit>", "file": "<path>" | null }]'
	},
	'bundles.name': {
		required: 'bundles.name is required (the name of a bundle codkit.json declares)',
		invalid: 'bundles.name must be one portable name that no other entry of the file uses',
		hint: 'name a bundle of codkit.json'
	},
	'bundles.file': {
		required: 'bundles.file is required (a path, or null to switch the bundle off on this machine)',
		invalid: 'bundles.file must be a path with forward slashes, or null',
		hint: 'set "file": "<path>" or "file": null'
	}
};
