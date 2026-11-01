/** @scope spec://codkit/modules/vscode-extension/PROP-005#VSX-ADVISORY-READERS */
// Area 5: what the upgrade advisory reads between two pins.
//
// The frame - the phase, the stop for a person, the acknowledgement that
// unblocks the cycle, the report - belongs to the engine. Which values of this
// family carry a meaning is the answer here, and ##VSX-ADVISORY-READERS names
// six of them, all over the extension manifest unless named otherwise: the
// engine range of the host, the version, the configuration keys, the
// activation events, the package manager of the root and the locale manifests
// the patch set names. A reader never throws on an absent file and refuses an
// unreadable one with `brokenArtifact`. What a change means is one sentence
// each (##VSX-ADVISORY-MEANINGS), and a difference with no meaning worth
// stopping for is not reported.
import { brokenArtifact } from '@codkit/type-api';
import { manifestPathOf, ROOT_MANIFEST_PATH } from './identity.js';
import { isJsonObject, objectField, readJsonObject } from './manifest.js';
export function readersFor(config) {
    const manifest = manifestPathOf(config.extensionRoot);
    const localeManifests = [...(config.localeManifests ?? [])].sort();
    const readers = [
        {
            id: 'engines-vscode',
            paths: [manifest],
            // ##VSX-ADVISORY-READERS: a change of the engine range is news by itself.
            changeIsNews: true,
            read: (files) => field(readJsonObject(files, manifest), ['engines', 'vscode']),
            meaning: () => 'the minimum host moved: the preview host and the hosts the product supports must satisfy the new engines.vscode range'
        },
        {
            id: 'manifest-version',
            paths: [manifest],
            changeIsNews: false,
            read: (files) => field(readJsonObject(files, manifest), ['version']),
            meaning: () => "the version of the extension changed: the product's own version policy decides what it ships"
        },
        {
            id: 'configuration-keys',
            paths: [manifest],
            changeIsNews: false,
            read: (files) => configurationKeys(readJsonObject(files, manifest)),
            meaning: (before, after) => removedEntries(before, after).length > 0
                ? 'a configuration key was renamed or removed: own code and the brand overlay that name the key break'
                : null
        },
        {
            id: 'activation-events',
            paths: [manifest],
            changeIsNews: false,
            read: (files) => field(readJsonObject(files, manifest), ['activationEvents']),
            meaning: () => 'the activation list changed: the entry module runs under new conditions'
        }
    ];
    // REVIEW: the package-manager reader exists for a monorepo only, as the
    // specification qualifies it ("when the tree is a monorepo"); a repository
    // that is one extension has the same field in the same file, and a product
    // that wants it read there declares the tree a monorepo.
    if (config.monorepo === true) {
        readers.push({
            id: 'package-manager',
            paths: [ROOT_MANIFEST_PATH],
            changeIsNews: false,
            read: (files) => field(readJsonObject(files, ROOT_MANIFEST_PATH), ['packageManager']),
            meaning: () => 'the package manager of the tree changed: the install, the lint and the build commands change their spelling'
        });
    }
    readers.push({
        id: 'locale-manifests',
        paths: localeManifests,
        changeIsNews: false,
        read: (files) => localeManifests.filter((path) => (files.get(path) ?? null) !== null),
        meaning: () => 'a locale manifest appeared or vanished: an overlay target appeared or vanished with it'
    });
    return readers;
}
export function makeAdvisory(config) {
    return { readers: readersFor(config) };
}
/**
 * ##VSX-ADVISORY-READERS: the sorted keys of every `contributes.configuration`
 * section - the manifest carries one section as an object or several as an
 * array, and the keys are the `properties` of each.
 */
export function configurationKeys(manifest) {
    if (manifest === null) {
        return null;
    }
    const configuration = objectField(manifest, 'contributes')?.['configuration'];
    const sections = Array.isArray(configuration) ? configuration : [configuration];
    const keys = new Set();
    for (const section of sections) {
        const properties = isJsonObject(section) ? section['properties'] : undefined;
        if (isJsonObject(properties)) {
            for (const key of Object.keys(properties)) {
                keys.add(key);
            }
        }
    }
    return [...keys].sort();
}
/** The entries of one sorted list that the other no longer carries. */
export function removedEntries(before, after) {
    const was = stringsOf(before);
    const is = new Set(stringsOf(after));
    return was.filter((entry) => !is.has(entry));
}
function stringsOf(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}
/** One field of a manifest by its path, as a portable value; null when absent. */
function field(manifest, path) {
    let current = manifest;
    for (const key of path) {
        if (!isJsonObject(current)) {
            return null;
        }
        current = current[key];
    }
    return current === undefined ? null : normalize(current);
}
function normalize(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(normalize);
    }
    if (isJsonObject(value)) {
        const normalized = {};
        for (const key of Object.keys(value).sort()) {
            normalized[key] = normalize(value[key]);
        }
        return normalized;
    }
    throw brokenArtifact('the manifest carries a value outside the portable data model', 'restore the manifest from the pin');
}
/** The files of one pin as the engine hands them, for a suite that builds them by hand. */
export function filesOf(entries) {
    return new Map(Object.entries(entries));
}
