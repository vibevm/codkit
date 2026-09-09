# 04 — Dependency injection (inversify)

Theia's DI is **InversifyJS**, re-exported from `@theia/core/shared/inversify`
(`packages/navigator/src/browser/navigator-frontend-module.ts:20`). Packages must import it
through that re-export, never directly — the `@theia/shared-dependencies` lint rule enforces it
(see `08`).

## The unit: a default-exported `ContainerModule`

Every entry named in `theiaExtensions` is a module file whose **default export is a
`ContainerModule`**. Canonical shape
(`packages/navigator/src/browser/navigator-frontend-module.ts:48-60`):

```ts
export default new ContainerModule(bind => {
    bindFileNavigatorPreferences(bind);
    bind(FileNavigatorFilter).toSelf().inSingletonScope();
    bindViewContribution(bind, FileNavigatorContribution);
    bind(FrontendApplicationContribution).toService(FileNavigatorContribution);
    bind(TabBarToolbarContribution).toService(FileNavigatorContribution);
    bind(FileNavigatorWidget).toDynamicValue(ctx => createFileNavigatorWidget(ctx.container));
    …
});
```

The `ContainerModule` callback also receives `unbind`, `isBound`, `rebind` — the signature
Theia uses for overrides.

## How the application composes the modules

The frontend entry point is **generated**, not written:
`dev-packages/application-manager/src/generator/frontend-generator.ts:73-150` emits
`src-gen/frontend/index.js`. It:

1. `require('reflect-metadata')` (`:76`);
2. sets the frontend config —
   `FrontendApplicationConfigProvider.set(<literal JSON of package.json theia.frontend.config>)`
   (`:80-82`);
3. `const container = new Container();` (`:115`);
4. loads `messagingFrontendModule` (`:116`), then the preload modules (`:98-100`), then
   `frontendApplicationModule` (`:133`) and `loggerFrontendModule` (`:137`);
5. loads **every collected extension module in order** (`:144`):
   ```js
   await load(container, require('<@theia/pkg>/<lib path>'));
   ```
   where `load` is `container.load(jsModule.default)` (`:91-93`).

The backend mirror is `backend-generator.ts:100, 182` (`await load(require('<path>'))` into the
backend container built at `:136-139` from `backendApplicationModule`, `messagingBackendModule`,
`loggerBackendModule`).

Electron main has its own container:
`backend-generator.ts:61-64` loads `electronMainApplicationModule` into a fresh `Container`,
then the `electronMain` entries.

So there are **four to six separate inversify containers** per application: frontend,
frontend preload, secondary window (`frontend-generator.ts:213-221`), backend, and (electron)
electron-main.

## Module order — the rule that makes overriding work

The module list comes from `ApplicationPackage.computeModules`
(`dev-packages/application-package/src/application-package.ts:185-201`), which walks
`this.extensionPackages` in the order produced by `ExtensionPackageCollector`.

`extension-package-collector.ts:56-86`: `collectPackage` (`:56`) recurses into a package's dependencies
*first* (`collectPackagesWithParent`) (`:83`) and only then does `this.sorted.push(extensionPackage)` (`:84`).
That is a **post-order depth-first walk of the dependency graph**, so:

> a package is always loaded **after** every package it depends on.

Because inversify's `rebind` replaces an existing binding, this ordering is the whole override
mechanism: a downstream package that declares `@theia/monaco` as a dependency is loaded after
`@theia/monaco`, and its `rebind(SomeMonacoService)` wins.

Duplicate packages are skipped by name (`extension-package-collector.ts:57-60`,
`this.visited`), and only packages whose `package.json` actually has `theiaExtensions` are
collected (`:76`, via `RawExtensionPackage.is`, defined at
`extension-package.ts:195-197` as `PublishedNodePackage.is(pck) && !!pck.theiaExtensions`).

## How a downstream overrides a service

The idiom is `rebind(<ServiceIdentifier>).to(...)` or `.toService(...)` inside the downstream's
own `ContainerModule`. 41 packages upstream do this
(`grep -rln 'rebind(' packages --include=*.ts`). Representative examples:

| Override | Evidence |
|---|---|
| `rebind(EditorManager).toService(EditorPreviewManager);` | `packages/editor-preview/src/browser/editor-preview-frontend-module.ts:35` |
| `rebind(WorkspaceService).toService(CollaborationWorkspaceService);` | `packages/collaboration/src/browser/collaboration-frontend-module.ts:29` |
| `rebind(ContextKeyService).toService(MonacoContextKeyService);` | `packages/monaco/src/browser/monaco-frontend-module.ts:94` |
| `rebind(LanguageService).toService(MonacoLanguages);` | `packages/monaco/src/browser/monaco-frontend-module.ts:110` |
| `rebind(MarkdownRenderer).to(MonacoMarkdownRenderer).inSingletonScope();` | `packages/monaco/src/browser/monaco-frontend-module.ts:153` |
| `rebind(ThemeService).toService(ThemeServiceWithDB);` | `packages/monaco/src/browser/monaco-frontend-module.ts:200` |
| `rebind(SaveableService).toService(FilesystemSaveableService);` | `packages/filesystem/src/browser/filesystem-frontend-module.ts:74` |
| `rebind(MessageClient).toService(NotificationManager);` | `packages/messages/src/browser/messages-frontend-module.ts:41` |
| `rebind(AIActivationService).toService(AIIdeActivationServiceImpl);` | `packages/ai-ide/src/browser/frontend-module.ts:161` |

Child containers also `rebind` locally, e.g.
`packages/outline-view/src/browser/outline-view-frontend-module.ts:44-45`
(`child.rebind(OutlineViewWidget).to(BreadcrumbPopupOutlineView)`).

### The recipe for an override, restated

1. The downstream package declares the package that owns the service as a **dependency**
   (this is what puts it later in the load order).
2. It declares a `theiaExtensions` entry for the right runtime
   (`frontend` / `backend` / `frontendElectron` / …).
3. Its `ContainerModule` calls `rebind(Id).to(Impl)` / `.toService(Impl)`.
4. The application lists the downstream package in its `dependencies`.

Nothing else — no registry file, no patch to an upstream source file. **This is the structural
difference from VS Code:** there is no `registerSingleton` call site inside an upstream file to
edit, and no central `workbench.common.main.ts`-style import list to graft into. The extension
point is the application's `package.json` dependency list plus the downstream package's own
`theiaExtensions`.

### What a verifier for a `service-override` layer would check

- The file default-exports a `ContainerModule`.
- It calls `rebind(<Id>)` for the declared service identifier.
- The owning package is in `dependencies` of the overriding package (otherwise load order is
  not guaranteed).
- The overriding package is reachable from the application's `dependencies`.

## Contribution points (the additive counterpart)

Beside `rebind`, the additive idiom is multi-binding to a contribution symbol —
`bind(FrontendApplicationContribution).toService(X)`,
`bind(TabBarToolbarContribution).toService(X)`,
`bindViewContribution(bind, X)`
(`packages/navigator/src/browser/navigator-frontend-module.ts:55-57`),
read back through `ContributionProvider` (`bindRootContributionProvider`, `:39`).
An addition therefore needs **no upstream edit at all**.
