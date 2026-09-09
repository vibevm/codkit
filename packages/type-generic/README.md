# @codkit/type-generic

The `generic` project type: a plain git upstream with no product model. It knows
no product manifest, no extension directory, no service registry and no entry
module, and it carries no brand images and no runtime library. What it does
carry is everything a patch set needs to live over an arbitrary repository - own
code in a configured directory, patches with markers, resource files, rewrite
rules, and a configuration overlay over JSON files the patch set declares.

Everything this type answers therefore comes from `typeConfig`: the own root,
the install, lint, compile and test commands, the overlay targets, the cleanup
whitelist and the manifest that proves the tree. The type declares
`config-overlay` and `build-channels` only for a patch set whose configuration
asks for them, through the `configure` step of the contract.

The questions it answers are the ten areas of `modules/codkit/PROP-016` §2, and
the type itself is `##TYPE-GENERIC` of that document. This package imports
`@codkit/type-api` and nothing else from the tool.

Licensed UPL-1.0; see [LICENSE.md](LICENSE.md).
