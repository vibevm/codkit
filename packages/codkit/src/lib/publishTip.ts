/** @scope spec://codkit/modules/codkit/PROP-007#PUBLISH-FORMS */
// The tip `publish` delivers, in one of the three forms of PROP-007
// ##PUBLISH-FORMS: the checked history as it is, one squashed commit on the pin
// (##PUBLISH-SQUASH), or one squashed commit without a parent
// (##PUBLISH-ORPHAN) - the squashed tree scrubbed under --scrub
// (##PUBLISH-SCRUB). Every object is written into the disposable fork; nothing
// here pushes.

import { join } from 'node:path';
import type { ProjectType } from '@codkit/type-api';
import type { CodkitConfig, PublishConfig } from './configFile.ts';
import { loadConventions } from './conventionsFile.ts';
import type { Output } from './jsonOut.ts';
import { ckError } from './messages.ts';
import type { CkError } from './messages.ts';
import { reportScrub, scrubReleaseTree, squashCommit, treeOf } from './publishRelease.ts';
import type { ScrubReport, SquashRequest } from './publishRelease.ts';
import { scrubSettingsOf, vocabularySources } from './publishVocabulary.ts';

/** What `--squash` made of the checked history; `parent` is null under `--orphan`. */
export type PublishSquash = {
	readonly parent: string | null;
	readonly tree: string;
	readonly unsquashedTip: string;
	readonly author: string;
};

export type TipRequest = {
	/** The scratch root of the run; the release index and blobs go under it. */
	readonly workspaceRoot: string;
	/** The disposable fork that holds the checked history. */
	readonly treeDir: string;
	/** The snapshot of the published patchset commit. */
	readonly snapshotDir: string;
	readonly type: ProjectType;
	/** The configuration of the published patchset commit. */
	readonly config: CodkitConfig;
	readonly patchSetSha: string;
	/** The tip of the generated history the checks passed on. */
	readonly checkedTip: string;
	readonly squash: SquashRequest | null;
	/** Both dates of the squashed commit; null without `--squash`. */
	readonly squashDate: string | null;
	readonly orphan: boolean;
	readonly scrub: boolean;
	/** The joined `publish` section of the published commit and of this machine. */
	readonly publishConfig: PublishConfig | undefined;
	readonly exclude: readonly string[];
	readonly out: Output;
};

export type ShapedTip =
	| { readonly ok: true; readonly tip: string; readonly squash: PublishSquash | null; readonly scrub: ScrubReport | null }
	| { readonly ok: false; readonly status: 'scrub-failed'; readonly scrub: ScrubReport };

/** ##PUBLISH-ORPHAN: `--orphan` is a modifier of `--squash`; alone it is refused before any gate. */
export function orphanRefusal(): CkError {
	return ckError(
		'CONFIG',
		'--orphan needs --squash',
		'--orphan writes the squashed commit without a parent; add --squash with --author and --message-file'
	);
}

/**
 * The published tip in the form the flags ask for. Without `--squash` it is the
 * checked tip itself; with it, one commit over the tree the checked history ends
 * at - scrubbed under `--scrub` - on the pin, or without a parent under
 * `--orphan`. A scrub that leaves anything behind is reported and nothing is
 * committed.
 */
export function shapeTip(request: TipRequest): ShapedTip {
	if (request.squash === null || request.squashDate === null) {
		return { ok: true, tip: request.checkedTip, squash: null, scrub: null };
	}
	const scratchDir = join(request.workspaceRoot, 'release');
	let tree = treeOf(request.treeDir, request.checkedTip);
	let scrubReport: ScrubReport | null = null;
	if (request.scrub) {
		const scrubbed = scrubbedTree(request, scratchDir);
		scrubReport = scrubbed.report;
		if (scrubbed.report.leftovers.length > 0) return { ok: false, status: 'scrub-failed', scrub: scrubbed.report };
		tree = scrubbed.tree;
	}
	const parent = request.orphan ? null : request.config.pin.sha;
	const tip = squashCommit({ treeDir: request.treeDir, scratchDir, tree, parent, request: request.squash, date: request.squashDate });
	const author = `${request.squash.author.name} <${request.squash.author.email}>`;
	const base = parent === null ? 'without a parent' : `on ${parent.slice(0, 12)}`;
	request.out.info(`squash: ${request.checkedTip.slice(0, 12)} -> ${tip.slice(0, 12)} ${base} (tree ${tree.slice(0, 12)})`);
	return { ok: true, tip, squash: { parent, tree, unsquashedTip: request.checkedTip, author }, scrub: scrubReport };
}

/** ##PUBLISH-SCRUB: the scrubbed release tree, every leftover reported as an error. */
function scrubbedTree(request: TipRequest, scratchDir: string): { readonly tree: string; readonly report: ScrubReport } {
	const learned = vocabularySources({
		snapshotDir: request.snapshotDir,
		type: request.type,
		config: request.config,
		patchSetSha: request.patchSetSha,
		settings: scrubSettingsOf(request.publishConfig?.scrub)
	});
	const configuredRoots = request.publishConfig?.scrub?.specRoots ?? [];
	for (const root of learned.missing.filter((entry) => configuredRoots.includes(entry))) {
		request.out.warn(`publish.scrub.specRoots entry ${root} names no directory of the published commit`);
	}
	const scrubbed = scrubReleaseTree({
		treeDir: request.treeDir,
		scratchDir,
		pinSha: request.config.pin.sha,
		tip: request.checkedTip,
		conventions: loadConventions(request.type, request.snapshotDir),
		exclude: request.exclude,
		references: learned.sources
	});
	reportScrub(request.out, scrubbed.report);
	for (const leftover of scrubbed.report.leftovers) {
		const where = `${leftover.path}${leftover.line === null ? ' (binary)' : `:${leftover.line}: ${leftover.text}`}`;
		request.out.addError(
			leftover.tokens.length === 0
				? {
						code: 'CONFIG',
						message: `the scrubbed release still carries tooling: ${where}`,
						hint: 'leave the file out through publish.exclude, or change it in the patch set; nothing was pushed'
					}
				: {
						code: 'CONFIG',
						message: `the scrubbed release still carries a reference (${leftover.tokens.join(', ')}): ${where}`,
						hint: 'reword the place in the patch set, or name the token in publish.scrub.allow if the release may carry it; nothing was pushed'
					}
		);
	}
	return scrubbed;
}
