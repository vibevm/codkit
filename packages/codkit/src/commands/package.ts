/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE */
// codkit package - build the product's distributable out of the managed tree.
// Contract: PROP-007 sec. 27 (##CMD-PACKAGE); the engine: lib/packageEngine.ts.
//
// This is the verb that was missing: `ci --profile build` ends at the compile
// channels and the tests, so the last step of a release - materialize the
// overlay targets, stamp what the family asks for, run the packager, put the
// tree back - was a sequence people typed by hand and got wrong at both ends.
//
// It is not a daemon, so it needs no wrapper of PROP-007 sec. 13: one
// synchronous command after another, their whole output printed, and
// `--timeout` bounding each of them - a target on its container route runs as
// one such command, `docker run` (##CMD-PACKAGE-CONTAINER). It holds the per-tree lock
// like every writing command, and it refuses over a dirty tree exactly as
// `load` does - there is no `--discard` here, because giving up somebody's
// edits is never a side effect of packaging.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_ENVIRONMENT, commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { withLock } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';
import { DEFAULT_CONTAINER_PREFIX, requireContainerPrefix } from '../lib/packageContainer.ts';
import { runPackageRelease } from '../lib/packageRelease.ts';
import type { PackageReleaseResult } from '../lib/packageRelease.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { checkTree } from '../lib/treeIdentity.ts';

const KEEP_OVERLAY = '--keep-overlay';
const SKIP_TYPE_BUILD = '--skip-type-build';
const TIMEOUT = '--timeout';
const INPUTS = '--inputs';
const CONTAINER_PREFIX = '--container-prefix';
const COMPONENT_ID = '--component-id';

async function run(ctx: CommandContext): Promise<number> {
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	const config = requireConfig(ctx.config);
	const componentId = commandFlagValue(ctx.commandFlags, COMPONENT_ID);
	const type = requireProjectType(ctx);
	const timeoutMs = requireTimeout(commandFlagValue(ctx.commandFlags, TIMEOUT));
	const inputsDir = requireInputsDir(commandFlagValue(ctx.commandFlags, INPUTS));
	const containerPrefix = requireContainerPrefix(commandFlagValue(ctx.commandFlags, CONTAINER_PREFIX) ?? DEFAULT_CONTAINER_PREFIX);

	const identity = checkTree(resolution, config, { mode: 'write', type });
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		return EXIT_ENVIRONMENT;
	}

	return withLock(
		ctx.patchesDir,
		treeId(resolution.path),
		'package',
		() => {
			const result = runPackageRelease({
				patchesDir: ctx.patchesDir,
				resolution,
				config,
				type,
				out: ctx.out,
				flags: {
					keepOverlay: commandFlagGiven(ctx.commandFlags, KEEP_OVERLAY),
					skipTypeBuild: commandFlagGiven(ctx.commandFlags, SKIP_TYPE_BUILD)
				},
				timeoutMs,
				targetSelector: ctx.args[0] ?? null,
				inputsDir,
				offline: ctx.flags.ci,
				containerPrefix,
				...(componentId === null ? {} : { componentId })
			});
			ctx.out.setData(dataOf(result));
			return result.exitCode;
		},
		(text) => {
			ctx.out.warn(text);
		}
	);
}

function dataOf(result: PackageReleaseResult): JsonValue {
	return {
		release: result.release === null ? null : { ...result.release, missing: [...result.release.missing] },
		steps: result.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })),
		materialized: [...result.materialized],
		restored: [...result.restored],
		scratchRestored: [...result.scratchRestored],
		stamps: { ...result.stamps },
		stampsFromEnvironment: [...result.stampsFromEnvironment],
		commands: [...result.commands],
		outputs: [...result.outputs],
		targets: [...result.targets],
		routes: result.routes.map((route) => ({ target: route.target, route: route.route, image: route.image, volume: route.volume })),
		inputs: result.inputs.map((input) => ({ name: input.name, path: input.path, from: input.from, state: input.state }))
	};
}

/** `--timeout <seconds>` for one packaging command; null leaves it unbounded. */
function requireTimeout(raw: string | null): number | null {
	if (raw === null) {
		return null;
	}
	if (!/^\d+$/u.test(raw) || Number.parseInt(raw, 10) <= 0) {
		throw ckError('CONFIG', `${TIMEOUT} expects a positive number of seconds`, `usage: ${TIMEOUT} <seconds>`);
	}
	return Number.parseInt(raw, 10) * 1000;
}

/** `--inputs <dir>`: an existing directory, as an absolute path; null without the flag. */
function requireInputsDir(raw: string | null): string | null {
	if (raw === null) {
		return null;
	}
	const path = resolve(raw);
	if (!existsSync(path) || !statSync(path).isDirectory()) {
		throw ckError('CONFIG', `${INPUTS} names no directory: ${path}`, `usage: ${INPUTS} <dir>, the directory of the pre-provisioned inputs`);
	}
	return path;
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: package needs the pin, the delta and the project type of this repository',
			'run package from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

export const packageCommand: CommandDefinition = {
	name: 'package',
	summary: 'build the distributable from the loaded tree and put the tree back',
	configMode: 'load',
	maxArgs: 1,
	commandFlags: [KEEP_OVERLAY, SKIP_TYPE_BUILD, TIMEOUT, INPUTS, CONTAINER_PREFIX, COMPONENT_ID],
	run
};
