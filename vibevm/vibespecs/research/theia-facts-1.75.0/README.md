# Theia facts — upstream `master` at 1.75.0

Research output of spike S1 for DESIGN-001 (project types). These are **facts about upstream
Eclipse Theia only**. Nothing here describes, names or presumes any product built on Theia.

| | |
|---|---|
| Upstream | `https://github.com/eclipse-theia/theia`, branch `master` |
| HEAD sha | `c8926e4df55986ad77d1f24c297873f1656fc9cb` |
| HEAD date | 2026-09-08 (`chore: remove deprecated @theia/preview extension code (#18002)`) |
| Version | **1.75.0** (`lerna.json:4`); nearest release tag `v1.75.0`, 11 commits behind HEAD |
| Read on | 2026-09-09 |

Every citation is `path:line` **relative to the root of the upstream clone**. The clone used
for this spike is at `/home/olegchir/work/sbtgit/theia-master-spike` (outside every
repository) and is disposable — re-create it with
`git clone https://github.com/eclipse-theia/theia` and `git checkout c8926e4df5`.

## The map

| File | Area | Answers the DESIGN-001 §2 question |
|---|---|---|
| [`01-version-and-sha.md`](01-version-and-sha.md) | version, sha, tag shape, where the version is written | 1 — upstream identity |
| [`02-repository-layout.md`](02-repository-layout.md) | workspace globs, runtime folders, build outputs, tsconfig references | 2 — tree layout |
| [`03-build-watch-lint-test.md`](03-build-watch-lint-test.md) | npm/lerna, Node 24, `compile`/`build`/`theia build`, watchers, eslint, three test runners, subset selection | 4 — build and test |
| [`04-dependency-injection.md`](04-dependency-injection.md) | inversify `ContainerModule`, module load order, `rebind`, how a downstream overrides a service | 3 — layers (`service-override`, `entry-module`) |
| [`05-application-and-product-model.md`](05-application-and-product-model.md) | the `theia` section of `package.json`, `applicationName`, branding funnel, `theia build`/`start` | 3 — layers (`config-overlay`); 6 — brand |
| [`06-extension-model.md`](06-extension-model.md) | `theiaExtensions`, the ten entry kinds, fallbacks; plugins (`.vsix`) as the separate mechanism | 2/3 — own extensions |
| [`07-localization.md`](07-localization.md) | `nls.localize` vs `nls.localizeByDefault`, `nls.json`, the vendored `nls.metadata.json`, DeepL pipeline | 3/8 — string funnels |
| [`08-hygiene-and-lint.md`](08-hygiene-and-lint.md) | the SPDX `file-header` rule, the six `@theia/*` rules, the clean-tree CI gate | 4/9 — hygiene, conventions |
| [`09-build-time-stamps.md`](09-build-time-stamps.md) | what is baked into `src-gen` (config, title, `extensionInfo`); no sha, no build date | 4 — stamps |
| [`10-downstream-own-package.md`](10-downstream-own-package.md) | where an own package lives and how the application includes it | 2 — own layer location |
| [`11-release-packaging.md`](11-release-packaging.md) | npm publish, native-dependency zips, ffmpeg codec check — **no electron-builder upstream** | 4 — package build |
| [`12-app-test-harness.md`](12-app-test-harness.md) | `@theia/playwright`, `theia test`, electron-mocha | 4 — test runner |
| [`commands.md`](commands.md) | every command run, with exit code and last output lines | — |
| [`open-questions.md`](open-questions.md) | what could not be established | — |

## The five facts that most shape a Theia project type

1. **A Theia application is a `package.json`, not a source tree.** Product identity, preference
   defaults, Electron window options and the whole extension inventory live in the `theia`
   section and the `dependencies` list of one file the downstream owns
   (`examples/browser/package.json:6-23, 26-99`). There is no `product.json`, no
   `product.overrides.json`, no `src/vs/` equivalent.
2. **Own code is a package; including it is one dependency line.** A package with
   `theiaExtensions` in its `package.json`, placed under a workspace glob, added to the
   application's `dependencies` — and the generator emits the `container.load(...)` for it
   (`extension-package.ts:22-33`, `application-package.ts:185-201`,
   `frontend-generator.ts:144`). The VS Code "own layer + entry-module graft" pair collapses
   into a JSON key. **Additions need no upstream patch at all.**
3. **Overriding a service is `rebind` plus dependency order.** Inversify `rebind(Id).to(Impl)`
   inside the downstream's own `ContainerModule` wins because
   `ExtensionPackageCollector` pushes a package after its dependencies
   (`extension-package-collector.ts:76-80`). A `service-override` verifier must check the
   `rebind` call *and* the dependency edge that guarantees load order — not a call site in an
   upstream file.
4. **The build is npm + lerna + tsc project references + esbuild, on Node ≥ 24 — and webpack
   was removed in exactly this version.** `lerna.json:3` (`npmClient: npm`),
   `package.json:5-6`, `bundler-generator.ts:43-45`. A watcher is two processes:
   `tsc -b -w` and `theia build --watch` (esbuild context watch)
   (`examples/browser/package.json:118-120`). Any Theia knowledge predating 1.75.0 describes a
   webpack build that no longer exists.
5. **Hygiene refuses foreign code through an SPDX file-header rule and six `@theia/*` ESLint
   rules**, all at error level (`configs/errors.eslintrc.json:105-115, 143-148`) — including
   `@theia/localization-check`, which forbids `nls.localizeByDefault` for any string that is
   not one of VS Code's own messages, so a product's own text *must* use `nls.localize` with
   its own key (`rules/localization-check.js:5-8, 29-53`).

## Two facts that a project type must decide about, because upstream has no answer

- **Release packaging.** No `electron-builder` configuration exists upstream; the contract is
  only "the built `lib/` directory" (`11`).
- **Build stamping.** Nothing stamps a commit sha or build date (`09`). A downstream that wants
  one must add it.
