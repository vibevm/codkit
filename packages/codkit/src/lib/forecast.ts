/** @scope spec://codkit/modules/codkit/PROP-008#classify */
// Deterministic forecast projection over the generic read-only upgrade analysis.

import type { MergeFileRunner } from './classifyEngine.ts';
import type { Cause } from './cause.ts';
import type { CycleLayerReadRuntime } from './cycleClassifyLayers.ts';
import type { CodkitConfig, PinConfig } from './configFile.ts';
import { runGit } from './gitx.ts';
import { ckError } from './messages.ts';
import { analyzeUpgrade } from './upgradeAnalysis.ts';
import type { UpgradeAnalysisCounts } from './upgradeAnalysis.ts';
import type { ProjectType } from '@codkit/type-api';

export const DEFAULT_FORECAST_REF = 'refs/remotes/upstream/main';

export type ForecastOptions = {
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly config: CodkitConfig;
	/** The project type of the patch set; the engines below are handed it. */
	readonly type: ProjectType;
	readonly ref?: string | null;
	readonly similarity?: number;
	readonly layerRuntime?: CycleLayerReadRuntime;
	readonly mergeFile?: MergeFileRunner;
};

export type ForecastArtifact = {
	readonly id: string;
	readonly artifact: string;
	readonly layer: string;
	readonly target: string;
	readonly outcome: Exclude<keyof UpgradeAnalysisCounts['byOutcome'], 'clean'>;
	readonly cause: Cause;
};

export type ForecastOwnerGroup = {
	readonly owner: string;
	readonly artifacts: readonly ForecastArtifact[];
};

export type ForecastReport = {
	readonly sourcePin: PinConfig;
	readonly ref: { readonly input: string; readonly sha: string; readonly usedDefault: boolean };
	readonly counts: UpgradeAnalysisCounts;
	readonly owners: readonly ForecastOwnerGroup[];
};

export type ForecastResult = { readonly exitCode: 0 | 1; readonly report: ForecastReport };

/** Resolve, freeze, analyze, and project one forecast without changing either repository. */
export function forecastUpgrade(options: ForecastOptions): ForecastResult {
	const input = options.ref ?? DEFAULT_FORECAST_REF;
	const sha = resolveForecastRef(options.treeDir, input);
	const analysis = analyzeUpgrade({
		patchesDir: options.patchesDir,
		treeDir: options.treeDir,
		config: options.config,
		type: options.type,
		newRef: sha,
		...(options.similarity === undefined ? {} : { similarity: options.similarity }),
		...(options.layerRuntime === undefined ? {} : { layerRuntime: options.layerRuntime }),
		...(options.mergeFile === undefined ? {} : { mergeFile: options.mergeFile })
	});
	const owners = analysis.owners.flatMap((group): readonly ForecastOwnerGroup[] => {
		const artifacts = analysis.artifacts
			.filter((artifact) => artifact.owner === group.owner && artifact.outcome !== 'clean')
			.map((artifact): ForecastArtifact => {
				if (artifact.cause === null || artifact.outcome === 'clean') {
					throw ckError('INTERNAL', `forecast lost the cause of ${artifact.artifactPath}`);
				}
				return {
					id: artifact.artifactId,
					artifact: artifact.artifactPath,
					layer: artifact.layer,
					target: artifact.targetPath,
					outcome: artifact.outcome,
					cause: artifact.cause
				};
			});
		return artifacts.length === 0 ? [] : [{ owner: group.owner, artifacts }];
	});
	return {
		exitCode: analysis.counts.nonClean === 0 ? 0 : 1,
		report: {
			sourcePin: { ...analysis.sourcePin },
			ref: { input, sha, usedDefault: options.ref === null || options.ref === undefined },
			counts: analysis.counts,
			owners
		}
	};
}

/** Freeze a user/default revision to one full commit SHA without fetching. */
export function resolveForecastRef(treeDir: string, ref: string): string {
	if (ref.trim() === '') {
		throw ckError('CONFIG', 'forecast --ref must not be empty', 'pass one local commit, tag, or branch name after --ref');
	}
	const resolved = runGit({ args: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], cwd: treeDir });
	const sha = resolved.stdout.trim();
	if (resolved.status !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
		throw ckError(
			'PIN-UNREACHABLE',
			`forecast ref ${ref} does not resolve to one local commit`,
			'fetch the ref outside codkit, then retry; forecast never reaches the network'
		);
	}
	return sha;
}
