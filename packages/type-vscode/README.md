# @codkit/type-vscode

The `vscode` project type: the answers the Codkit engine used to carry inline
about the Visual Studio Code family of upstreams - where own code lives, which
file is the product manifest and which sidecar is its development channel, how
a service override is proved, how the tree is built, linted and tested, which
images a distribution carries, which runtime library and which standards
packages the type delivers, and what an intervention id may name.

The specification of these answers is `modules/vscode` of the tool's spec tree;
the questions they answer are the nine areas of `modules/codkit/PROP-016` §2.
This package imports `@codkit/type-api` and nothing else from the tool.

Licensed UPL-1.0; see [LICENSE.md](LICENSE.md).
