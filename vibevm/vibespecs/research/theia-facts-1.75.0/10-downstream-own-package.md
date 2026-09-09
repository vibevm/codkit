# 10 — Where a downstream's own package lives, and how the application includes it

This is the area where Theia differs most from VS Code, and it is the reason the second
project type is worth having.

## The short version

A downstream's own code is **an ordinary npm package with `theiaExtensions`**, placed inside
one of the workspace globs, added to the application's `dependencies`. There is no upstream
file to patch, no central import list, no registry.

## Placement

`package.json:121-126` — the workspace globs are `dev-packages/*`, `packages/*`,
`examples/*`, `sample-plugins/*/*`. Any directory matching one of them is a workspace member.

For a fork keeping upstream's shape, `packages/<own-name>/` is the natural home: it is the
glob where every framework extension already lives, it is what `theiaext` scripts assume
(relative paths `../../configs/…`, see below), and it is what the `nls-extract` glob
`./packages/**/{browser,electron-browser,common}/**/*.{ts,tsx}` already covers (`07`).

A package outside every glob works too, if it is a real dependency resolvable from the
application — `ExtensionPackageCollector` resolves by module resolution
(`dev-packages/application-package/src/extension-package-collector.ts:64`,
`this.resolveModule(parentPackagePath, name)`), not by workspace membership. But it then
misses the monorepo's `lerna run` fan-out, the generated tsconfig references, and the
localization extraction.

## The skeleton of an own package

Minimal working example upstream: `examples/api-provider-sample/package.json`.

```json
{
  "private": true,                                   // :2  — omit to publish
  "name": "@theia/api-provider-sample",              // :3
  "version": "1.75.0",                               // :4  — must match the monorepo version
  "dependencies": {                                  // :6-10
    "@theia/core": "1.75.0",
    "@theia/plugin-ext": "1.75.0"
  },
  "theiaExtensions": [                               // :11-15
    { "backend": "lib/node/gotd-backend-module" }
  ],
  "keywords": [ "theia-extension" ],                 // :16-18
  "license": "EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0",   // :19
  "files": [ "lib", "src" ],                         // :28-31
  "scripts": {                                       // :33-38
    "lint": "theiaext lint",
    "build": "theiaext build",
    "watch": "theiaext watch",
    "clean": "theiaext clean"
  },
  "devDependencies": { "@theia/ext-scripts": "1.75.0" }   // :39-41
}
```

Framework packages add `"compile": "theiaext compile"` and `"test": "theiaext test"`
(`packages/core/package.json:211-221`).

Alongside it the package needs:

| File | Content | Evidence |
|---|---|---|
| `tsconfig.json` | extends `../../configs/base.tsconfig`, `composite: true`, `rootDir: src`, `outDir: lib`, and a **generated** `references` array | `packages/core/tsconfig.json:1-22` |
| `.eslintrc.js` | extends `../../configs/build.eslintrc.json`, `tsconfigRootDir: __dirname` | `packages/core/.eslintrc.js:1-10` |
| `src/<runtime>/…` | only `common`, `browser`, `browser-only`, `node`, `electron-common`, `electron-browser`, `electron-node`, `electron-main` | `doc/code-organization.md:5-17` |
| `src/**/<name>-<runtime>-module.ts` | `export default new ContainerModule(bind => …)` | `packages/navigator/src/browser/navigator-frontend-module.ts:48` |
| a license header on every file | the SPDX line the `file-header` rule matches | `configs/errors.eslintrc.json:109-115` |

The `references` array must not be written by hand: `npm install` (via `postinstall`) runs
`node scripts/compile-references.js`, which derives it from the dependency graph and rewrites
the file (`scripts/compile-references.js:52-53, 110-119`); CI then asserts the tree is clean
(`./scripts/check_git_status.sh`).

## Inclusion in the application

One line per application `package.json`:

```json
"dependencies": { …, "@own/scope-name": "1.75.0" }
```

exactly as `examples/browser/package.json:26-99` lists all 74 framework packages. The
generator then discovers it through `ExtensionPackageCollector`
(`extension-package-collector.ts:32-45`), places it after its dependencies in load order
(`:83-84`, post-order push — see `04`), and emits a `container.load(require('@own/scope-name/lib/browser/…'))`
line into `src-gen/frontend/index.js` (`frontend-generator.ts:144`).

**Nothing in the upstream tree is edited.** That is the structural fact: in Theia the "own
layer" and the "entry-module registration" collapse into one JSON key in a file the downstream
already owns (the application `package.json`), whereas VS Code needs a graft into
`workbench.common.main.ts`.

## What still requires touching upstream files

The additions above are patch-free. Genuine upstream edits are still needed for:

- changing behaviour that is not exposed through a service identifier or a contribution point
  (no `rebind` target);
- changing an upstream package's `theiaExtensions` list;
- changing `configs/*` (lint, tsconfig, mocha) globally;
- changing the root `package.json` scripts, `theiaPlugins` map, or workspace globs;
- changing `scripts/translation-update.js` if the own package is outside `packages/`.

## Own *plugins* (VS Code extensions), for completeness

A downstream's own VS Code-style plugin is a different artefact: it goes under a
`sample-plugins/<ns>/<name>`-shaped directory (workspace glob `sample-plugins/*/*`,
`package.json:125`) or is fetched as a `.vsix` through the `theiaPlugins` map
(`package.json:128-134`). See `06`.
