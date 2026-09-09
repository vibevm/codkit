# 11 — Release packaging

## Upstream does not package a desktop application

**There is no `electron-builder` configuration anywhere in the repository.**
`find . -name 'electron-builder*'` returns nothing; the only three mentions of the tool in
the whole tree are prose:

- `dev-packages/application-package/src/application-props.ts:93` — a comment saying a
  window option corresponds to something "in the electron-builder config";
- `doc/Migration.md:98,100` — advice to adopters who "use custom packaging (e.g.
  `electron-builder`, `electron-forge`)" to include `lib/backend/shell-integrations` in the
  `files` pattern.

So **electron-builder is an adopter's concern, and Theia's contract with it is `lib/`**: the
built application directory (`lib/frontend`, `lib/backend`, `lib/backend/electron-main.js` as
`main`, plus `resources/` and `plugins/`) is what a packager must wrap. `examples/electron`
declares `"main": "lib/backend/electron-main.js"` (`examples/electron/package.json:6`) and
`"productName": "Theia Electron Example"` (`:4`) — the two fields electron-builder reads —
but no builder ever consumes them upstream.

There are no signing hooks, no notarization steps, no `.icns`/`.ico` generation, no
installer configuration in the repository.

## What upstream *does* release

### 1. npm packages — the real release artefact

`package.json:96-99`:
```json
"publish:latest": "lerna publish --exact --yes",
"publish:patch":  "lerna publish --exact --yes --dist-tag patch",
"publish:next":   "lerna publish --canary preminor --exact --yes --preid next --dist-tag next && npm run -s publish:check next",
"publish:check":  "node scripts/check-publish.js",
```

`lerna.json:5-13` configures publishing: `forcePublish: true`, `graphType: "all"`,
registry `https://registry.npmjs.org/`, `push: false`, `gitTagVersion: false`.

The workflow is `.github/workflows/publish-ci.yml` (manual `workflow_dispatch`, Node 24,
Python 3.13, "Install and build", then one of the three publish scripts, then a PR with the
version bumps). Procedure for maintainers: `doc/Publishing.md`.

### 2. Prebuilt native dependencies

`.github/workflows/native-dependencies.yml` — a matrix build that installs, builds the browser
example, then `npm run zip:native:dependencies`
(`package.json:120` → `scripts/zip-native-dependencies.js`), which archives into
`native-dependencies-${process.platform}-${process.arch}.zip`
(`scripts/zip-native-dependencies.js:25, 36-38`) and uploads it as an artifact, finally
publishing them to the rolling `next` GitHub pre-release.

This is the closest thing to a binary release, and it exists to save adopters a native
rebuild — not to ship an IDE.

### 3. API documentation

`.github/workflows/publish-api-doc-gh-pages.yml`, driven by
`package.json:84-87` (`typedoc`, `scripts/generate-typedoc-per-package.js`,
`scripts/merge-package-typedocs.js`, `configs/*.typedoc.json`).

### 4. SBOM

`.github/workflows/generate-sbom.yml` — `cdxgen` over the installed tree, uploaded as an
artifact.

## The Electron-specific packaging steps Theia *does* own

- **Native module rebuild.** `theia rebuild:browser` / `theia rebuild:electron`
  (`dev-packages/cli/src/theia.ts:183-185`, implementation
  `dev-packages/application-manager/src/rebuild.ts`), invoked before every bundle
  (`examples/electron/package.json:108, 112` — `"bundle": "npm run rebuild && theia build …"`,
  `"rebuild": "theia rebuild:electron --cacheRoot ../.."`). The cache directory is
  `.browser_modules` at the repo root (`package.json:104`).
- **ffmpeg codec stripping.** `theia ffmpeg:replace [ffmpeg-path]` and
  `theia ffmpeg:check [ffmpeg-path]` — "(electron-only) Check that ffmpeg doesn't contain
  proprietary codecs" (`dev-packages/cli/src/theia.ts:648, 676-683`), implemented in
  `dev-packages/ffmpeg`. This is the legal gate a distribution must pass; it operates on the
  Electron shared library **after** packaging has placed it.
- **Electron version** is a devDependency of the application, not of the framework:
  `examples/electron/package.json:123` — `"electron": "42.8.1"`.

## Production build

`examples/browser/package.json:104, 106`:
```json
"build:production": "theiaext build && npm run -s bundle:production",
"bundle:production": "npm run rebuild && theia build --mode production"
```
Production means `minify: true`, `sourcemap: false`, gzip copies of the frontend assets
(`dev-packages/application-manager/src/generator/bundler-generator.ts:112-121`).

`examples/electron` has **no** `build:production` script — only `build`
(`examples/electron/package.json:107`).

Smoke test of the production path: `.github/workflows/production-smoke-test.yml` builds
`examples/browser` with `build:production` and runs the `theia-app` Playwright suite against
it.

## Consequence for a project type

Packaging is the **one area where a Theia project type has no upstream answer to borrow**.
The type must either declare packaging out of scope (build stops at `lib/`) or carry a
downstream-supplied electron-builder configuration as a resource file. Nothing upstream will
conflict with it, and nothing upstream will verify it.
