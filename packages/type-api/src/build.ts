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
	/**
	 * The directories of the fork tree that hold installed dependencies, from
	 * the tree root. One family installs into a single `node_modules/`; another
	 * has a second install root beside it, and a third could have none at all.
	 *
	 * `ci --profile build` refuses when the npm receipt of any of them is
	 * missing, and `publish` carries exactly these directories into its
	 * disposable fork. The engine never installs them - the supply kit does
	 * (PROP-011) - so all it needs from the type is their names.
	 */
	readonly dependencyRoots: readonly string[];
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
	 * What turns the built application into the artifact the product ships -
	 * an installer, an archive, a signed bundle - or an empty list when this
	 * family has no such step or the patch set declared none.
	 *
	 * It is a separate answer from `packageBuild` because the two have different
	 * authors: the build above is the family's, this one is the product's, and
	 * `codkit package --skip-type-build` runs only this half over an application
	 * the watch channels already built. Which packager it is stays entirely in
	 * the patch set's own configuration; the engine only runs what it is given.
	 */
	readonly packageDistributable: readonly BuildCommand[];
	/**
	 * Environment variables the package build needs stamped, with the meaning of
	 * each; the engine fills them from the pin, the tree head, or the type's own
	 * answer, and a name the operator already exported keeps the operator's
	 * value (`spec://codkit/modules/codkit/PROP-016#TYPE-STAMPS-FILL-A-GAP`).
	 */
	readonly packageStamps: readonly BuildStamp[];
	/**
	 * Where a package build leaves its artifacts, as path patterns from the tree
	 * root: `codkit package` prints the ones that exist when the build is done.
	 *
	 * A pattern is matched segment by segment and `*` never crosses a `/`; a
	 * trailing `/` names a directory. The patterns stay inside the tree - a
	 * `..` segment is refused - so a family whose packager writes beside the
	 * managed tree rather than into it answers with an empty list rather than
	 * pointing the engine at a path it does not manage.
	 */
	readonly packageOutputs: readonly string[];
	/**
	 * The compile channels a run that names none starts: `codkit build up`
	 * without `--channel`, and the single pass of `ci --profile build`.
	 *
	 * It is an answer of the type and not a constant of the engine because the
	 * names belong to the family: one family transpiles and typechecks, another
	 * typechecks and bundles, and a third declares its channels in the patch
	 * set's own configuration. A name the profile does not declare is ignored,
	 * and a type that names none has every declared channel as its default -
	 * the engine never refuses the bare form of a command over a name it made up
	 * itself.
	 */
	readonly defaultChannels: readonly string[];
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

/**
 * One environment variable the packaging of the family reads, and where its
 * value comes from.
 *
 * Three of the sources are values of the run - the head of the tree and the two
 * halves of the pin - and the fourth is the type's own word: a channel, a
 * flavour, a build kind that belongs to the product and not to the pin it sits
 * on. The type answers it as a literal so that the engine keeps filling
 * environment names it does not understand (##TYPE-ENGINE-IS-BLIND) instead of
 * learning a fourth kind of value.
 */
export type BuildStamp =
	| {
			readonly name: string;
			/** Which value of the run fills it. */
			readonly source: 'tree-head' | 'pin-date' | 'pin-tag';
	  }
	| {
			readonly name: string;
			readonly source: 'literal';
			/** The value the type itself answers with, from its own configuration. */
			readonly value: string;
	  };
