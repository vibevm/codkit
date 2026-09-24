/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit publish - guarded network publication of one immutable patchset commit.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.ts';
import { CI_PROFILES } from '../lib/ciEngine.ts';
import type { CiProfile } from '../lib/ciEngine.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { runPublish } from '../lib/publish.ts';
import type { PublishResult } from '../lib/publish.ts';
import { parseAuthor, readMessageFile } from '../lib/publishRelease.ts';
import type { SquashRequest } from '../lib/publishRelease.ts';

const PROFILE = '--profile';
const RELEASE = '--release';
const BRANCH = '--branch';
const SQUASH = '--squash';
const AUTHOR = '--author';
const MESSAGE_FILE = '--message-file';
const SCRUB = '--scrub';
const BOT_CONFIRMATION = '--yes-i-am-publish-bot';

async function run(ctx: CommandContext): Promise<number> {
	if (ctx.args.length !== 1 || ctx.args[0] === undefined) {
		throw ckError(
			'CONFIG',
			'publish needs exactly one immutable patchset ref',
			'usage: codkit publish <patchset-ref> --yes-i-am-publish-bot'
		);
	}
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) ctx.out.warn(resolution.warning);
	const config = requireConfig(ctx.config);
	const result = await runPublish({
		patchesDir: ctx.patchesDir,
		resolution,
		config,
		type: requireProjectType(ctx),
		out: ctx.out,
		patchSetRef: ctx.args[0],
		profile: requireProfile(commandFlagValue(ctx.commandFlags, PROFILE)),
		release: commandFlagValue(ctx.commandFlags, RELEASE),
		confirmed: commandFlagGiven(ctx.commandFlags, BOT_CONFIRMATION),
		ci: ctx.flags.ci,
		verbose: ctx.flags.verbose,
		branch: commandFlagValue(ctx.commandFlags, BRANCH),
		squash: squashRequest(ctx),
		scrub: commandFlagGiven(ctx.commandFlags, SCRUB)
	});
	ctx.out.setData(dataOf(result));
	return result.exitCode;
}

/** ##PUBLISH-SQUASH: `--squash` takes both `--author` and `--message-file`, and they take it. */
function squashRequest(ctx: CommandContext): SquashRequest | null {
	const author = commandFlagValue(ctx.commandFlags, AUTHOR);
	const messageFile = commandFlagValue(ctx.commandFlags, MESSAGE_FILE);
	if (!commandFlagGiven(ctx.commandFlags, SQUASH)) {
		if (author !== null || messageFile !== null) {
			throw ckError('CONFIG', `${AUTHOR} and ${MESSAGE_FILE} belong to ${SQUASH}`, `add ${SQUASH}, or drop them`);
		}
		return null;
	}
	if (author === null || messageFile === null) {
		throw ckError(
			'CONFIG',
			`${SQUASH} needs ${AUTHOR} and ${MESSAGE_FILE}`,
			`example: ${SQUASH} ${AUTHOR} "Jane Doe <jane@example.org>" ${MESSAGE_FILE} release-message.txt`
		);
	}
	return { author: parseAuthor(author), message: readMessageFile(messageFile) };
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError('CONFIG', 'codkit.json was not found in the patchset root: publish needs pin and ref conventions');
	}
	return config;
}

function requireProfile(raw: string | null): CiProfile {
	if (raw === null) return 'verify';
	const profile = CI_PROFILES.find((known) => known === raw);
	if (profile === undefined) throw ckError('CONFIG', `unknown publish profile: ${raw}`, `${PROFILE} takes ${CI_PROFILES.join(' or ')}`);
	return profile;
}

function dataOf(result: PublishResult): JsonValue {
	return {
		status: result.status,
		patchSetSha: result.patchSetSha,
		pinTag: result.pinTag,
		tip: result.tip,
		branch: result.branch,
		tag: result.tag,
		observedBranch: result.observedBranch,
		observedTag: result.observedTag,
		pushedBranch: result.pushedBranch,
		pushedTag: result.pushedTag,
		profile: result.checks?.profile ?? null,
		steps: result.checks?.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })) ?? [],
		squash: result.squash === null ? null : { ...result.squash },
		scrub:
			result.scrub === null
				? null
				: {
						files: result.scrub.files.map((file) => ({ ...file })),
						excluded: [...result.scrub.excluded],
						leftovers: result.scrub.leftovers.map((leftover) => ({ ...leftover }))
					}
	};
}

export const publishCommand: CommandDefinition = {
	name: 'publish',
	summary: 'publish one checked immutable patchset commit through a leased release ref',
	configMode: 'load',
	maxArgs: 1,
	commandFlags: [PROFILE, RELEASE, BRANCH, SQUASH, AUTHOR, MESSAGE_FILE, SCRUB, BOT_CONFIRMATION],
	run
};
