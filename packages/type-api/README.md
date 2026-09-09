# @codkit/type-api

The contract between the Codkit engine and a project type: the `ProjectType`
interface with the nine areas of `PROP-016` §2, the closed list of capability
names, and the shape gate `projectTypeProblems` both sides run.

A type package imports this package and nothing else from the tool; the CLI
package imports a type only through this interface, so a change of the contract
is a change of every official type in the same commit of the workspace.

Licensed UPL-1.0; see [LICENSE.md](LICENSE.md).
