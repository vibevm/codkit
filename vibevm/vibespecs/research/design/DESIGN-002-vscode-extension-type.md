# DESIGN-002: The `vscode-extension` project type, the preview capability and the rebrand toolkit

Status: proposal written 2026-11-01 for the owner's review; the normative form arrives as
`modules/vscode-extension/PROP-001..005`, a `preview` area in PROP-016 and a `preview` verb in
PROP-007. Genre: design document (lore, not binding). Owner's request of 2026-11-01, in the words
that concern the tool: teach Codkit to fork Visual Studio Code extensions; think through how the
tool determines the product type and its strategies; make it fast and convenient to maintain
many extensions; and, as a deliberate exception to the tool's hands-off posture, give a way to
preview the result quickly in an existing VS Code-based IDE - the default one first, a custom one
later. The consumer product that commissioned this, its upstream and its own repository are named
only there (`common/PROP-004` `NO-CONSUMER-PRODUCT-IN-THE-TOOL`); this document speaks of "the
specimen" and records nothing that identifies it.

## 1. Findings: what an extension upstream is, as a family

Measured on one real specimen (a package-manager-driven monorepo whose extension is one
workspace package; the facts with `path:line` citations live in the consumer's repository) and
checked against the public Extension API documentation. The facts that shape a type:

1. **The product manifest is the extension's `package.json`, and it is the whole product
   model.** Identity (`name`, `displayName`, `publisher`, `version`, `icon`, `galleryBanner`,
   `repository`, `author`, `keywords`), the host contract (`engines.vscode`, `main`,
   `activationEvents`, `extensionKind`) and every user-visible contribution (`contributes.*`:
   commands with their titles and categories, views and view containers with their titles and
   icons, configuration keys with their descriptions, walkthroughs, menus) are one JSON document.
   There is no `product.json` and no source tree the family anchors own code to; the manifest
   plays the part the application `package.json` plays for Theia (`modules/theia/PROP-003`).
2. **Localization has funnels, not files, and a product has several.** The official shape is
   `package.nls.json` plus `package.nls.<locale>.json` for manifest strings and `vscode.l10n`
   with `l10n/bundle.l10n.<locale>.json` for runtime strings. The specimen uses neither for its
   product strings: it carries one TypeScript dictionary module per locale (21 locales, Russian
   among them) for each of its surfaces - the webview, the extension host, a backend bridge -
   and each surface has one `t()` every rendered string passes through (the webview's fills
   placeholders and plurals; the host's selects the locale from a setting and falls back to the
   host language). So the string funnel the `gen-brand` question of the contract is about exists,
   but there is one per surface, and the dictionaries are code, not data: a JSON overlay cannot
   reach them, a render-time transform reaches all of them. Manifest strings have no funnel at
   all when the product ships no `package.nls*.json`; they are the manifest's own values.
3. **The build is the extension's own scripts, run by the package manager the manifest names.**
   `packageManager` and a lockfile (npm, pnpm, yarn or bun; the specimen pins bun by version
   and revision) fix the runtime of the scripts; bundlers vary (esbuild for the host and the
   webview in the specimen, vite elsewhere); the distributable is a `.vsix` produced by
   `@vscode/vsce` (`vsce package --no-dependencies`), a zip of the manifest, the bundles and the
   assets - **one universal file for a pure-JavaScript extension, one per platform (`--target`)
   when native binaries are bundled**, which the specimen does for eight targets. Tests run
   through `@vscode/test-electron` against a downloaded host and through the project's unit
   runner (`bun test` in the specimen). Parts of a release build reach the network (prebuilt
   binaries, model catalogues, toolchain tarballs); the bundle itself does not. Nothing of this
   is a constant of the family: it is declared per product, exactly as the `generic` type
   declares its commands, and the type's job is to put the declaration into the shape the
   universal build skeleton asks for while supplying the family's defaults.
4. **A human looks at an extension by launching a host with it.** The host - VS Code, VS Code
   Insiders, or any VS Code-based IDE - takes `--extensionDevelopmentPath=<extension root>` and
   runs the unpacked extension from source (the "extension development host"), or installs a
   `.vsix` with `--install-extension`. Both forms take `--user-data-dir` and `--extensions-dir`,
   which is what isolates a preview from the person's own profile. The specimen ships a
   launcher script doing exactly this; the mechanism is the host's, not the specimen's.
5. **The upstream pin is an ordinary release tag and the tree is a monorepo or a single package.**
   The extension root is the directory whose `package.json` carries `engines.vscode`; in a
   single-package repository it is the tree root, in a monorepo it is one workspace package.
6. **Rebranding is a surface operation with a known inventory**: the manifest's strings (the
   specimen: 77 occurrences of the product name inside `contributes` alone), the translated
   dictionaries (about a hundred of two thousand entries per locale carry the name), the icons
   the manifest names, the README and CHANGELOG, a handful of hard-coded strings in code (a
   display-name constant, the extension id in five places, window titles), telemetry identifiers
   and the publisher identity. Two things are **not** surface: the identifier namespaces of
   commands and settings (`<brand>.<command>`, hundreds of references, and a user's settings
   file names them) and the service endpoints the product talks to; renaming either is a product
   decision with a compatibility cost, taken in the product's own repository, never by the
   toolkit. The licence of the upstream (MIT with Apache-2.0 components in the specimen) requires
   the licence texts, the copyright lines and the third-party notices to stay, and prominent
   change notices on modified Apache-licensed files; trademarks are not licensed, which is what
   makes renaming a requirement rather than a preference.

## 2. The type: the ten answers

`vscode-extension` is a **configured** type (`PROP-016#TYPE-CONFIGURED`), like `theia`: most of
its answers are a function of `typeConfig`, because the family has no constant layout and no
constant scripts. `configure(typeConfig)` returns the type the engine asks everything.

| Area | Answer |
|---|---|
| identity | tag pattern `^v?\d+\.\d+\.\d+$` by default, overridable by `typeConfig.tagPattern`; fingerprints: `<extensionRoot>/package.json` must be a JSON object with `name`, `publisher`, `engines.vscode` and either `main` or `browser` or `contributes`; a monorepo adds the root `package.json` with a `workspaces`/`packageManager` statement when `typeConfig.monorepo` is declared. The pin resolution stays the engine's. |
| layout | `typeConfig.ownRoot` must lie under `<extensionRoot>/src/`, because the bundler reaches own code only from the host entry; one owned directory, no build outputs inside it; `ownExtensionPath` null (an extension has no extension host of its own); cleanup whitelist: `node_modules/` at any depth, `<extensionRoot>/dist/`, `<extensionRoot>/out/`, `<extensionRoot>/*.vsix`, `.vscode-test/`, `**/.turbo/`, `.eslintcache`, `*.tsbuildinfo`, plus `typeConfig.cleanupWhitelist`; forbidden patch targets: every lockfile (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `bun.lockb`) and the overlay targets. |
| layers | `config-overlay`: `<extensionRoot>/package.json` as the product manifest, whole document open, no dev channel (the host reads the manifest from the extension root, so a preview needs the overlay materialized in the tree, like packaging does); `package.nls.json` and `package.nls.<locale>.json`, and every file `typeConfig.localeManifests` names, open, no dev channel. `own-extensions` null, `service-override` null (the family has no uniform registry), `entry-module`: locator over `typeConfig.entryModules`, default `<extensionRoot>/src/extension.ts` - the activation module is where own code is composed in. |
| build | install from the declared package manager (`npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable` / `bun install --frozen-lockfile`); dependency roots `node_modules` and `<extensionRoot>/node_modules` for a monorepo; hygiene = the declared lint scripts; own tests = the declared unit runner over the own root; `packageBuild` = the declared build script; `packageDistributable` = `vsce package --no-dependencies` through the project's own `node_modules/@vscode/vsce` (never fetched), writing into `<extensionRoot>/dist/`; `packageOutputs` `<extensionRoot>/dist/*.vsix`; `packageScratch` from `typeConfig`; stamps from `typeConfig` as literals; watch channels declared with their pass boundaries, with the type's defaults for an esbuild watch (`[watch] build started` / `[watch] build finished`) and a `tsc --watch`. |
| advisory | readers over `<extensionRoot>/package.json`: `engines.vscode` (the host minimum moved: the preview host and the supported IDEs must follow), `version`, the set of `contributes.configuration` keys (a renamed or removed setting breaks own code that reads it), `activationEvents`, `packageManager` of the root (a toolchain change), and the locale file list when `package.nls.*.json` exist. |
| brand-images | not declared in the first version; the icon targets the manifest names (`icon`, view-container icons) are PNG and SVG and will become a declared target table in a second version (see D6). |
| runtime | not declared; the brand table is self-contained (D5). |
| standards | one package of the type, `seams-vscode-extension`: the catalogue of this family's seams - the manifest overlay, the i18n funnel, the contribution points, the webview, telemetry - ranked like `seams-theia` (second version; the first version delivers the universal set). |
| conventions | subsystems `extension`, `webview`, `i18n`, `assets`, `build`, `config`, `docs`, `test`; no forbidden service ids. |
| generators | `featureSkeleton`: an own module exporting `activate(context)`-shaped registration (a command or a contribution pushed into `context.subscriptions`), its identifiers module and its test inside the feature directory; the import line is for the entry module. `brandGraft` (capability `gen-brand`): the brand table module with a self-contained, locale-aware transform, and a hook text in the shape of a wrap around a translate function (`return brandMessage(result, locale)`) that the product grafts at each funnel it has - the hook is a patch of the product, printed and never written; plus the leftover guard test (§4). |
| **preview** (new, §3) | modes `development` (run from source through `--extensionDevelopmentPath`) and `artifact` (install the `.vsix` into the isolated profile); the host is an executable path; isolation through `--user-data-dir` and `--extensions-dir`. |

`typeConfig` of the type, all paths from the tree root, POSIX:

```json
{
  "ownRoot": "packages/example/src/own",
  "extensionRoot": "packages/example",
  "monorepo": true,
  "packageManager": "bun",
  "scripts": { "build": "compile", "lint": ["lint"], "test": { "command": ["bun", "test"], "ownGlobArg": null } },
  "entryModules": ["packages/example/src/extension.ts"],
  "localeManifests": ["packages/example/package.nls.json"],
  "watch": { "channels": [ { "channel": "bundle", "script": "watch:esbuild", "passStart": ["..."], "passEnd": ["..."], "errorCountLine": ["..."] } ] },
  "preview": { "host": null, "workspace": null }
}
```

Everything but `ownRoot` and `extensionRoot` has a family default; `packageManager` defaults to
what the root manifest's `packageManager` field names and to `npm` when it names nothing.

## 3. Preview: the eleventh question

The tool has had no verb that shows a human the product; the owner asks for one as a deliberate
exception, because for an extension the whole feedback loop is "see it in the IDE". Three
families would answer the question - an extension launches a host with itself, a VS Code fork
launches its own built product, a Theia application starts its backend and opens a browser or an
Electron window - so the question is added to the contract by the rule of
`PROP-016#DECISION-TYPE-CONTRACT-FROM-MEASUREMENT`: it is measured on the first type that needs
it and the other two answer it when their products ask.

- **Contract.** `PreviewArea` is an optional area paired with the capability `preview` in
  `OPTIONAL_AREAS`, exactly like `brandImages`/`brand-images`. It answers `modes` (the names a
  patch set may select) and `recipe(request)`: for a request `{treeDir, mode, host, stateDir,
  workspaceDir, artifact}` it returns the commands that prepare the tree (the family's build, or
  nothing with `--no-build`), the launch (`command`, `args`, `env`) and whether the mode needs the
  distributable first. The type never spawns anything.
- **Verb.** `codkit preview [--mode <name>] [--host <executable>] [--workspace <dir>] [--no-build]
  [--clean] [--wait]`. It requires a loaded tree (the fast path of `load`), materializes the overlay
  targets into the tree the way `package --keep-overlay` does and says so, runs the recipe's
  preparation through the build skeleton, then spawns the host detached from codkit's process with
  the isolated profile under `patchesDir/.codkit/preview/<mode>/{user-data,extensions}`, records
  `{pid, host, mode, startedAt, stateDir}` in `.codkit/preview/<mode>/record.json`, and prints
  the state directory and the record. `--clean` removes the isolated profile before launching;
  `--wait` blocks until the host exits and then restores the overlay targets; without `--wait` the
  materialization stays and `status` names it as a known materialization. The host never touches
  the person's own VS Code profile: the two isolation flags are always passed, and a recipe that
  omits them is refused by the engine before spawn.
- **Host resolution.** `--host` → `CODKIT_PREVIEW_HOST` → `typeConfig.preview.host` → the
  family default `code` found on `PATH`. A shell wrapper (`code.cmd`, `code` shell script) is
  resolved to the executable it starts, because a wrapper that exits after spawning leaves no
  process to record. The custom IDE of the owner's later step is one `--host` value.
- **What is reused and what is not** (from the daemon machinery of PROP-010): the detached launch,
  the record and its tree binding, the per-mode lock and the gc class are reused; the pass
  protocol is not - a GUI has no pass - so `preview` is its own action kind, and `build status`
  never reports it.
- **Surfaces** (`org.vibevm.world/omnichannel`): the capability lives in `lib/previewEngine.ts`;
  the CLI verb is the first surface; an MCP tool of the agent protocol is the second when the
  agent needs to open a preview for the person.

## 4. The rebrand toolkit

The owner's first change on every extension is the same: the product name everywhere, the
original authors nowhere but the licence. The toolkit makes that one generated intervention set,
re-applied by `load` on every upgrade, with the layers that exist (the layer order of
`PROP-005#LAYER-CHOICE-RULE`, no new layer kind - D3):

1. **Manifest** - a `config-overlay` of `<extensionRoot>/package.json`: `set` operations on
   `displayName`, `name`, `publisher`, `description`, `icon`, `galleryBanner`, `repository`,
   `homepage`, `bugs`, `author`, `keywords`, `qna`, and whole-array `set` on the contribution
   arrays whose string values carry the brand (command categories and titles, view and view
   container titles), each with `expectUpstream` so that an upstream rename of the string is a
   loud `CK-E-OVERLAY-DRIFT`. `package.nls*.json`, where present, are overlays of the same kind.
2. **Translated dictionaries and runtime strings** - the brand table (`gen brand`): an own module
   `brand.ts` with ordered rules `{find, replace, except?}` per locale group (the owner's case:
   one replacement for the Russian locale, another for every other) and a self-contained
   `createBrandTransform(rules)(message, locale)`, installed by one marked hook patch of type
   `hook` at each funnel the product has - the specimen has three `t()` functions and a display
   name constant, so four hooks of three lines each, inside the budget of
   `PROP-005#PATCH-HOOK-BUDGET`. Every translated string of every locale is branded at the moment
   it is rendered, in the host and in the webview alike, and a new upstream string is branded
   without a new artifact. Dictionaries that are TypeScript modules are never patched entry by
   entry: that is exactly the patch pile the layer metric forbids.
3. **Icons and documents** - `resource-file` entries for the PNG and SVG targets the manifest
   names and for `README.md` and `CHANGELOG.md`; the licence file and the third-party notices are
   never targets (the rebrand keeps them by law).
4. **Code constants and URLs** - marker patches of type `hook` where a string is built outside
   the funnel (a telemetry identifier, a documentation URL, a user-agent); the leftover gate below
   is what finds them.
5. **The leftover gate** - the third module `gen brand` writes, a contract test that unpacks the
   last `.vsix` of `packageOutputs` (or scans `<extensionRoot>/dist/` and the manifest) and fails
   on any occurrence of the original brand terms outside an allow-list that holds exactly the
   licence files and the third-party notices. It is the executable form of the owner's rule and
   the reason the toolkit may be lenient elsewhere: nothing leaves un-renamed quietly.

For many extensions the toolkit repeats per patch set; what is shared travels as packages
(`PROP-016#TYPE-MANY-FORKS`): the type package, `seams-vscode-extension` and the agent skills,
all delivered by `standards load`. `codkit workspace create` already pairs a patch set with its
tree per extension; a `codkit init --type vscode-extension` that writes the first `codkit.json`,
the own manifest and the overlay skeleton from a pinned clone is the next convenience and is a
phase of the campaign, not of this document.

## 5. Decisions

**D1 - a type of its own, not a profile of `generic`.** *Why:* the family has constant answers
`generic` cannot give - the manifest as the product model with its open overlay, the activation
entry as the entry module, `vsce` as the packager, the host launch as the preview, the i18n funnel
as the brand graft, and advisory readers over the manifest. *Considered and rejected:* `generic`
with a long `typeConfig` (no advisory, no entry module, no preview, no brand graft; every
extension would restate the family); a variant of `vscode` (a fork of the editor and an extension
of it share a vocabulary and nothing of their layout, build or packaging). *Revisit:* if a second
extension family (a JetBrains plugin, a browser extension) appears and shares more than half of
these answers - then a common base of "manifest-driven plugin" types is worth extracting.

**D2 - the extension manifest is an open overlay target without a dev channel.** *Why:* the host
reads the manifest from the extension root and there is no sidecar it reads instead; an overlay
of the whole document is the family's product model, as for Theia. *Rejected:* a patch of
`package.json` (JSON has no markers, `PROP-004#MR-BLIND-ZONES`); a resource-file copy (merges
badly across pins). *Revisit:* if the host gains an overrides sidecar for development.

**D3 - rebrand through existing layers, no term-substitution layer.** *Why:* a brand table hooked
into the funnel brands every string of every locale at render time with one hook and one module,
the shape the `vscode` type already uses; the manifest's strings are a finite overlay; a new layer
kind is a change of the tool's conventions, the completeness check and every inventory consumer
(`PROP-005#EVERY-LAYER-IS-AN-ARTIFACT`). *Rejected:* a `term-map` engine of `rewrite-rule`
over the locale JSON files (hundreds of generated patches per locale, re-counted at every upstream
release, and the drift guard would have to learn a transformed pin); per-locale overlays
(hundreds of artifacts). *Revisit:* when a product needs branded strings in a place the funnel
does not reach and patches of locale files start to accumulate - the metric of
`PROP-005#LAYER-METRIC` is the trigger.

**D4 - preview is a contract area and an engine verb, not a type-specific command.** *Why:* three
families answer it; the engine owns the isolation, the record, the lock and the restore, which are
the same for all. *Rejected:* a script in the patch set (every product rewrites the isolation and
the host detection); running the upstream's own launcher (it is the specimen's, not the family's,
and it is not isolated by default). *Revisit:* if a family's preview needs a readiness protocol
(a URL to open after the backend is up) - then the recipe gains an optional readiness probe.

**D5 - the brand transform is generated self-contained, not delivered as a runtime library.**
*Why:* one pure function of thirty lines; a `runtime-library` of the type would be a package, a
delivery and a drift check for one file. *Rejected:* reusing `runtime-vscode` (it is the VS Code
fork's library and brings DI the extension does not have). *Revisit:* when a second shared module
appears for this family - then `runtime-vscode-extension` is born and `gen brand` imports from it.

**D6 - brand images are a second version.** *Why:* the first change only needs the icon files
replaced, which `resource-file` does; the image pipeline wants a declared target table and the
manifest-driven discovery of the targets is the engine's reading of the tree, which a type cannot
do today. *Revisit:* the first product that regenerates its icons from masters.

**D9 - one universal `.vsix` in the first version; platform targets in the second.** *Why:* the
first consumer's bundle is JavaScript plus a bundled native binary per platform, and the
`packageTargets` catalog of the contract (`PROP-016#TYPE-PACKAGE-TARGETS`) is the right shape
for the per-platform `vsce package --target` runs - but the catalog wants the type to name the
targets, and which platforms a product bundles binaries for is the product's declaration. The
first version answers `packageBuild` + `packageDistributable` with `--no-dependencies` and no
`--target`, which is a valid universal package of the extension's JavaScript; the second version
reads `typeConfig.packageTargets` into the catalog. *Rejected:* hard-coding the specimen's eight
targets (a leak of one product into the family). *Revisit:* the first `codkit package` of a
product that ships native binaries.

**D7 - the package manager is declared, never guessed.** *Why:* the family runs on four package
managers and a wrong one corrupts the lockfile; `packageManager` of the root manifest is the
upstream's own declaration and the default. *Rejected:* detecting from lockfile names (two
lockfiles can coexist during a migration).

**D8 - the specimen is named only in the consumer's repository.** *Why:*
`common/PROP-004#NO-CONSUMER-PRODUCT-IN-THE-TOOL` and the owner's rule that the tool names no
product built with it; the upstream of a consumer is one step from the consumer. The family facts
above are stated at the level of the Extension API, which is public and generic. *Revisit:* only
by the owner.

## 6. Risks

- The `preview` area grows the contract by one question; every official type is touched (an
  `undefined` answer and no capability for `vscode`, `generic`, `theia`), the manifest schema
  of the handshake gains the capability name, and `codkit types` prints it.
- Spawning a GUI detached on Windows: a `.cmd` wrapper must be resolved to the executable, and the
  record's process identity must be the host's, not the wrapper's; the daemon orphan guard is the
  precedent.
- The brand hook is a patch of upstream code at the i18n initialisation: it moves on upgrade like
  any hook; the leftover gate catches a silently lost hook.
- A bun-driven specimen needs `bun` on the host that builds; the type refuses with the declared
  package manager named when it is absent, and never installs one.
- Service endpoints, telemetry destinations and account flows of the upstream stay in a rebranded
  build unless the product decides otherwise; the toolkit renames what is displayed and leaves
  those decisions, with their legal weight, to the product's own repository and owner.
- The identifier namespaces of commands and settings carry the upstream's brand and are read by
  hundreds of call sites and by users' settings files; the first version renames displayed
  strings only, and a namespace rename is a later, separately decided intervention.
