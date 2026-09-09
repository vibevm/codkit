/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-BUILD */
// Area 4 of the contract: build and test.
//
// `ci --profile build` is one universal skeleton (PROP-011); its steps call the
// answers below. The engine owns the order of the steps, the transactions and
// the reporting; the type owns which command each step runs and where the
// pass boundaries of a watch channel are.

/** One command a build step runs in the fork tree. */
export type BuildCommand = {
	/** What the step is called in the report. */
	readonly label: string;
	/** Executable name; `npm` is resolved to the platform's npm by the engine. */
	readonly command: 'npm' | (string & {});
	readonly args: readonly string[];
};

export type BuildArea = {
	/** Installing the tree's dependencies. */
	readonly install: readonly BuildCommand[];
	/** The hygiene and lint gates of the upstream, in the order they must run. */
	readonly hygiene: readonly BuildCommand[];
	/**
	 * Running the patch set's own tests inside the tree, or null when the family
	 * has no own-root test runner. The own root arrives as a tree-relative path.
	 */
	ownTests(ownRoot: string): BuildCommand | null;
	/** Building the distributable package, after the compile channels are clean. */
	readonly packageBuild: readonly BuildCommand[];
	/**
	 * Environment variables the package build needs stamped, with the meaning of
	 * each; the engine fills them from the pin and the tree head.
	 */
	readonly packageStamps: readonly BuildStamp[];
	/**
	 * The default pass-boundary profile of the watch channels, as a path inside
	 * the type package, or null when this family ships no file of its own. The
	 * engine reads and validates it exactly as it reads a profile a patch set
	 * declares for itself.
	 */
	readonly watchProfilePath: string | null;
	/**
	 * The same profile as data, for a type whose channels come from its own
	 * section of the configuration and can therefore not be a file it ships. The
	 * engine validates it with the same schema it applies to a file, and a
	 * refusal names the type rather than a path. A patch set's own profile still
	 * wins over both answers.
	 */
	readonly watchProfile?: unknown;
	/**
	 * Argv words that mean "somebody else's watcher is already running over this
	 * tree"; compared word by word, never as substrings.
	 */
	readonly foreignWatcherMarkers: readonly string[];
};

export type BuildStamp = {
	readonly name: string;
	/** Which value of the run fills it. */
	readonly source: 'tree-head' | 'pin-date' | 'pin-tag';
};
