/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-BUILD */
// Area 4 of the contract: build and test.
//
// `ci --profile build` is one universal skeleton (PROP-011); its steps call the
// answers below. The engine owns the order of the steps, the transactions and
// the reporting; the type owns which command each step runs and where the
// pass boundaries of a watch channel are.
export {};
