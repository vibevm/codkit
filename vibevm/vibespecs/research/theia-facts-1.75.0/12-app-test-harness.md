# 12 — The application test harness

Three harnesses exist; only the third drives a running application end to end.

## A. Unit tests — mocha in Node

See `03`. `nyc mocha --config ../../configs/mocharc.yml "./lib/**/*.*spec.js"`
(`dev-packages/private-ext-scripts/package.json:21`), setup from
`dev-packages/private-test-setup` (`configs/mocharc.yml:4`), `jsdom` available as a root
devDependency. No application is started.

## B. In-page tests — `theia test` (puppeteer + mocha in the browser)

`examples/browser/package.json:116`:
```
theia test . --plugins=local-dir:../../plugins --test-spec=../api-tests/**/*.spec.js
```

`dev-packages/cli/src/test-page.ts` starts the application, opens a page, injects
`mocha/mocha.js` (`:87`), waits for `window.chai`, `window.mocha` **and
`window.theia.container`** (`:88`, 30 s timeout) — i.e. the tests run *inside* the frontend
with access to the live inversify container — then `mocha.setup({ reporter: 'spec' })` (`:112-113`)
and `mocha.run` (`:131`). Coverage via `puppeteer-to-istanbul` (`--test-coverage`,
`dev-packages/cli/src/theia.ts:600`).

The specs live in `examples/api-tests/`. This is Theia's API-level integration harness.

Electron counterpart: `electron-mocha --timeout 60000 "./lib/test/**/*.espec.js"`
(`examples/electron/package.json:116`).

## C. System tests — Playwright (`@theia/playwright`)

Package `examples/playwright` (`examples/playwright/package.json:2-3`), published as
`@theia/playwright`, `"main": "lib/index"` (`:51`) — it is a **reusable page-object library
for adopters**, not only upstream's own suite.

### Scripts (`examples/playwright/package.json:14-28`)

| Script | Command |
|---|---|
| `ui-tests` | `npm run build && playwright test --config=./configs/playwright.config.ts` |
| `ui-tests-electron` | `… cross-env USE_ELECTRON=true playwright test …` |
| `ui-tests-ci` | `… --config=./configs/playwright.ci.config.ts` |
| `ui-tests-headful` | `… --config=./configs/playwright.headful.config.ts` |
| `theia:start` | `cd ../browser && rimraf .tmp.cfg && cross-env THEIA_CONFIG_DIR=$PWD/.tmp.cfg npm run start` |
| `playwright:install` | `playwright install chromium` |
| `ui-tests-report` | allure generate + open |

Root entry point: `package.json:110` — `"test:playwright": "cd examples/playwright && npm run -s ui-tests"`.

### Configuration (`examples/playwright/configs/playwright.config.ts:19-43`)

```ts
const config: PlaywrightTestConfig = {
    testDir: '../lib/tests',          // compiled tests, not src
    testMatch: ['**/*.js'],
    workers: 1,
    fullyParallel: false,
    timeout: 60 * 1000,
    use: { baseURL: 'http://localhost:3000', browserName: 'chromium',
           permissions: ['clipboard-read'], screenshot: 'only-on-failure' },
    preserveOutput: 'failures-only',
    reporter: [['list'], ['allure-playwright']],
    webServer: { command: 'npm run theia:start', port: 3000, reuseExistingServer: true }
};
```

Four config variants exist: `playwright.config.ts`, `playwright.ci.config.ts`,
`playwright.debug.config.ts`, `playwright.headful.config.ts`.

Note `THEIA_CONFIG_DIR` pointing at a throwaway `.tmp.cfg` — the isolation mechanism for a
test run's user configuration.

### The page-object library

`examples/playwright/src/` holds ~37 page objects:
`theia-app.ts`, `theia-app-loader.ts` (browser-vs-electron switch, honouring `USE_ELECTRON`),
`theia-page-object.ts`, `theia-workspace.ts`, `theia-main-menu.ts`, `theia-explorer-view.ts`,
`theia-editor.ts`, `theia-monaco-editor.ts`, `theia-text-editor.ts`, `theia-terminal.ts`,
`theia-preference-view.ts`, `theia-quick-command-palette.ts`, `theia-about-dialog.ts`,
`theia-notification-indicator.ts`, `theia-problem-view.ts`, `theia-output-view.ts`,
`theia-notebook-editor.ts`, `theia-status-bar.ts`, `theia-toolbar.ts`, `theia-view.ts`, …

Suites in `examples/playwright/src/tests/` (16 `*.test.ts`):
`theia-app.test.ts`, `theia-application-shell.test.ts`, `theia-explorer-view.test.ts`,
`theia-getting-started.test.ts`, `theia-main-menu.test.ts`, `theia-notebook-editor.test.ts`,
`theia-output-view.test.ts`, `theia-preference-view.test.ts`, `theia-problems-view.test.ts`,
`theia-quick-command.test.ts`, `theia-sample-app.test.ts`, `theia-status-bar.test.ts`,
`theia-terminal-view.test.ts`, `theia-text-editor.test.ts`, `theia-toolbar.test.ts`,
`theia-workspace.test.ts`, plus `resources/`.

### How a subset is selected

Playwright's own positional filter, e.g.
`.github/workflows/production-smoke-test.yml`:
`npm run test:playwright -- theia-app` (runs only `theia-app*` from `lib/tests`).

### CI

- `.github/workflows/playwright.yml` — builds the browser app, caches Playwright browsers,
  installs an IPython kernel (for the notebook suite), runs
  `cd examples/playwright && npm run ui-tests-ci`, archives results.
- `.github/workflows/production-smoke-test.yml` — production build + the `theia-app` suite.
- `.github/workflows/performance-tests.yml` with
  `scripts/performance/browser-performance.js` / `electron-performance.js`
  (`package.json:116-119`, 10 runs measuring frontend startup).

## Consequence for a project type

A Theia project type gets a **first-class UI harness for free**: `@theia/playwright` is a
published library, its page objects are the stable surface, and a downstream's suite is a
package that depends on it and points `testDir` at its own compiled tests. The application
under test is started by the Playwright `webServer` block, so the harness needs only
`npm run start` to work.
