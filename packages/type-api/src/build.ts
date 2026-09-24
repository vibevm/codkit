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
	/** Target-owned environment discovery, evaluated immediately before spawn. */
	readonly environment?: (environment: Readonly<Record<string, string | undefined>>) => Readonly<Record<string, string>>;
};

export type PackageHost = 'win32' | 'linux' | 'darwin';

/** One closed package recipe owned by a project type. */
export type PackageTarget = {
	readonly id: string;
	readonly platform: 'windows' | 'linux' | 'macos';
	readonly arch: 'x64' | 'arm64' | 'armhf';
	readonly build: readonly BuildCommand[];
	/** Hosts on which the build commands run natively, in the fork tree. */
	readonly supportedHosts: readonly PackageHost[];
	/**
	 * Where the artifacts of this target land, as path patterns from the tree
	 * root read like `BuildArea.packageOutputs`; absent for a target whose
	 * packager writes beside the tree
	 * (`spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-TARGET-OUTPUTS`).
	 */
	readonly outputs?: readonly string[];
	/**
	 * The container route: on the hosts it names, the same build commands run
	 * in a container of the type's recipe over a read-only view of the tree
	 * (`spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-CONTAINER`).
	 */
	readonly container?: PackageContainer;
	/**
	 * Why a host with no route is refused and what to run there instead; without
	 * it the refusal names the hosts that have a route.
	 */
	readonly hostRefusal?: { readonly reason: string; readonly hint: string };
	/**
	 * What the build of this target downloads unless a pre-provisioned copy is
	 * given, computed from the tree it builds
	 * (`spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-INPUTS`).
	 */
	readonly inputs?: (treeDir: string) => readonly PackageInput[];
};

/** The container a target is built in on a host that cannot build it natively. */
export type PackageContainer = {
	/** The hosts that take this route; none of them is a native host of the target. */
	readonly hosts: readonly PackageHost[];
	/**
	 * The absolute path of the recipe inside the type package: a directory with
	 * a `Dockerfile` whose entrypoint is the type's entry, and the files it copies.
	 */
	readonly recipe: string;
	/** Build arguments read from the tree: argument name to a tree-relative file whose first line is the value. */
	readonly treeArguments: Readonly<Record<string, string>>;
	/** Variables of codkit's environment the image build receives when they are set; their values are never printed. */
	readonly buildEnvironment: readonly string[];
	/** Variables, or `prefix*` patterns, of codkit's environment the container receives when they are set. */
	readonly runEnvironment: readonly string[];
};

/** Something a build downloads, and how the build is pointed at a pre-provisioned copy of it. */
export type PackageInput = {
	/** What it is, for the report. */
	readonly name: string;
	/** Where the build fetches it from when it is not provisioned. */
	readonly from: string;
	/** Its path inside the inputs directory, with `/` separators. */
	readonly path: string;
	readonly use: PackageInputUse;
};

export type PackageInputUse =
	/** The variable of the upstream that names its location gets the path of the copy. */
	| { readonly kind: 'environment'; readonly variable: string }
	/** The upstream fetches this address with `curl` on every run; the fetch answer serves it from the copy. */
	| { readonly kind: 'fetch'; readonly url: string }
	/** The upstream looks inside the directory this variable names; the run's own directory holds every entry of the copy. */
	| { readonly kind: 'directory'; readonly variable: string }
	/** A cache of the build inside the tree, at this tree-relative path; the copy replaces it. */
	| { readonly kind: 'tree'; readonly target: string };

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
	/** Closed target catalog; absent keeps the legacy single packageBuild answer. */
	readonly packageTargets?: readonly PackageTarget[];
	/** Target ids used by bare `codkit package`. */
	readonly defaultPackageTargets?: readonly string[];
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
	 * Paths inside the tree that the packaging above rewrites as a side effect
	 * of running - a manifest whose version it bumps, a generated file it
	 * refreshes - as the same kind of patterns as `packageOutputs`.
	 *
	 * They are not artifacts and nobody asked for them: they are bytes of the
	 * upstream that the packager edited in place, and after a package run they
	 * are what makes an otherwise clean tree dirty. `codkit package` returns
	 * exactly these paths to the tip of the loaded tree once the packaging is
	 * over, and `codkit status` names them as packaging residue rather than as
	 * work to extract (`spec://codkit/modules/codkit/PROP-016#TYPE-PACKAGE-SCRATCH`).
	 * A family whose packager writes nothing but its artifacts answers with an
	 * empty list.
	 */
	readonly packageScratch: readonly string[];
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
