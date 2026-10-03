/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-API-STABILITY */
// Read installed package data without importing an executable adapter.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { validateTypeManifest } from '@codkit/type-api';
import { readCodkitVersion } from '../lib/jsonOut.js';
import { ckError } from '../lib/messages.js';
import { approvedPackage } from './installation.js';
import { typeIntegrityProblems } from './integrity.js';
const packageSchema = z.object({ name: z.string(), version: z.string() });
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
/** Inspect a registration; the only arbitrary module path is an already-authorized test seam. */
export function readTypeManifest(id, packageName) {
    try {
        const seam = isAbsolute(packageName);
        const path = seam ? `${packageName}.manifest.json` : require.resolve(`${packageName}/type-manifest.json`);
        const bytes = readFileSync(path);
        const raw = JSON.parse(bytes.toString('utf8'));
        const identity = seam
            ? packageSchema.parse({ name: '@codkit/test-stub', version: '1.0.0' })
            : packageSchema.parse(JSON.parse(readFileSync(require.resolve(`${packageName}/package.json`), 'utf8')));
        const checked = validateTypeManifest(raw, {
            id,
            package: identity.name,
            version: identity.version,
            engineVersion: readCodkitVersion(codkitRoot)
        });
        if (!checked.ok)
            throw new Error(checked.problem.message);
        if (!seam && identity.name !== packageName)
            throw new Error(`registered package ${packageName} resolves to ${identity.name}`);
        if (!seam) {
            const approval = approvedPackage(id);
            if (approval === undefined ||
                approval.package !== packageName ||
                approval.version !== identity.version ||
                approval.contractVersion !== checked.manifest.contractVersion)
                throw new Error(`package identity is outside the installation approval: ${packageName}@${identity.version}`);
            const manifestSha256 = createHash('sha256').update(bytes).digest('hex');
            if (manifestSha256 !== approval.manifestSha256)
                throw new Error(`manifest integrity mismatch for ${packageName}`);
            const packageRoot = dirname(require.resolve(`${packageName}/package.json`));
            const problems = typeIntegrityProblems(packageRoot, approval);
            if (problems.length > 0)
                throw new Error(problems.join('; '));
        }
        return {
            manifest: checked.manifest,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            path,
            source: seam ? 'test-seam' : 'installation'
        };
    }
    catch (error) {
        throw ckError('TYPE-UNKNOWN', `${id} (${packageName}): ${error instanceof Error ? error.message : String(error)}`, 'restore a type package with a compatible declarative manifest; no adapter has been imported', 'codkit.json');
    }
}
