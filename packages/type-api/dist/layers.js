/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-AREA-LAYERS */
// Area 3 of the contract: the layers whose shape a type decides.
//
// `own`, `patch`, `resource-file` and `rewrite-rule` are universal and always
// present, so they ask the type nothing. Four layers do ask: `config-overlay`
// wants its targets and its optional dev channel, `own-extension` wants its
// materializer, `service-override` wants its verifier and `entry-module` wants
// its locator. A layer the type does not provide is absent for that patch set,
// and `verify` refuses an artifact of it with `CK-E-TYPE-CAPABILITY`.
export {};
