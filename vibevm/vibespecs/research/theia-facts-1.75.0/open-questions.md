# Open questions — what this spike did not establish

Everything below was either out of the packet's reach or could only be answered by running
the tree, and is flagged rather than guessed.

## Not established from files

1. **Whether `theia nls-extract` can serve a package outside `packages/`.**
   `scripts/translation-update.js:29-38` hard-codes the glob
   `./packages/**/{browser,electron-browser,common}/**/*.{ts,tsx}`. The CLI itself takes
   `--root` and `--files` (`dev-packages/cli/src/theia.ts:513-538`), so it is very likely
   possible, but the behaviour was not exercised.

2. **The exact semantics of `check:theia-extensions` and `check:dependencies`** beyond their
   `describe` strings (`dev-packages/cli/src/theia.ts:241-330`). Their failure modes matter to
   a project type's `verify`, and reading `dev-packages/cli/src/check-dependencies.ts` in
   depth was not done.

3. **The `secondaryWindow` and `preload` / `frontendPreload` container lifecycles.** The maps
   exist (`application-package.ts:165-183`) and the generator emits a second container
   (`frontend-generator.ts:213-221`), but which contributions run in which is not traced.

4. **Whether `rebind` of a service bound in a *child* container behaves the same as in the
   root container** for an override that a downstream would want. Upstream does both
   (`packages/outline-view/src/browser/outline-view-frontend-module.ts:44-45`), and the
   difference is real but was not characterised.

5. **`browser-only` target details.** `examples/browser-only` exists and
   `application-package.ts:154-159, 273-278` handles it, but the target was not examined; it
   may or may not be a third value a project type must model beside `browser`/`electron`
   (`theia.target` only enumerates two — `application-props.ts:318-322` — while
   `isBrowserOnly` is a separate predicate).

6. **`@theia/re-exports` / `private-re-exports`.** `packages/core/package.json:215-216` runs
   `theia-re-exports generate` in `afterInstall` and regenerates `README.md` from a template.
   That is a generated-file hazard for a fork (the clean-tree CI gate will notice) but the
   mechanism was not read.

7. **`.theia/` at the repo root and in `examples/browser`.** Present, not inspected.

8. **`dev-packages/cli/patches/`** — applied on every install by `theia-patch`
   (`package.json:95`). What they patch was not read; for a fork this is a place where
   upstream mutates `node_modules`.

9. **The `remote` / `dev-container` packages' effect on the application model.** Ignored.

10. **`scripts/prepare-initial.js`, `scripts/npm-install-with-platforms.js`,
    `scripts/verify-lockfile-platforms.js`.** Named in `03`/`08` from their call sites; their
    contents were not read.

## Established by running, after all

The optional install and build were attempted and both succeeded well inside the 20-minute
cap (`npm ci` 59 s, `npm run build` 102 s, clone 201 MiB -> 3.2 GiB). See `commands.md`.
What remains unestablished from that direction:

11. **Whether the three example applications actually start**, and what `theia start` prints.
    Not attempted; it needs `theia download:plugins` first.

12. **The test suites were not run** — neither `npm run test:theia`, nor `theia test`, nor
    Playwright. So the claims in `03` and `12` about how a subset is selected come from the
    scripts and configs, not from observed runs.

13. **The generated `src-gen/` content was not inspected.** The claims in `09` about what is
    baked in come from reading the generator templates. `examples/browser/src-gen` does exist
    after the build and is only 52 KiB, which is consistent with them, but they were not
    verified against the emitted text.

14. **Lint was not run** (`npm run lint`). The rules in `08` are read from the configs and the
    rule implementations.

## Deliberately out of scope

15. **Upgrade advisory readers** (DESIGN-001 §2 item 5): what a Theia type would compare
    between two pins. Candidates visible from this spike are `lerna.json` version,
    `package.json` `theiaPlugins` map (the built-in VS Code extensions — the direct analogue of
    VS Code's `product.json` built-ins), the Electron version in an application's
    devDependencies (`examples/electron/package.json:123`), the TypeScript version
    (`package.json` devDependencies `~5.9.3`), and the Node engine (`package.json:5-6`). None
    of this was designed, only noticed.

16. **A Theia runtime library** (DESIGN-001 §2 item 7). Out of the packet.

17. **A seam catalogue for Theia** (DESIGN-001 §2 item 8). Out of the packet. The raw material
    is the contribution-point inventory (`ContributionProvider` symbols) and the 41 packages
    that `rebind`; neither was enumerated exhaustively.

18. **Brand images** (DESIGN-001 §2 item 6). Upstream has no icon target table at all
    (`05`, `11`), so there is nothing to extract; a Theia type would have to invent one or
    declare the capability absent.
