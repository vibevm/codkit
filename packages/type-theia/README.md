# @codkit/type-theia

The `theia` project type: the tool's knowledge of the Eclipse Theia monorepo as
an upstream. It is the second real type, and it answers the ten questions of the
contract with different shapes than the first one.

An upstream of this family is one npm workspace of packages on Node 24, built by
lerna and TypeScript project references and bundled by esbuild, and an
application of it is not a source tree but a `package.json`: the `theia` section
of that file carries the application name, the preference defaults and the
Electron window options, and its `dependencies` list is the whole extension
inventory. Own code is therefore an ordinary workspace package with
`theiaExtensions`, and it reaches the application by one line in that dependency
list - no upstream file is patched to include it at all. A service is overridden
by an inversify `rebind` in the own package's container module, and it wins only
because the own package depends on the package that binds the service, so the
verifier of this type checks the call and the dependency edge together.

Three answers come from the patch set's own `typeConfig`, because upstream ships
no product of its own: `ownRoot` (a workspace package directory),
`ownPackageName` (what `lerna --scope` selects) and `applicationRoot` (the
application whose manifest is the overlay target). The capabilities are the same
for every patch set: `config-overlay`, `service-override`, `build-channels` and
`upgrade-advisory`. There are no brand images, no runtime library, no entry
module and no own extensions, and every verb that needs one of them refuses with
`CK-E-TYPE-CAPABILITY`.

The type is specified in `modules/theia` of the tool's specifications, and every
fact of it is derived from the research of upstream master 1.75.0. This package
imports `@codkit/type-api` and nothing else from the tool.

Licensed UPL-1.0; see [LICENSE.md](LICENSE.md).
