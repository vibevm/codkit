/** @scope spec://codkit/modules/codkit/PROP-021#ARTIFACT-CODEC */
// A representation seam over the existing v2 bytes; no new patch wire format.
import { createHash } from 'node:crypto';
import { parseCkpatch, serializeCkpatch } from './patchFormat.ts';
import type { ParsedPatch, PatchConventions } from './patchFormat.ts';
import { applyUnified } from './applyUnified.ts';
import { regeneratePatch } from './patchGenerate.ts';
import type { RegenerateOptions, RegenerateResult } from './patchGenerate.ts';
import { MINIMAL_DISCIPLINE } from './discipline.ts';
import { ckError, isCkError } from './messages.ts';
import type { CkError } from './messages.ts';

export const TEXT_PATCH_CODEC_ID = 'text-patch-v2';
export type ArtifactOperation = 'add' | 'modify' | 'delete' | 'move' | 'replace';
export type CodecProblem = {
	readonly kind: 'unsupported' | 'invalid' | 'stale';
	readonly message: string;
	readonly code?: string;
	readonly cause?: CkError;
};
export type CodecResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: CodecProblem };
export type ArtifactFile = { readonly targetPath: string; readonly exists: boolean; readonly bytes: Uint8Array };
export type ArtifactPlan = {
	readonly codecId: string;
	readonly targetPath: string;
	readonly operation: ArtifactOperation;
	readonly baseExists: boolean;
	readonly baseSha256: string;
	readonly resultSha256: string;
	readonly result: Uint8Array;
};
export type ArtifactMetadata = {
	readonly codecId: string;
	readonly id: string;
	readonly layer: string;
	readonly targets: readonly string[];
	readonly operations: readonly ArtifactOperation[];
	readonly hunks?: number;
	readonly contractTests: readonly string[];
};
export interface ArtifactCodec<Representation = ParsedPatch, ExtractOptions = RegenerateOptions, Extracted = RegenerateResult> {
	readonly id: string;
	readonly operations: readonly ArtifactOperation[];
	compatible(profile: string): boolean;
	decode(bytes: Uint8Array, conventions: PatchConventions, file: string): CodecResult<Representation>;
	identifyTargets(artifact: Representation): readonly string[];
	plan(artifact: Representation, base: ArtifactFile): CodecResult<ArtifactPlan>;
	apply(plan: ArtifactPlan, current: ArtifactFile): CodecResult<Uint8Array>;
	extract(options: ExtractOptions): CodecResult<Extracted>;
	fingerprint(artifact: Representation): string;
	inventory(artifact: Representation): ArtifactMetadata;
}

/** @example const codec = artifactCodec('text-patch-v2'); if (codec.ok) codec.value.compatible('minimal-intervention@1'); */
export function artifactCodec(id: string): CodecResult<ArtifactCodec> {
	return id === TEXT_PATCH_CODEC_ID
		? { ok: true, value: textPatchCodec }
		: failure('unsupported', `artifact codec is not registered: ${id}`);
}
const textPatchCodec: ArtifactCodec = Object.freeze<ArtifactCodec>({
	id: TEXT_PATCH_CODEC_ID,
	operations: ['add', 'modify'],
	compatible: (profile: string) => profile === MINIMAL_DISCIPLINE,
	decode: (bytes: Uint8Array, conventions: PatchConventions, file: string) => checked(() => parseCkpatch(bytes, conventions, file)),
	identifyTargets: (artifact: ParsedPatch) => [artifact.targetPath],
	plan: (artifact: ParsedPatch, base: ArtifactFile) => {
		if (base.targetPath !== artifact.targetPath) return failure('invalid', 'artifact target differs from plan target');
		if (artifact.isAddFile === base.exists) return failure('invalid', 'artifact add/modify operation differs from file existence');
		if (!base.exists && base.bytes.length !== 0) return failure('invalid', 'absent artifact base must have empty bytes');
		return checked(() => {
			const result = applyUnified(base.bytes, artifact);
			return {
				codecId: TEXT_PATCH_CODEC_ID,
				targetPath: artifact.targetPath,
				operation: artifact.isAddFile ? 'add' : 'modify',
				baseExists: base.exists,
				baseSha256: hash(base.bytes),
				resultSha256: hash(result),
				result: result.slice()
			};
		});
	},
	apply: (plan: ArtifactPlan, current: ArtifactFile) => {
		if (
			plan.codecId !== TEXT_PATCH_CODEC_ID ||
			plan.targetPath !== current.targetPath ||
			plan.baseExists !== current.exists ||
			plan.baseSha256 !== hash(current.bytes)
		)
			return failure('stale', 'artifact plan base/target custody changed');
		if (hash(plan.result) !== plan.resultSha256) return failure('stale', 'artifact plan output bytes changed');
		return { ok: true, value: plan.result.slice() };
	},
	extract: (options: RegenerateOptions) => checked(() => regeneratePatch(options)),
	fingerprint: (artifact: ParsedPatch) => hash(serializeCkpatch(artifact)),
	inventory: (artifact: ParsedPatch) => ({
		codecId: TEXT_PATCH_CODEC_ID,
		id: artifact.header.id,
		layer: artifact.header.layer,
		targets: [artifact.targetPath],
		operations: [artifact.isAddFile ? 'add' : 'modify'],
		hunks: artifact.hunks.length,
		contractTests: [...artifact.header.contractTests]
	})
});
function hash(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}
function failure<T>(kind: CodecProblem['kind'], message: string, code?: string): CodecResult<T> {
	return { ok: false, problem: { kind, message, ...(code === undefined ? {} : { code }) } };
}
function checked<T>(body: () => T): CodecResult<T> {
	try {
		return { ok: true, value: body() };
	} catch (error) {
		if (isCkError(error)) return { ok: false, problem: { kind: 'invalid', message: error.message, code: error.code, cause: error } };
		throw error;
	}
}
/** Legacy engine boundary retains original diagnostics while using typed codec results. */
export function decodeTextArtifact(bytes: Uint8Array, conventions: PatchConventions, file: string): ParsedPatch {
	const decoded = textPatchCodec.decode(bytes, conventions, file);
	if (decoded.ok) return decoded.value;
	if (decoded.problem.cause !== undefined) throw decoded.problem.cause;
	throw ckError('ARTIFACT-BROKEN', decoded.problem.message);
}
