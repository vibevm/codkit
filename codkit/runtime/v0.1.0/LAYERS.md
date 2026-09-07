<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->

# Codkit runtime — import layers

The runtime sits inside the product's own layer (`src/vs/<own>/codkit/`) and
touches upstream through a deliberately narrow surface. The table below is
both the rule the library follows and the content of the `code-import-patterns`
targets the product adds for `src/vs/<own>/codkit/~` (shape them like upstream's
own top-level layer targets).

| Folder | May import |
|---|---|
| `common/**` | `vs/base/common/**`, `vs/platform/*/common/**`, the runtime's own `common/**` |
| `browser/**` | everything `common/**` may, plus `vs/workbench/common/contributions.js`, `vs/workbench/services/host/browser/host.js`, `vs/workbench/services/lifecycle/common/lifecycle.js`, `vs/nls.js`, the runtime's own `browser/**` |
| `test/**` | everything above, plus `vs/base/test/common/**`, `vs/platform/*/test/common/**` |

Never imported: anything under `vs/workbench/contrib/**`, any `node/` or
`electron-main/` layer, any module marked internal.

Every upstream API the runtime uses is reached from `browser/adapters/*.ts`,
`browser/browserFeatureFlagsService.ts`, `browser/featureRegistry.ts`,
`browser/featuresHost.contribution.ts` and `browser/featureFlags.contribution.ts`.
A change of an upstream API is a change of one of those files, never of
`common/**` or of a product's features.

The product's composition root imports `browser/featureFlags.contribution.js`
once, after its own feature declarations; the import must be relative
(`'../codkit/browser/featureFlags.contribution.js'`), as upstream's lint rejects
absolute `vs/...` specifiers.
