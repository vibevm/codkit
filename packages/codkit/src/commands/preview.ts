/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW */
// codkit preview - show a person the product: launch a host application over
// the loaded fork tree in a profile isolated from the person's own, and leave
// it running. Contract: PROP-007 sec. 29 (##CMD-PREVIEW); the engine:
// lib/previewEngine.ts.
//
// It is the owner's deliberate exception of 2026-11-01 to the tool's hands-off
// posture (PROP-016 ##DECISION-PREVIEW-IS-A-CONTRACT-AREA), for the family whose
// whole feedback loop is a host running the product. The verb needs the
// capability `preview` and refuses without it before anything else is asked
// (##TYPE-CAPABILITY-REFUSAL); the recipe is the type's, the run is the engine's.
//
// It holds the per-tree lock while it prepares and spawns, and releases it when
// the host is running: a preview is a person's session, not a daemon of the
// tree. `--wait` then blocks outside the lock until the host exits, and takes
// the lock once more to put the overlay targets back.
//
// The folder the host opens is `--workspace-dir`, not the `--workspace <dir>`
// the specification spells: `--workspace <name>` is the global flag that
// selects a registered worktree pair (##CLI-GLOBAL-FLAGS), parsed before any
// command flag, and a command cannot take it back.
// REVIEW: PROP-007 ##CMD-PREVIEW names the flag `--workspace <dir>`, which collides with the global `--workspace <name>`; `--workspace-dir` is the spelling until the specification settles it.

import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PreviewArea, ProjectType } from '@codkit/type-api';
import type { CommandContext, CommandDefinition } from '../lib/command.ts';
import { EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, commandFlagValue, forkResolution, requireProjectType } from '../lib/command.ts';
import type { CodkitConfig } from '../lib/configFile.ts';
import { treeId } from '../lib/fingerprint.ts';
import type { JsonValue } from '../lib/jsonOut.ts';
import { withLock } from '../lib/lock.ts';
import { ckError } from '../lib/messages.ts';
import { formatForkTreeLine } from '../lib/paths.ts';
import { preparePreview, requireMode, restorePreviewTargets } from '../lib/previewEngine.ts';
import type { PreviewOptions, PreviewResult } from '../lib/previewEngine.ts';
import { checkTree } from '../lib/treeIdentity.ts';
import { requireCapability } from '../types/capability.ts';

const MODE = '--mode';
const HOST = '--host';
const WORKSPACE_DIR = '--workspace-dir';
const NO_BUILD = '--no-build';
const CLEAN = '--clean';
const WAIT = '--wait';

async function run(ctx: CommandContext): Promise<number> {
	requireCapability(ctx.type, 'preview', 'preview');
	const resolution = forkResolution(ctx);
	ctx.out.setForkTree(resolution.path, resolution.source);
	ctx.out.info(formatForkTreeLine(resolution));
	if (resolution.warning !== null) {
		ctx.out.warn(resolution.warning);
	}

	const config = requireConfig(ctx.config);
	const type = requireProjectType(ctx);
	const area = requireArea(type);
	const mode = requireMode(area, type, commandFlagValue(ctx.commandFlags, MODE));
	const workspaceDir = requireWorkspaceDir(commandFlagValue(ctx.commandFlags, WORKSPACE_DIR));
	const wait = commandFlagGiven(ctx.commandFlags, WAIT);

	const identity = checkTree(resolution, config, { mode: 'write', type });
	if (identity.fatal !== null) {
		ctx.out.addError(identity.fatal.toPayload());
		return EXIT_ENVIRONMENT;
	}

	const options: PreviewOptions = {
		patchesDir: ctx.patchesDir,
		resolution,
		config,
		type,
		area,
		out: ctx.out,
		flags: {
			mode,
			host: commandFlagValue(ctx.commandFlags, HOST),
			workspaceDir,
			noBuild: commandFlagGiven(ctx.commandFlags, NO_BUILD),
			clean: commandFlagGiven(ctx.commandFlags, CLEAN),
			wait
		}
	};
	const id = treeId(resolution.path);
	const warn = (text: string): void => {
		ctx.out.warn(text);
	};

	// Steps 1-7 under the lock; the host is running when it is released.
	const prepared = withLock(ctx.patchesDir, id, 'preview', () => preparePreview(options), warn);
	if (prepared.exitCode !== EXIT_OK || prepared.spawned === null) {
		ctx.out.setData(dataOf(prepared));
		return prepared.exitCode;
	}
	printLaunched(ctx, prepared);
	if (!wait) {
		ctx.out.setData(dataOf(prepared));
		return EXIT_OK;
	}

	// Step 8 under `--wait`: the person's session, then the restore - under the
	// lock again, because it writes the tree. The host is never killed here;
	// closing it is the person's act (##CMD-PREVIEW-RECORD).
	ctx.out.info(`waiting for the host (pid ${prepared.spawned.pid}) to exit; closing it is yours to do`);
	const code = await prepared.spawned.exited;
	ctx.out.info(code === null ? 'the host did not run to an exit code' : `the host exited with code ${code}`);
	const finished = withLock(ctx.patchesDir, id, 'preview', () => restorePreviewTargets(options, prepared), warn);
	ctx.out.setData(dataOf(finished));
	return EXIT_OK;
}

/** What a person reads when the host is up: the mode, the host, the state directory and the record (##CMD-PREVIEW step 8). */
function printLaunched(ctx: CommandContext, result: PreviewResult): void {
	ctx.out.info(`preview mode: ${result.mode}`);
	ctx.out.info(`preview host: ${result.host ?? ''}`);
	ctx.out.info(`preview state: ${result.stateDir}`);
	if (result.record !== null) {
		ctx.out.info(`preview record: ${result.record.path} (pid ${result.record.pid}, started ${result.record.startedAt})`);
	}
}

function dataOf(result: PreviewResult): JsonValue {
	return {
		mode: result.mode,
		host: result.host,
		stateDir: result.stateDir,
		workspace: result.workspace,
		artifact: result.artifact,
		steps: result.steps.map((step) => ({ name: step.name, state: step.state, detail: step.detail })),
		materialized: [...result.materialized],
		restored: [...result.restored],
		launch: result.launch === null ? null : { command: result.launch.command, args: [...result.launch.args] },
		record: result.record === null ? null : { pid: result.record.pid, startedAt: result.record.startedAt, path: result.record.path }
	};
}

/** The preview area of a type that declares the capability; `projectTypeProblems` makes the pairing exact. */
function requireArea(type: ProjectType): PreviewArea {
	const area = type.preview;
	if (area === undefined) {
		throw ckError(
			'INTERNAL',
			`the project type ${type.id} declares the capability preview and answers no preview area`,
			'reinstall the type package at a version built against this codkit'
		);
	}
	return area;
}

/** `--workspace-dir <dir>`: an existing directory, as an absolute path; null without the flag. */
function requireWorkspaceDir(raw: string | null): string | null {
	if (raw === null) {
		return null;
	}
	const path = resolve(raw);
	if (!existsSync(path) || !statSync(path).isDirectory()) {
		throw ckError(
			'CONFIG',
			`${WORKSPACE_DIR} names no directory: ${path}`,
			`usage: ${WORKSPACE_DIR} <dir>, an existing folder the host opens`
		);
	}
	return path;
}

function requireConfig(config: CodkitConfig | null): CodkitConfig {
	if (config === null) {
		throw ckError(
			'CONFIG',
			'codkit.json was not found in the patchset root: preview needs the pin, the delta and the project type of this repository',
			'run preview from a patchset checkout that carries codkit.json'
		);
	}
	return config;
}

export const previewCommand: CommandDefinition = {
	name: 'preview',
	summary: 'launch a host over the loaded tree in an isolated profile and leave it running',
	configMode: 'load',
	maxArgs: 0,
	commandFlags: [MODE, HOST, WORKSPACE_DIR, NO_BUILD, CLEAN, WAIT],
	run
};
