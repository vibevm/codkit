# DESIGN-001: Project kinds — one Codkit for VS Code, Theia and other upstreams

Status: design for the owner's review (2026-09-09). Genre: design document — it describes
findings and a proposal; the normative form arrives later as PROP-016 and `modules/vscode`.
Owner's request: split the VS Code knowledge out of `modules/codkit`, draw the dividing line
carefully across every specification, and design the CLI and the internal API so that the tool
switches between kinds of projects — several VS Code forks, several Theia forks, and later
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

**Ring 1 - the VS Code kind, spread through the code without a boundary.** Measured hotspots:

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
VS Code *kind* gives to a question the engine asks. Today the engine asks nobody - it carries the
answers inline.

## 2. The model: a kind answers a fixed contract

A **project kind** is the tool's knowledge of one family of upstreams. A patch set declares its
kind once; the engine asks the kind and never names a kind's facts itself. The contract is the
list of questions the inventory found - no more:

1. **Upstream identity.** Tag pattern and pin resolution (already `tag@sha@date`), what a
   healthy tree looks like (`check-tree` fingerprints: manifest name, marker files), the
   anchor policy.
2. **Tree layout.** Where own code lives (`src/vs/<own>/` for VS Code; a package under
   `packages/` for Theia), whether and where own extensions materialize (`extensions/<name>`
   for VS Code; a workspace package plus a registration for Theia), the cleanup whitelist of
   build outputs, the forbidden patch targets, kind-specific marker comment forms if any.
3. **Layers.** Which layers the kind supports and how each is materialized and verified:
   `own` and `patch` and `resource-file` and `rewrite-rule` are universal; `config-overlay`
   has kind-provided targets and an optional dev channel (VS Code: `product.json` with
   `product.overrides.json`); `own-extension` has a kind-provided materializer; `service-override`
   has a kind-provided verifier (VS Code: `registerSingleton`; Theia: inversify `rebind`
   in a container module); `entry-module` has a kind-provided locator (VS Code:
   `workbench.common.main.ts`; Theia: the application's frontend module list).
4. **Build and test.** Dependency install, hygiene and lint scripts, compile channels for
   `build up|down|status|errors`, the test runner with an own-directory glob, the package
   build and its stamps (`BUILD_SOURCEVERSION`, `VSCODE_QUALITY`), foreign-watcher markers.
5. **Upgrade advisory.** The semantic readers the cycle runs between two pins (VS Code:
   built-in extensions of `product.json`, Electron and TypeScript versions).
6. **Brand images.** An optional capability with the kind's target table (VS Code's icon set).
7. **Runtime library.** Which shipped runtime the kind delivers (`runtime-vscode` is today's
   library; a Theia runtime would be inversify-based).
8. **Standards and skills.** The core standard is universal; the seam catalogue and the
   "how upstream builds it" list of `ck-intervene` come from the kind.
9. **Conventions.** Subsystems for intervention ids, forbidden service ids, defaults the
   product's `conventionsExtensionFile` may extend.

Everything not on this list stays in the engine and is forbidden to know the kind: the
graft budget, the marker grammar, the drift guard's predicate, the sacrifice-by-name of
`--discard`, the licence carriers, the generated branch, the cycle's transactions.

Three kinds are foreseen: `vscode` (extracted from today's code, no behaviour change),
`generic` (a plain git upstream with declared commands and no product model - the way to start
on anything before its own kind exists), `theia` (the second real kind, the proof that the
contract holds). Brave and GitLab Web IDE come later; see §7.

## 3. Configuration: one kind per patch set, forks are patch sets

- `codkit.json` gains `"kind": "vscode" | "generic" | "theia" | ...` (schema 2). A schema-1 file
  without the field reads as `vscode`, so the existing product changes nothing on the day the
  field appears. The kind validates its own section, `"kindConfig": { ... }`: for VS Code the
  own directory name and the overlay target it already has; for Theia the own package name and
  the application directory; for `generic` the install, lint, build and test commands.
- **Several forks** need nothing new: a fork is a patch set with its own fork tree, bound per
  command by `--patches-dir`/`--fork-dir` or the local config, exactly as today
  (`GOAL-ANY-FORK`). Two Theia forks are two patch sets of kind `theia`; a VS Code fork and a
  Theia fork side by side are two patch sets of two kinds. Sharing between forks happens
  through packages - standards, runtime, skills - not through the tool's configuration.
- An optional later convenience, not part of the first cut: a workspace file that names
  several patch sets and their trees so that `codkit --patch-set <name> ...` resolves roots
  without flags. The air-gapped circuit and the clean room do not depend on it.

## 4. CLI

- The verbs stay universal: `load save sync status verify inventory cycle publish ci license
  standards runtime gen build overlay marker hooks forecast rebase-onto-pin gc`. Their output
  names the kind where it matters (`where`, the JSON envelope's `codkit.kind`).
- Kind-specific verbs are **capabilities** the kind declares: `imageset` (brand images),
  `gen brand` (a string-funnel graft), `build` channels, `runtime load`. A verb whose
  capability the kind does not declare refuses with `CK-E-KIND-CAPABILITY`, exit 2, naming the
  kind and the capability; no verb silently does something else.
- `codkit kinds` prints the registered kinds and their capability matrix; `codkit where` prints
  the kind of the patch set.
- Error codes, hints and the FAQ stay one registry; a kind may add codes under its own prefix
  (`CK-E-VSCODE-...`) only for facts the engine cannot state.

## 5. Internal API

- `codkit/src/kinds/kind.ts`: the `ProjectKind` interface with exactly the nine areas of §2,
  each an object of small functions (`layout(config)`, `layers()`, `build()`, `advisory()`,
  `brandImages?()`, `runtime()`, `standards()`, `conventions()`), plus `id`, `configSchema`
  (zod, like `configFile.ts`) and `capabilities: ReadonlySet<Capability>`.
- `codkit/src/kinds/index.ts`: a static registry. No dynamic plugin loading in the first cut:
  determinism, the air-gapped circuit and the clean room all prefer a kind to be a directory in
  the tool's tree with its own tests and its own specification module. Adding a kind is adding
  a directory, a spec module and a polygon.
- `codkit/src/kinds/vscode/**`: today's code moved, not rewritten - `imagesetTargets`,
  the `product.json` overlay with its dev channel, the extensions materializer, the CI steps,
  the build channels, the advisory readers, the skeleton templates, the `registerSingleton`
  verifier, the conventions defaults. The engine receives the kind through `CommandContext`
  (`ctx.kind`), resolved once from the configuration.
- `codkit/src/kinds/generic/**`: no product model, no extensions, no DI verification; install,
  lint, compile and test commands declared in `kindConfig`; the own directory is a configured
  path. Enough to run `load|save|verify|cycle|publish|ci` over any git upstream.
- Tests: the engine's tests run against a kind stub; each kind has its own suites and its own
  polygon (FEAT-001 becomes two polygons: the VS Code one it is today, and a tiny generic one).

## 6. Specifications: the split

- `modules/codkit` keeps the engine. Facts that are VS Code answers move to
  `modules/vscode` and leave a tombstone behind (anchors are immutable; code that cites a moved
  fact by `##ANCHOR` is re-pointed, and `trace:check` enforces it). The new contract is
  `modules/codkit/PROP-016-project-kinds.xml`.
- `modules/vscode` is the VS Code kind: layout (`src/vs/<own>`, `extensions/`), layers
  (`product.json` + `product.overrides.json`, built-in extensions, `registerSingleton`,
  `workbench.common.main`), build and test (`npm ci`, hygiene, eslint, watch channels,
  `test-node`, the package build and its stamps), the advisory readers, the brand image set,
  the runtime library (today's PROP-015 almost whole), the seam catalogue, the conventions.
  The existing `research/vscode-facts-1.135` is the natural neighbour.
- Where each existing section goes (first pass; the split phase refines it): PROP-005 §13
  own-extension and the overlay dev channel → vscode; PROP-007 imageset, `gen brand`, `build`
  channel names → vscode, the verbs themselves stay; PROP-009 advisory readers → vscode;
  PROP-010 → the universal skeleton stays, the VS Code build facts move; PROP-015 → vscode;
  PROP-014 seam catalogue → a per-kind package; FEAT-002 scenarios get a kind tag each and the
  generic polygon gets its own scenarios; PROP-001/vision drop "VS Code" from the definition
  and name the kinds.
- Packages: `org.vibevm.codkit/standards` keeps the universal standard; the seam catalogue
  becomes `org.vibevm.codkit/seams-vscode`; the runtime becomes `runtime-vscode`; the skills
  stay one package with kind-neutral wording and read the kind's lists from the installed
  packages. All at the development version 1.0.0, delivered with `--upgrade`.

## 7. Phases

| Phase | Deliverable | Gate |
|---|---|---|
| P0 | this design reviewed; owner rulings on §8 | rulings recorded |
| P1 | `PROP-016` contract; `modules/vscode` created by moving facts with tombstones; vision reworded | specmap, trace:check, floor green; unit counts accounted for |
| P2 | `ProjectKind` interface; the `vscode` kind extracted; `kind` in the configuration (schema 2, schema 1 reads as vscode); `codkit kinds`, `where` and the envelope report it | floor green; the product's own gates unchanged: `verify`, `status`, `ci --profile build`, static proof, dev and package UI proofs |
| P3 | the `generic` kind and the generic polygon; capability refusals | FEAT-002 scenarios for the generic polygon end to end |
| P4 | packages split (standards core, `seams-vscode`, `runtime-vscode`); skills kind-neutral; delivery to the product | product `vibe check` 0, standards and runtime checks current |
| P5 | Theia spike (`research/theia-facts-<version>`: layout, DI, build, test, packaging), then the `theia` kind and a scratch Theia fork through `load|save|verify|ci` | the second real kind passes the same scenarios as the first |
| later | Brave: Chromium `patches/` and `chromium_src/` overrides mapped onto the layers - the closest kin to this model; GitLab Web IDE: a VS Code fork, so the `vscode` kind with its own product configuration and, if its layout diverged, a kind variant | spikes first |

Each phase leaves the VS Code product working unchanged; the product's proofs are the
regression net for the whole programme.

## 8. Open questions for the owner

1. The word: `kind` (proposed), `profile`, or `flavor`.
2. Module naming: `modules/vscode` (proposed, next to `modules/codkit`) or `modules/kinds/vscode`.
3. The generic polygon: a synthetic npm repository in the fixtures (proposed) or a small real upstream.
4. Theia as the second real kind, and which Theia version to spike on.
5. Kinds in-tree (proposed for the first cut) or as separate npm packages later.
6. Whether the VS Code own root stays `ownDirName` under `src/vs/` or becomes a full `ownRoot` path in `kindConfig` (proposed: full path, with `src/vs/<name>` as the VS Code default).

## 9. Risks

- Hidden couplings in the cycle engine (advisory, classification, stabilization) - mitigated by
  extracting with the test suites unchanged and by the product's proofs.
- Moving about 150-200 specification units into `modules/vscode` costs tombstones and
  re-pointed citations; the `NEVER-RENAME-OR-DELETE-A-CITED-ANCHOR` rule and `trace:check`
  make the cost visible rather than dangerous.
- A plugin interface designed for one real kind tends to fit that kind; the `generic` kind in
  P3 and Theia in P5 are the two forces that keep it honest. The interface is derived from the
  measured variation points of §1, not from imagined ones.
- The product's static proof and skills name tool paths and package names; delivery through
  packages keeps them stable, and the split of packages in P4 is itself an upgrade with
  `--upgrade`, under the mutable 1.0.0.
