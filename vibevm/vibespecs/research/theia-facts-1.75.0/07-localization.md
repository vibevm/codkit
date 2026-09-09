# 07 — Localization (`nls`), and the funnels comparable to VS Code's `nls.ts`

## The API

`packages/core/src/common/nls.ts` defines `export namespace nls` (`:19`) with exactly two
string functions:

| Function | Line | Meaning |
|---|---|---|
| `nls.localize(key, defaultValue, ...args)` | :57-59 | a **Theia-owned** string with an explicit key |
| `nls.localizeByDefault(defaultValue, ...args)` | :34-44 | "Automatically localizes a text if that text also exists in the vscode repository" (`:32-33`) — no key given |

Supporting members: `defaultLocale = 'en'` (`:23`), `localeId = 'localeId'` (`:25`),
`locale` read from `window.localStorage` (`:27`), `setLocale` (`:68-70`),
`isSelectedLocale` (`:61-66`), `setHtmlLang` (`:79-82`), `setHtmlNoTranslate` (`:92-95`).

Import path for consumers: `@theia/core/lib/common/nls`.

## The two funnels

### Funnel A — Theia's own strings: `packages/core/i18n/nls.json`

`ls packages/core/i18n` → 15 files: `nls.json` (the English source of truth) plus
`nls.cs.json`, `nls.de.json`, `nls.es.json`, `nls.fr.json`, `nls.hu.json`, `nls.it.json`,
`nls.ja.json`, `nls.ko.json`, `nls.pl.json`, and more.

`nls.json` is a flat map key → English text, e.g.
`"ai-chat-ui.show-settings": "Show AI Settings"`. It is **generated**, not hand-edited:

`scripts/translation-update.js:5,29-38`:
```js
const NLS_FILE = './packages/core/i18n/nls.json';
…
cp.spawnSync('npx', ['theia', 'nls-extract',
    '-o', NLS_FILE,
    '-e', 'vscode',
    '-f', './packages/**/{browser,electron-browser,common}/**/*.{ts,tsx}'
], …);
```

i.e. `theia nls-extract` (`dev-packages/cli/src/theia.ts:508-542`) scans exactly the
`browser`, `electron-browser` and `common` folders of `packages/**`, excludes keys starting
with `vscode` (`-e vscode`), and writes `nls.json`. Then, if the file changed,
`theia nls-localize` translates the changed keys through the DeepL API
(`translation-update.js:11-22, 82`; the CLI command at `theia.ts:457-497`;
implementation in `dev-packages/localization-manager/src/deepl-api.ts`).
Automation: `.github/workflows/translation.yml`.

**Consequence for a downstream:** `-f './packages/**/...'` is a repository-shaped glob. A
downstream package placed under `packages/` is picked up by the same extraction; a package
elsewhere is not, unless the glob is changed.

### Funnel B — VS Code's strings: `nls.metadata.json`

`packages/core/src/common/i18n/nls.metadata.json` is a **vendored copy of VS Code's
localization metadata** — `{ "keys": { "vs/base/browser/ui/...": [...] }, "messages": {...} }`.

`nls.ts:100-140` (`class LocalizationKeyProvider`) inverts it into a
`message → key` map so that `localizeByDefault('Close Editor')` resolves to the VS Code key
`vscode/editor.contribution/closeEditor` without the caller ever naming a key. A
`preferredKeys` set (`:105-111`) disambiguates messages that VS Code uses under several keys.

This is the closest analogue of VS Code's own `nls.ts` funnel, and it is **inverted**: in VS
Code the source names the key; in Theia the source names the *English text* and the key is
looked up.

### Runtime assembly

`packages/core/src/node/i18n/localization-contribution.ts:23-25` defines the
`LocalizationContribution` symbol; `:56-64` `registerLocalizationFromFile(localizationPath, locale?)`
reads a translation JSON and `:104-106` infers the locale from the file name.
`packages/core/src/node/i18n/theia-localization-contribution.ts` registers Theia's own
`i18n/nls.*.json`. Contributions are collected through `ContributionProvider`
(`localization-contribution.ts:35-36`) and served to the frontend by
`packages/core/src/node/i18n/localization-server.ts`.

A downstream adds its own translations by binding a `LocalizationContribution` — an additive
DI contribution, no upstream edit.

The frontend/backend/browser-only wiring is itself a `theiaExtensions` entry of `@theia/core`
(`packages/core/package.json:152-156`):
```json
{ "frontend": "lib/browser/i18n/i18n-frontend-module",
  "frontendOnly": "lib/browser-only/i18n/i18n-frontend-only-module",
  "backend": "lib/node/i18n/i18n-backend-module" }
```

## The lint rule that guards funnel B

`@theia/localization-check` (error level —
`configs/errors.eslintrc.json:144`) loads `nls.metadata.json`
(`dev-packages/private-eslint-plugin/rules/localization-check.js:5-8`) and, for every
`nls.localizeByDefault('…')`, refuses a default value that is not one of VS Code's messages,
offering the nearest match by Levenshtein distance as an auto-fix (`:29-53`):

> `'<value>' is not a valid default value. Did you mean '<nearest>'?`

So **`localizeByDefault` cannot be used for a product's own strings** — a downstream's own
text must go through `nls.localize(key, text)` and its own translation files, or lint fails.
This is the single most important localization constraint for a fork.

## Not established

- Whether `theia nls-extract` can be pointed at a downstream package outside `packages/`
  without editing `scripts/translation-update.js` (the glob is hard-coded there; the CLI
  option `--root`/`-f` exists at `theia.ts:513-538`, so it is likely possible — not verified
  by running it).
