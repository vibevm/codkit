/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-STANDARDS */
// Area 8 of the contract: standards and skills.
//
// The standard `minimal-intervention` is universal and ships with the tool. The
// seam catalogue and the list "how upstream would build it" that the
// intervention skill routes through belong to the family, and travel as vibe
// packages of the type rather than as code.

export type StandardsArea = {
	/**
	 * Vibe packages of this type that `codkit standards load` delivers next to
	 * the universal ones, by package name, in delivery order.
	 */
	readonly packages: readonly string[];
};
