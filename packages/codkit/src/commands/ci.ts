/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit ci - the container run of the whole threshold.
// Contract: PROP-007 sec. 17 (the ci command); everything it does: PROP-011.
//
// One command is the whole job (PROP-011 sec. 1: one command is the job): the image carries Node, git
// and git-lfs, the job mounts patchset and the fork tree, and this runs. It always
// behaves as `--ci` whether or not the flag was typed - a container run has no
// person to ask and no network to use - and it holds the per-tree lock, because
// it rewrites the tree from scratch.
//
// The engine keeps the steps and their verdicts; this file is the flags, the
// lock and the envelope.

import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { commandFlagValue, forkResolution } from '../lib/command.ts';
import { CI_PROFILES, runCi } from '../lib/ciEngine.ts';
import type { CiProfile, CiResult } from '../lib/ciEngine.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { acquireLock } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';

const PROFILE = '--profile';
const EFFECTIVE_DIFF = '--effective-diff';
const PIN_GUARD_BASE = '--pin-guard-base';
const TIMEOUT = '--timeout';

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	const config = requireConfig(ctx.config);
	const profile = requireProfile(commandFlagValue(ctx.commandFlags, PROFILE));
	const passTimeoutMs = requireTimeout(commandFlagValue(ctx.commandFlags, TIMEOUT));

	// Not a reminder but the contract: nothing below ever passes netAllowed, so
	// every network subcommand is refused by gitx (PROP-011 sec. 2).
	ctx.out.info(`ci ${profile}: --ci is implied; codkit makes no network call in this run`);

	const handle = acquireLock(ctx.patchesDir, treeId(resolution.path), 'ci', (text) => {
		ctx.out.warn(text);
	});
	try {
		const result = await runCi({
			patchesDir: ctx.patchesDir,
			resolution,
			config,
			out: ctx.out,
			profile,
			effectiveDiffBase: commandFlagValue(ctx.commandFlags, EFFECTIVE_DIFF),
			pinGuardBase: commandFlagValue(ctx.commandFlags, PIN_GUARD_BASE),
			verbose: ctx.flags.verbose,
			...(passTimeoutMs === null ? {} : { passTimeoutMs })
		});
		ctx.out.setData(dataOf(result));
		return result.exitCode;
	} finally {
		handle.release();
	}
}

function dataOf(result: CiResult): JsonValue {
	const data: { [key: string]: JsonValue } = {
		profile: result.profile,
		steps: result.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })),
		branchTip: result.branchTip
	};
	if (result.effectiveDiff !== null) {
		const diff = result.effectiveDiff;
		data['effectiveDiff'] = {
			base: diff.base,
			baseSha: diff.baseSha,
			baseTip: diff.baseTip,
			tip: diff.tip,
			patch: diff.patchPath,
			inventoryDiff: diff.inventoryDiffPath,
			stat: diff.stat
		};
	}
	return data;
}

function requireProfile(raw: string | null): CiProfile {
	if (raw === null) {
		return 'verify';
	}
	const profile = CI_PROFILES.find((known) => known === raw);
	if (profile === undefined) {
		throw ckError('CONFIG', `unknown ci profile: ${raw}`, `${PROFILE} takes one of: ${CI_PROFILES.join(', ')} (default: verify)`);
	}
	return profile;
}

/** `--timeout <seconds>` for one compilation pass; null keeps the default. */
function requireTimeout(raw: string | null): number | null {
	if (raw === null) {
		return null;
	}
	if (!/^\d+$/.test(raw) || Number.parseInt(raw, 10) <= 0) {
		throw ckError('CONFIG', `${TIMEOUT} expects a positive number of seconds`, `usage: ${TIMEOUT} <seconds>`);
	}
	return Number.parseInt(raw, 10) * 1000;
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: ci needs the pin and the delta of this repository',
			'mount the patchset checkout into the container and run ci from it'
		);
	}
	return config;
}

export const ciCommand: CommandDefinition = {
	name: 'ci',
	summary: 'run the container threshold: fresh apply, verify, guards, and (with --profile build) one compilation pass',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [PROFILE, EFFECTIVE_DIFF, PIN_GUARD_BASE, TIMEOUT],
	run
};
