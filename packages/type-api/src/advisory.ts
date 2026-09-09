/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-ADVISORY */
// Area 5 of the contract: the readers of the upgrade advisory.
//
// Between two pins the cycle asks each reader for the value it can see at each
// pin and reports the pairs that differ. The frame of the advisory - what
// changed, what it means, what to do, the acknowledgement that unblocks the
// cycle - is the engine's; which files carry a meaning, and what that meaning
// is, is the type's answer (capability `upgrade-advisory`).

/** A value a reader extracts; compared by structural equality. */
export type AdvisoryValue = null | boolean | number | string | readonly AdvisoryValue[] | { readonly [key: string]: AdvisoryValue };

/** The bytes of one advisory file at one pin, or null when the file is absent. */
export type AdvisoryFiles = ReadonlyMap<string, string | null>;

export type AdvisoryReader = {
	/** Stable identifier of the reader; it names the change in the report. */
	readonly id: string;
	/** The tree-relative files this reader needs, in a stable order. */
	readonly paths: readonly string[];
	/**
	 * The semantic value at one pin. A file this reader declared but that the
	 * pin does not carry arrives as null; a reader never throws on absence.
	 */
	read(files: AdvisoryFiles): AdvisoryValue;
	/**
	 * One sentence saying what a change of this value means for the patch set,
	 * or null when a difference carries no meaning worth stopping for.
	 */
	meaning(before: AdvisoryValue, after: AdvisoryValue): string | null;
};

export type AdvisoryArea = {
	readonly readers: readonly AdvisoryReader[];
};
