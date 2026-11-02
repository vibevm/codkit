/** @scope spec://codkit/modules/codkit/PROP-003#LOCAL-CONFIG-RULE */
// The declaration of the bundles of a patch set (PROP-003 ##CFG-BUNDLES): the
// schema of the top-level `bundles` list of codkit.json - the name of a unit and
// either the one archive that serves every platform (`file`) or one archive per
// target of the family (`files`) - the fields codkit.local.json may set in an
// entry - the archive or the archives on this machine, or `file: null` to
// switch the bundle off here (##LOCAL-CONFIG-RULE) - and the rules that span
// entries. What a bundle is, where its unit lands, which targets the family
// names and how its archive is read is the type's bundles layer (PROP-016
// ##TYPE-AREA-LAYERS); nothing here names a kind of unit or a platform.
import { isAbsolute, posix, relative, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { ckError } from './messages.js';
const CONTROL = /[\u0000-\u001f\u007f]/u;
/** A name is one portable token: letters, digits, `.`, `_` and `-`, opening with a letter or a digit. */
export const bundleName = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'must be a portable name of letters, digits, ".", "_" and "-"');
/** A target is the family's token for one platform of a unit built per target. */
export const bundleTarget = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/u, 'must be a target name of lower-case letters, digits and "-"');
/** The problem with an archive path, or null when it is usable. */
export function bundleFileProblem(value) {
    if (value === '')
        return 'must not be empty';
    if (CONTROL.test(value))
        return 'must not contain control characters';
    if (value.includes('\\'))
        return 'must use forward slashes';
    if (value.endsWith('/'))
        return 'must name a file, not a directory';
    return null;
}
const bundleFile = z.string().superRefine((value, context) => {
    const problem = bundleFileProblem(value);
    if (problem !== null)
        context.addIssue({ code: 'custom', message: problem });
});
const bundleFiles = z
    .record(bundleTarget, bundleFile)
    .refine((files) => Object.keys(files).length > 0, { message: 'must name the archive of at least one target' });
/** Exactly one of the two forms; `file: null` of codkit.local.json counts as the first. */
function oneForm(entry, context) {
    if ((entry.file === undefined) === (entry.files === undefined)) {
        context.addIssue({ code: 'custom', message: 'needs exactly one of file and files', path: ['file'] });
    }
}
function uniqueNames(bundles, context) {
    bundles.forEach((bundle, index) => {
        if (bundles.slice(0, index).some((other) => other.name === bundle.name)) {
            context.addIssue({ code: 'custom', message: 'duplicate', path: [index, 'name'] });
        }
    });
}
export const bundlesSchema = z
    .array(z.strictObject({ name: bundleName, file: bundleFile.optional(), files: bundleFiles.optional() }).superRefine(oneForm))
    .superRefine(uniqueNames);
/** codkit.local.json: the archive or archives of a bundle on this machine, or `file: null` to switch it off here. */
export const localBundlesSchema = z
    .array(z.strictObject({ name: bundleName, file: bundleFile.nullable().optional(), files: bundleFiles.optional() }).superRefine(oneForm))
    .superRefine(uniqueNames);
/** The fields of an entry of codkit.local.json `bundles`: its key and where its archives are. */
const LOCAL_BUNDLE_FIELDS = ['name', 'file', 'files'];
/** ##LOCAL-CONFIG-RULE: the first field of a local `bundles` entry that is neither the key nor an archive, or null. */
export function localBundleContentField(bundles) {
    if (!Array.isArray(bundles))
        return null;
    for (const entry of bundles) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            continue;
        const field = Object.keys(entry).find((key) => !LOCAL_BUNDLE_FIELDS.includes(key));
        if (field !== undefined)
            return field;
    }
    return null;
}
/**
 * ##LOCAL-CONFIG-RULE: the archives of a bundle on this machine replace the
 * shared ones in the same form - `file` for a unit with one archive, `files`
 * (the whole map) for a unit built per target - and `file: null` switches the
 * bundle off here; a local entry for a name codkit.json does not declare
 * changes nothing - `status` names it.
 */
export function locateBundles(bundles, local) {
    if (local === undefined)
        return bundles;
    return bundles.map((bundle) => {
        const entry = local.find((candidate) => candidate.name === bundle.name);
        if (entry === undefined)
            return bundle;
        if (entry.file === null)
            return { ...bundle, off: true };
        if (entry.files !== undefined) {
            if (bundle.files === undefined) {
                throw ckError('CONFIG', `codkit.local.json gives the bundle ${bundle.name} an archive per target, but codkit.json declares one archive for it`, 'give "file" with the archive on this machine, or "file": null to switch the bundle off here');
            }
            return { name: bundle.name, files: entry.files };
        }
        if (bundle.file === undefined) {
            throw ckError('CONFIG', `codkit.local.json gives the bundle ${bundle.name} one archive, but codkit.json declares an archive per target for it`, 'give "files" with the archive of every target on this machine, or "file": null to switch the bundle off here');
        }
        return { name: bundle.name, file: entry.file ?? bundle.file };
    });
}
/** The names of local `bundles` entries that codkit.json does not declare. */
export function unmatchedLocalBundles(declared, local) {
    if (local === undefined)
        return [];
    const names = new Set(declared.map((bundle) => bundle.name));
    return local.map((entry) => entry.name).filter((name) => !names.has(name));
}
/** The serializable declaration of a bundle: its key and its archive or archives, nothing local. */
export function declarationOf(bundle) {
    return bundle.files === undefined ? { name: bundle.name, file: bundle.file } : { name: bundle.name, files: { ...bundle.files } };
}
/** The absolute path of an archive: the declared path as it is, or resolved against the patch-set root. */
export function resolveBundleFile(patchesDir, file) {
    return isAbsolute(file) || win32.isAbsolute(file) ? resolve(file) : resolve(patchesDir, ...file.split('/'));
}
/**
 * How `bundles add` writes a path into codkit.json: an absolute path as it was
 * given, with forward slashes; otherwise relative to the patch-set root, with
 * `..` segments where the archive lives beside the patch set.
 */
export function declaredBundleFile(patchesDir, absolute, asGiven) {
    if (isAbsolute(asGiven) || win32.isAbsolute(asGiven))
        return asGiven.split('\\').join('/');
    const relativePath = relative(patchesDir, absolute).split('\\').join('/');
    return relativePath === '' ? '.' : posix.normalize(relativePath);
}
/** The diagnostics of the fields of a bundle entry, keyed the way configDiagnostics addresses them. */
export const BUNDLE_FIELD_DOCS = {
    bundles: {
        required: 'bundles is optional',
        invalid: 'bundles must be a list of { "name", "file" } or { "name", "files" } objects, each name once',
        hint: 'set "bundles": [{ "name": "<unit>", "file": "<path to the archive>" }], or run codkit bundles add <archive>...'
    },
    'bundles.name': {
        required: 'bundles.name is required (the name of the unit as the manifest of the family lists it)',
        invalid: 'bundles.name must be one portable name - letters, digits, ".", "_" and "-" - that no other bundle uses',
        hint: 'set "name": "<publisher.name>"'
    },
    'bundles.file': {
        required: 'bundles.file or bundles.files is required (the archive, or one archive per target)',
        invalid: 'a bundle needs exactly one of file and files; file must be a path with forward slashes, absolute or relative to the patch-set root, naming a file',
        hint: 'set "file": "../bundles/<archive>", or "files": { "<target>": "../bundles/<archive of the target>" }'
    },
    'bundles.files': {
        required: 'bundles.files is optional (one archive per target of the family)',
        invalid: 'bundles.files must map target names of lower-case letters, digits and "-" to archive paths with forward slashes',
        hint: 'set "files": { "<target>": "../bundles/<archive of the target>" }'
    }
};
/** The same table for codkit.local.json, where `file` may also be null. */
export const LOCAL_BUNDLE_FIELD_DOCS = {
    bundles: {
        required: 'bundles is optional',
        invalid: 'bundles of codkit.local.json must be a list of { "name", "file" } or { "name", "files" } objects, each name once; file is a path or null',
        hint: 'set "bundles": [{ "name": "<unit>", "file": "<path>" | null }]'
    },
    'bundles.name': {
        required: 'bundles.name is required (the name of a bundle codkit.json declares)',
        invalid: 'bundles.name must be one portable name that no other entry of the file uses',
        hint: 'name a bundle of codkit.json'
    },
    'bundles.file': {
        required: 'bundles.file or bundles.files is required (where the archive is on this machine, or null to switch the bundle off)',
        invalid: 'a local bundle needs exactly one of file and files; file must be a path with forward slashes, or null',
        hint: 'set "file": "<path>" or "file": null, or "files": { "<target>": "<path>" }'
    },
    'bundles.files': {
        required: 'bundles.files is optional (where the archive of every target is on this machine)',
        invalid: 'bundles.files must map target names to archive paths with forward slashes',
        hint: 'set "files": { "<target>": "<path>" }'
    }
};
