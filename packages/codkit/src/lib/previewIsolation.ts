/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW-ISOLATION */
// What keeps a preview out of the person's own profile, and what one run leaves
// behind. Contract: PROP-007 ##CMD-PREVIEW-ISOLATION, ##CMD-PREVIEW-RECORD.
//
// The state directory of a mode is `<patchesDir>/.codkit/preview/<mode>/`:
// runtime state of the patch set, bound to the tree like a daemon record. The
// recipe's two isolation directories must lie under it and both must be whole
// arguments of the launch; the check is the engine's precisely so that no type
// can forget it, and it refuses before anything is spawned. The record is one
// file inside the state directory, written after the spawn and rewritten by the
// next run of the same mode: a diagnostic, not custody.

import { spawn } from 'node:child_process';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { PreviewLaunch, PreviewRecipe, ProjectType } from '@codkit/type-api';
import { encodeUtf8 } from './bytes.ts';
import { writeContainedFileAtomic } from './containedFile.ts';
import { ckError } from './messages.ts';
import type { CkErrorPayload } from './messages.ts';
import { processInvocation } from './processInvocation.ts';

/** Where the state of every preview mode lives, from the patch set root. */
export const PREVIEW_DIR = '.codkit/preview';

/** The record one run leaves behind, inside the state directory of its mode. */
export const PREVIEW_RECORD_FILE = 'record.json';

export const PREVIEW_RECORD_SCHEMA_VERSION = 1;

/** `<patchesDir>/.codkit/preview/<mode>/`. */
export function previewStateDir(patchesDir: string, mode: string): string {
	return join(patchesDir, ...PREVIEW_DIR.split('/'), mode);
}

/** `<stateDir>/record.json`. */
export function previewRecordPath(stateDir: string): string {
	return join(stateDir, PREVIEW_RECORD_FILE);
}

/**
 * Why a recipe breaks the isolation rule, or null when it keeps it: both
 * directories lie under the state directory, and both are whole arguments of
 * the launch.
 */
export function isolationProblem(recipe: PreviewRecipe, stateDir: string): string | null {
	const root = resolve(stateDir);
	const directories = [
		['userDataDir', recipe.isolation.userDataDir],
		['extensionsDir', recipe.isolation.extensionsDir]
	] as const;
	for (const [name, directory] of directories) {
		if (directory === '') {
			return `the recipe names no ${name}`;
		}
		if (!liesUnder(directory, root)) {
			return `${name} ${directory} does not lie under the state directory ${stateDir}`;
		}
		if (!recipe.launch.args.includes(directory)) {
			return `${name} ${directory} is not a whole argument of the launch`;
		}
	}
	return null;
}

function liesUnder(path: string, root: string): boolean {
	const between = relative(root, resolve(path));
	return between !== '' && between !== '..' && !between.startsWith(`..${sep}`) && !isAbsolute(between);
}

/** The refusal of ##CMD-PREVIEW-ISOLATION; nothing was spawned when it is made. */
export function isolationRefusal(type: ProjectType, problem: string): CkErrorPayload {
	return {
		code: 'PREVIEW-ISOLATION',
		message: `the preview recipe of the project type ${type.id} breaks the isolation rule: ${problem}`,
		hint:
			'nothing was spawned; both isolation directories must lie under the state directory of the mode and be whole arguments ' +
			'of the launch - this is a defect of the type package'
	};
}

export type PreviewRecord = {
	readonly codkitPreview: number;
	readonly mode: string;
	readonly host: string;
	readonly pid: number;
	readonly startedAt: string;
	readonly treeId: string;
	readonly workspace: string | null;
	readonly artifact: string | null;
	readonly launch: { readonly command: string; readonly args: readonly string[] };
};

export function previewRecordBytes(record: PreviewRecord): Uint8Array {
	return encodeUtf8(`${JSON.stringify(record, null, 2)}\n`);
}

/** Write the record of a launch; the next run of the same mode rewrites it (##CMD-PREVIEW-RECORD). */
export function writePreviewRecord(patchesDir: string, mode: string, record: PreviewRecord): string {
	const path = previewRecordPath(previewStateDir(patchesDir, mode));
	writeContainedFileAtomic(patchesDir, `${PREVIEW_DIR}/${mode}/${PREVIEW_RECORD_FILE}`, { bytes: previewRecordBytes(record), what: path });
	return path;
}

export type SpawnedPreview = {
	readonly pid: number;
	/** Resolves with the exit code when the host exits, or null when it could not run to one. */
	readonly exited: Promise<number | null>;
};

/** The process seam: a test drives the plan without starting a host. */
export type PreviewSpawner = (launch: PreviewLaunch, cwd: string, wait: boolean) => SpawnedPreview;

/**
 * The one process of a preview: detached, with the tree as its working
 * directory and its stdio closed, so that it outlives the command that started
 * it on every platform - on Windows an attached child dies with codkit's job
 * object (PROP-010 ##DAEMON-WINDOWS-LAUNCH). Without `--wait` it is unreferenced
 * so that codkit returns at once; with it the child keeps the event loop alive
 * until it exits. A batch launcher is routed through the command interpreter the
 * way every command of the engine is (processInvocation).
 */
export function spawnPreviewHost(
	launch: PreviewLaunch,
	cwd: string,
	wait: boolean,
	env: Readonly<Record<string, string | undefined>> = process.env
): SpawnedPreview {
	const invocation = processInvocation(launch.command, launch.args);
	const child = spawn(invocation.command, [...invocation.args], {
		cwd,
		detached: true,
		stdio: 'ignore',
		env: { ...env, ...(launch.env ?? {}) },
		shell: false,
		windowsHide: true
	});
	const exited = new Promise<number | null>((settle) => {
		child.once('exit', (code) => settle(code));
		child.once('error', () => settle(null));
	});
	const pid = child.pid;
	if (pid === undefined) {
		throw ckError(
			'PREVIEW-HOST',
			`the host ${launch.command} could not be spawned`,
			'check that the resolved host is an executable this user may run; pass --host to name another'
		);
	}
	if (!wait) {
		child.unref();
	}
	return { pid, exited };
}
