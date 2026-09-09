# 03 — Install, build, watch, lint, test

## Package manager: npm, not yarn

This is the single most consequential change against older Theia knowledge.

- `lerna.json:3` — `"npmClient": "npm"`.
- The lockfile in git is `package-lock.json` (there is no `yarn.lock`).
- CI installs with `npm ci`: `.github/workflows/ci-cd.yml` "Install and Build" step
  (`npm ci` then `./scripts/check_git_status.sh`), and the same in the build matrix job.
- Node engine: `package.json:5-6` — `"engines": { "node": ">=24" }`. CI matrix is
  `node: [24.x, 26.x]` on `windows-2022`, `ubuntu-22.04`, `macos-15`.
- Python 3.13 is a build prerequisite (native modules): `actions/setup-python` with
  `python-version: '3.13'` in both CI jobs.

Install has hooks on both sides (`package.json:94-95`):

```json
"preinstall": "node-gyp install",
"postinstall": "theia-patch && npm run -s compute-references && lerna run afterInstall"
```

`theia-patch` is a bin of `@theia/cli` (`dev-packages/cli/package.json:23-26`), applying the
patches in `dev-packages/cli/patches` (`dev-packages/cli/package.json:18-21`).
`allowScripts` (`package.json:140-…`) is an explicit allow/deny list of which dependencies may
run install scripts (`node-pty: true`, `nx: false`, …).

## The three build layers

`package.json:74-81`:

```json
"all": "npm -s install && npm run -s lint && npm run -s build",
"build": "npm run compile && npm run build:applications",
"build:applications": "npm run build:browser && npm run build:browser-only && npm run build:electron",
"compile": "lerna run compile",
```

1. **`compile`** — `lerna run compile`, which in each package is `theiaext compile`
   (`packages/core/package.json:213`), i.e.
   `ts-clean-dangling && tsc --project .`
   (`dev-packages/private-ext-scripts/package.json:15`). Pure TypeScript `src/` → `lib/`.
2. **`theiaext build`** — `ts-clean-dangling && tsc --build`
   (`dev-packages/private-ext-scripts/package.json:14`), the project-reference build.
3. **`theia build`** — the application bundle. In `examples/browser/package.json:103-106`:
   ```json
   "build": "theiaext build && npm run -s bundle",
   "bundle": "npm run rebuild && theia build --mode development",
   "bundle:production": "npm run rebuild && theia build --mode production",
   ```

## What `theia build` does

`dev-packages/application-manager/src/application-package-manager.ts:128-133`:

```ts
async build(args: string[] = [], options: GeneratorOptions = {}): Promise<void> {
    await this.generate(options);
    await this.copy();
    const process = this.__process.spawn('node', [bundlerGenerator.esbuildPath, ...args]);
    return this.__process.promisify('esbuild', process);
}
```

`generate` runs three generators in parallel
(`application-package-manager.ts:108-110`): `BundlerGenerator`, `BackendGenerator`,
`FrontendGenerator`. They write into `src-gen/`
(`dev-packages/application-package/src/application-package.ts:220-233`:
`srcGen()`, `backend()` = `src-gen/backend`, `frontend()` = `src-gen/frontend`).
`copy()` copies `src-gen/frontend/index.html` to `lib/frontend/index.html`
(`application-package-manager.ts:116`).

Then `node esbuild.mjs` is spawned. `esbuild.mjs` sits in the application directory and is
user-editable; it imports the machine-generated
`gen-esbuild.browser.mjs` / `gen-esbuild.node.mjs` / `gen-esbuild.electron.mjs`
(`dev-packages/application-manager/src/generator/bundler-generator.ts:61-74`,
`examples/browser/esbuild.mjs:1-13`). The generator only regenerates the user file when it does
not exist or no longer imports `gen-esbuild`
(`bundler-generator.ts:49-55`).

Bundle entry points and outputs (`bundler-generator.ts:146-154, 219-240`):

| Target | entryPoints | outdir |
|---|---|---|
| browser | `./src-gen/frontend/index.js`, `./src-gen/frontend/secondary-index.js` | `lib/frontend` |
| node | `./src-gen/backend/main`, (electron) `./src-gen/backend/electron-main` | `lib/backend` |

**webpack is gone.** `bundler-generator.ts:36-47` warns that a leftover `webpack.config.js`
is ignored — "webpack bundling was removed in Theia 1.75.0". `doc/Migration.md` (_ESBuild_
section) states the same and notes that `@theia/native-webpack-plugin` was renamed to
`@theia/bundle-plugin`.

## `theia` CLI verbs

`dev-packages/cli/src/theia.ts` (yargs). The commands are:

| Verb | Line | Purpose |
|---|---|---|
| `start [theia-args...]` | :121-122 | start the browser/electron backend |
| `clean` | :130-131 | clean for the target |
| `copy` | :137-138 | copy files from `src-gen` to `lib` |
| `generate` | :147-148 | generate `src-gen` for the target |
| `build [bundler-args...]` | :160-161 | "Generate and bundle the … frontend using esbuild" |
| `rebuild`, `rebuild:browser`, `rebuild:electron` | :183-185 | rebuild native node modules per target |
| `check:hoisted` | :189-190 | all dependencies hoisted |
| `check:theia-version` | :215-216 | all deps resolved to the same Theia version |
| `check:theia-extensions` | :241-242 | uniqueness / hoisting of Theia extension versions |
| `check:dependencies` | :274-275 | uniqueness / hoisting of dependency versions |
| `download:plugins` | :362-363 | download the declared VS Code plugins |
| `nls-localize [languages...]` | :457-458 | translate via DeepL |
| `nls-extract` | :508-509 | extract translation keys from source |
| `test [theia-args...]` | :562 | run the browser test page |
| `ffmpeg:replace`, `ffmpeg:check` | :648, :676 | strip proprietary codecs from Electron's ffmpeg |

`@theia/cli` bins: `theia` and `theia-patch` (`dev-packages/cli/package.json:23-26`).

## Watch

There are two watchers and they run concurrently, per application
(`examples/browser/package.json:115-120`):

```json
"start:watch": "concurrently --kill-others -n tsc,bundle,run -c red,yellow,green \"tsc -b -w --preserveWatchOutput\" \"npm run -s watch:bundle\" \"npm run -s start\"",
"watch":       "concurrently --kill-others -n tsc,bundle -c red,yellow \"tsc -b -w --preserveWatchOutput\" \"npm run -s watch:bundle\"",
"watch:bundle": "theia build --watch --mode development",
"watch:compile": "tsc -b -w"
```

So a Theia watcher is: **(a) `tsc -b -w` over the whole project-reference graph, and
(b) `theia build --watch`, which is `esbuild` in context/watch mode**
(`examples/browser/esbuild.mjs:15-19` — `browserContext.watch()` / `nodeContext.watch()`).

At package level (`dev-packages/private-ext-scripts/package.json:19-20`):

```json
"ext:watch": "concurrently --kill-others -n cleanup,tsc -c magenta,red \"ts-clean-dangling -w\" \"tsc -b -w --preserveWatchOutput\"",
"ext:watch:fast": "tsc -p -w"
```

Root-level (`package.json:112-115`): `watch:browser`, `watch:browser-only`, `watch:electron`,
and `watch` = both browser and electron concurrently.

A **foreign-watcher marker** for a project type: the process names are `tsc`, `esbuild`
(spawned as `node <app>/esbuild.mjs --watch`), and `ts-clean-dangling`; `concurrently` labels
them `tsc`/`bundle`/`run`/`cleanup`.

## Lint

- Root: `package.json:91` — `"lint": "lerna run lint"`; `"lint:fix": "lerna run lint -- --fix"`
  (`:93`); `"lint:clean": "rimraf .eslintcache"` (`:92`).
- Per package: `"lint": "theiaext lint"` (`packages/core/package.json:217`) →
  `eslint --cache=true --no-error-on-unmatched-pattern=true "{src,test}/**/*.{ts,tsx}"`
  (`dev-packages/private-ext-scripts/package.json:17`).
- Config chain: `<pkg>/.eslintrc.js` → `configs/build.eslintrc.json` →
  `configs/base.eslintrc.json` + `configs/errors.eslintrc.json`
  (`packages/core/.eslintrc.js:1-10`, `configs/build.eslintrc.json:1-11`). See `08`.
- ESLint 8 (`package.json` devDependencies `"eslint": "^8.57.1"`), i.e. **eslintrc, not flat
  config**.

## Test

Three separate runners.

### 1. Node/headless unit tests (mocha + nyc)

`dev-packages/private-ext-scripts/package.json:21-23`:

```json
"ext:test": "nyc mocha --config ../../configs/mocharc.yml \"./lib/**/*.*spec.js\"",
"ext:test:watch": "mocha -w --config ../../configs/mocharc.yml \"./lib/**/*.*spec.js\"",
"ext:test:clean": "rimraf .nyc_output coverage"
```

Note the glob runs over **compiled `lib/`, not `src/`** — tests must be compiled first
(`doc/Testing.md:5`).

`configs/mocharc.yml:1-8` requires `ignore-styles`, `reflect-metadata/Reflect` and
`@theia/test-setup` (the `dev-packages/private-test-setup` package), reporter `spec`,
`exit: true`.
`configs/nyc.json` includes `src/**/*.ts`, excludes `src/typings` and `src/**/*.spec.ts`.

### 2. Browser tests (`theia test`, puppeteer + mocha in-page)

`examples/browser/package.json:116-117`:

```json
"test": "theia test . --plugins=local-dir:../../plugins --test-spec=../api-tests/**/*.spec.js",
"test:debug": "npm run -s test -- --test-inspect"
```

`dev-packages/cli/src/test-page.ts` launches a page, injects `mocha/mocha.js` and waits for
`window.chai`, `window.mocha` and `window.theia.container` (`:87-88`), then
`mocha.run(...)` (`:131`). File collection uses mocha's own `collect-files`
(`test-page.ts:20`). The `test` command's options (`dev-packages/cli/src/theia.ts:562-600`)
are `--test-extension`, `--test-file`, `--test-ignore`, `--test-recursive`, `--test-sort`,
`--test-spec` (default `['test']`), `--test-coverage`, `--test-inspect`.

### 3. Electron tests (electron-mocha)

`examples/electron/package.json:116`:
`"test": "electron-mocha --timeout 60000 \"./lib/test/**/*.espec.js\""`.
The `.espec.js` extension marks an Electron-only spec.

### How a subset of tests is selected

| Granularity | Command | Evidence |
|---|---|---|
| All CI tests | `npm run test` | `package.json:106` |
| All package unit tests | `npm run test:theia` = `lerna run --scope "@theia/!(example-)*" test --stream --concurrency=1` | `package.json:109` |
| One package | `npx lerna run test --scope @theia/<name>` | `doc/Testing.md:13-15` |
| One package, watch | `npx lerna run test:watch --scope @theia/<name>` (the package must add the script) | `doc/Testing.md:17-25` |
| One file / pattern | mocha's own `--grep` / glob via `theiaext test` is not parameterised; run `npx mocha --config configs/mocharc.yml "<glob>"` directly | `dev-packages/private-ext-scripts/package.json:21` |
| Browser spec subset | `theia test . --test-spec=<glob>` | `examples/browser/package.json:116`, `theia.ts:595` |
| Playwright | `npm run test:playwright` | `package.json:110` — see `12` |

Test-file naming is a **convention with meaning** (`doc/Testing.md:29-42, 50-53`):
`foo.spec.ts` (unit, published), `foo.slow-spec.ts` (excluded), `foo.ui-spec.ts` (UI,
unpublished), `foo.espec.ts` (Electron), and `test-resources/` for fixtures.

## Maintenance scripts

`scripts/` (`ls scripts`): `check-publish.js`, `check_git_status.sh`, `compile-references.js`,
`fetch-dash-licenses-jar.js`, `generate-typedoc-per-package.js`,
`merge-package-typedocs.js`, `npm-install-with-platforms.js`, `prepare-initial.js`,
`replace-license-headers.js`, `translation-update.js`, `verify-lockfile-platforms.js`,
`zip-native-dependencies.js`, plus `performance/` and `deps/`.

CI gate worth copying: `./scripts/check_git_status.sh` runs after install and after build in
both CI jobs — **the tree must be unchanged by installing or building**. Since `postinstall`
regenerates `tsconfig.json` references (`02`), that check is what keeps generated files
committed and in sync.

`.github/workflows/license-check.yml` + `package.json:88-90` run the Eclipse Dash license tool
against `configs/license-check-config.json`.

## Measured on this machine (32 cores, 92 GiB RAM, Node 24.18.0, npm 11.16.0)

| Step | Time | Result |
|---|---|---|
| `git clone` | — | 201 MiB |
| `npm ci` | **59 s** | exit 0; `node_modules` 1.3 GiB; tree still clean |
| `npm run build` | **102 s** | exit 0; all three applications bundled |
| Clone after build | — | **3.2 GiB** |

`npm run build` produced `examples/browser/lib` 441 MiB, `examples/electron/lib` 464 MiB,
`examples/browser-only/lib` 253 MiB, `.browser_modules` 29 MiB, `packages/*/lib` 77 MiB total.
The development-mode browser bundle is `bundle.js` 47.5 MB + `bundle.js.map` 83.2 MB.

`./scripts/check_git_status.sh` exits 0 after both install and build — confirmed empirically.
Full log in `commands.md`.
