# 06 — The extension model

Theia has **two different, unrelated extension mechanisms**. Confusing them is the classic
mistake.

1. **Theia extension** — an npm package that contributes inversify modules into the
   application's own containers. Compiled into the application. This is the framework's own
   plugin system.
2. **Plugin** — a VS Code extension (`.vsix`) or a Theia plugin, loaded at runtime into a
   sandboxed host. Not compiled into the application.

## 1. Theia extensions (`theiaExtensions`)

A package is a Theia extension iff its `package.json` has a `theiaExtensions` array:

`dev-packages/application-package/src/extension-package.ts:195-197`
```ts
export function is(pck: NodePackage | undefined): pck is RawExtensionPackage {
    return PublishedNodePackage.is(pck) && !!pck.theiaExtensions;
}
```

The entry shape (`dev-packages/application-package/src/extension-package.ts:22-33`):

```ts
export interface Extension {
    frontendPreload?: string;
    frontendOnlyPreload?: string;
    frontend?: string;
    frontendOnly?: string;
    frontendElectron?: string;
    secondaryWindow?: string;
    backend?: string;
    backendElectron?: string;
    electronMain?: string;
    preload?: string;
}
```

Each value is a path **into `lib/`, without extension**, relative to the package root.
Minimal example (`examples/api-provider-sample/package.json:11-15`):

```json
"theiaExtensions": [
  { "backend": "lib/node/gotd-backend-module" }
],
"keywords": [ "theia-extension" ],
```

A rich example, `packages/core/package.json:144-190`, shows the pairing convention: the same
array element carries the browser variant *and* its electron override, so the fallback works:

```json
{ "frontend": "lib/browser/menu/browser-menu-module",
  "frontendElectron": "lib/electron-browser/menu/electron-menu-module" },
{ "frontend": "lib/browser/window/browser-window-module",
  "frontendElectron": "lib/electron-browser/window/electron-window-module",
  "backendElectron": "lib/electron-node/window/electron-window-module" },
```

**77 of the 79 packages** under `packages/` declare `theiaExtensions`
(`grep -l '"theiaExtensions"' packages/*/package.json | wc -l` → 77).

### Fallback rules

`dev-packages/application-package/src/application-package.ts:139-184` — each container's
module map is computed with a *primary* and an optional *secondary* key:

| Getter | primary | secondary (fallback) |
|---|---|---|
| `frontendPreloadModules` :139-141 | `frontendPreload` | — |
| `frontendOnlyPreloadModules` :143-148 | `frontendOnlyPreload` | `frontendPreload` |
| `frontendModules` :150-152 | `frontend` | — |
| `frontendOnlyModules` :154-159 | `frontendOnly` | `frontend` |
| `frontendElectronModules` :161-163 | `frontendElectron` | **`frontend`** |
| `secondaryWindowModules` :165-167 | `secondaryWindow` | — |
| `backendModules` :169-171 | `backend` | — |
| `backendElectronModules` :173-175 | `backendElectron` | **`backend`** |
| `preloadModules` :181-183 | `preload` | — |

Target dispatch: `targetFrontendModules` :273-278 and `targetBackendModules` :266-270 pick the
browser or electron map from `theia.target`.

Key generation: `computeModules` :185-201 keys each module `"<primary>_<n>"` with a running
index, and joins `<package name>/<module path>` — so the generated `require` is
`require('@theia/navigator/lib/browser/navigator-frontend-module')`.

### How an application includes one

By listing the package in the application's `dependencies`, at an exact version
(`examples/browser/package.json:26-99` — 74 entries, all `"1.75.0"`). No other registration.
`ExtensionPackageCollector.collect` walks `dependencies` **and `peerDependencies`**
(`extension-package-collector.ts:39-45`), respecting `peerDependenciesMeta.optional`
(`:43`, `:66-68`).

Transitive Theia extensions are collected too (`:24` `const transitive = !(name in this.root.dependencies!)`),
so depending on a package pulls in its Theia extensions automatically.

### Consistency checks upstream ships

`dev-packages/cli/src/theia.ts`:
`check:hoisted` (:189), `check:theia-version` (:215 — "all dependencies have been resolved to
the same Theia version"), `check:theia-extensions` (:241 — "uniqueness of Theia extension
versions or whether they are hoisted"), `check:dependencies` (:274, with `--include`/`--exclude`
globs, `--skip-hoisted`, `--only-theia-extensions`).

## 2. Plugins (VS Code extensions)

### Declaration

At the *root* or application `package.json`:

- `package.json:127` — `"theiaPluginsDir": "plugins"` (the download target;
  `examples/browser/package.json:24` overrides it to `"../../plugins"`).
- `package.json:128-134` — `"theiaPlugins"`: a map of id → download URL, e.g.
  `"vscode-builtin-extensions": "https://github.com/eclipse-theia/vscode-builtin-extensions/releases/download/1.108.2/…tar.gz"`,
  and individual Open VSX `.vsix` URLs (`EditorConfig.EditorConfig`, `dbaeumer.vscode-eslint`,
  `ms-toolsai.jupyter`, `ms-python.python`).
- `package.json:135-139` — `"theiaPluginsExcludeIds"`: ids to skip when unpacking a pack
  (`ms-vscode.js-debug-companion`, `vscode.extension-editing`, `ms-python.vscode-pylance`).

### Download

`theia download:plugins` (`dev-packages/cli/src/theia.ts:362-409`), implemented in
`dev-packages/cli/src/download-plugins.ts` (`:88` — `const pluginsDir = pck.theiaPluginsDir || 'plugins';`).
Options include `--packed`, `--ignore-errors`, `--api-version`, `--open-vsx-registry`,
`--parallel`, `--rate-limit`, proxy settings and `--ovsx-router-config`.
CI runs it as `npm run download:plugins -- --rate-limit 3`
(`.github/workflows/ci-cd.yml`, "Download Plugins" step).

The directory is created by the download; it is **not in git**.

### Runtime

Plugins are passed to the running app on the command line:
`--plugins=local-dir:../../plugins` (`examples/browser/package.json:112`,
`examples/electron/package.json:113`). The deployer is
`packages/plugin-ext/src/main/node/plugin-deployer-impl.ts`, driven by the
`PluginDeployerResolver` / `PluginDeployerFileHandler` / `PluginDeployerDirectoryHandler`
contribution points (`:22-25`).

Supporting packages: `packages/plugin`, `packages/plugin-ext`, `packages/plugin-ext-vscode`,
`packages/plugin-ext-headless`, `packages/plugin-dev`, `packages/plugin-metrics`,
`packages/plugin-utils`, `packages/vsx-registry`.

Sample plugins live at `sample-plugins/sample-namespace/*` (7 of them) and are part of the
npm workspace (`package.json:125`).

## The dividing line, stated for a project type

| | Theia extension | Plugin |
|---|---|---|
| Declared by | `theiaExtensions` in `package.json` | `theiaPlugins` map / `--plugins` CLI |
| Where it lives | an npm package in the workspace or in `node_modules` | a `.vsix`/tarball under `theiaPluginsDir` |
| Bound into | the application's inversify containers, at build time | a separate plugin host, at runtime |
| Can override a core service | **yes** (`rebind`, see `04`) | no |
| Analogue in the VS Code world | roughly "a change to `src/vs/`" | a built-in extension in `extensions/` |
