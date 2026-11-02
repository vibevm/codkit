/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYERS */
// Area 3 of the contract: the layers whose shape a type decides.
//
// `own`, `patch`, `resource-file` and `rewrite-rule` are universal and always
// present, so they ask the type nothing. Four layers do ask: `config-overlay`
// wants its targets and its optional dev channel, `own-extension` wants its
// materializer, `service-override` wants its verifier and `entry-module` wants
// its locator. A layer the type does not provide is absent for that patch set,
// and `verify` refuses an artifact of it with `CK-E-TYPE-CAPABILITY`.

import type { PackageTarget } from './build.ts';

/** One JSON file an overlay may target, with the channels it has. */
export type OverlayTarget = {
	/** Path of the target file from the tree root, POSIX. */
	readonly path: string;
	/**
	 * The sidecar the running product reads instead of the target during
	 * development, or null when this target has no dev channel. Only a target
	 * with a dev channel can be materialized without touching upstream bytes.
	 */
	readonly devChannel: string | null;
	/**
	 * Top-level keys the packaging step of this family stamps by itself. An
	 * operation on one of them is announced, not refused: whatever it writes is
	 * overwritten at packaging time.
	 */
	readonly stampedKeys: readonly string[];
	/**
	 * The only top-level keys an overlay of this target may touch, or null when
	 * the whole document is open to it.
	 */
	readonly allowedKeys: readonly string[] | null;
	/**
	 * Top-level scalar keys an overlay may set, with `expectUpstream` carrying
	 * the pin's value: the licence identifier of a manifest, which the licensing
	 * area writes (##TYPE-AREA-LICENSING, 2026-11-01). Additions under
	 * `allowedKeys` stay what they were; a scalar is replaced, never added to.
	 */
	readonly allowedScalarKeys?: readonly string[];
	/** Dependency sections from which an overlay may remove one named package. */
	readonly allowedRemovals?: readonly string[];
	/** Dependency sections allowing an exact, pin-guarded version replacement. */
	readonly allowedDependencyUpdates?: readonly string[];
	/** This target owns guarded npm v3 lockfile operations paired with a manifest. */
	readonly npmLockfile?: boolean;
};

/** How an own extension of the patch set reaches the tree. */
export type ExtensionMaterializer = {
	/** Directory of the units in the patch set, POSIX, e.g. `delta/own-extensions`. */
	readonly deltaRoot: string;
	/** The materialized directory in the tree for one unit name, POSIX. */
	materializedPath(name: string): string;
	/** The shape a unit name may take. */
	readonly namePattern: RegExp;
	/** The file every unit directory must contain, relative to the unit. */
	readonly manifestFile: string;
};

/** What else an override of this family has to say, beyond calling the registration. */
export type ServiceOverrideContext = {
	/** The service identifier the override declares. */
	readonly serviceId: string;
	/** The module of the override, as a path inside the own layer, POSIX. */
	readonly modulePath: string;
	/** Its text; the registration call itself has already been found in it. */
	readonly moduleText: string;
	/**
	 * Another file of the own layer by its path inside the layer, or null when
	 * the layer does not carry it. A family whose override wins by the order of
	 * its packages needs the manifest of the own package, not only the module.
	 */
	read(path: string): string | null;
};

/** One thing wrong with an override, in the engine's own frame. */
export type ServiceOverrideProblem = {
	/** Completes the sentence "`<id>`: ..."; states what is wrong. */
	readonly detail: string;
	/** What makes it right. */
	readonly hint: string;
};

/** How the engine proves that own code really overrides the service it declares. */
export type ServiceOverrideVerifier = {
	/** The function an override calls, e.g. a registration or a rebinding. */
	readonly registrationCall: string;
	/** The module that function is imported from, or null when it is not fixed. */
	readonly registrationModule: string | null;
	/** Why overriding one of the forbidden service ids breaks the product. */
	readonly forbiddenReason: string;
	/** What a person should do instead of overriding a forbidden service. */
	readonly forbiddenHint: string;
	/**
	 * Everything else this family requires of an override that the registration
	 * call alone does not prove. A family where the last registration of an id
	 * wins needs nothing here; a family where the override wins only because its
	 * package is loaded after the package it overrides needs the dependency edge
	 * that guarantees the order, and the engine cannot state that edge itself.
	 * Added on 2026-09-09 with the second official type, by the rule of
	 * ##DECISION-TYPE-CONTRACT-FROM-MEASUREMENT; the answer is optional and a
	 * type that omits it is verified exactly as before.
	 */
	overrideProblems?(context: ServiceOverrideContext): readonly ServiceOverrideProblem[];
};

/** Where a graft of the entry-module layer belongs in this family. */
export type EntryModuleLocator = {
	/** Tree-relative paths that are entries of this family, in report order. */
	readonly entries: readonly string[];
	/** Why these files are the entries; printed with the candidacy advice. */
	readonly why: string;
};

/** One unit of the list a manifest of the family declares its bundled units in. */
export type BundleEntry = {
	readonly name: string;
	readonly version: string;
	/** The hash of the one archive of a unit that serves every platform; empty for a unit built per target. */
	readonly sha256: string;
	/**
	 * The hash of the archive of each target of a unit built per target, keyed
	 * by the family's name of the target; absent for a unit with one archive.
	 */
	readonly targets?: Readonly<Record<string, string>> | undefined;
};

/** The host a tree runs on, as the target of a unit built per target is chosen for it. */
export type BundleHost = { readonly platform: string; readonly arch: string };

/** What the manifest inside an archive says about the unit it holds. */
export type BundleIdentity = { readonly name: string; readonly version: string };

/**
 * How a family ships a unit another repository built - a built-in extension of
 * the first family - delivered as an archive its own build already takes
 * (PROP-016 ##TYPE-AREA-LAYERS, PROP-008 ##BUNDLES-LOAD). The engine provisions
 * the unit into the cache the build reads; the type says what the list, the
 * archive and the cache look like, and never sees the bytes.
 */
export type BundleLayer = {
	/** The manifest target whose list declares the units, from the tree root. */
	readonly manifestTarget: string;
	/** The key of that list in the manifest document, as an overlay path. */
	readonly listPath: readonly string[];
	/** The entries of the list of a manifest document; an element without the three fields is skipped. */
	entries(document: Readonly<Record<string, unknown>>): readonly BundleEntry[];
	/** The element the overlay appends to the list for one unit. */
	entry(unit: BundleEntry): Readonly<Record<string, unknown>>;
	/** Where a unit is unpacked in the tree, from the tree root, POSIX. */
	cachePath(name: string): string;
	/** The directory inside the archive the unit is read from, with a trailing slash; empty for the whole archive. */
	readonly archiveRoot: string;
	/** The manifest inside the archive the identity is read from, as an archive path. */
	readonly archiveManifest: string;
	/** The identity a manifest text declares, or null when it declares none. */
	identity(manifestText: string): BundleIdentity | null;
	/** The shape a unit name may take. */
	readonly namePattern: RegExp;
	/** The word for the archive in reports, e.g. VSIX. */
	readonly archiveWord: string;
	/**
	 * The targets a unit may be built for, one archive each, in the family's own
	 * names (the first family: `win32-x64`, `linux-x64`, `darwin-arm64`, ...);
	 * empty when every unit of the family is one archive for every platform.
	 */
	readonly targets: readonly string[];
	/** The target whose archive a tree on this host runs, or null when the family names none for it. */
	hostTarget(host: BundleHost): string | null;
	/** The target whose archive a package target of the family ships, or null when it ships none of one target. */
	packageTarget(target: PackageTarget): string | null;
	/** The manifest inside an archive that names the target it was built for, as an archive path; null when archives name none. */
	readonly archiveTargetManifest: string | null;
	/** The target that manifest text names, or null when the archive serves every platform. */
	archiveTarget(manifestText: string): string | null;
};

export type LayersArea = {
	/** The overlay targets of this family, in a stable order. */
	readonly overlayTargets: readonly OverlayTarget[];
	/** The materializer of own extensions, or null when the family has none. */
	readonly ownExtensions: ExtensionMaterializer | null;
	/** The service-override verifier, or null when the family has no such seam. */
	readonly serviceOverride: ServiceOverrideVerifier | null;
	/** The entry-module locator, or null when the family has no entry list. */
	readonly entryModule: EntryModuleLocator | null;
	/** The bundles layer, or null when the family ships no unit another repository built. */
	readonly bundles: BundleLayer | null;
};
