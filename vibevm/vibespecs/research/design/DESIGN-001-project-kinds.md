# DESIGN-001: Project types — one Codkit for VS Code, Theia and other upstreams

Status: reviewed by the owner on 2026-09-09; the rulings are in §8 and the text follows them. Genre: design document — it describes
findings and a proposal; the normative form arrives later as PROP-016 and `modules/vscode`.
Owner's request: split the VS Code knowledge out of `modules/codkit`, draw the dividing line
carefully across every specification, and design the CLI and the internal API so that the tool
switches between types of projects — several VS Code forks, several Theia forks, and later
products that are not IDEs at all (Brave, GitLab Web IDE were the reference points).

## 1. Findings: where VS Code lives in the tool today

The tool is 25 command files (5.6k lines) and 141 library files (48k lines). Read against the
list of VS Code tokens (`product.json`, `src/vs/`, `extensions/`, `gulp`, `BUILD_SOURCEVERSION`,
`electron`, `hygiene`, `code-import-patterns`, `imageset`/`icns`, `product.overrides`,
`watch-client`, `test-node`, `workbench`, `nls.ts`), the knowledge sits in three rings.

**Ring 0 - the universal engine (about four fifths of the code).** Nothing in it needs VS Code:
the patch-set model (owners, marker patches with graft budgets, the own layer mirrored by
content, resource files, rename transactions), the engines (`load`/`save`/`sync`, the
generated branch, the drift guard, `cycle`, `rebase-onto-pin`, `publish`, locks and daemons,
contained generation), licensing (carriers, notices, REUSE registries), standards packaging and
delivery, the agent protocol, JSON envelopes, the testing harness. VS Code appears there only in
wording and examples.

**Ring 1 - the VS Code type, spread through the code without a boundary.** Measured hotspots:

| Area | Files (token hits) | What is VS Code-specific |
|---|---|---|
| Brand image set | `imageset*.ts` (~150), `commands/imageset.ts` (24) | the icon target table of a VS Code distribution, ICNS/ICO/BMP/XPM forms, masters in `resources/` |
| Upgrade advisory | `cycleAdvisory.ts` (25) | reads `product.json` built-in extensions, `package.json` + `build/lib/electron.ts` for Electron/TypeScript versions |
| CI profile | `ciEngine.ts` (18) | `npm ci`, `npm run hygiene`, `npm run eslint`, compile channels, `npm run test-node -- --runGlob` |
| Own extensions | `layers/ownExtensions.ts` (14), `driftGuard.ts` (8), `status.ts` (5) | the built-in extension model: `delta/own-extensions/<name>` → `<tree>/extensions/<name>` |
| Config overlay | `layers/overlay.ts` (13), `commands/overlay.ts` (3) | the target `product.json`, the dev channel `product.overrides.json` (read under `VSCODE_DEV`), the keys the packaging step stamps |
| Own layer location | `treeIdentity.ts`, `rebaseOntoPin.ts`, `ownCopy.ts`, `runtimeLoad.ts` | `src/vs/<ownDirName>/` |
| Build watchers | `buildWrap.ts` (5), `buildChannel.ts` | the channels `watch-client-transpile`, `watch-client`, extensions, copilot; the foreign-watcher markers |
| Service overrides | `verifyEngine.ts` (3), `conventionsFile.ts` | `registerSingleton` detection, the forbidden service ids of the VS Code DI |
| Generators | `genTemplates.ts` (5), `commands/gen.ts` | the feature skeleton with VS Code DI, the `nls.ts` brand graft, `code-import-patterns` |
| Conventions | `codkit/config/conventions.json` | subsystems `workbench|editor|platform|...` in the id pattern, `forbiddenServiceIds`, the cleanup whitelist (`out*/`, `.build/`, `extensions/*/out/`) |
| Runtime library | `codkit/runtime/v1.0.0/**` | entirely VS Code: DI, observables, storage, configuration, the features host as a workbench contribution |
| Standards | `seam-catalogue.xml` (22 hits), `minimal-intervention.xml` (14) | the seam catalogue is a VS Code catalogue; the norms of §9-11 are universal but every example is VS Code |
| Skills | `ck-intervene` (1) | "how upstream would build it": workbench contribution, registry, extension point, `product.json`, built-in extension |

In the specifications the same picture: PROP-007 (74 hits), PROP-005 (25), PROP-015 (20),
PROP-010 (13), FEAT-002 (11), PROP-004 (10), PROP-014 (9), PROP-006 (7); the rest under five.
The vision itself says "a VS Code fork" (`CODKIT-DEFINITION`, `ROLE-FORK-TREE`), and the polygon
of FEAT-001 is VS Code-shaped.

**Ring 2 - the product.** The seam map per pin, the product's own code and specifications.
Already outside the tool; nothing to move.

The line to draw is the boundary of ring 1: every fact in the table above is an answer that the
VS Code *type* gives to a question the engine asks. Today the engine asks nobody - it carries the
answers inline.

## 2. The model: a type answers a fixed contract

A **project type** is the tool's knowledge of one family of upstreams. A patch set declares its
type once; the engine asks the type and never names a type's facts itself. The contract is the
list of questions the inventory found - no more:

1. **Upstream identity.** Tag pattern and pin resolution (already `tag@sha@date`), what a
   healthy tree looks like (`check-tree` fingerprints: manifest name, marker files), the
   anchor policy.
2. **Tree layout.** Where own code lives (`src/vs/<own>/` for VS Code; a package under
   `packages/` for Theia), whether and where own extensions materialize (`extensions/<name>`
   for VS Code; a workspace package plus a registration for Theia), the cleanup whitelist of
   build outputs, the forbidden patch targets, type-specific marker comment forms if any.
3. **Layers.** Which layers the type supports and how each is materialized and verified:
   `own` and `patch` and `resource-file` and `rewrite-rule` are universal; `config-overlay`
   has type-provided targets and an optional dev channel (VS Code: `product.json` with
   `product.overrides.json`); `own-extension` has a type-provided materializer; `service-override`
   has a type-provided verifier (VS Code: `registerSingleton`; Theia: inversify `rebind`
   in a container module); `entry-module` has a type-provided locator (VS Code:
   `workbench.common.main.ts`; Theia: the application's frontend module list).
4. **Build and test.** Dependency install, hygiene and lint scripts, compile channels for
   `build up|down|status|errors`, the test runner with an own-directory glob, the package
   build and its stamps (`BUILD_SOURCEVERSION`, `VSCODE_QUALITY`), foreign-watcher markers.
5. **Upgrade advisory.** The semantic readers the cycle runs between two pins (VS Code:
   built-in extensions of `product.json`, Electron and TypeScript versions).
6. **Brand images.** An optional capability with the type's target table (VS Code's icon set).
7. **Runtime library.** Which shipped runtime the type delivers (`runtime-vscode` is today's
   library; a Theia runtime would be inversify-based).
8. **Standards and skills.** The core standard is universal; the seam catalogue and the
   "how upstream builds it" list of `ck-intervene` come from the type.
9. **Conventions.** Subsystems for intervention ids, forbidden service ids, defaults the
   product's `conventionsExtensionFile` may extend.

Everything not on this list stays in the engine and is forbidden to know the type: the
graft budget, the marker grammar, the drift guard's predicate, the sacrifice-by-name of
`--discard`, the licence carriers, the generated branch, the cycle's transactions.

Three types are foreseen: `vscode` (extracted from today's code, no behaviour change),
`generic` (a plain git upstream with declared commands and no product model - the way to start
on anything before its own type exists), `theia` (the second real type, the proof that the
contract holds). Brave and GitLab Web IDE come later; see §7.

## 3. Configuration: one type per patch set, forks are patch sets

- `codkit.json` gains `"type": "vscode" | "generic" | "theia" | ...` (schema 2). A schema-1 file
  without the field reads as `vscode`, so the existing product changes nothing on the day the
  field appears. The type validates its own section, `"typeConfig": { ... }`: for VS Code the
  own directory name and the overlay target it already has; for Theia the own package name and
  the application directory; for `generic` the install, lint, build and test commands.
- **Several forks** need nothing new: a fork is a patch set with its own fork tree, bound per
  command by `--patches-dir`/`--fork-dir` or the local config, exactly as today
  (`GOAL-ANY-FORK`). Two Theia forks are two patch sets of type `theia`; a VS Code fork and a
  Theia fork side by side are two patch sets of two types. Sharing between forks happens
  through packages - standards, runtime, skills - not through the tool's configuration.
- An optional later convenience, not part of the first cut: a workspace file that names
  several patch sets and their trees so that `codkit --patch-set <name> ...` resolves roots
  without flags. The air-gapped circuit and the clean room do not depend on it.

## 4. CLI

- The verbs stay universal: `load save sync status verify inventory cycle publish ci license
  standards runtime gen build overlay marker hooks forecast rebase-onto-pin gc`. Their output
  names the type where it matters (`where`, the JSON envelope's `codkit.type`).
- Type-specific verbs are **capabilities** the type declares: `imageset` (brand images),
  `gen brand` (a string-funnel graft), `build` channels, `runtime load`. A verb whose
  capability the type does not declare refuses with `CK-E-TYPE-CAPABILITY`, exit 2, naming the
  type and the capability; no verb silently does something else.
- `codkit types` prints the registered types and their capability matrix; `codkit where` prints
  the type of the patch set.
- Error codes, hints and the FAQ stay one registry; a type may add codes under its own prefix
  (`CK-E-VSCODE-...`) only for facts the engine cannot state.

## 5. Internal API

- `packages/type-api/src/type.ts`: the `ProjectType` interface with exactly the nine areas of §2,
  each an object of small functions (`layout(config)`, `layers()`, `build()`, `advisory()`,
  `brandImages?()`, `runtime()`, `standards()`, `conventions()`), plus `id`, `configSchema`
  (zod, like `configFile.ts`) and `capabilities: ReadonlySet<Capability>`.
- **Types are separate packages from the first day** (owner ruling of 2026-09-09: the procedure of splitting is done once). The repository becomes an npm workspace: `packages/codkit` (the CLI and the engine), `packages/type-api` (the contract: the `ProjectType` interface, the capability names, the config-schema helpers), `packages/type-vscode`, `packages/type-generic`, later `packages/type-theia`. Each is its own publishable package at the development version 1.0.0. The engine resolves a type by package name (`@codkit/type-<type>`) from its own dependencies with a dynamic import; the official types are regular dependencies of the CLI package so that `npm pack` and the air-gapped supply kit (PROP-011) carry them as tarballs. A registry of the package names the engine will load stays in the engine (determinism and the clean room: no arbitrary third-party module is loaded from a patch set); adding a type is publishing a package and adding its name to the registry.
- `packages/type-vscode/**`: today's code moved, not rewritten - `imagesetTargets`,
  the `product.json` overlay with its dev channel, the extensions materializer, the CI steps,
  the build channels, the advisory readers, the skeleton templates, the `registerSingleton`
  verifier, the conventions defaults. The engine receives the type through `CommandContext`
  (`ctx.type`), resolved once from the configuration.
- `packages/type-generic/**`: no product model, no extensions, no DI verification; install,
  lint, compile and test commands declared in `typeConfig`; the own directory is a configured
  path. Enough to run `load|save|verify|cycle|publish|ci` over any git upstream.
- Tests: the engine's tests run against a type stub; each type has its own suites and its own
  polygon (FEAT-001 becomes two polygons: the VS Code one it is today, and a tiny generic one).

## 6. Specifications: the split

- `modules/codkit` keeps the engine. Facts that are VS Code answers move to
  `modules/vscode` and leave a tombstone behind (anchors are immutable; code that cites a moved
  fact by `##ANCHOR` is re-pointed, and `trace:check` enforces it). The new contract is
  `modules/codkit/PROP-016-project-types.xml`.
- `modules/vscode` is the VS Code type: layout (`src/vs/<own>`, `extensions/`), layers
  (`product.json` + `product.overrides.json`, built-in extensions, `registerSingleton`,
  `workbench.common.main`), build and test (`npm ci`, hygiene, eslint, watch channels,
  `test-node`, the package build and its stamps), the advisory readers, the brand image set,
  the runtime library (today's PROP-015 almost whole), the seam catalogue, the conventions.
  The existing `research/vscode-facts-1.135` is the natural neighbour.
- Where each existing section goes (first pass; the split phase refines it): PROP-005 §13
  own-extension and the overlay dev channel → vscode; PROP-007 imageset, `gen brand`, `build`
  channel names → vscode, the verbs themselves stay; PROP-009 advisory readers → vscode;
  PROP-010 → the universal skeleton stays, the VS Code build facts move; PROP-015 → vscode;
  PROP-014 seam catalogue → a per-type package; FEAT-002 scenarios get a type tag each and the
  generic polygon gets its own scenarios; PROP-001/vision drop "VS Code" from the definition
  and name the types.
- Packages: `org.vibevm.codkit/standards` keeps the universal standard; the seam catalogue
  becomes `org.vibevm.codkit/seams-vscode`; the runtime becomes `runtime-vscode`; the skills
  stay one package with type-neutral wording and read the type's lists from the installed
  packages. All at the development version 1.0.0, delivered with `--upgrade`.

## 7. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| P0 | this design reviewed; owner rulings on §8 | rulings recorded |
| P1 | `PROP-016` contract; `modules/vscode` created by moving facts with tombstones; vision reworded | specmap, trace:check, floor green; unit counts accounted for |
| P2 | `ProjectType` interface; the `vscode` type extracted; `type` in the configuration (schema 2, schema 1 reads as vscode); `codkit types`, `where` and the envelope report it | floor green; the product's own gates unchanged: `verify`, `status`, `ci --profile build`, static proof, dev and package UI proofs |
| P3 | the `generic` type and the generic polygon; capability refusals | FEAT-002 scenarios for the generic polygon end to end |
| P4 | packages split (standards core, `seams-vscode`, `runtime-vscode`); skills type-neutral; delivery to the product | product `vibe check` 0, standards and runtime checks current |
| P5 | Theia spike on master (`research/theia-facts-<version>`: layout, DI, build, test, packaging, application model), then `@codkit/type-theia`, then the owner's Theia-based product (named only in its own repository): its patch set repository, managed tree on a pinned master commit, identity, boot lane, steward context, proofs - the same way the VS Code product was started | the second real type passes the same scenarios as the first; `the owner's Theia-based product` loads, verifies, builds and runs |
| later | Brave: Chromium `patches/` and `chromium_src/` overrides mapped onto the layers - the closest kin to this model; GitLab Web IDE: a VS Code fork, so the `vscode` type with its own product configuration and, if its layout diverged, a type variant | spikes first |

Each phase leaves the VS Code product working unchanged; the product's proofs are the
regression net for the whole programme.

## 8. Owner rulings (2026-09-09)

1. The word is **`type`**: the configuration field is `"type"`, the packages are `@codkit/type-*`, the verb is `codkit types`, the refusal code is `CK-E-TYPE-CAPABILITY`.
2. The module is **`modules/vscode`**, next to `modules/codkit`.
3. The generic polygon is a **synthetic repository** in the fixtures.
4. Theia is the second real type, taken from **Theia master**, and it is not a scratch: it becomes a real product the owner develops, named only in its own repository (the clean room of this tool names no consumer product), a patch set of type `theia` with its own repository, managed tree, specifications and proofs, built the way the VS Code product was built.
5. Types are **separate packages from the start**, so that the procedure of splitting is done once (§5).
6. The own root: the field is `typeConfig.ownRoot`, a path from the tree root; the VS Code type derives it from a schema-1 `ownDirName` as `src/vs/<name>`.

## 9. Risks

- Hidden couplings in the cycle engine (advisory, classification, stabilization) - mitigated by
  extracting with the test suites unchanged and by the product's proofs.
- Moving about 150-200 specification units into `modules/vscode` costs tombstones and
  re-pointed citations; the `NEVER-RENAME-OR-DELETE-A-CITED-ANCHOR` rule and `trace:check`
  make the cost visible rather than dangerous.
- A plugin interface designed for one real type tends to fit that type; the `generic` type in
  P3 and Theia in P5 are the two forces that keep it honest. The interface is derived from the
  measured variation points of §1, not from imagined ones.
- The product's static proof and skills name tool paths and package names; delivery through
  packages keeps them stable, and the split of packages in P4 is itself an upgrade with
  `--upgrade`, under the mutable 1.0.0.
