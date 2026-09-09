# 05 — The application / product model

## An application is a package.json

There is **no `product.json`**. A Theia application is an npm package whose `package.json`
carries a `theia` section plus a dependency list. The whole product identity lives there.

`examples/browser/package.json:1-24`:

```json
{
  "private": true,
  "name": "@theia/example-browser",
  "version": "1.75.0",
  "license": "EPL-2.0 OR GPL-2.0-only WITH Classpath-exception-2.0",
  "theia": {
    "frontend": {
      "config": {
        "applicationName": "Theia Browser Example",
        "preferences": {
          "files.enableTrash": false,
          "security.workspace.trust.enabled": false
        },
        "reloadOnReconnect": true
      }
    },
    "backend": {
      "config": {
        "frontendConnectionTimeout": 3000,
        "configureProxyFromPreferences": true
      }
    }
  },
  "theiaPluginsDir": "../../plugins",
  …
}
```

`examples/electron/package.json:1-29` adds the Electron shape:

```json
  "productName": "Theia Electron Example",
  "main": "lib/backend/electron-main.js",
  "theia": {
    "target": "electron",
    "frontend": { "config": {
        "applicationName": "Theia Electron Example",
        "reloadOnReconnect": true,
        "electron": {
          "splashScreenOptions": { "content": "resources/theia-logo.svg", "height": 90 },
          "appUserModelId": "EclipseTheia.ElectronExample"
        } } },
    "backend": { "config": { "frontendConnectionTimeout": -1, "configureProxyFromPreferences": true } }
  },
```

## The schema of the `theia` section

`dev-packages/application-package/src/application-props.ts`:

| Key | Line | Note |
|---|---|---|
| `ApplicationProps` interface | :286-315 | `target`, `frontend.config`, `backend.config`, `generator.config`, plus `NpmRegistryProps` |
| `ApplicationProps.Target` enum | :318-322 | `browser` \| `electron` (`isBrowserOnly` is separate) |
| `ApplicationProps.DEFAULT` | :324-336 | defaults merged under the package's own values |
| `FrontendApplicationConfig.DEFAULT` | :133-138 | **`applicationName: 'Eclipse Theia'`**, `defaultIconTheme: 'theia-file-icons'`, `electron: ElectronFrontendApplicationConfig.DEFAULT` |
| `FrontendApplicationConfig` fields | :157-181 | `defaultIconTheme`, `applicationName`, `electron`, preference defaults, JSON-schema validation flag |
| `BackendApplicationConfig.DEFAULT` | :201-204 | `frontendConnectionTimeout: 0` |
| `BackendApplicationConfig` fields | :219-231 | `frontendConnectionTimeout`, `configureProxyFromPreferences`, `singleInstance` |
| `ElectronFrontendApplicationConfig.DEFAULT` | :34-… | splash screen, `windowOptions` overrides, `appUserModelId` |
| `GeneratorConfig.DEFAULT` | :249 | |
| `NpmRegistryProps.DEFAULT` | :277 | |

The section is read into `ApplicationPackage.props` and merged with `DEFAULT`
(`FrontendApplicationConfigProvider.set` does `deepmerge(FrontendApplicationConfig.DEFAULT, config)` —
`packages/core/src/browser/frontend-application-config-provider.ts:40`).

## Where identity and branding actually reach the running app

The config is **baked into generated code at build time** (see also `09`):

- Frontend: `dev-packages/application-manager/src/generator/frontend-generator.ts:80-82`
  emits into `src-gen/frontend/index.js`
  `FrontendApplicationConfigProvider.set(<pretty-printed literal of theia.frontend.config>)`.
- Page title: `frontend-generator.ts:70` —
  `<title>${this.pck.props.frontend.config.applicationName}</title>` in the generated
  `index.html`.
- Backend: `backend-generator.ts:204` —
  `BackendApplicationConfigProvider.set(<literal of theia.backend.config>)`.
- Electron main: `backend-generator.ts:66` — `const config = <literal of frontend config>;`
  then `application.start(config)` (`:95`).

At runtime the one funnel for branding strings is
`FrontendApplicationConfigProvider.get().applicationName`
(`packages/core/src/browser/frontend-application-config-provider.ts:25-31`). Its call sites are
the product-name surface:

| Surface | Evidence |
|---|---|
| About dialog title | `packages/core/src/browser/about-dialog.tsx:52` |
| Window / document title | `packages/core/src/browser/window/window-title-service.ts:40, 116` |
| Electron BrowserWindow title | `packages/core/src/electron-main/electron-main-application.ts:501` |
| Common frontend contribution | `packages/core/src/browser/common-frontend-contribution.ts:1116` |
| Getting-started page | `packages/getting-started/src/browser/getting-started-contribution.ts:97` |
| Electron restart prompt | `packages/core/src/electron-browser/menu/electron-menu-contribution.ts:280` |
| AI packages (product-name variable, welcome message, agents) | `packages/ai-core/src/browser/product-name-variable-contribution.ts:43`, `packages/ai-ide/src/browser/ide-chat-welcome-message-provider.tsx:281,305`, and ~10 more |

**Consequence: renaming the product needs one JSON key, not a source graft.** The
`applicationName` of `package.json` is the funnel; there is no equivalent of a
`product.json` + a brand `nls.ts` graft.

### About-dialog / version

`packages/core/src/node/application-server.ts:33-45` — `getApplicationInfo()` returns
`{ name, version }` read from the **application's own `package.json`** at runtime
(`this.applicationPackage.pck`), and `getExtensionsInfos()` (`:29-31`) returns the baked
extension list (see `09`). `getApplicationRoot()` (`:47-49`) returns the project path.

### Icons, splash, logo

- Electron splash screen: `theia.frontend.config.electron.splashScreenOptions.content`
  pointing at a file in the application directory
  (`examples/electron/package.json:15-18` → `examples/electron/resources/theia-logo.svg`;
  that directory holds exactly one file).
- `defaultIconTheme` (`application-props.ts:136`) selects the *file icon* theme, not the app
  icon.
- Upstream's own logo assets live in `logo/` at the repo root; **no icon target table, no
  `.icns`/`.ico`/`.bmp`/`.xpm` generation exists upstream** — see `11` and
  `open-questions.md`.

### Preference defaults

`theia.frontend.config.preferences` is a plain object of preference id → default
(`examples/browser/package.json:10-13`). That is the product-level way to change a default
without touching a schema.

## `theia build` / `theia start`

Documented under `03`. In brief:
`theia build` = generate `src-gen/` + copy + `node esbuild.mjs`
(`dev-packages/application-manager/src/application-package-manager.ts:128-133`);
`theia start` dispatches to `startElectron` / `startBrowserOnly` / `startBrowser`
(`:136-198`), preferring the bundled `lib/backend` and falling back to the generated
`src-gen` (`:174`, `:198`).

`examples/browser/package.json:112-114`:
```json
"start:plugins": "theia start --plugins=local-dir:../../plugins --ovsx-router-config=../ovsx-router-config.json",
"start": "npm run -s start:plugins -- --log-config=log-config.json",
```

## No `@theia/generator-theia`

There is no scaffolding generator package in the tree at this version — `@theia/cli` has
`generate` (which writes `src-gen`, not a new project) but nothing that creates an
application skeleton. A downstream creates the application `package.json` by hand or copies
`examples/browser`.
