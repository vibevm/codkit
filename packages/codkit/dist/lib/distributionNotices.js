/** @scope spec://codkit/modules/codkit/PROP-019#DISTRIBUTION-NOTICE-CHECK */
// Required notices must travel in the declared output bundle, not just exist in source.
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { z } from 'zod';
import { captureReleaseArtifacts } from './releaseArtifacts.js';
import { readContainedFile } from './containedFile.js';
import { decodeUtf8Strict } from './bytes.js';
import { repoRelativePathProblem } from './pathSafety.js';
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const path = z.string().refine((value) => repoRelativePathProblem(value) === null);
export const distributionNoticesSchema = z
    .strictObject({
    codkitDistributionNotices: z.literal(1),
    policy: z.strictObject({ id: z.string().min(1), version: z.number().int().positive(), sha256: digest }),
    artifactInventorySha256: digest,
    notices: z.array(z.strictObject({ id: z.string().min(1), path, sha256: digest, bytes: z.number().int().positive() })),
    problems: z.array(z.strictObject({ file: z.string(), message: z.string() })),
    status: z.enum(['complete', 'incomplete'])
})
    .superRefine((value, ctx) => {
    if (value.status !== (value.problems.length === 0 ? 'complete' : 'incomplete'))
        ctx.addIssue({ code: 'custom', path: ['status'], message: 'notice status must follow actual problems' });
    if (new Set(value.notices.map((notice) => notice.path)).size !== value.notices.length)
        ctx.addIssue({ code: 'custom', path: ['notices'], message: 'notice paths must not repeat' });
});
/** Directory outputs carry notices at their root; file outputs carry declared sibling notices. */
export function checkDistributionNotices(root, outputs, selected) {
    const problems = [];
    const notices = [];
    const policy = { id: selected.policy.id, version: selected.policy.version, sha256: selected.sha256 };
    const before = captureReleaseArtifacts(root, outputs);
    const inventory = before.ok ? before.value : [];
    const artifactInventorySha256 = hash(JSON.stringify(inventory));
    if (!before.ok)
        problems.push({ file: '.', message: before.problem.message });
    else {
        if (inventory.length === 0)
            problems.push({ file: '.', message: 'distribution has no declared output artifacts' });
        const required = selected.policy.distribution.requiredNotices;
        if (inventory.every((entry) => entry.kind === 'file' && required.includes(posix.basename(entry.path))))
            problems.push({ file: '.', message: 'distribution contains notices but no payload artifact' });
        const checked = new Set();
        for (const artifact of inventory) {
            // A separately delivered notice is metadata, not another payload needing a notice.
            if (artifact.kind === 'file' && required.includes(posix.basename(artifact.path)))
                continue;
            if (artifact.kind === 'git-commit' || artifact.kind === 'git-tree')
                continue;
            const base = artifact.kind === 'directory' ? artifact.path : posix.dirname(artifact.path);
            for (const id of required) {
                const relative = base === '.' ? id : `${base}/${id}`;
                if (checked.has(relative))
                    continue;
                checked.add(relative);
                const delivered = artifact.kind === 'directory' || inventory.some((entry) => entry.kind === 'file' && entry.path === relative);
                if (!delivered) {
                    problems.push({ file: relative, message: 'required notice is not included in declared distribution outputs' });
                    continue;
                }
                try {
                    const read = readContainedFile(root, relative, { what: 'distribution notice' });
                    if (read.state === 'absent')
                        throw new Error('required distribution notice is missing');
                    const text = decodeUtf8Strict(read.bytes);
                    if (text === null || text.trim() === '')
                        throw new Error('distribution notice must contain nonempty UTF-8 text');
                    notices.push({ id, path: relative, sha256: hash(read.bytes), bytes: read.bytes.byteLength });
                }
                catch (error) {
                    problems.push({ file: relative, message: error instanceof Error ? error.message : 'distribution notice read failed' });
                }
            }
        }
        // Re-observe all delivered bytes, so a notice cannot bind a stale output inventory.
        const after = captureReleaseArtifacts(root, outputs);
        if (!after.ok || JSON.stringify(after.value) !== JSON.stringify(inventory))
            problems.push({ file: '.', message: 'distribution outputs changed during notice inspection' });
        for (const notice of notices) {
            try {
                const read = readContainedFile(root, notice.path, { what: 'distribution notice confirmation' });
                if (read.state === 'absent' || hash(read.bytes) !== notice.sha256)
                    throw new Error('distribution notice changed during inspection');
            }
            catch (error) {
                problems.push({ file: notice.path, message: error instanceof Error ? error.message : 'distribution notice confirmation failed' });
            }
        }
    }
    return distributionNoticesSchema.parse({
        codkitDistributionNotices: 1,
        policy,
        artifactInventorySha256,
        notices: notices.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
        problems,
        status: problems.length === 0 ? 'complete' : 'incomplete'
    });
}
function hash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
