/** @scope spec://codkit/modules/codkit/PROP-019#GEN-LICENSING */
// The licence surfaces of a product, computed once from the profile and the
// type's licensing area, so that the writer (`gen licensing`, ##GEN-LICENSING)
// and the checker (`verify`, ##VERIFY-LICENSING) read the same expectations:
// which overlay operations each manifest field takes, with the pin's value as
// `expectUpstream`; where the licence file goes and what its text is; which
// component licences travel with the product and from where; which renderings
// the family's installers read; where the guard lives.
//
// Nothing here writes: a surface is a description, and the two callers decide
// whether to write it or to compare it with what the patch set carries.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireCapability } from '../types/capability.js';
import { decodeUtf8Strict } from './bytes.js';
import { valueAtPath } from './layers/overlay.js';
import { CODKIT_DELIVERED_DIR, DEFAULT_LICENCE_FILE, readLicensingDeclaration } from './licensingProfile.js';
import { ckError } from './messages.js';
import { parsePolicyExpression } from './organizationPolicy.js';
import { encodePatchName } from './patchFormat.js';
import { bytesAtPin } from './pinBytes.js';
import { PATCHES_DIR } from './syncEngine.js';
/** The component under which the tool's own licence text travels when its runtime library is delivered. */
export const CODKIT_COMPONENT = 'codkit';
/** The file of the tool root carrying the tool's licence, shipped as the text of the component `codkit`. */
export const CODKIT_LICENCE_FILE = 'LICENSE.md';
/** The id of the leftover guard's suite, which the surfaces name among their contract tests. */
export const LICENCE_GUARD_SUITE = 'licence-leftovers';
/** The licensing area of the type, or the refusal every verb of the area makes (##TYPE-CAPABILITY-REFUSAL). */
export function licensingAreaOf(type, what) {
    requireCapability(type, 'licensing', what);
    const area = type.licensing;
    if (area === undefined) {
        throw ckError('ARTIFACT-BROKEN', `the project type ${type.id} declares licensing and answers no area`, 'the type package is inconsistent');
    }
    return area;
}
/** The own expression of the product, canonical: the profile's default own licence. */
export function productExpression(profile) {
    const parsed = parsePolicyExpression(profile.selected.policy.ownLicense);
    if (!parsed.ok)
        throw ckError('CONFIG', `the profile's own licence does not parse: ${parsed.problems.join('; ')}`, 'fix the profile in the trusted store');
    return parsed.value.canonical;
}
/**
 * ##GEN-LICENSING: the canonical text of an expression - the profile's custom
 * text for a `LicenseRef-` identifier, its trusted standard text otherwise. A
 * compound expression has no single text, and an identifier the profile keeps
 * no text for cannot become the licence file of a product.
 */
export function canonicalTextOf(profile, expression) {
    const parsed = parsePolicyExpression(expression);
    if (!parsed.ok)
        throw ckError('CONFIG', `the expression ${expression} does not parse`, 'fix the profile in the trusted store');
    const id = parsed.value.licenses[0];
    if (id === undefined || parsed.value.licenses.length !== 1 || parsed.value.exceptions.length !== 0) {
        throw ckError('CONFIG', `the own licence ${expression} is a compound expression and has no single text to ship as the licence file`, 'declare a single licence identifier as the own licence of the profile');
    }
    const { policy } = profile.selected;
    const record = id.startsWith('LicenseRef-')
        ? policy.customLicenses.find((entry) => entry.id === id)
        : (policy.standardLicenseTexts ?? []).find((entry) => entry.id === id);
    if (record === undefined) {
        throw ckError('CONFIG', `the profile carries no text for the own licence ${id}`, id.startsWith('LicenseRef-')
            ? 'add the licence to customLicenses of the profile with its canonical text and SHA-256'
            : 'add the licence to standardLicenseTexts of the profile with its canonical text and SHA-256');
    }
    return record.text;
}
/** The artifact of an add-file patch for a tree path. */
export function addFileArtifactOf(treePath) {
    return `${PATCHES_DIR}/${encodePatchName(treePath)}`;
}
/** `<directory>/<name>`, or `<name>` at the root. */
function under(directory, name) {
    return directory === '' ? name : `${directory}/${name}`;
}
/** The tree path of the licence file for a declared (or default) file name. */
function licenceFileTreePath(area, fileName) {
    return under(area.licenceFileDirectory, fileName);
}
/** The tree path of a component licence: `LICENSE-<component>.txt` in the component licence directory. */
function componentTreePath(area, component) {
    return under(area.componentLicenceDirectory, `LICENSE-${component}.txt`);
}
/**
 * ##LICENCE-DOCUMENT-EXEMPTION (PROP-006): the tree paths of the licence surfaces
 * an add-file patch ships verbatim - the licence file, the component licences,
 * the renderings. They are documents, not code: `verify` compares their bodies
 * with the canonical texts and the guard checks the digest of the licence
 * file, so a marker block inside one would corrupt the very text it protected.
 * The paths follow from the type's area and the declaration's file name alone -
 * never from the trusted store - so `verify` and `save` read such a patch as
 * block-free on any machine. Without the area or without a declaration there
 * are no surfaces, and the set is empty.
 */
export function licensingDocumentPaths(patchesDir, type) {
    const area = type.licensing;
    if (area === undefined)
        return new Set();
    const read = readLicensingDeclaration(patchesDir);
    if (read === null)
        return new Set();
    const { declaration } = read;
    const block = declaration.codkitReleaseLicensing === 2 ? declaration.product : undefined;
    const paths = new Set([
        licenceFileTreePath(area, block?.licenseFile ?? DEFAULT_LICENCE_FILE),
        componentTreePath(area, CODKIT_COMPONENT)
    ]);
    for (const file of area.upstreamLicenceFiles)
        paths.add(componentTreePath(area, file.component));
    for (const rendering of area.renderings)
        paths.add(rendering.path);
    return paths;
}
/** The JSON document of an overlay target at the pin, for the `expectUpstream` of every field. */
function documentAtPin(options, target) {
    const bytes = bytesAtPin(options.treeDir, options.config.pin.sha, target);
    if (bytes === null) {
        throw ckError('CONFIG', `the overlay target ${target} is absent at the pin`, 'the type names a manifest the upstream does not carry at this pin', target);
    }
    const text = decodeUtf8Strict(bytes);
    let parsed;
    try {
        parsed = text === null ? undefined : JSON.parse(text);
    }
    catch {
        parsed = undefined;
    }
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw ckError('CONFIG', `the overlay target ${target} at the pin is not a JSON object`, 'write the overlay of this target by hand', target);
    }
    return parsed;
}
/**
 * ##GEN-LICENSING (1): the overlay operations of the manifest fields, grouped by
 * target in the order the type lists them. A `url` field without a declared URL
 * is removed when the pin carries it and skipped when it does not.
 */
function overlaySurfaces(options, area, expression) {
    const byTarget = new Map();
    const documents = new Map();
    for (const field of area.fields) {
        let document = documents.get(field.target);
        if (document === undefined) {
            document = documentAtPin(options, field.target);
            documents.set(field.target, document);
        }
        const upstream = valueAtPath(document, field.path);
        const expectUpstream = upstream === undefined ? { $absent: true } : upstream;
        let operation;
        if (field.role === 'expression')
            operation = { op: 'set', path: field.path, value: expression, expectUpstream };
        else if (field.role === 'file-name')
            operation = { op: 'set', path: field.path, value: options.profile.product.licenseFile, expectUpstream };
        else if (options.profile.product.url !== null)
            operation = { op: 'set', path: field.path, value: options.profile.product.url, expectUpstream };
        else
            operation = upstream === undefined ? null : { op: 'remove', path: field.path, expectUpstream };
        if (operation === null)
            continue;
        const operations = byTarget.get(field.target) ?? [];
        operations.push(operation);
        byTarget.set(field.target, operations);
    }
    return [...byTarget.entries()].map(([target, operations]) => ({ target, operations }));
}
/**
 * ##GEN-LICENSING (3): the component licences - every upstream licence file the
 * type names, byte for byte from the pin, and the tool's own text when the
 * runtime library is delivered into the own layer.
 */
function componentSurfaces(options, area) {
    const components = [];
    for (const file of area.upstreamLicenceFiles) {
        if (file.component === CODKIT_COMPONENT) {
            throw ckError('CONFIG', `the type names the component ${CODKIT_COMPONENT}, which is the tool's own`, 'name the upstream component differently');
        }
        const bytes = bytesAtPin(options.treeDir, options.config.pin.sha, file.path);
        const text = bytes === null ? null : decodeUtf8Strict(bytes);
        if (text === null) {
            throw ckError('CONFIG', `the upstream licence file ${file.path} is absent at the pin or is not UTF-8`, 'the type names a licence file the upstream carries as text at this pin', file.path);
        }
        const treePath = componentTreePath(area, file.component);
        components.push({
            component: file.component,
            treePath,
            artifact: addFileArtifactOf(treePath),
            text: text.endsWith('\n') ? text : `${text}\n`
        });
    }
    if (existsSync(join(options.patchesDir, ...CODKIT_DELIVERED_DIR.split('/')))) {
        const text = readFileSync(join(options.toolRoot, CODKIT_LICENCE_FILE), 'utf8');
        const treePath = componentTreePath(area, CODKIT_COMPONENT);
        components.push({
            component: CODKIT_COMPONENT,
            treePath,
            artifact: addFileArtifactOf(treePath),
            text: text.endsWith('\n') ? text : `${text}\n`
        });
    }
    return components;
}
/** Every surface of the product, as the writer writes it and the checker expects it. */
export function licensingSurfaces(options) {
    const area = licensingAreaOf(options.type, 'the licence surfaces');
    const expression = productExpression(options.profile);
    const canonicalText = canonicalTextOf(options.profile, expression);
    const licenceTreePath = licenceFileTreePath(area, options.profile.product.licenseFile);
    const guard = area.guard(options.config.typeConfig.ownRoot);
    return {
        expression,
        canonicalText,
        overlays: overlaySurfaces(options, area, expression),
        licenceFile: { treePath: licenceTreePath, artifact: addFileArtifactOf(licenceTreePath), text: canonicalText },
        components: componentSurfaces(options, area),
        renderings: area.renderings.map((rendering) => ({
            treePath: rendering.path,
            artifact: addFileArtifactOf(rendering.path),
            format: rendering.format
        })),
        guard: { artifact: guard.path, suite: guard.suite, test: guard.test }
    };
}
