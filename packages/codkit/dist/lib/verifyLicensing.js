/** @scope spec://codkit/modules/codkit/PROP-019#VERIFY-LICENSING */
// The licensing check of `verify` (##VERIFY-LICENSING): what a patch set that
// carries `codkit.licensing.json` has to prove on top of the integrity of its
// layers. Three questions, each with a code of its own:
//
//   * the profile. The store on the machine must approve what the declaration
//     selects (##ORGANIZATION-POLICY-TRUST): one `LICENSE-PROFILE` finding and
//     nothing more, because every later answer would be measured against a
//     profile nobody trusts. The machine that verifies carries the policy - the
//     CI machine included - and the patch set cannot supply one;
//   * the carriers. ##CONSUMER-LICENSE-CHECK over the own layers the product is
//     answerable for - the tool's delivered paths and the own manifest left out -
//     every problem a `LICENSE-HEADER` finding naming the file;
//   * the surfaces, for a type with the licensing area. The expectations of
//     ##GEN-LICENSING come from `licensingSurfaces`, the same computation the
//     writer uses, so the checker cannot drift from the writer; each disagreement
//     with what the patch set carries is a `LICENSE-SURFACE` finding naming the
//     surface and its artifact.
//
// Without a declaration nothing here speaks and `verify` is what it was. Like
// the rest of the engine the check reads and never writes: the patch set from
// its files, the tree only through its git objects at the pin.
import { addFileBodyOf } from './addFilePatch.js';
import { checkConsumerLicenses } from './consumerLicenseCheck.js';
import { readContainedFile } from './containedFile.js';
import { loadConventions } from './conventionsFile.js';
import { OVERLAYS_DIR, deepEqual, loadOverlays, overlayArtifactName } from './layers/overlay.js';
import { ownLayerPaths, readLicensingDeclaration, selectLicensingProfile } from './licensingProfile.js';
import { licensingSurfaces } from './licensingSurfaces.js';
import { isCkError } from './messages.js';
import { organizationPolicyRoot } from './organizationPolicyStore.js';
import { parseCkpatch } from './patchFormat.js';
import { RELEASE_LICENSING_FILE } from './releaseLicensing.js';
import { finding } from './verifyEngine.js';
/** The hint of the profile finding: the store is the machine's, never the patch set's. */
const PROFILE_HINT = 'install the approved profile in ~/.codkit/organization-policies.json on the machine that verifies - the CI machine included; the patch set cannot supply one';
/** The hint of every carrier finding. */
const HEADER_HINT = 'run codkit license annotate --own, or give the file a header or a .license sidecar naming a holder of the profile and its own licence';
/** The hint of a field no overlay sets: the writer serves both the first run and the update. */
const FIELD_HINT = 'run codkit gen licensing (or --update) to write the surfaces from the profile';
/** The hint of a file surface that is missing or stale: the update path rewrites exactly these artifacts. */
const UPDATE_HINT = 'run codkit gen licensing --update';
/** The hint of a missing guard. */
const GUARD_HINT = 'run codkit gen licensing';
/** What the contained reader is told it reads, for its own refusals. */
const WHAT = 'licence surface artifact';
/**
 * ##VERIFY-LICENSING: the three checks, in the order a reviewer needs them. A
 * profile the machine does not carry ends the check after its one finding.
 */
export function checkLicensing(options) {
    const read = readLicensingDeclaration(options.patchesDir);
    if (read === null) {
        return;
    }
    const selected = selectLicensingProfile(options.patchesDir, read, options.trustedRoot ?? organizationPolicyRoot());
    if (!selected.ok) {
        options.findings.push(finding('LICENSE-PROFILE', `the licensing declaration selects the profile ${JSON.stringify(read.declaration.profile)}, which this machine does not carry: ${selected.problems.join('; ')}`, PROFILE_HINT, RELEASE_LICENSING_FILE));
        return;
    }
    checkCarriers(options, selected.value);
    // A type without the area states no licence anywhere in the tree, so there is
    // no surface to compare; the carriers above are type-neutral and were checked.
    if (options.type.licensing !== undefined) {
        checkSurfaces(options, selected.value);
    }
}
/**
 * ##CONSUMER-LICENSE-CHECK over the own layers: the paths the product is
 * answerable for, judged with the authority of the selected profile and nothing
 * else.
 */
function checkCarriers(options, profile) {
    const report = checkConsumerLicenses(options.patchesDir, profile.selected, ownLayerPaths(options.patchesDir, options.type));
    for (const problem of report.problems) {
        options.findings.push(finding('LICENSE-HEADER', problem.message, HEADER_HINT, problem.file));
    }
}
/**
 * The surfaces of ##GEN-LICENSING, read back in the order the writer writes
 * them. A profile or a pin the surfaces cannot be computed from - no text for
 * the own licence, a target or an upstream licence file absent at the pin - is
 * one finding about the declaration: the product cannot have written what
 * cannot be described.
 */
function checkSurfaces(options, profile) {
    let surfaces;
    try {
        surfaces = licensingSurfaces({
            profile,
            type: options.type,
            config: options.config,
            patchesDir: options.patchesDir,
            treeDir: options.treeDir,
            toolRoot: options.toolRoot
        });
    }
    catch (error) {
        if (!isCkError(error) || error.code !== 'CONFIG') {
            throw error;
        }
        options.findings.push(finding('LICENSE-SURFACE', error.message, error.hint ?? FIELD_HINT, RELEASE_LICENSING_FILE));
        return;
    }
    const { findings, patchesDir } = options;
    const overlays = loadOverlays(patchesDir, options.type);
    for (const surface of surfaces.overlays) {
        checkFieldSurface(surface, overlays, findings);
    }
    const conventions = loadConventions(options.type, patchesDir);
    const body = (artifact) => addFileBodyAt(patchesDir, artifact, conventions);
    checkLicenceFile(surfaces, body, findings);
    for (const component of surfaces.components) {
        checkComponent(component, body, findings);
    }
    // The renderer owns the bytes of a rendering; what `verify` asks is that the
    // family's installers have a file to read at all.
    for (const rendering of surfaces.renderings) {
        if (!artifactPresent(patchesDir, rendering.artifact)) {
            findings.push(finding('LICENSE-SURFACE', `the rendering ${rendering.treePath} has no add-file patch`, UPDATE_HINT, rendering.artifact));
        }
    }
    checkGuard(patchesDir, surfaces, findings);
}
/**
 * ##VERIFY-LICENSING: every field is set by an overlay of its target to the
 * value the writer would write - or removed, for a `url` without `product.url`.
 * The comparison is structural, like the overlay engine's own; `expectUpstream`
 * is not compared here, because the drift check of the overlay layer owns it.
 */
function checkFieldSurface(surface, overlays, findings) {
    const ofTarget = overlays.filter((overlay) => overlay.target === surface.target);
    // The finding names the artifact a person opens: the overlay of the target
    // when there is one, else the file a scaffold would give it.
    const file = ofTarget[0]?.artifactPath ?? `${OVERLAYS_DIR}/${overlayArtifactName(surface.target)}`;
    for (const expected of surface.operations) {
        if (ofTarget.some((overlay) => overlay.operations.some((actual) => sameOperation(expected, actual)))) {
            continue;
        }
        const wanted = expected.op === 'remove' ? 'removed' : `set to ${JSON.stringify(expected.value)}`;
        findings.push(finding('LICENSE-SURFACE', `the licence field ${surface.target}:${expected.path.join('.')} is not ${wanted} by an overlay of the target`, FIELD_HINT, file));
    }
}
/** The same operation: the op and the path always, the value unless the operation removes. */
function sameOperation(expected, actual) {
    if (expected.op !== actual.op || !deepEqual([...expected.path], [...actual.path])) {
        return false;
    }
    return expected.op === 'remove' || deepEqual(expected.value, actual.value);
}
/** ##VERIFY-LICENSING: the licence file's patch exists and its body is the canonical text of the own expression. */
function checkLicenceFile(surfaces, body, findings) {
    const { licenceFile } = surfaces;
    const found = body(licenceFile.artifact);
    if (found.state === 'absent') {
        findings.push(finding('LICENSE-SURFACE', `the licence file ${licenceFile.treePath} has no add-file patch`, UPDATE_HINT, licenceFile.artifact));
        return;
    }
    if (found.body !== licenceFile.text) {
        findings.push(finding('LICENSE-SURFACE', `the add-file patch of ${licenceFile.treePath} does not carry the canonical text of ${surfaces.expression}`, UPDATE_HINT, licenceFile.artifact));
    }
}
/** ##VERIFY-LICENSING: a component licence is declared by an add-file patch carrying the component's text byte for byte. */
function checkComponent(component, body, findings) {
    const found = body(component.artifact);
    if (found.state === 'absent') {
        findings.push(finding('LICENSE-SURFACE', `the component licence ${component.treePath} of ${component.component} has no add-file patch`, UPDATE_HINT, component.artifact));
        return;
    }
    if (found.body !== component.text) {
        findings.push(finding('LICENSE-SURFACE', `the add-file patch of ${component.treePath} does not carry the licence text of the component ${component.component}`, UPDATE_HINT, component.artifact));
    }
}
/**
 * ##LICENCE-GUARD: the guard is written at the type's path. Its content is the
 * renderer's, and whether its suite covers the surfaces is the guard check's
 * question, asked of every record alike.
 */
function checkGuard(patchesDir, surfaces, findings) {
    if (artifactPresent(patchesDir, surfaces.guard.artifact)) {
        return;
    }
    findings.push(finding('LICENSE-SURFACE', `the licence guard ${surfaces.guard.artifact} is not written`, GUARD_HINT, surfaces.guard.artifact));
}
/**
 * The content an add-file patch of the patch set creates. A patch that does not
 * parse, or one over an existing file, creates no such content: the loader of
 * `verify` has already raised the first, and both read as a body that is not
 * the expected one - what the surface needs is simply not there.
 */
function addFileBodyAt(patchesDir, artifact, conventions) {
    const read = readContainedFile(patchesDir, artifact, { what: WHAT });
    if (read.state === 'absent') {
        return { state: 'absent' };
    }
    try {
        return { state: 'present', body: addFileBodyOf(parseCkpatch(read.bytes, conventions, artifact)) };
    }
    catch (error) {
        if (!isCkError(error)) {
            throw error;
        }
        return { state: 'present', body: null };
    }
}
/** Whether the patch set carries the artifact at all; its bytes are somebody else's to judge. */
function artifactPresent(patchesDir, artifact) {
    return readContainedFile(patchesDir, artifact, { what: WHAT }).state !== 'absent';
}
