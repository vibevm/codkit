/** @scope spec://codkit/modules/codkit/PROP-008#classify */
// Read-only patch classification for an upgrade from one pin to another.
//
// The work tree and index are deliberately absent from this module's model:
// source bytes come from git objects, exact patch application happens in
// memory, and the only files written are private merge-file scratch inputs.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUnified } from './applyUnified.ts';
import { bytesEqual, encodeUtf8 } from './bytes.ts';
import { runGit, runGitBytes } from './gitx.ts';
import { checkOverlay } from './layers/overlay.ts';
import type { Overlay, OverlayCheckReport } from './layers/overlay.ts';
import { countRuleMatches } from './layers/rule.ts';
import type { Rule, RuleMatchCount } from './layers/rule.ts';
import { ckError, isCkError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import type { ParsedPatch } from './patchFormat.ts';
import type { PatchLayer } from './patchFormat.ts';

/** Exact cycle-state vocabulary of PROP-008 ##OUTCOME-CLASS-NAMES. */
export const CLASSIFICATION_OUTCOMES = [
	'clean',
	'shifted',
	'merged',
	'conflict',
	'target-deleted',
	'target-renamed',
	'rule-broken',
	'contract-failed'
] as const;

export type ClassificationOutcome = (typeof CLASSIFICATION_OUTCOMES)[number];

export const PATCH_CLASSIFICATION_OUTCOMES = ['clean', 'shifted', 'merged', 'conflict', 'target-deleted'] as const;

export type PatchClassificationOutcome = (typeof PATCH_CLASSIFICATION_OUTCOMES)[number];

/** A parsed patch together with the patchset path that identifies the artifact. */
export type PatchClassificationArtifact = {
	readonly artifactPath: string;
	readonly patch: ParsedPatch;
};

/** Optional rename mapping around one patch; omission preserves the old API. */
export type PatchTargetMapping = {
	/** Path whose bytes are the patch base at oldPin. */
	readonly baseTargetPath?: string;
	/** Current path read at newRef and exposed in the result identity. */
	readonly newTargetPath?: string;
};

export type MappedPatchClassificationArtifact = PatchClassificationArtifact & PatchTargetMapping;

/** The three inputs retained for regeneration, diagnostics, and resolution. */
export type PatchClassificationMaterials = {
	/** Target bytes at `oldPin`. */
	readonly base: Uint8Array;
	/** False only for a genuine add-file base; empty bytes alone are ambiguous. */
	readonly baseExists: boolean;
	/** Target bytes at `newRef`. */
	readonly ours: Uint8Array;
	/** Whether the target path exists at `newRef`, independent of byte length. */
	readonly oursExists: boolean;
	/** `base` with the codkit patch applied exactly. */
	readonly theirs: Uint8Array;
};

type ClassificationIdentity = {
	readonly artifactPath: string;
	readonly artifactId: string;
	readonly targetPath: string;
};

export type AppliedPatchClassification = ClassificationIdentity & {
	readonly outcome: Exclude<PatchClassificationOutcome, 'target-deleted'>;
	/** Bytes to materialize or regenerate from; conflict outcomes contain diff3 markers. */
	readonly bytes: Uint8Array;
	readonly materials: PatchClassificationMaterials;
};

export type DeletedPatchClassification = ClassificationIdentity & {
	readonly outcome: 'target-deleted';
	readonly bytes: null;
	readonly materials: null;
};

export type PatchClassification = AppliedPatchClassification | DeletedPatchClassification;

export type MergeFileRequest = {
	/** Repository cwd used only to run the isolated git executable. */
	readonly treeDir: string;
	readonly targetPath: string;
	readonly ours: Uint8Array;
	readonly base: Uint8Array;
	readonly theirs: Uint8Array;
};

export type MergeFileResult = {
	readonly bytes: Uint8Array;
	readonly hasConflicts: boolean;
};

/** Injectable seam for tests or hosts that provide their own isolated git runner. */
export type MergeFileRunner = (request: MergeFileRequest) => MergeFileResult;

export type ClassifyPatchOptions = PatchTargetMapping & {
	readonly treeDir: string;
	readonly artifact: PatchClassificationArtifact;
	readonly oldPin: string;
	readonly newRef: string;
	readonly mergeFile?: MergeFileRunner;
};

export type ClassifyPatchesOptions = {
	readonly treeDir: string;
	readonly artifacts: readonly MappedPatchClassificationArtifact[];
	readonly oldPin: string;
	readonly newRef: string;
	readonly mergeFile?: MergeFileRunner;
};

/** All artifact kinds classified by the Phase 1 library aggregate. */
export type ClassificationArtifact =
	| ({ readonly kind: 'patch' } & MappedPatchClassificationArtifact)
	| { readonly kind: 'rule'; readonly rule: Rule }
	| { readonly kind: 'overlay'; readonly overlay: Overlay };

export type BatchPatchClassification = PatchClassification & {
	readonly kind: 'patch';
	readonly layer: PatchLayer;
};

export type RuleClassification = ClassificationIdentity & {
	readonly kind: 'rule';
	readonly layer: 'rewrite-rule';
	readonly outcome: 'clean' | 'rule-broken' | 'target-deleted';
	/** Exact bytes inspected at newRef; null only for target-deleted. */
	readonly targetBytes: Uint8Array | null;
	/** Existing rule counter result; null only for target-deleted. */
	readonly matches: RuleMatchCount | null;
	readonly expectedMatches: number;
};

export type OverlayClassification = ClassificationIdentity & {
	readonly kind: 'overlay';
	readonly layer: 'config-overlay';
	/** Overlay drift is the config-overlay form of the normative conflict class. */
	readonly outcome: 'clean' | 'conflict' | 'target-deleted';
	/** Exact target bytes inspected at newRef; null only for target-deleted. */
	readonly targetBytes: Uint8Array | null;
	/** Existing overlay checker report, including every drifted operation. */
	readonly report: OverlayCheckReport | null;
};

export type ArtifactClassification = BatchPatchClassification | RuleClassification | OverlayClassification;

export type ClassifyArtifactsOptions = {
	readonly treeDir: string;
	readonly artifacts: readonly ClassificationArtifact[];
	readonly oldPin: string;
	readonly newRef: string;
	readonly mergeFile?: MergeFileRunner;
};

/**
 * Classify one patch without changing refs, the index, or work-tree files.
 * A rename mapping separates the base path from the current path. Without one,
 * both default to the target carried by the parsed patch.
 */
export function classifyPatchArtifact(options: ClassifyPatchOptions): PatchClassification {
	const { artifact, treeDir, oldPin, newRef } = options;
	const targets = patchTargets(options);
	const identity: ClassificationIdentity = {
		artifactPath: artifact.artifactPath,
		artifactId: artifact.patch.header.id,
		targetPath: targets.current
	};

	assertCommit(treeDir, oldPin);
	const oldObject = blobAtRef(treeDir, oldPin, targets.base);
	const base = artifact.patch.isAddFile
		? requireAbsentAtOldPin(oldObject, oldPin, artifact, targets.base)
		: requireOldBytes(oldObject, oldPin, artifact, targets.base);

	assertCommit(treeDir, newRef);
	const newObject = blobAtRef(treeDir, newRef, targets.current);
	if (!artifact.patch.isAddFile && newObject === null) {
		return { ...identity, outcome: 'target-deleted', bytes: null, materials: null };
	}

	// Absence at both pins is the normal base/ours state of an add-file patch.
	// If upstream independently added the path, its actual bytes participate in
	// the same three-way merge against an empty base.
	const ours = newObject ?? new Uint8Array(0);
	const theirs = applyUnified(base, patchAtTarget(artifact.patch, targets.base));
	const materials: PatchClassificationMaterials = {
		base,
		baseExists: !artifact.patch.isAddFile,
		ours,
		oursExists: newObject !== null,
		theirs
	};

	if (bytesEqual(ours, base)) {
		return { ...identity, outcome: 'clean', bytes: theirs, materials };
	}

	const merged = (options.mergeFile ?? runMergeFile)({
		treeDir,
		targetPath: targets.current,
		ours,
		base,
		theirs
	});
	if (merged.hasConflicts) {
		return { ...identity, outcome: 'conflict', bytes: merged.bytes, materials };
	}

	return {
		...identity,
		outcome: appliesExactly(ours, patchAtTarget(artifact.patch, targets.current)) ? 'shifted' : 'merged',
		bytes: merged.bytes,
		materials
	};
}

/** Classify the complete input list, retaining conflicts as values and continuing. */
export function classifyPatchArtifacts(options: ClassifyPatchesOptions): readonly PatchClassification[] {
	return options.artifacts.map((artifact) =>
		classifyPatchArtifact({
			treeDir: options.treeDir,
			artifact,
			oldPin: options.oldPin,
			newRef: options.newRef,
			...(artifact.baseTargetPath === undefined ? {} : { baseTargetPath: artifact.baseTargetPath }),
			...(artifact.newTargetPath === undefined ? {} : { newTargetPath: artifact.newTargetPath }),
			...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
		})
	);
}

/**
 * Classify patches, rewrite rules, and overlays in input order. Conflicts,
 * rule mismatches, overlay drift, and deletions are values, so none of them
 * truncates the list. Invalid refs and unreadable objects remain loud failures.
 */
export function classifyArtifacts(options: ClassifyArtifactsOptions): readonly ArtifactClassification[] {
	assertCommit(options.treeDir, options.oldPin);
	assertCommit(options.treeDir, options.newRef);
	return options.artifacts.map((artifact) => {
		switch (artifact.kind) {
			case 'patch': {
				const classified = classifyPatchArtifact({
					treeDir: options.treeDir,
					artifact,
					oldPin: options.oldPin,
					newRef: options.newRef,
					...(artifact.baseTargetPath === undefined ? {} : { baseTargetPath: artifact.baseTargetPath }),
					...(artifact.newTargetPath === undefined ? {} : { newTargetPath: artifact.newTargetPath }),
					...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
				});
				return { ...classified, kind: 'patch', layer: artifact.patch.header.layer };
			}
			case 'rule':
				return classifyRule(options.treeDir, options.newRef, artifact.rule);
			case 'overlay':
				return classifyOverlay(options.treeDir, options.newRef, artifact.overlay);
		}
	});
}

/** Default `git merge-file -p --diff3` implementation over private scratch files. */
export const runMergeFile: MergeFileRunner = (request) => {
	const scratch = mkdtempSync(join(tmpdir(), 'codkit-classify-'));
	const oursPath = join(scratch, 'ours');
	const basePath = join(scratch, 'base');
	const theirsPath = join(scratch, 'theirs');
	try {
		writeFileSync(oursPath, request.ours);
		writeFileSync(basePath, request.base);
		writeFileSync(theirsPath, request.theirs);
		const result = runGit({
			args: ['merge-file', '-p', '--diff3', '-L', 'ours', '-L', 'base', '-L', 'theirs', oursPath, basePath, theirsPath],
			cwd: request.treeDir
		});
		// merge-file returns the number of conflicts, capped at 127. An error is
		// negative in git and reaches Node as a shell-style status above 127.
		if (result.status > 127) {
			throw ckError(
				'INTERNAL',
				`git merge-file failed for ${request.targetPath}: ${firstDiagnostic(result.stderr, result.stdout)}`,
				'check that git >= 2.40 is installed and re-run the classification'
			);
		}
		return { bytes: encodeUtf8(result.stdout), hasConflicts: result.status !== 0 };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
};

function appliesExactly(bytes: Uint8Array, patch: ParsedPatch): boolean {
	try {
		applyUnified(bytes, patch);
		return true;
	} catch (error) {
		if (isCkError(error)) {
			return false;
		}
		throw error;
	}
}

function assertCommit(treeDir: string, ref: string): void {
	const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd: treeDir });
	if (resolved.status !== 0) {
		throw ckError(
			'PIN-UNREACHABLE',
			`cannot classify patches because ref ${ref} is not reachable in the fork tree`,
			`fetch ${ref} into the fork tree outside codkit, then re-run the classification`
		);
	}
}

function requireOldBytes(
	object: Uint8Array | null,
	oldPin: string,
	artifact: PatchClassificationArtifact,
	baseTargetPath: string
): Uint8Array {
	if (object !== null) {
		return object;
	}
	throw ckError(
		'ARTIFACT-BROKEN',
		`${artifact.artifactPath}: ${baseTargetPath} does not exist at old pin ${oldPin}`,
		'the patch must be regenerated against a pin where its target exists',
		artifact.artifactPath
	);
}

function requireAbsentAtOldPin(
	object: Uint8Array | null,
	oldPin: string,
	artifact: PatchClassificationArtifact,
	baseTargetPath: string
): Uint8Array {
	if (object === null) {
		return new Uint8Array(0);
	}
	throw ckError(
		'ARTIFACT-BROKEN',
		`${artifact.artifactPath}: add-file target ${baseTargetPath} already exists at old pin ${oldPin}`,
		'the patch must be regenerated as an edit patch against the existing upstream file',
		artifact.artifactPath
	);
}

function patchTargets(options: ClassifyPatchOptions): { readonly base: string; readonly current: string } {
	const base = options.baseTargetPath ?? options.artifact.patch.targetPath;
	const current = options.newTargetPath ?? options.artifact.patch.targetPath;
	assertMappedTarget(base, 'baseTargetPath', options.artifact);
	assertMappedTarget(current, 'newTargetPath', options.artifact);
	return { base, current };
}

function assertMappedTarget(path: string, field: keyof PatchTargetMapping, artifact: PatchClassificationArtifact): void {
	const problem = repoRelativePathProblem(path);
	if (problem === null) {
		return;
	}
	throw ckError(
		'ARTIFACT-BROKEN',
		`${artifact.artifactPath}: ${field} ${JSON.stringify(path)} ${problem}`,
		'rename mappings must use canonical repository-relative POSIX file paths',
		artifact.artifactPath
	);
}

function patchAtTarget(patch: ParsedPatch, targetPath: string): ParsedPatch {
	return patch.targetPath === targetPath ? patch : { ...patch, targetPath };
}

function classifyRule(treeDir: string, newRef: string, rule: Rule): RuleClassification {
	const identity: ClassificationIdentity = {
		artifactPath: rule.artifactPath,
		artifactId: rule.id,
		targetPath: rule.target
	};
	const targetBytes = blobAtRef(treeDir, newRef, rule.target);
	if (targetBytes === null) {
		return {
			...identity,
			kind: 'rule',
			layer: 'rewrite-rule',
			outcome: 'target-deleted',
			targetBytes: null,
			matches: null,
			expectedMatches: rule.expectedMatches
		};
	}
	const matches = countRuleMatches(rule, targetBytes);
	return {
		...identity,
		kind: 'rule',
		layer: 'rewrite-rule',
		outcome: matches.total === rule.expectedMatches ? 'clean' : 'rule-broken',
		targetBytes,
		matches,
		expectedMatches: rule.expectedMatches
	};
}

function classifyOverlay(treeDir: string, newRef: string, overlay: Overlay): OverlayClassification {
	const identity: ClassificationIdentity = {
		artifactPath: overlay.artifactPath,
		artifactId: overlay.id,
		targetPath: overlay.target
	};
	const targetBytes = blobAtRef(treeDir, newRef, overlay.target);
	if (targetBytes === null) {
		return {
			...identity,
			kind: 'overlay',
			layer: 'config-overlay',
			outcome: 'target-deleted',
			targetBytes: null,
			report: null
		};
	}
	const report = checkOverlay(overlay, { treeDir, pinSha: newRef, pinOnly: true });
	return {
		...identity,
		kind: 'overlay',
		layer: 'config-overlay',
		outcome: report.drift.length === 0 ? 'clean' : 'conflict',
		targetBytes,
		report
	};
}

/**
 * Read one path through Git plumbing. ls-tree distinguishes a genuinely absent
 * path from a damaged/unreadable object; cat-file preserves blob stdout bytes.
 */
function blobAtRef(treeDir: string, ref: string, targetPath: string): Uint8Array | null {
	const listed = runGit({
		args: ['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', ref, '--', targetPath],
		cwd: treeDir
	});
	if (listed.status !== 0) {
		throw objectReadError(targetPath, ref, 'inspect the target', listed.status, listed.stderr, listed.stdout);
	}
	const records = listed.stdout.split('\0').filter((record) => record !== '');
	if (records.length === 0) {
		return null;
	}
	if (records.length !== 1) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot read ${targetPath} at ${ref}: git ls-tree returned ${records.length} entries for one literal path`,
			'check that the artifact target is one repository-relative file path',
			targetPath
		);
	}
	const record = records[0] ?? '';
	const tab = record.indexOf('\t');
	const fields = (tab === -1 ? record : record.slice(0, tab)).split(' ');
	const listedPath = tab === -1 ? '' : record.slice(tab + 1);
	const type = fields[1];
	const objectId = fields[2];
	if (listedPath !== targetPath || type !== 'blob' || objectId === undefined || !/^[0-9a-f]{40}$/i.test(objectId)) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`cannot read ${targetPath} at ${ref}: git ls-tree did not identify one blob at that exact path`,
			'the artifact target must be a regular file carried by the selected commit',
			targetPath
		);
	}

	const blob = runGitBytes({ args: ['cat-file', 'blob', objectId], cwd: treeDir });
	if (blob.status !== 0) {
		throw objectReadError(targetPath, ref, `read blob ${objectId}`, blob.status, blob.stderr, '');
	}
	return blob.stdout;
}

function objectReadError(targetPath: string, ref: string, action: string, status: number, stderr: string, stdout: string): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		`cannot ${action} ${targetPath} at ${ref}: ${firstDiagnostic(stderr, stdout)} (git exit ${status})`,
		'check the fork repository with git fsck and restore every object before classifying the upgrade',
		targetPath
	);
}

function firstDiagnostic(stderr: string, stdout: string): string {
	for (const text of [stderr, stdout]) {
		const line = text.trim().split('\n')[0];
		if (line !== undefined && line !== '') {
			return line;
		}
	}
	return 'git exited without a diagnostic';
}
