/** @scope spec://codkit/modules/codkit/PROP-018#COMPONENT-RELEASE-PUBLISH */
// Bind checked and delivered Git objects without changing publish leases or trees.
import { createHash } from 'node:crypto';
import { sealComponentRelease, writeComponentRelease } from './componentRelease.ts';
import type { ComponentRelease } from './componentRelease.ts';
import { captureComponentRelease } from './releaseFacts.ts';
import { releaseTypeRegistration } from './packageRelease.ts';
import { runPublish } from './publish.ts';
import type { PublishOptions, PublishResult } from './publish.ts';
import { ckError } from './messages.ts';
import type { RegisteredManifest } from '../types/manifest.ts';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { runGit } from './gitx.ts';
import { checkReleaseLicensing, readSnapshotReleaseLicensing } from './releaseLicensing.ts';
import { writeExport } from './publishExport.ts';
import { Output } from './jsonOut.ts';

export type PublishReceiptOptions = PublishOptions & {
	readonly registration?: RegisteredManifest;
	readonly componentId?: string;
	readonly organizationPolicyDirectory?: string;
};
export type PublishReceiptResult = PublishResult & {
	readonly release: {
		readonly path: string;
		readonly sha256: string;
		readonly evidenceStatus: 'complete' | 'incomplete';
		readonly missing: readonly string[];
	} | null;
};

export async function runPublishReceipt(options: PublishReceiptOptions): Promise<PublishReceiptResult> {
	if (options.componentId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(options.componentId))
		throw ckError('CONFIG', 'component identifier must be one non-empty portable release identifier');
	const capture: { release: ComponentRelease | null } = { release: null };
	const result = await runPublish({
		...options,
		onPreparedRelease: (facts) => {
			options.onPreparedRelease?.(facts);
			const registration = options.registration ?? releaseTypeRegistration(facts.config.type);
			if (registration.manifest.id !== options.type.id)
				throw ckError('TYPE-UNKNOWN', 'publish type and selected snapshot declaration must agree');
			const licensing = readSnapshotReleaseLicensing(
				options.patchesDir,
				facts.snapshotDir,
				facts.patchsetCommit,
				options.organizationPolicyDirectory
			);
			const componentId = options.componentId ?? licensing?.declaration.componentId;
			if (licensing !== null && componentId !== licensing.declaration.componentId)
				throw ckError('CONFIG', 'component identifier differs from selected licensing declaration');
			let licenseEvidence;
			if (licensing !== null) {
				const inspection = mkdtempSync(join(facts.workspaceRoot, 'licensing-'));
				const delivered = join(inspection, 'delivered');
				const inspectionExport = writeExport({
					request: { kind: 'repository', path: delivered },
					forkDir: facts.forkDir,
					scratchDir: inspection,
					branchRef: `refs/heads/${facts.branch}`,
					tagRef: facts.tag === null ? null : `refs/tags/${facts.tag}`,
					tip: facts.tip,
					keepLfs: options.noLfs !== true,
					forkTree: options.resolution.path,
					pinSha: facts.config.pin.sha,
					out: new Output({
						command: 'publish',
						version: 'internal-inspection',
						jsonMode: true,
						streams: { writeOut: () => {}, writeErr: () => {} }
					})
				});
				if (inspectionExport.lfsObjects > 0 && runGit({ cwd: delivered, args: ['lfs', 'version'] }).status !== 0)
					throw ckError('CONFIG', 'git-lfs is required to inspect hydrated publish licensing artifacts');
				const paths = runGit({ cwd: delivered, args: ['ls-files', '-z'] });
				if (paths.status !== 0) throw ckError('CONFIG', 'cannot inspect delivered publish file inventory');
				licenseEvidence = checkReleaseLicensing({
					licensing,
					sourceTree: facts.forkDir,
					artifactRoot: delivered,
					outputs: paths.stdout.split('\0').filter((path) => path !== ''),
					operation: 'publish'
				});
				const confirmed = readSnapshotReleaseLicensing(
					options.patchesDir,
					facts.snapshotDir,
					facts.patchsetCommit,
					options.organizationPolicyDirectory
				);
				if (confirmed?.selected.storeSha256 !== licensing.selected.storeSha256)
					throw ckError('CONFIG', 'trusted organization store changed during publish inspection');
			}
			const release = captureComponentRelease({
				patchesDir: options.patchesDir,
				forkDir: facts.forkDir,
				config: facts.config,
				registration,
				operation: 'publish',
				tip: facts.tip,
				generatedTip: facts.generatedTip,
				patchsetCommit: facts.patchsetCommit,
				outputs: [],
				...(componentId === undefined ? {} : { componentId }),
				...(licenseEvidence === undefined ? {} : { licensing: licenseEvidence }),
				recipe: {
					operation: 'publish',
					profile: options.profile,
					squash: options.squash ?? null,
					orphan: options.orphan ?? false,
					scrub: options.scrub ?? false,
					noLfs: options.noLfs ?? false
				}
			});
			if (!release.ok) throw ckError('CONFIG', release.problem.message);
			capture.release = release.value;
		}
	});
	if (result.exitCode !== 0 || result.tip === null) return { ...result, release: null };
	const captured = capture.release;
	if (captured === null) throw ckError('INTERNAL', 'successful publish has no captured release inputs');
	// Record a historical successful delivery, not a promise that a mutable remote branch stays put.
	const delivery = {
		branch: result.branch,
		tag: result.tag,
		tip: result.tip,
		patchset: result.patchSetSha,
		destination: result.export === null ? 'remote' : result.export.kind
	};
	const { descriptorSha256, ...body } = captured;
	void descriptorSha256;
	const sealed = sealComponentRelease({
		...body,
		distribution: {
			...body.distribution,
			evidence: [
				...body.distribution.evidence,
				{
					requirement: 'delivery',
					reference: `git-ref:${result.branch}@${result.tip}`,
					sha256: createHash('sha256').update(JSON.stringify(delivery)).digest('hex')
				}
			],
			missing: body.distribution.missing.filter((requirement) => requirement !== 'delivery'),
			status: body.distribution.missing.some((requirement) => requirement !== 'delivery') ? 'incomplete' : 'complete'
		}
	});
	if (!sealed.ok) throw ckError('CONFIG', sealed.problem.message);
	const stored = writeComponentRelease(options.patchesDir, sealed.value);
	if (!stored.ok)
		throw ckError(
			'CONFIG',
			`delivery succeeded but descriptor recording failed: ${stored.problem.message}`,
			'repair the receipt store and retry the immutable publish operation'
		);
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
