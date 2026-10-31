/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-PREVIEW */
// Area 11 of the contract: the preview (capability `preview`).
//
// `codkit preview` shows a person the product: it launches a host application
// with the loaded tree - an extension development host with the extension, a
// built editor, an application's backend - in a profile that is isolated from
// the person's own. The engine owns the isolation directories, the record of
// the launched process, the lock, the overlay materialization and the restore;
// the type owns the recipe: what prepares the tree, which executable is the
// family's default host, and the exact argv the host takes
// (##DECISION-PREVIEW-IS-A-CONTRACT-AREA). A type never spawns anything.

import type { BuildCommand } from './build.ts';

/**
 * What the engine hands the type for one launch. Every path is absolute and
 * already resolved: the engine found the host, created the state directory and
 * built the artifact when the mode asked for one.
 */
export type PreviewRequest = {
	/** The loaded fork tree. */
	readonly treeDir: string;
	/** One of `PreviewArea.modes`. */
	readonly mode: string;
	/** The host executable the engine resolved (flag, environment, configuration, family default). */
	readonly host: string;
	/** The isolated profile root of this mode under the patch set's runtime state. */
	readonly stateDir: string;
	/** The folder the host opens, or null for the host's default. */
	readonly workspaceDir: string | null;
	/** The distributable the engine built for a mode that needs one, else null. */
	readonly artifact: string | null;
};

/** The one process the engine spawns, detached, with the tree as its cwd. */
export type PreviewLaunch = {
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
};

/**
 * The two directories that keep a preview out of the person's own profile.
 * Both must lie under `PreviewRequest.stateDir` and both must appear in the
 * launch arguments; the engine refuses a recipe that breaks either rule before
 * it spawns anything (`spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW-ISOLATION`).
 */
export type PreviewIsolation = {
	readonly userDataDir: string;
	readonly extensionsDir: string;
};

export type PreviewRecipe = {
	/** Commands run in the tree before the launch, in order; empty when nothing has to be built. */
	readonly prepare: readonly BuildCommand[];
	/** Whether the engine builds the distributable (`packageBuild` then `packageDistributable`) and hands it over as `artifact`. */
	readonly needsArtifact: boolean;
	readonly launch: PreviewLaunch;
	readonly isolation: PreviewIsolation;
};

export type PreviewArea = {
	/** The modes a patch set may select, in the order they are listed to a person. */
	readonly modes: readonly string[];
	/** The mode a bare `codkit preview` runs. */
	readonly defaultMode: string;
	/** The executable name of the family's default host, found on PATH when nothing names one. */
	readonly defaultHost: string;
	/** The recipe of one launch; pure, and total over the declared modes. */
	recipe(request: PreviewRequest): PreviewRecipe;
};
