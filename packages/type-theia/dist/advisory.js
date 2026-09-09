/** @scope spec://codkit/modules/theia/PROP-005#THEIA-ADVISORY-READERS */
// Area 5: what the upgrade advisory reads between two pins.
//
// The frame - the phase, the stop for a person, the acknowledgement that
// unblocks the cycle, the report - belongs to the engine. Which files of this
// family carry a meaning is the answer here, and ##THEIA-ADVISORY-READERS names
// six of them: the version of the monorepo, the Node engine of the tree, the
// set of `@theia/*` packages, the entry kinds a `theiaExtensions` array may use,
// the schema of the `theia` section of an application manifest, and the
// Electron version the application pins.
//
// Two of the six read TypeScript rather than JSON, because that is where
// upstream writes them: the entry kinds are an interface and the schema of the
// application manifest is a set of interfaces. Both are read as the set of
// property names they declare - which is exactly what "a key was added or
// removed" means for a downstream - and never as code.
import { brokenArtifact } from '@codkit/type-api';
import { LERNA_MANIFEST_PATH, ROOT_MANIFEST_PATH } from './identity.js';
/** The lockfile, which is where every workspace package of the tree is named. */
export const LOCK_PATH = 'package-lock.json';
/** Where the entry kinds of `theiaExtensions` are declared (##THEIA-ADVISORY-READERS). */
export const EXTENSION_PACKAGE_PATH = 'dev-packages/application-package/src/extension-package.ts';
/** Where the schema of the `theia` section of an application manifest is declared. */
export const APPLICATION_PROPS_PATH = 'dev-packages/application-package/src/application-props.ts';
export function readersFor(applicationRoot) {
    const applicationManifest = `${applicationRoot}/package.json`;
    return [
        {
            id: 'monorepo-version',
            paths: [LERNA_MANIFEST_PATH],
            changeIsNews: true,
            read: (files) => select(object(files, LERNA_MANIFEST_PATH), ['version', 'npmClient']),
            meaning: () => 'the version of the monorepo changed: every @theia/* dependency of the own package and of the application is that literal, so they are all bumped together'
        },
        {
            id: 'node-engine',
            paths: [ROOT_MANIFEST_PATH],
            // The root manifest of a monorepo changes constantly; only what it
            // says about the toolchain is news.
            changeIsNews: false,
            read: (files) => select(object(files, ROOT_MANIFEST_PATH), ['engines', 'packageManager']),
            meaning: () => 'the toolchain this monorepo builds with changed: switch the Node version before the next install in the tree'
        },
        {
            id: 'workspace-packages',
            paths: [LOCK_PATH],
            changeIsNews: false,
            read: (files) => workspacePackages(object(files, LOCK_PATH)),
            meaning: () => 'the set of packages the monorepo ships changed: a package the application depends on may be gone, and a new one may replace it'
        },
        {
            id: 'extension-entry-kinds',
            paths: [EXTENSION_PACKAGE_PATH],
            changeIsNews: false,
            read: (files) => interfaceMembers(text(files, EXTENSION_PACKAGE_PATH), 'Extension'),
            meaning: () => 'the entry kinds a theiaExtensions array may declare changed: the own package may name a kind that no longer exists, or miss one it now needs'
        },
        {
            id: 'application-schema',
            paths: [APPLICATION_PROPS_PATH],
            changeIsNews: false,
            read: (files) => declaredProperties(text(files, APPLICATION_PROPS_PATH)),
            meaning: () => 'the schema of the theia section of an application manifest changed: the overlay of that manifest may set a key upstream no longer reads'
        },
        {
            id: 'application-electron',
            paths: [applicationManifest],
            changeIsNews: false,
            read: (files) => applicationToolchain(object(files, applicationManifest)),
            meaning: () => 'the Electron version or the target of the application changed: the native modules and the packaging of the product have to be checked against it'
        }
    ];
}
export function makeAdvisory(applicationRoot) {
    return { readers: readersFor(applicationRoot) };
}
/** The workspace packages the lockfile names, sorted, or null when it is absent. */
function workspacePackages(lock) {
    if (lock === null) {
        return null;
    }
    const packages = lock['packages'];
    if (!isJsonObject(packages)) {
        return null;
    }
    const names = [];
    for (const [location, entry] of Object.entries(packages)) {
        if (location === '' || location.startsWith('node_modules/') || !isJsonObject(entry)) {
            continue;
        }
        const name = entry['name'];
        if (typeof name === 'string') {
            names.push(name);
        }
    }
    return [...new Set(names)].sort();
}
/** The Electron version and the target an application manifest declares. */
function applicationToolchain(manifest) {
    if (manifest === null) {
        return null;
    }
    const devDependencies = manifest['devDependencies'];
    const electron = isJsonObject(devDependencies) ? (devDependencies['electron'] ?? null) : null;
    const theia = manifest['theia'];
    const target = isJsonObject(theia) ? (theia['target'] ?? null) : null;
    return { electron, target };
}
/**
 * The member names of one declared interface, in source order. The file is read
 * as text, never evaluated: what an upgrade needs to know is which keys exist.
 */
export function interfaceMembers(source, name) {
    if (source === null) {
        return null;
    }
    const opening = new RegExp(`interface\\s+${name}\\s*(?:extends[^{]*)?\\{`, 'u').exec(source);
    if (opening === null) {
        return null;
    }
    const start = opening.index + opening[0].length;
    const end = source.indexOf('}', start);
    if (end === -1) {
        throw brokenArtifact(`the interface ${name} is not closed`, 'restore the file from the pin');
    }
    return memberNames(source.slice(start, end));
}
/** Every property name the file declares, sorted and without repeats. */
export function declaredProperties(source) {
    return source === null ? null : [...new Set(memberNames(source))].sort();
}
function memberNames(body) {
    const names = [];
    for (const match of body.matchAll(/^[ \t]*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gmu)) {
        const name = match[1];
        if (name !== undefined) {
            names.push(name);
        }
    }
    return names;
}
function text(files, path) {
    return files.get(path) ?? null;
}
function object(files, path) {
    const content = text(files, path);
    if (content === null) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch (error) {
        throw brokenArtifact(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`, 'restore the upstream object from the pin');
    }
    if (!isRecord(parsed)) {
        throw brokenArtifact(`${path} must contain one JSON object`, 'restore the upstream object from the pin');
    }
    return normalizeObject(parsed);
}
function select(value, keys) {
    if (value === null) {
        return null;
    }
    const selected = {};
    for (const key of keys) {
        const field = value[key];
        if (field !== undefined) {
            selected[key] = field;
        }
    }
    return selected;
}
function normalizeObject(value) {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
        normalized[key] = normalizeJson(value[key]);
    }
    return normalized;
}
function normalizeJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(normalizeJson);
    }
    if (isRecord(value)) {
        return normalizeObject(value);
    }
    throw brokenArtifact('the JSON carries a value outside the portable data model', 'restore the upstream object from the pin');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
