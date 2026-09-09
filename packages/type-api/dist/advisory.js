/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-ADVISORY */
// Area 5 of the contract: the readers of the upgrade advisory.
//
// Between two pins the cycle asks each reader for the value it can see at each
// pin and reports the pairs that differ. The frame of the advisory - what
// changed, what it means, what to do, the acknowledgement that unblocks the
// cycle - is the engine's; which files carry a meaning, and what that meaning
// is, is the type's answer (capability `upgrade-advisory`).
export {};
