/** @scope spec://codkit/modules/vscode/PROP-005#VSCODE-ADVISORY-READERS */
// Area 5: what the upgrade advisory reads between two pins.
//
// The frame around these readings - the `deps-advisory` phase, the stop for a
// human, the acknowledgement that unblocks the cycle, the report and the
// journal - belongs to the engine
// (`spec://codkit/modules/codkit/PROP-009#PHASE-DEPS-ADVISORY`). Which files
// carry a meaning, what that meaning is, and how to read it out of the bytes is
// this type's answer, and it is stated here in full: the engine hands a reader
// the text of the files it declared at one pin and compares what comes back.
//
// A reader never throws on a file the pin does not carry - an absent file is a
// null reading, which is exactly the news that the file was deleted upstream.
// It does refuse a file it cannot read at all, with `brokenArtifact`, and the
// engine turns that into `CK-E-ARTIFACT-BROKEN` naming the pin.
import { brokenArtifact } from '@codkit/type-api';
import { extractNpmDirectories } from './npmDirectories.js';
/** The manifest fields that decide what an install produces. */
const PACKAGE_SUMMARY_KEYS = [
    'packageManager',
    'engines',
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
    'overrides',
    'resolutions'
];
/** The root-package fields of the lock that decide the same thing. */
const LOCK_ROOT_KEYS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'engines'];
const SEMVERISH = /^(?:[~^]|[<>]=?)?v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;
/**
 * ##VSCODE-ADVISORY-READERS: the toolchain of this distribution, file by file.
 * A reader that finds nothing contributes no line to the report.
 */
export const readers = [
    {
        id: 'node-version',
        paths: ['.nvmrc'],
        changeIsNews: true,
        read: (files) => nodeVersion(text(files, '.nvmrc')),
        meaning: () => 'the Node version this distribution builds with changed: switch the toolchain before the next build in the tree'
    },
    {
        id: 'package-manifest',
        paths: ['package.json'],
        changeIsNews: true,
        read: (files) => summary(object(files, 'package.json'), PACKAGE_SUMMARY_KEYS),
        meaning: () => 'the dependency declarations of the distribution changed: the tree needs a fresh dependency install before it builds again'
    },
    {
        id: 'package-lock',
        paths: ['package-lock.json'],
        changeIsNews: true,
        read: (files) => packageLockSummary(object(files, 'package-lock.json')),
        meaning: () => 'the resolved dependency tree of the distribution changed: install from the lock rather than reusing what is installed'
    },
    {
        id: 'npm-directories',
        paths: ['build/npm/dirs.ts'],
        changeIsNews: true,
        read: (files) => npmDirectories(text(files, 'build/npm/dirs.ts')),
        meaning: () => 'the set of directories the distribution installs dependencies into changed: a directory left behind by the old set is not reinstalled'
    },
    {
        id: 'built-in-extensions',
        paths: ['product.json'],
        // The product manifest carries a hundred fields the cycle has no opinion
        // about; only a change of the built-in extension set is news.
        changeIsNews: false,
        read: (files) => builtInExtensions(object(files, 'product.json')),
        meaning: () => 'the built-in extensions the product manifest declares changed: the overlay of that manifest may name entries upstream no longer ships'
    },
    {
        id: 'electron-versions',
        paths: ['package.json', 'build/lib/electron.ts'],
        changeIsNews: false,
        read: (files) => electronVersions(object(files, 'package.json'), files.get('build/lib/electron.ts') ?? null),
        meaning: () => 'the Electron version of the distribution changed: the native modules and the packaging step have to be checked against it'
    }
];
/** Every file the readers of this type need, in a stable order, without repeats. */
export const ADVISORY_PATHS = [...new Set(readers.flatMap((reader) => reader.paths))];
export const advisory = { readers };
/** The text of one declared file at this pin, or null when it is absent. */
function text(files, path) {
    return files.get(path) ?? null;
}
/** The one nonempty version line of a version file. */
function nodeVersion(content) {
    if (content === null) {
        return null;
    }
    const value = content.trim();
    if (value === '' || /\s/.test(value)) {
        throw brokenArtifact('.nvmrc must contain exactly one nonempty version', 'restore a single-line version file upstream');
    }
    return value;
}
/** One JSON object of the distribution, with its keys in a stable order. */
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
        throw brokenArtifact(`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`, 'repair the upstream object');
    }
    if (!isRecord(parsed)) {
        throw brokenArtifact(`${path} must contain one JSON object`, 'repair the upstream object');
    }
    return normalizeObject(parsed);
}
/** The declared fields that decide what an install produces. */
function summary(value, keys) {
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
/** The lock's version and the resolved dependencies of its root package. */
function packageLockSummary(value) {
    if (value === null) {
        return null;
    }
    const selected = {};
    if (value['lockfileVersion'] !== undefined) {
        selected['lockfileVersion'] = value['lockfileVersion'];
    }
    const packages = value['packages'];
    if (isJsonObject(packages)) {
        const root = packages[''];
        if (isJsonObject(root)) {
            selected['root'] = summary(root, LOCK_ROOT_KEYS) ?? {};
        }
    }
    return selected;
}
/** The built-in extension set of the product manifest, or null when absent. */
function builtInExtensions(value) {
    if (value === null || value['builtInExtensions'] === undefined) {
        return null;
    }
    const extensions = value['builtInExtensions'];
    if (!Array.isArray(extensions)) {
        throw brokenArtifact('builtInExtensions in product.json must be an array', 'repair the upstream product manifest');
    }
    return extensions;
}
/** The npm directory list, parsed out of the distribution's own source. */
function npmDirectories(content) {
    return content === null ? null : [...extractNpmDirectories(content)];
}
/**
 * Every Electron version the distribution states, from both places it states
 * them: the manifest keys whose name mentions Electron, and the version
 * literals of the build source. Sorted, so the comparison is about the values
 * and not about where a reader happened to walk first.
 */
function electronVersions(packageJson, source) {
    const values = [];
    if (packageJson !== null) {
        collectElectronJson(packageJson, '', values);
    }
    if (source !== null) {
        for (const value of source.match(/(?:[~^]|[<>]=?)?v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/g) ?? []) {
            if (SEMVERISH.test(value)) {
                values.push({ path: 'build/lib/electron.ts', locator: 'version-literal', value });
            }
        }
    }
    return dedupeElectron(values)
        .sort(compareElectron)
        .map((value) => ({ path: value.path, locator: value.locator, value: value.value }));
}
function collectElectronJson(value, pointer, output) {
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectElectronJson(item, `${pointer}/${index}`, output));
        return;
    }
    if (!isJsonObject(value)) {
        return;
    }
    for (const key of Object.keys(value).sort()) {
        const child = value[key];
        if (child === undefined) {
            continue;
        }
        const childPointer = `${pointer}/${escapePointer(key)}`;
        if (key.toLowerCase().includes('electron') && (typeof child === 'string' || typeof child === 'number')) {
            output.push({ path: 'package.json', locator: childPointer, value: String(child) });
        }
        collectElectronJson(child, childPointer, output);
    }
}
function dedupeElectron(values) {
    const seen = new Set();
    return values.filter((value) => {
        const key = `${value.path}\0${value.locator}\0${value.value}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}
function compareElectron(left, right) {
    const a = `${left.path}\0${left.locator}\0${left.value}`;
    const b = `${right.path}\0${right.locator}\0${right.value}`;
    return a < b ? -1 : a > b ? 1 : 0;
}
function escapePointer(value) {
    return value.replaceAll('~', '~0').replaceAll('/', '~1');
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
    throw brokenArtifact('the JSON carries a value outside the portable data model', 'repair the upstream object');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isJsonObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
