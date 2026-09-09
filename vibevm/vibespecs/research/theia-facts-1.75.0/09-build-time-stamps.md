# 09 — What upstream stamps at build time

Short answer: **no git sha, no build date, no quality channel.** Theia stamps only the
application's declared configuration and its extension inventory, and it does it by emitting
JavaScript literals into `src-gen/`.

There is no `BUILD_SOURCEVERSION`, no `VSCODE_QUALITY` analogue, no `--define` of a commit id.
A grep over `dev-packages`, `packages/core/src` and `examples` for
`GIT_COMMIT|COMMIT_SHA|SOURCEVERSION|buildDate|BUILD_` returns only
`dev-packages/application-manager/src/rebuild.ts:158` (`THEIA_REBUILD_NO_WORKAROUND`,
unrelated).

## The four things that are baked in

### 1. Frontend configuration

`dev-packages/application-manager/src/generator/frontend-generator.ts:80-82` writes into
`src-gen/frontend/index.js`:

```js
const { FrontendApplicationConfigProvider } = require('@theia/core/lib/browser/frontend-application-config-provider');
FrontendApplicationConfigProvider.set(<pretty-printed literal of package.json theia.frontend.config>);
```

`FrontendApplicationConfigProvider.set` is **write-once** — it throws if called twice
(`packages/core/src/browser/frontend-application-config-provider.ts:33-36`) — and deep-merges
onto `FrontendApplicationConfig.DEFAULT` (`:40`). So the shipped bundle carries the product
name and preference defaults as a frozen literal.

### 2. The page title

`frontend-generator.ts:70`:
```
<title>${this.pck.props.frontend.config.applicationName}</title>
```
in the generated `src-gen/frontend/index.html`, later copied to `lib/frontend/index.html`
(`application-package-manager.ts:116`).

### 3. Backend configuration

`backend-generator.ts:201-204`:
```js
const { BackendApplicationConfigProvider } = require('@theia/core/lib/node/backend-application-config-provider');
BackendApplicationConfigProvider.set(<literal of theia.backend.config>);
```
Electron main gets the same frontend config as a local `const config = …`
(`backend-generator.ts:66`, used at `:95` `application.start(config)`).

### 4. The extension inventory — the closest thing to a build stamp

`backend-generator.ts:206`:

```js
globalThis.extensionInfo = <literal of extensionPackages.map(({ name, version }) => ({ name, version }))>;
```

Read back at runtime by
`packages/core/src/node/application-server.ts:29-31`
(`getExtensionsInfos()` → `backendGlobal.extensionInfo`), with the default `[]` guard at
`packages/core/src/node/backend-global.ts:38-40` and the type at `:23`.

Together with `getApplicationInfo()` (`application-server.ts:33-45`), which reads `name` and
`version` from the **application's `package.json` at runtime** (not baked), this is the whole
of the About dialog's data.

## Build modes

`bundler-generator.ts:97-122` — the generated `gen-esbuild.browser.mjs` parses
`--mode`, `--watch`, `--static-compression` and derives:

```js
const production = mode === 'production';
const sourcemap = production ? false : 'linked';
const minify = production;
```

`--mode development` vs `--mode production` is the only build channel
(`examples/browser/package.json:105-106`). Production additionally emits gzipped copies of the
frontend assets (`:108`, `:119-121`).

## `gitHead`

Many published packages carry a `"gitHead"` field in `package.json` (e.g.
`examples/playwright/package.json:52` — `"gitHead": "21358137e41342742707f660b8e222f940a27652"`).
This is written by **npm at publish time**, not by Theia's build, and it is stale in the
working tree. It is not a reliable pin and must not be treated as one.

## Consequence for a project type

A Theia "stamp" step has nothing to graft into. If a downstream wants a commit sha or build
date in its About dialog, it must add it itself — the natural places are a generated
constant in its own package, or an extra key under `theia.frontend.config` (an unknown key
survives `deepmerge` and reaches `FrontendApplicationConfigProvider.get()`), plus a
`rebind`/contribution to render it.
