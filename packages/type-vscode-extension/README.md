# @codkit/type-vscode-extension

The `vscode-extension` project type: the tool's knowledge of a Visual Studio
Code extension repository as an upstream. It is the fourth official type, the
third real one, and the first to answer the preview question of the contract.

An upstream of this family is one package - alone in its repository or one
workspace package of a monorepo - whose `package.json` is at once the product
manifest and the host contract. It is built by the package manager the
repository names (npm, pnpm, yarn or bun) into a bundle, packaged by the
product's own script into a `.vsix`, and looked at by launching a VS Code-based
host with it: the extension development host runs the extension from the loaded
tree, or the packaged artifact is installed into an isolated profile.

The type is configured: its answers are a function of `typeConfig`, where a
patch set names the extension root, the own root under `<extensionRoot>/src/`,
the package manager, the scripts of the manifest, the entry modules, the locale
manifests an overlay may target, and the watch channels when the family's
esbuild and TypeScript defaults do not fit. The capabilities are the same for
every patch set: `config-overlay`, `entry-module`, `build-channels`,
`upgrade-advisory`, `gen-brand` and `preview`. There are no own extensions, no
service override, no dev channel, no brand images and no runtime library, and
every verb that needs one of them refuses with `CK-E-TYPE-CAPABILITY`.

The type is specified in `modules/vscode-extension` of the tool's
specifications. Its fixtures model a synthetic extension of their own, and no
product built with the tool is named here. This package imports
`@codkit/type-api` and nothing else from the tool.

Licensed UPL-1.0; see [LICENSE.md](LICENSE.md).
