/** @scope spec://codkit/modules/codkit/PROP-005#root */
// own layer: the unit manifest delta/own/patchset.delta.json (PROP-005 sec. 3).
//
// Own code is the layer with no upstream file to anchor it, so nothing in the
// tree can say who owns a given file or why it exists. The manifest is that
// statement: every file under delta/own/ belongs to exactly one declared unit,
// and every service override names the decorator it replaces. A file outside all
// units is CK-E-OWN-UNCOVERED - own code that nobody claimed is own code nobody
// maintains.
//
// This module reads and validates the manifest and computes the coverage; the
// verdict (which code to raise, and whether to fail) belongs to `verify`.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ckError } from '../messages.js';
export const OWN_MANIFEST_SCHEMA_VERSION = 2;
/** File name of the manifest inside delta/own/. */
export const OWN_MANIFEST_NAME = 'patchset.delta.json';
/** The manifest, relative to the patchset root. */
export const OWN_MANIFEST_PATH = `delta/own/${OWN_MANIFEST_NAME}`;
/** Files under delta/own/ that are never part of a unit. */
const NOT_OWN_CODE = [OWN_MANIFEST_NAME, '.gitkeep'];
const unitSchema = z.object({
    id: z.string().min(1),
    layer: z.literal('own'),
    type: z.string().min(1),
    category: z.string().min(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    link: z.string().min(1),
    cause: z.string().min(1),
    pin: z.string().min(1),
    contractTests: z.array(z.string().min(1)),
    roots: z.array(z.string().min(1)).min(1)
});
const serviceOverrideSchema = z.object({
    id: z.string().min(1),
    serviceId: z.string().min(1),
    module: z.string().min(1),
    owner: z.string().min(1),
    reason: z.string().min(1),
    link: z.string().min(1),
    cause: z.string().min(1),
    pin: z.string().min(1),
    contractTests: z.array(z.string().min(1))
});
const manifestSchema = z.object({
    codkitOwnManifest: z.literal(OWN_MANIFEST_SCHEMA_VERSION),
    units: z.array(unitSchema).default([]),
    serviceOverrides: z.array(serviceOverrideSchema).default([])
});
const FIELD_EXPECTATION = {
    codkitOwnManifest: `must be exactly ${OWN_MANIFEST_SCHEMA_VERSION}`,
    units: 'must be a list of own units',
    serviceOverrides: 'must be a list of service overrides',
    id: 'must be a non-empty artifact id',
    layer: 'must be the literal "own": this manifest declares the own layer',
    type: 'must be a non-empty intervention type',
    category: 'must be a non-empty category',
    owner: 'must be a non-empty owner name',
    reason: 'must be a non-empty reason',
    link: 'must be an issue reference or the literal "none"',
    cause: 'must be an upstream sha or the literal "none"',
    pin: 'must be "<tag>@<sha>" of the pin the unit was written against',
    contractTests: 'must be a list of contract test names',
    roots: 'must be a non-empty list of paths inside delta/own/ (a directory ends with "/")',
    serviceId: 'must be the decorator id the override replaces',
    module: 'must be the path of our module inside delta/own/'
};
const HINT = 'see PROP-005 sec. 3 for the own manifest';
/**
 * Read delta/own/patchset.delta.json.
 *
 * An absent file yields an empty manifest. That is the correct answer for an
 * empty delta/own/, and for a non-empty one it is not this module's verdict to
 * give: `verify` is where "own code without a manifest" becomes a failure, with
 * the list of files nobody declared.
 */
export function loadOwnManifest(patchesDir) {
    const absolute = join(patchesDir, ...OWN_MANIFEST_PATH.split('/'));
    if (!existsSync(absolute)) {
        return { units: [], serviceOverrides: [], present: false };
    }
    let raw;
    try {
        raw = JSON.parse(readFileSync(absolute, 'utf8'));
    }
    catch (error) {
        throw broken(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'the manifest is plain JSON without comments');
    }
    const parsed = parseOwnManifest(raw);
    return { units: parsed.units, serviceOverrides: parsed.serviceOverrides, present: true };
}
/** Validate a decoded manifest document. Exposed so tests need no file. */
export function parseOwnManifest(raw) {
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) {
        throw schemaError(parsed.error.issues, raw);
    }
    return { units: parsed.data.units, serviceOverrides: parsed.data.serviceOverrides };
}
/** Canonical manifest bytes: schema key order, two spaces, exactly one final LF. */
export function serializeOwnManifest(manifest) {
    const units = manifest.units.map((unit) => ({
        id: unit.id,
        layer: unit.layer,
        type: unit.type,
        category: unit.category,
        owner: unit.owner,
        reason: unit.reason,
        link: unit.link,
        cause: unit.cause,
        pin: unit.pin,
        contractTests: [...unit.contractTests],
        roots: [...unit.roots]
    }));
    const serviceOverrides = manifest.serviceOverrides.map((override) => ({
        id: override.id,
        serviceId: override.serviceId,
        module: override.module,
        owner: override.owner,
        reason: override.reason,
        link: override.link,
        cause: override.cause,
        pin: override.pin,
        contractTests: [...override.contractTests]
    }));
    return `${JSON.stringify({ codkitOwnManifest: OWN_MANIFEST_SCHEMA_VERSION, units, serviceOverrides }, null, 2)}\n`;
}
/**
 * ##OWN-MANIFEST: every own file falls into exactly one unit.
 *
 * `ownFiles` are paths relative to delta/own/, POSIX. The manifest itself and
 * the `.gitkeep` files git needs to carry empty directories are not own code and
 * are never expected to be claimed.
 *
 * A root that ends with `/` is a directory prefix and covers everything under
 * it; any other root names one file exactly. The two failure lists are returned
 * rather than raised: `verify` prints them all in one pass, under
 * CK-E-OWN-UNCOVERED.
 */
export function checkUnitCoverage(manifest, ownFiles) {
    const uncovered = [];
    const overlapping = [];
    for (const file of ownFiles) {
        if (isNotOwnCode(file)) {
            continue;
        }
        const claiming = [];
        for (const unit of manifest.units) {
            if (unit.roots.some((root) => covers(root, file))) {
                claiming.push(unit.id);
            }
        }
        if (claiming.length === 0) {
            uncovered.push(file);
            continue;
        }
        if (claiming.length > 1) {
            overlapping.push([file, claiming]);
        }
    }
    return { uncovered, overlapping };
}
/**
 * ##OWN-MANIFEST: a service override names a delivered own module, and that
 * module belongs to exactly one own unit. Keeping the module check next to the
 * general coverage calculation makes both use the same root semantics.
 */
export function checkServiceOverrideModules(manifest, ownFiles) {
    const deliveredFiles = new Set(ownFiles.filter((file) => !isNotOwnCode(file)).map(cleanOwnPath));
    return manifest.serviceOverrides.map((override) => {
        const module = cleanOwnPath(override.module);
        const units = manifest.units.filter((unit) => unit.roots.some((root) => covers(root, module))).map((unit) => unit.id);
        return { override, module, delivered: deliveredFiles.has(module), units };
    });
}
/** The manifest and the placeholders git needs are not own code. */
function isNotOwnCode(file) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    return file === OWN_MANIFEST_NAME || NOT_OWN_CODE.includes(name);
}
function covers(root, file) {
    const clean = cleanOwnPath(root);
    return clean.endsWith('/') ? file.startsWith(clean) : file === clean;
}
function cleanOwnPath(path) {
    return path.startsWith('./') ? path.slice(2) : path;
}
function schemaError(issues, raw) {
    const issue = issues[0];
    if (issue === undefined) {
        return broken('failed validation', HINT);
    }
    const label = renderIssuePath(issue.path);
    const field = String(issue.path[issue.path.length - 1] ?? '');
    const expectation = FIELD_EXPECTATION[field] ?? issue.message;
    const actual = valueAtPath(raw, issue.path);
    const got = actual === undefined ? 'nothing' : renderValue(actual);
    return broken(label === '' ? `${expectation}, got ${got}` : `${label} ${expectation}, got ${got}`, HINT);
}
function renderIssuePath(path) {
    let out = '';
    for (const segment of path) {
        if (typeof segment === 'number') {
            out += `[${segment}]`;
            continue;
        }
        out = out === '' ? String(segment) : `${out}.${String(segment)}`;
    }
    return out;
}
function renderValue(value) {
    const text = JSON.stringify(value) ?? String(value);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function valueAtPath(raw, path) {
    let current = raw;
    for (const segment of path) {
        if (current === null || typeof current !== 'object') {
            return undefined;
        }
        current = current[String(segment)];
    }
    return current;
}
function broken(message, hint) {
    return ckError('ARTIFACT-BROKEN', message, hint, OWN_MANIFEST_PATH);
}
