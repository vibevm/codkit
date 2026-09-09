# 08 — Hygiene and lint: the rules that would refuse foreign code

Theia has no `hygiene` gulp task. Everything is ESLint 8 (eslintrc), one shared config chain,
plus six repository-specific rules in a private plugin.

## The config chain

```
<pkg>/.eslintrc.js                        packages/core/.eslintrc.js:1-10
   → configs/build.eslintrc.json          :1-11
        → configs/base.eslintrc.json      :1-29
        → configs/errors.eslintrc.json    :1-188
```

`configs/base.eslintrc.json:10-19` loads the plugins:
`@theia` (the private plugin), `@typescript-eslint`, `@typescript-eslint/tslint`,
`import`, `no-null`, `eslint-plugin-deprecation`, `eslint-plugin-react`,
`eslint-plugin-no-unsanitized`. `ignorePatterns` is `["node_modules", "lib"]` (`:25-28`).

Each package's `.eslintrc.js` also sets `parserOptions.tsconfigRootDir: __dirname` and
`project: 'tsconfig.json'` (`packages/core/.eslintrc.js:6-9`) — i.e. **type-aware linting per
package**, so a new package must have its own `.eslintrc.js` and `tsconfig.json` or it is not
linted at all.

Two side configs, not in the default chain: `configs/warnings.eslintrc.json`
(await-thenable, `deprecation/deprecation`) and `configs/xss.eslintrc.json`
(`no-unsanitized/DOM` with `DOMPurify.sanitize` as the escape hatch, `no-eval`,
`react/no-danger`).

## The license-header rule — the one that refuses foreign code outright

`configs/errors.eslintrc.json:105-115`, through the tslint bridge:

```json
"@typescript-eslint/tslint/config": ["error", { "rules": {
  "file-header": [ true, {
    "allow-single-line-comments": true,
    "match": "SPDX-License-Identifier: EPL-2\\.0 OR GPL-2\\.0-only WITH Classpath-exception-2\\.0"
  } ],
  …
}}]
```

Every `.ts`/`.tsx` file must begin with a header containing that exact SPDX line. The
canonical 15-line block is visible at the top of essentially every source file, e.g.
`packages/navigator/src/browser/navigator-frontend-module.ts:1-15`,
`dev-packages/application-package/src/extension-package-collector.ts:1-15`.
`scripts/replace-license-headers.js:14,37,56` rewrites headers in bulk and shows the
canonical form.

**A file pasted in from a differently licensed project fails lint immediately.** This is the
hardest hygiene edge a fork's own code has to satisfy, and the analogue of VS Code's
`hygiene` copyright check.

## The six repository-specific rules

`dev-packages/private-eslint-plugin/index.js:19-26`, all wired at **error** level in
`configs/errors.eslintrc.json:143-148`:

| Rule | What it refuses | Evidence |
|---|---|---|
| `@theia/annotation-check` | a constructor parameter of an `@injectable` class without `@inject`/`@unmanaged`/`@multiInject` | `rules/annotation-check.js:42-46` |
| `@theia/localization-check` | `nls.localizeByDefault('<text>')` where `<text>` is not a VS Code message (see `07`) | `rules/localization-check.js:5-8, 29-53` |
| `@theia/named-logger-check` | `console.*` in an `@injectable` class; `ILogger` injected without a matching `@named` tag | `rules/named-logger-check.js:40-44, 123, 150-173` |
| `@theia/no-src-import` | importing `@theia/<pkg>/src/...` instead of `/lib/...`; auto-fixable | `rules/no-src-import.js:26, 41-47` |
| `@theia/runtime-import-check` | importing across incompatible runtime folders | `rules/runtime-import-check.js:25-33, 46-63, 109-115` |
| `@theia/shared-dependencies` | depending on a dependency `@theia/core` already shares, instead of importing it from `@theia/core/shared/...` | `rules/shared-dependencies.js:31, 46, 56` |

`runtime-import-check` message (`rules/runtime-import-check.js:113-114`):
> `'<module>' cannot be imported in '<folder>', only '<allowed…>' are allowed.`

The folder matrix is in `02`.

`shared-dependencies` message (`rules/shared-dependencies.js:56`):
> `"<module>" is a @theia/core shared dependency, please use "@theia/core/shared/<module>" instead.`

This is why every module file imports inversify as
`from '@theia/core/shared/inversify'` (`packages/navigator/src/browser/navigator-frontend-module.ts:20`).

## Other error-level rules worth knowing before writing code

`configs/errors.eslintrc.json`: `@typescript-eslint/no-explicit-any` (:6),
single quotes (:7-13), semicolons (:14-17), `arrow-parens: as-needed` (:23-26),
`curly` (:29), `eqeqeq: smart` (:31-34), `max-len` 180 (:42-47),
`no-null/no-null` (:57), `no-tabs` (:66), `one-var: never` (:74-77),
`prefer-const` (:78-83), 4-space `space-before-function-paren` shape (:85-92),
`import/no-extraneous-dependencies` (:149), `import/no-dynamic-require` (:150),
`no-restricted-imports` forbidding `.`, `./`, `..`, `../` (:151-157).

Overrides (`:159-187`): spec files relax
`runtime-import-check`, `shared-dependencies`, `import/no-extraneous-dependencies`,
`no-unused-expressions`; `electron-{node,main}` may use dynamic require;
`electron-main` is exempt from `named-logger-check`.

## Beyond ESLint

- **The tree must not change on install or build.** CI runs
  `./scripts/check_git_status.sh` after `npm ci` and after `npm run build`
  (`.github/workflows/ci-cd.yml`, both jobs). Since `postinstall` regenerates every
  `tsconfig.json` references block (`03`, `02`), a new package with wrong references fails CI.
- **Lockfile platform verification**: `node scripts/verify-lockfile-platforms.js`, run in the
  lint job when `package.json`/`package-lock.json` changed.
- **License scan of dependencies**: Eclipse Dash, `package.json:88-90` and
  `.github/workflows/license-check.yml`, configured by `configs/license-check-config.json`
  (`"project": "ecd.theia"`, `"inputFile": "package-lock.json"`).
- **New package checklist**: `.github/workflows/check-new-package.yml` detects an added
  package and posts a checklist comment.
- **Publish sanity**: `scripts/check-publish.js` (`package.json:99`).
- `.editorconfig`, `tsfmt.json` and `doc/coding-guidelines.md` carry the formatting
  conventions that the tslint bridge partly enforces.
