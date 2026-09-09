/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYERS */
// Area 3 of the contract: the layers whose shape a type decides.
//
// `own`, `patch`, `resource-file` and `rewrite-rule` are universal and always
// present, so they ask the type nothing. Four layers do ask: `config-overlay`
// wants its targets and its optional dev channel, `own-extension` wants its
// materializer, `service-override` wants its verifier and `entry-module` wants
// its locator. A layer the type does not provide is absent for that patch set,
// and `verify` refuses an artifact of it with `CK-E-TYPE-CAPABILITY`.

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

export type LayersArea = {
	/** The overlay targets of this family, in a stable order. */
	readonly overlayTargets: readonly OverlayTarget[];
	/** The materializer of own extensions, or null when the family has none. */
	readonly ownExtensions: ExtensionMaterializer | null;
	/** The service-override verifier, or null when the family has no such seam. */
	readonly serviceOverride: ServiceOverrideVerifier | null;
	/** The entry-module locator, or null when the family has no entry list. */
	readonly entryModule: EntryModuleLocator | null;
};
