/** @scope spec://codkit/modules/codkit/PROP-018#COMPONENT-RELEASE-FACTS */
// Gather data from checked roots and declarations, without executing adapters.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { componentReleaseBodySchema, sealComponentRelease } from './componentRelease.js';
import { serializeBaseConfig } from './configFile.js';
import { disciplineOf } from './discipline.js';
import { runGit } from './gitx.js';
import { licensePolicySnapshot } from './licensePolicy.js';
import { captureReleaseArtifacts } from './releaseArtifacts.js';
export function captureComponentRelease(options) {
    try {
        if (!/^[0-9a-f]{40}$/.test(options.tip))
            return refuse('release tip must be a full commit ID');
        if (options.registration.manifest.id !== options.config.type)
            return refuse('release type declaration differs from the selected configuration');
        const recipe = z.json().safeParse(options.recipe);
        if (!recipe.success)
            return refuse('release recipe identity requires JSON data');
        if (options.patchsetCommit !== undefined && !/^[0-9a-f]{40}$/.test(options.patchsetCommit))
            return refuse('patchset release ref must be a full commit ID');
        const patchsetCommit = git(options.patchesDir, ['rev-parse', '--verify', `${options.patchsetCommit ?? 'HEAD'}^{commit}`]);
        if (options.expectedPatchsetCommit !== undefined && patchsetCommit !== options.expectedPatchsetCommit)
            return refuse('patchset commit changed during the release operation');
        const tip = git(options.forkDir, ['rev-parse', '--verify', `${options.tip}^{commit}`]);
        if (tip !== options.tip)
            return refuse('release tip must be an immutable full commit ID');
        const tree = git(options.forkDir, ['rev-parse', '--verify', `${tip}^{tree}`]);
        const upstream = git(options.forkDir, ['rev-parse', '--verify', `${options.config.pin.sha}^{commit}`]);
        const upstreamDate = git(options.forkDir, ['show', '-s', '--format=%cs', upstream]);
        if (upstream !== options.config.pin.sha || upstreamDate !== options.config.pin.date)
            return refuse('upstream revision or commit date differs from the release configuration');
        if (options.componentId === undefined && git(options.patchesDir, ['rev-parse', '--is-shallow-repository']) === 'true')
            return refuse('a shallow patchset requires an explicit component identifier');
        const roots = options.componentId === undefined ? git(options.patchesDir, ['rev-list', '--max-parents=0', patchsetCommit]).split('\n').sort() : [];
        const captured = captureReleaseArtifacts(options.forkDir, options.outputs);
        if (!captured.ok)
            return captured;
        const artifacts = componentReleaseBodySchema.shape.artifacts.parse([
            ...captured.value,
            { kind: 'git-commit', objectId: tip },
            { kind: 'git-tree', objectId: tree }
        ]);
        const generatedTip = options.generatedTip ?? tip;
        if (!/^[0-9a-f]{40}$/.test(generatedTip))
            return refuse('checked generated tip must be a full commit ID');
        const generatedTree = git(options.forkDir, ['rev-parse', '--verify', `${generatedTip}^{tree}`]);
        const dirty = options.operation === 'publish' && options.patchsetCommit !== undefined
            ? ''
            : git(options.patchesDir, ['status', '--porcelain', '--untracked-files=no']);
        const policy = licensePolicySnapshot();
        const requirements = ['artifact-inventory', 'patchset-clean', 'organization-policy', 'distribution-notices', 'sbom'];
        if (options.operation === 'package')
            requirements.push('package-artifacts');
        else
            requirements.push('delivery');
        const evidence = [{ requirement: 'artifact-inventory', reference: 'descriptor:artifacts', sha256: hash(JSON.stringify(artifacts)) }];
        if (dirty === '')
            evidence.push({ requirement: 'patchset-clean', reference: `git:${patchsetCommit}`, sha256: hash(patchsetCommit) });
        if (options.operation === 'package' && captured.value.length > 0)
            evidence.push({ requirement: 'package-artifacts', reference: 'descriptor:artifacts', sha256: hash(JSON.stringify(captured.value)) });
        const supplied = new Set(evidence.map((entry) => entry.requirement));
        const missing = requirements.filter((requirement) => !supplied.has(requirement));
        const manifest = options.registration.manifest;
        return sealComponentRelease({
            codkitComponentRelease: 1,
            componentId: options.componentId ?? `patchset:${hash(JSON.stringify(roots))}`,
            operation: options.operation,
            upstream: {
                revision: options.config.pin.sha,
                label: options.config.pin.tag,
                commitDate: options.config.pin.date,
                ...(options.config.pin.resolvedAt === undefined ? {} : { resolvedAt: options.config.pin.resolvedAt }),
                ...(options.config.pin.provenance === undefined ? {} : { provenance: options.config.pin.provenance })
            },
            patchset: { commit: patchsetCommit, configSha256: hash(serializeBaseConfig(options.config)) },
            type: {
                id: manifest.id,
                package: manifest.package,
                version: manifest.version,
                contractVersion: manifest.contractVersion,
                manifestSha256: options.registration.sha256
            },
            discipline: disciplineOf(options.config),
            generated: { tip: generatedTip, tree: generatedTree },
            artifacts,
            buildRecipeSha256: hash(JSON.stringify(recipe.data)),
            licensePolicies: [{ scope: 'codkit-supply', id: 'codkit-supply', version: policy.version, sha256: policy.sha256 }],
            distribution: { requirements, evidence, missing, status: missing.length === 0 ? 'complete' : 'incomplete' }
        });
    }
    catch (error) {
        return refuse(error instanceof Error ? error.message : 'release fact capture failed');
    }
}
function git(root, args) {
    const result = runGit({ cwd: root, args });
    if (result.status !== 0)
        throw new Error('cannot prove a release Git fact');
    return result.stdout.trim();
}
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
function refuse(message) {
    return { ok: false, problem: { kind: 'storage', message } };
}
