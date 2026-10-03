/** @scope spec://codkit/modules/codkit/PROP-018#COMPONENT-RELEASE-PACKAGE */
// Release recording surrounds the existing packaging/restore transaction.
import { writeComponentRelease } from './componentRelease.js';
import { runPackage } from './packageEngine.js';
import { captureComponentRelease } from './releaseFacts.js';
import { runGit } from './gitx.js';
import { captureReleaseArtifacts } from './releaseArtifacts.js';
import { ckError } from './messages.js';
import { readTypeManifest } from '../types/manifest.js';
import { effectiveRegistry } from '../types/registry.js';
export function runPackageRelease(options) {
    const registration = options.registration ?? releaseTypeRegistration(options.config.type);
    if (registration.manifest.id !== options.type.id || options.type.id !== options.config.type)
        throw ckError('TYPE-UNKNOWN', 'package type, configuration and release declaration must agree');
    if (options.componentId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.componentId))
        throw ckError('CONFIG', 'component identifier must be one non-empty portable release identifier');
    if (options.componentId === undefined) {
        const shallow = runGit({ cwd: options.patchesDir, args: ['rev-parse', '--is-shallow-repository'] });
        if (shallow.status !== 0 || shallow.stdout.trim() === 'true')
            throw ckError('CONFIG', 'a shallow patchset requires --component-id for stable release identity');
    }
    const patchsetCommit = head(options.patchesDir);
    const tip = head(options.resolution.path);
    const capture = { release: null };
    const result = runPackage({
        ...options,
        onOutputs: (outputs) => {
            options.onOutputs?.(outputs);
            if (head(options.resolution.path) !== tip)
                throw ckError('CONFIG', 'package changed the checked generated commit; release evidence refuses');
            const release = captureComponentRelease({
                patchesDir: options.patchesDir,
                forkDir: options.resolution.path,
                config: options.config,
                registration,
                operation: 'package',
                tip,
                outputs: outputs.outputs,
                expectedPatchsetCommit: patchsetCommit,
                ...(options.componentId === undefined ? {} : { componentId: options.componentId }),
                recipe: {
                    operation: 'package',
                    commands: outputs.commands,
                    targets: outputs.targets,
                    stamps: outputs.stamps,
                    flags: options.flags,
                    offline: options.offline ?? false,
                    routes: outputs.routes.map((route) => ({ target: route.target, route: route.route, image: route.image }))
                }
            });
            if (!release.ok)
                throw ckError('CONFIG', release.problem.message);
            capture.release = release.value;
        }
    });
    if (result.exitCode !== 0)
        return { ...result, release: null };
    const captured = capture.release;
    if (captured === null)
        throw ckError('INTERNAL', 'successful package did not capture release inputs');
    // Recheck the delivered outputs: a declared output may overlap a restored source/scratch target.
    const finalArtifacts = captureReleaseArtifacts(options.resolution.path, result.outputs);
    if (!finalArtifacts.ok)
        throw ckError('CONFIG', finalArtifacts.problem.message);
    const observedArtifacts = captured.artifacts.filter((artifact) => artifact.kind !== 'git-commit' && artifact.kind !== 'git-tree');
    if (JSON.stringify(finalArtifacts.value) !== JSON.stringify(observedArtifacts))
        throw ckError('CONFIG', 'restoration changed declared package artifacts; no release descriptor was recorded');
    // Receipt publication follows successful restoration; no receipt claims a failed restore.
    const stored = writeComponentRelease(options.patchesDir, captured);
    if (!stored.ok)
        throw ckError('CONFIG', stored.problem.message);
    options.out.info(`release descriptor ${stored.value.path}; distribution evidence ${stored.value.release.distribution.status}`);
    return {
        ...result,
        release: {
            path: stored.value.path,
            sha256: stored.value.release.descriptorSha256,
            evidenceStatus: stored.value.release.distribution.status,
            missing: stored.value.release.distribution.missing
        }
    };
}
export function releaseTypeRegistration(id) {
    const packageName = effectiveRegistry().get(id);
    if (packageName === undefined)
        throw ckError('TYPE-UNKNOWN', 'release type has no trusted registration');
    return readTypeManifest(id, packageName);
}
function head(root) {
    const result = runGit({ cwd: root, args: ['rev-parse', '--verify', 'HEAD^{commit}'] });
    if (result.status !== 0 || !/^[0-9a-f]{40}$/.test(result.stdout.trim()))
        throw ckError('CONFIG', 'release root has no immutable HEAD commit');
    return result.stdout.trim();
}
