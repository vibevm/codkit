# @codkit/type-api

The contract between the Codkit engine and a project type: the `ProjectType`
interface with the nine areas of `PROP-016` §2, the closed list of capability
names, and the shape gate `projectTypeProblems` both sides run.

A type package imports this package and nothing else from the tool; the CLI
package imports a type only through this interface, so a change of the contract
is a change of every official type in the same commit of the workspace.

Licensed UPL-1.0; see [LICENSE.md](LICENSE.md).

## Declarative handshake and conformance

A type ships `type-manifest.json` alongside `package.json` and exports it as
`./type-manifest.json`. Manifest version and contract version are independent
of package version. `validateTypeManifest` validates unknown metadata before
execution, including package identity, capabilities and the supported stable
engine interval (`min` inclusive, `maxExclusive` exclusive).

From a separate type repository, run `codkit-type-conform <package-directory>`
after building its runtime. The type package needs an ESM `exports["."].import`
entry. The check validates the manifest first, then executes the selected
adapter and checks its functional contract and declared capabilities.
`codkit types` itself reads metadata without executing adapters.
