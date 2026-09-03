/** @scope spec://codkit/modules/codkit/PROP-008#renames */

import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { bytesEqual, decodeUtf8Strict } from './bytes.ts';
import { ckError } from './messages.ts';
import { resolveContainedPath } from './pathSafety.ts';
import { serializeCkpatch } from './patchFormat.ts';
import type { ParsedPatch } from './patchFormat.ts';
import {
	applyBoundRenameBatch,
	bindRenamePlans,
	resumeBoundRenameBatch,
	type BoundRenameBatch,
	type RenameTransactionRuntime
} from './renameTransaction.ts';
import { planPatchArtifactRename } from './renames.ts';
import type { PatchRenamePlan, RenameReferenceArea, RenameReferenceReplacement, UpstreamRename } from './renames.ts';

export { RENAME_COMPLETIONS_DIR, RENAME_TRANSACTION_PATH, RENAME_TRANSACTION_VERSION } from './renameTransaction.ts';
export type { ReplacementBinding } from './renameTransaction.ts';

export type RenamePatchArtifact = { readonly artifactPath: string; readonly patch: ParsedPatch };
export type ExplicitRenameReference = RenameReferenceReplacement & { readonly renameFrom: string };
export type RenameReviewCandidate = {
	readonly renameFrom: string;
	readonly renameTo: string;
	readonly area: RenameReferenceArea;
	readonly file: string;
	readonly matched: string;
	readonly reason: 'basename' | 'module-stem';
};
export type PatchRenameBatchPlan = BoundRenameBatch & {
	readonly candidates: readonly RenameReviewCandidate[];
	readonly needsReview: boolean;
};
export type BuildPatchRenameBatchOptions = {
	readonly patchesDir: string;
	readonly renames: readonly UpstreamRename[];
	readonly artifacts: readonly RenamePatchArtifact[];
	readonly contractTestPaths?: readonly string[];
	readonly ownPaths?: readonly string[];
	readonly explicitReferenceReplacements?: readonly ExplicitRenameReference[];
};
export type RenameApplyRuntime = RenameTransactionRuntime;
export type ApplyPatchRenameBatchOptions = {
	readonly patchesDir: string;
	readonly batch: PatchRenameBatchPlan;
	readonly reviewed?: boolean;
};
export type RenameApplyResult = {
	readonly completed: true;
	readonly operations: number;
	readonly resumed: boolean;
	readonly repeated: boolean;
};

export function buildPatchRenameBatch(options: BuildPatchRenameBatchOptions): PatchRenameBatchPlan {
	const files = [
		...scanFiles(options.patchesDir, options.contractTestPaths ?? [], 'contract-test'),
		...scanFiles(options.patchesDir, options.ownPaths ?? [], 'own-import')
	];
	const duplicateFile = duplicate(files.map((file) => file.path));
	if (duplicateFile !== null) throw broken(`declared reference file occurs more than once: ${duplicateFile}`);
	const artifacts = new Map<string, RenamePatchArtifact>();
	for (const artifact of options.artifacts) {
		if (artifacts.has(artifact.patch.targetPath)) throw broken(`multiple patch artifacts target ${artifact.patch.targetPath}`);
		const bytes = readRequired(options.patchesDir, artifact.artifactPath);
		if (!bytesEqual(bytes, serializeCkpatch(artifact.patch))) {
			throw broken(`parsed patch bytes no longer match ${artifact.artifactPath}`);
		}
		artifacts.set(artifact.patch.targetPath, artifact);
	}
	const explicit = groupExplicit(options.explicitReferenceReplacements ?? [], options.renames);
	const plans: PatchRenamePlan[] = [];
	const candidates: RenameReviewCandidate[] = [];
	const seenRename = new Set<string>();
	for (const rename of [...options.renames].sort((left, right) => compareText(left.from, right.from))) {
		if (seenRename.has(rename.from)) throw broken(`duplicate detected rename source: ${rename.from}`);
		seenRename.add(rename.from);
		const artifact = artifacts.get(rename.from);
		if (artifact === undefined) continue;
		const references: RenameReferenceReplacement[] = [];
		for (const file of files) {
			if (file.text.includes(rename.from)) {
				references.push({ area: file.area, file: file.path, from: rename.from, to: rename.to });
				continue;
			}
			const candidate = referenceCandidate(rename, file);
			if (candidate !== null) candidates.push(candidate);
		}
		references.push(...(explicit.get(rename.from) ?? []));
		const plan = planPatchArtifactRename({ rename, referenceReplacements: references });
		if (plan.oldArtifactPath !== artifact.artifactPath) {
			throw broken(`patch artifact path ${artifact.artifactPath} does not match target ${rename.from}`);
		}
		plans.push(plan);
	}
	for (const renameFrom of explicit.keys()) {
		if (!plans.some((plan) => plan.fromTarget === renameFrom)) {
			throw broken(`explicit reference names a rename without a patch artifact: ${renameFrom}`);
		}
	}
	const bound = bindRenamePlans(options.patchesDir, plans);
	return { plans, ...bound, candidates, needsReview: plans.some((plan) => plan.needsReview) || candidates.length > 0 };
}

/**
 * Apply under the caller's common cycle lock. The engine rechecks a bound
 * preimage immediately before replacement, while the lock closes the final
 * compare/rename race against another codkit writer.
 */
export function applyPatchRenameBatch(options: ApplyPatchRenameBatchOptions, runtime: RenameApplyRuntime = {}): RenameApplyResult {
	validateReview(options.batch, options.reviewed);
	return applyBoundRenameBatch(options.patchesDir, executable(options.batch), runtime);
}

/** Resume under the same caller-held cycle lock and an independently rebuilt expected batch. */
export function resumePatchRenameTransaction(
	patchesDir: string,
	batch: PatchRenameBatchPlan,
	runtime: RenameApplyRuntime = {}
): RenameApplyResult {
	return resumeBoundRenameBatch(patchesDir, executable(batch), runtime);
}

function executable(batch: PatchRenameBatchPlan): BoundRenameBatch {
	return { plans: batch.plans, bindings: batch.bindings, modes: batch.modes };
}

function validateReview(batch: PatchRenameBatchPlan, reviewed: boolean | undefined): void {
	const needsReview = batch.plans.some((plan) => plan.needsReview) || batch.candidates.length > 0;
	if (batch.needsReview !== needsReview) throw broken('rename batch review flag disagrees with its plans and candidates');
	if (needsReview && reviewed !== true) throw broken('rename batch needs explicit review before filesystem changes');
}

type ScanFile = { readonly area: RenameReferenceArea; readonly path: string; readonly text: string };

function scanFiles(root: string, declared: readonly string[], area: RenameReferenceArea): readonly ScanFile[] {
	const paths = new Set<string>();
	for (const path of declared) {
		const stat = lstatSync(contained(root, path));
		if (stat.isDirectory()) walkDirectory(root, path, paths);
		else if (stat.isFile()) paths.add(path);
		else throw broken(`declared reference is not a regular file or directory: ${path}`);
	}
	return [...paths].sort().map((path) => {
		const text = decodeUtf8Strict(readRequired(root, path));
		if (text === null) {
			throw ckError('ENCODING', 'rename reference file is not valid UTF-8', 'remove it from the declared scan or repair it', path);
		}
		return { area, path, text };
	});
}

function walkDirectory(root: string, directory: string, out: Set<string>): void {
	for (const name of readdirSync(contained(root, directory)).sort()) {
		const path = posix.join(directory, name);
		const stat = lstatSync(contained(root, path));
		if (stat.isDirectory()) walkDirectory(root, path, out);
		else if (stat.isFile()) out.add(path);
	}
}

function referenceCandidate(rename: UpstreamRename, file: ScanFile): RenameReviewCandidate | null {
	const basename = posix.basename(rename.from);
	const dot = basename.lastIndexOf('.');
	const stem = dot > 0 ? basename.slice(0, dot) : basename;
	const match = file.text.includes(basename)
		? { matched: basename, reason: 'basename' as const }
		: file.text.includes(stem)
			? { matched: stem, reason: 'module-stem' as const }
			: null;
	return match === null ? null : { renameFrom: rename.from, renameTo: rename.to, area: file.area, file: file.path, ...match };
}

function groupExplicit(
	references: readonly ExplicitRenameReference[],
	renames: readonly UpstreamRename[]
): ReadonlyMap<string, readonly RenameReferenceReplacement[]> {
	const known = new Set(renames.map((rename) => rename.from));
	const grouped = new Map<string, RenameReferenceReplacement[]>();
	for (const { renameFrom, area, file, from, to } of references) {
		if (!known.has(renameFrom)) throw broken(`explicit reference names unknown rename source: ${renameFrom}`);
		const list = grouped.get(renameFrom) ?? [];
		list.push({ area, file, from, to });
		grouped.set(renameFrom, list);
	}
	return grouped;
}

function readRequired(root: string, path: string): Uint8Array {
	try {
		return readFileSync(contained(root, path));
	} catch (error) {
		throw broken(`cannot read ${path}: ${messageOf(error)}`);
	}
}

function contained(root: string, path: string): string {
	const result = resolveContainedPath(root, path);
	if (!result.ok) throw broken(`unsafe path ${path}: ${result.reason}`);
	return result.absolute;
}

function duplicate(values: readonly string[]): string | null {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) return value;
		seen.add(value);
	}
	return null;
}

function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function broken(reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `cannot apply patch rename: ${reason}`, 'review and repair the complete rename batch before retrying');
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
