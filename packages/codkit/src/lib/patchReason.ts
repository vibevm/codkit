/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Contract: PROP-007 CMD-MARKER-REASON; preserves the PROP-004 patch format.
// Scoped reason authoring; the fork and Git state are never write targets.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { matchesPatternList } from './conventionsFile.ts';
import type { Conventions } from './conventionsFile.ts';
import { ckError } from './messages.ts';
import { encodePatchName, extractHeaderText, parseCkpatch, serializeCkpatch } from './patchFormat.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import { loadOwnerKeys } from './owners.ts';

const RequestSchema = z
	.object({
		target: z.string().min(1),
		expectedId: z.string().min(1),
		expectedHash: z.string().regex(/^[0-9a-f]{64}$/),
		reason: z
			.string()
			.min(1)
			.refine((value) => value.trim().length > 0 && !/[\r\n\0]/.test(value)),
		dryRun: z.boolean()
	})
	.strict();
export type PatchReasonRequest = z.infer<typeof RequestSchema>;
export type PatchReasonResult = {
	readonly status: 'dry-run' | 'unchanged' | 'updated';
	readonly target: string;
	readonly artifact: string;
	readonly id: string;
	readonly beforeHash: string;
	readonly afterHash: string;
	readonly bodyHash: string;
	readonly preview: string | null;
};
const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Validate one current artifact and author only its reason through the normal writer. */
export function authorPatchReason(
	patchesDir: string,
	input: unknown,
	conventions: Conventions,
	beforeReplace?: () => void
): PatchReasonResult {
	const validation = RequestSchema.safeParse(input);
	if (!validation.success)
		throw ckError('CONFIG', 'invalid patch reason request', 'supply target, expected id/hash and a nonempty single-line reason');
	const request = validation.data;
	const problem = repoRelativePathProblem(request.target);
	if (problem !== null || matchesPatternList(request.target, conventions.forbiddenPatchTargets)) {
		throw ckError('ARTIFACT-BROKEN', 'patch reason target is not an admissible relative upstream path', 'select one existing patch target');
	}
	const artifact = 'delta/patches/' + encodePatchName(request.target);
	const options = { what: artifact, code: 'ARTIFACT-BROKEN' as const };
	const current = readContainedFile(patchesDir, artifact, options);
	if (current.state === 'absent')
		throw ckError('ARTIFACT-BROKEN', 'patch reason artifact is absent', 'select an existing patch artifact', artifact);
	const before = current.bytes;
	if (hash(before) !== request.expectedHash)
		throw ckError('ARTIFACT-BROKEN', 'patch reason current hash differs', 'review current bytes and retry with their exact hash', artifact);
	const parsed = parseCkpatch(before, conventions, artifact);
	const owners = loadOwnerKeys(patchesDir);
	if (
		parsed.targetPath !== request.target ||
		parsed.header.id !== request.expectedId ||
		parsed.header.layer === 'rewrite-rule' ||
		owners === null ||
		!owners.includes(parsed.header.owner)
	) {
		throw ckError(
			'ARTIFACT-BROKEN',
			'patch reason target/id/owner/layer mismatch',
			'review the exact existing artifact identity',
			artifact
		);
	}
	if (!Buffer.from(serializeCkpatch(parsed)).equals(Buffer.from(before)))
		throw ckError('ARTIFACT-BROKEN', 'patch reason round trip is not lossless', 'retain the artifact and report its format', artifact);
	const lines = parsed.header.lines.map((line) => (line.startsWith('# reason: ') ? '# reason: ' + request.reason : line));
	const after = serializeCkpatch({ ...parsed, header: { ...parsed.header, reason: request.reason, lines } });
	const next = parseCkpatch(after, conventions, artifact);
	const beforeBody = Buffer.from(before).subarray(Buffer.byteLength(extractHeaderText(parsed)));
	const afterBody = Buffer.from(after).subarray(Buffer.byteLength(extractHeaderText(next)));
	if (
		!beforeBody.equals(afterBody) ||
		next.header.reason !== request.reason ||
		next.targetPath !== parsed.targetPath ||
		next.header.id !== parsed.header.id ||
		JSON.stringify(next.header.lines.filter((line) => !line.startsWith('# reason: '))) !==
			JSON.stringify(parsed.header.lines.filter((line) => !line.startsWith('# reason: ')))
	) {
		throw ckError('ARTIFACT-BROKEN', 'patch reason preservation check failed', 'retain the artifact and report the serializer', artifact);
	}
	const result = {
		target: request.target,
		artifact,
		id: parsed.header.id,
		beforeHash: hash(before),
		afterHash: hash(after),
		bodyHash: hash(beforeBody),
		preview: request.dryRun ? Buffer.from(after).toString('utf8') : null
	};
	if (request.dryRun) return { ...result, status: 'dry-run' };
	if (Buffer.from(before).equals(Buffer.from(after))) return { ...result, status: 'unchanged' };
	writeContainedFileAtomic(patchesDir, artifact, {
		...options,
		bytes: after,
		afterOpen: () => {
			beforeReplace?.();
			const latest = readContainedFile(patchesDir, artifact, options);
			if (latest.state !== 'ok' || !Buffer.from(latest.bytes).equals(Buffer.from(before))) {
				throw ckError(
					'ARTIFACT-BROKEN',
					'patch reason changed before replacement',
					'retain concurrent bytes and retry after review',
					artifact
				);
			}
		}
	});
	return { ...result, status: 'updated' };
}
