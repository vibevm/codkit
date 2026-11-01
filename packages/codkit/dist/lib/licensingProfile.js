/** @scope spec://codkit/modules/codkit/PROP-019#LICENSING-DECLARATION-V2 */
// The selected licensing profile of a patch set, as the consumer surfaces read
// it: the declaration `codkit.licensing.json` (version 1 or 2), the trusted
// profile it selects, and the display choices of its `product` block.
//
// The authority stays where PROP-019 put it: holders, expressions, texts and
// permissions come from the store on the machine (##ORGANIZATION-POLICY-TRUST),
// and the patch set selects a profile id. What this module adds is the product's
// own choices about how that profile is shown - the name of its licence file,
// the title of the licence in a header, which of the policy's holders a notice
// names, the year, a URL, the notices that must not survive - and the two
// derivations every surface needs: the own expression for a path
// (##ORGANIZATION-OWN-SCOPES) and the header fields for a generated or
// annotated file (##HEADER-FROM-PROFILE).
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8Strict } from './bytes.js';
import { readContainedFile } from './containedFile.js';
import { NOTICE_OWN_PATH } from './licenceNotice.js';
import { ckError } from './messages.js';
import { organizationOwnLicense } from './organizationPolicy.js';
import { organizationPolicyRoot, readOrganizationPolicy } from './organizationPolicyStore.js';
import { OWN_MANIFEST_PATH } from './layers/ownManifest.js';
import { OWN_ROOTS_DIR } from './ownedRoots.js';
import { RELEASE_LICENSING_FILE, licensingDeclarationSchema } from './releaseLicensing.js';
/** The licence file a product gets when its declaration names none (##LICENSING-DECLARATION-V2). */
export const DEFAULT_LICENCE_FILE = 'LICENSE.md';
/** The own layer of the patch set; everything under it but the tool's own paths is the product's. */
export const OWN_LAYER_DIR = 'delta/own';
/** The directory the tool delivers its runtime library and its notice into; never the product's to annotate. */
export const CODKIT_DELIVERED_DIR = `${OWN_LAYER_DIR}/codkit`;
/**
 * ##LICENSING-DECLARATION-V2: the declaration of the patch set, either version,
 * or null when the patch set carries none. A declaration that does not parse
 * is `CK-E-CONFIG`: a product that wrote one wants it read.
 */
export function readLicensingDeclaration(patchesDir) {
    const read = readContainedFile(patchesDir, RELEASE_LICENSING_FILE, { what: 'licensing declaration' });
    if (read.state === 'absent')
        return null;
    const text = decodeUtf8Strict(read.bytes);
    if (text === null)
        throw ckError('CONFIG', `${RELEASE_LICENSING_FILE} is not UTF-8`, 'write the declaration as UTF-8 JSON', RELEASE_LICENSING_FILE);
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw ckError('CONFIG', `${RELEASE_LICENSING_FILE} is not JSON`, 'fix the declaration', RELEASE_LICENSING_FILE);
    }
    const parsed = licensingDeclarationSchema.safeParse(raw);
    if (!parsed.success) {
        const where = parsed.error.issues[0]?.path.join('.') || 'document';
        throw ckError('CONFIG', `${RELEASE_LICENSING_FILE} is invalid at ${where}`, 'the declaration selects a profile and may add a product block of display choices; see PROP-019 LICENSING-DECLARATION-V2', RELEASE_LICENSING_FILE);
    }
    return { declaration: parsed.data, sha256: createHash('sha256').update(read.bytes).digest('hex') };
}
/**
 * ##ORGANIZATION-POLICY-TRUST: the profile the declaration selects, from the
 * store on the machine. The problems are the store's own words; the caller
 * decides whether they are a refusal or a finding (`verify`).
 */
export function selectLicensingProfile(patchesDir, read, trustedRoot = organizationPolicyRoot()) {
    const { declaration } = read;
    const selected = readOrganizationPolicy(trustedRoot, patchesDir, {
        profile: declaration.profile,
        ...(declaration.additionalForbidden === undefined ? {} : { additionalForbidden: declaration.additionalForbidden })
    });
    if (!selected.ok)
        return selected;
    const product = productOf(declaration, selected.value);
    if (!product.ok)
        return product;
    return { ok: true, value: { declaration, sha256: read.sha256, selected: selected.value, product: product.value } };
}
/**
 * The profile of the patch set, or null when it declares none. A declaration
 * the store does not approve is `CK-E-LICENSE-PROFILE`: the machine that runs
 * the command carries the policy, and no patch-set fallback exists.
 */
export function readLicensingProfile(patchesDir, trustedRoot = organizationPolicyRoot()) {
    const read = readLicensingDeclaration(patchesDir);
    if (read === null)
        return null;
    const selected = selectLicensingProfile(patchesDir, read, trustedRoot);
    if (!selected.ok) {
        throw ckError('LICENSE-PROFILE', `the licensing declaration selects the profile ${JSON.stringify(read.declaration.profile)}, which this machine does not carry: ${selected.problems.join('; ')}`, 'install the approved profile in ~/.codkit/organization-policies.json; the patch set cannot supply one', RELEASE_LICENSING_FILE);
    }
    return selected.value;
}
/** ##LICENSING-DECLARATION-V2: the product block with its defaults, checked against the policy. */
function productOf(declaration, selected) {
    const block = declaration.codkitReleaseLicensing === 2 ? declaration.product : undefined;
    const first = selected.policy.holders[0];
    if (first === undefined)
        return { ok: false, problems: ['the selected profile names no holder'] };
    const holder = block?.holder ?? first;
    if (!selected.policy.holders.includes(holder)) {
        return { ok: false, problems: [`the product block names the holder ${JSON.stringify(holder)}, which the profile does not list`] };
    }
    return {
        ok: true,
        value: {
            licenseFile: block?.licenseFile ?? DEFAULT_LICENCE_FILE,
            title: block?.title ?? null,
            holder,
            year: block?.year ?? String(new Date().getUTCFullYear()),
            url: block?.url ?? null,
            retiredNotices: block?.retiredNotices ?? []
        }
    };
}
/**
 * ##ORGANIZATION-OWN-SCOPES: the own expression for a path of the patch set.
 * A path the policy's scopes overlap on is a refusal of the policy, which is a
 * configuration problem of the run.
 */
export function ownLicenseFor(profile, path) {
    const resolved = organizationOwnLicense(profile.selected.policy, path);
    if (!resolved.ok) {
        throw ckError('CONFIG', `the profile cannot resolve the own licence of ${path}: ${resolved.problems.join('; ')}`, 'fix the own licence scopes of the profile', path);
    }
    return resolved.value;
}
/** ##HEADER-FROM-PROFILE: the header fields of one file, laid out in the given style. */
export function headerFieldsFor(profile, path, style) {
    const { product } = profile;
    return {
        holder: product.holder,
        license: ownLicenseFor(profile, path),
        year: product.year,
        style,
        ...(product.title === null ? {} : { title: product.title }),
        file: product.licenseFile
    };
}
/** The header style a type asks for its own files; `line` for a type without the licensing area. */
export function headerStyleOf(type) {
    return type?.licensing?.headerStyle ?? 'line';
}
/**
 * The paths of the own layers a product is answerable for, from the patch-set
 * root, sorted by bytes: everything under `delta/own/` but the tool's delivered
 * directory and the own manifest, the owned roots beside it, and the own
 * extensions of the type when it has them (##ANNOTATE-OWN, ##VERIFY-LICENSING).
 * Sidecars are returned too: the consumer check pairs them with their files.
 */
export function ownLayerPaths(patchesDir, type) {
    const roots = [OWN_LAYER_DIR, OWN_ROOTS_DIR];
    const extensions = type?.layers.ownExtensions?.deltaRoot;
    if (extensions !== undefined)
        roots.push(extensions);
    const excluded = new Set([OWN_MANIFEST_PATH, NOTICE_OWN_PATH]);
    const paths = [];
    for (const root of roots) {
        for (const path of walk(patchesDir, root)) {
            if (excluded.has(path) || path.startsWith(`${CODKIT_DELIVERED_DIR}/`))
                continue;
            paths.push(path);
        }
    }
    return paths.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}
/** Whether a path of the patch set belongs to the tool rather than to the product. */
export function isCodkitDelivered(path) {
    return path === NOTICE_OWN_PATH || path.startsWith(`${CODKIT_DELIVERED_DIR}/`);
}
function walk(patchesDir, directory) {
    let entries;
    try {
        entries = readdirSync(join(patchesDir, ...directory.split('/')), { withFileTypes: true });
    }
    catch {
        return [];
    }
    const result = [];
    for (const entry of entries) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory())
            result.push(...walk(patchesDir, path));
        else if (entry.isFile())
            result.push(path);
    }
    return result;
}
