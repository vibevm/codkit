# 02 — Repository layout

Upstream Theia is a **single npm workspace monorepo**. There is no `src/` tree at the root;
every unit of code is an npm package.

## Workspace globs

`package.json:121-126`:

```json
"workspaces": [
  "dev-packages/*",
  "packages/*",
  "examples/*",
  "sample-plugins/*/*"
]
```

Four workspace roots, and the fourth is two levels deep.

## Top-level directories

| Path | Count | What it is |
|---|---|---|
| `packages/*` | 79 | The framework's Theia extensions, published as `@theia/<name>` (`ls packages`) |
| `dev-packages/*` | 12 | Build/tooling packages: `application-manager`, `application-package`, `bundle-plugin`, `cli`, `ffmpeg`, `localization-manager`, `ovsx-client`, `private-eslint-plugin`, `private-ext-scripts`, `private-re-exports`, `private-test-setup`, `request` |
| `examples/*` | 6 dirs | `browser`, `browser-only`, `electron`, `playwright`, `api-samples`, `api-provider-sample` (plus `ovsx-router-config.json`) |
| `sample-plugins/sample-namespace/*` | 7 | VS Code-style sample plugins (`plugin-a`, `plugin-b`, `plugin-browser`, `plugin-esm`, `plugin-esm-mjs`, `plugin-gotd`, `plugin-lm-tools`) |
| `configs/` | 11 files | Shared tsconfig/eslint/mocha/nyc/typedoc/license bases |
| `scripts/` | 15+ | Monorepo maintenance scripts (see `03`) |
| `doc/` | — | `Developing.md`, `Migration.md`, `Testing.md`, `code-organization.md`, `coding-guidelines.md`, `runtime-policy.md`, … |
| `logo/`, `.theia/`, `.vscode/`, `.github/` | — | assets, dev config, CI |

There is **no `applications/` directory**. The only applications upstream ships are the three
under `examples/` (`browser`, `browser-only`, `electron`), and they are `"private": true`
(`examples/browser/package.json:2`).

There is no `plugins/` directory in git; it is created by `theia download:plugins`
(`package.json:127` `"theiaPluginsDir": "plugins"`).

## The per-package source layout

Every package is `<pkg>/src/<runtime-folder>/…` compiled to `<pkg>/lib/<runtime-folder>/…`.
The runtime folders are a **closed set**, enforced by lint (see `08`):

`doc/code-organization.md:5-17`, and machine-readably
`dev-packages/private-eslint-plugin/rules/runtime-import-check.js:25-33`:

```js
const folders = {
    common: 'common',
    browser: 'browser',
    node: 'node',
    electronCommon: 'electron-common',
    electronBrowser: 'electron-browser',
    electronNode: 'electron-node',
    electronMain: 'electron-main',
};
```

(plus `browser-only`, documented at `doc/code-organization.md:8-9`).

Import direction is restricted
(`dev-packages/private-eslint-plugin/rules/runtime-import-check.js:57-63`):

| Folder | May import from |
|---|---|
| `common` | — |
| `browser` | `common` |
| `node` | `common` |
| `electron-common` | `common` |
| `electron-browser` | `electron-common`, `browser`, `common` |
| `electron-node` | `electron-common`, `node`, `common` |
| `electron-main` | `electron-common`, `node`, `common` |

## Build outputs (the cleanup whitelist a project type needs)

| Output | Where | Evidence |
|---|---|---|
| `lib/` + `*.tsbuildinfo` | every package | `dev-packages/private-ext-scripts/package.json:16` — `"ext:compile:clean": "rimraf lib *.tsbuildinfo"` |
| `src-gen/` | each application | `dev-packages/application-package/src/application-package.ts:220-233`; removed by `application-package-manager.ts:81` |
| `gen-esbuild.{browser,node,electron}.mjs` | each application | `dev-packages/application-manager/src/generator/bundler-generator.ts:66-74` |
| `lib/frontend/`, `lib/backend/` (bundles) | each application | `bundler-generator.ts:154` (`outdir: 'lib/frontend'`), `:240` (`outdir: 'lib/backend'`) |
| `.eslintcache` | every package | `dev-packages/private-ext-scripts/package.json:18` |
| `.nyc_output`, `coverage` | every package | `dev-packages/private-ext-scripts/package.json:23` |
| `.browser_modules` | repo root | `package.json:104` — `"rebuild:clean": "rimraf .browser_modules"` |
| `plugins/` | repo root | `package.json:127` (downloaded, not in git) |
| `node_modules`, `lib` | ignored by lint | `configs/base.eslintrc.json:25-28` |

`esbuild.mjs` in an application directory is **user-editable and must not be deleted**
(`examples/browser/esbuild.mjs:1-4`: "This file can be edited … To reset, delete this file").

## TypeScript project references

Every package's `tsconfig.json` extends `configs/base.tsconfig` and declares
`"composite": true` plus a `references` array
(`packages/core/tsconfig.json:1-22`). The references are **generated, not hand-written**:
`scripts/compile-references.js:21-27,52-53,110-119` derives them from the workspace
dependency graph and rewrites each `tsconfig.json`. It runs on every install
(`package.json:95` — `"postinstall": "theia-patch && npm run -s compute-references && lerna run afterInstall"`).

Consequence: **adding a package to a Theia tree is not a purely additive edit** — `postinstall`
rewrites the `tsconfig.json` of every package that depends on it.
