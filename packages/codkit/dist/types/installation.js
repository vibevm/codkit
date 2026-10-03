/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-REGISTRY */
// Installation-owned approvals. A patch set cannot select or shadow this file.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { readContainedFile } from '../lib/containedFile.js';
import { ckError } from '../lib/messages.js';
import { repoRelativePathProblem } from '../lib/pathSafety.js';
export const TYPE_REGISTRY_VERSION = 1;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const fileSchema = z
    .object({
    path: z.string().refine((value) => repoRelativePathProblem(value) === null, 'must be a contained package path'),
    sha256: digest
})
    .strict();
const approvalSchema = z
    .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    package: z.string().regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/),
    version: z.string().min(1),
    contractVersion: z.number().int().positive(),
    manifestSha256: digest,
    integrityRoots: z
        .array(z.string().refine((value) => repoRelativePathProblem(value) === null, 'must be a contained package root'))
        .min(1),
    files: z.array(fileSchema).min(1)
})
    .strict();
const registrySchema = z.object({ codkitTypeRegistry: z.literal(TYPE_REGISTRY_VERSION), entries: z.array(approvalSchema).min(1) }).strict();
const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export function installationApprovals() {
    const read = readContainedFile(codkitRoot, 'config/type-registry.json', { what: 'installation type registry' });
    if (read.state === 'absent')
        throw ckError('TYPE-UNKNOWN', 'installation type registry is missing', 'restore the approved Codkit installation');
    let raw;
    try {
        raw = JSON.parse(Buffer.from(read.bytes).toString('utf8'));
    }
    catch {
        throw ckError('TYPE-UNKNOWN', 'installation type registry is not valid JSON', 'restore the approved Codkit installation');
    }
    const parsed = registrySchema.safeParse(raw);
    if (!parsed.success)
        throw ckError('TYPE-UNKNOWN', `installation type registry is invalid: ${parsed.error.issues[0]?.message ?? 'invalid shape'}`, 'restore the approved Codkit installation');
    const ids = new Set();
    const packages = new Set();
    for (const entry of parsed.data.entries) {
        if (ids.has(entry.id) || packages.has(entry.package))
            throw ckError('TYPE-UNKNOWN', `duplicate installation type registration: ${entry.id} ${entry.package}`, 'restore a unique approved registry');
        ids.add(entry.id);
        packages.add(entry.package);
        const paths = new Set();
        for (const file of entry.files) {
            if (paths.has(file.path))
                throw ckError('TYPE-UNKNOWN', `duplicate integrity path for ${entry.package}: ${file.path}`, 'restore the approved registry');
            paths.add(file.path);
        }
    }
    return parsed.data.entries;
}
/** Resolve exact installed approvals only; no cwd, environment or patchset overlay. */
export function approvedPackage(id) {
    return installationApprovals().find((entry) => entry.id === id);
}
/** Lazy read keeps malformed registry refusal inside the CLI's JSON/error boundary. */
export class InstallationRegistry {
    snapshot() {
        return new Map(installationApprovals().map((entry) => [entry.id, entry.package]));
    }
    get size() {
        return this.snapshot().size;
    }
    get(key) {
        return this.snapshot().get(key);
    }
    has(key) {
        return this.snapshot().has(key);
    }
    entries() {
        return this.snapshot().entries();
    }
    keys() {
        return this.snapshot().keys();
    }
    values() {
        return this.snapshot().values();
    }
    [Symbol.iterator]() {
        return this.entries();
    }
    forEach(callback, thisArg) {
        for (const [key, value] of this.snapshot())
            callback.call(thisArg, value, key, this);
    }
}
