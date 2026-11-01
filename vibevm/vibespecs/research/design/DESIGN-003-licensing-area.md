# DESIGN-003: Licensing as a contract area — the product's licence, stated once and carried everywhere

Status: proposal written 2026-11-01 for the owner's review; the owner chose the systematic path the
same day («сделай хорошо и системно, то есть это второй вариант»). The normative form arrives as
`TYPE-AREA-LICENSING` in PROP-016, new facts in PROP-019, `CMD-GEN-LICENSING` and the amended
`CMD-LICENSE-ANNOTATE` and `CMD-VERIFY` in PROP-007, the amended `GEN-HEADER-IS-THE-PRODUCTS` in
PROP-015, and `modules/vscode/PROP-010`. Genre: design document (lore, not binding). The consumer
product whose failure commissioned this is named only in its own repository (`common/PROP-004`
`NO-CONSUMER-PRODUCT-IN-THE-TOOL`); here it is "the pilot" and its upstream is "the editor family".

## 1. Findings: how a product shipped under the wrong licence while every tool said yes

Measured on the pilot on 2026-11-01, read-only, in its repository and its fork tree.

1. **The posture was a placeholder that nobody revisited.** On its first day the pilot wrote a
   repository licence file as a personal "source-available for evaluation" notice, marked "for later
   legal review", and opened a risk-register row for counsel sign-off. The row stayed open; the
   notice became the text every own file carried.
2. **The product's own proofs defended the placeholder.** A decision record mandated the banner
   on every own `.ts` file; a static proof asserted the banner byte for byte and asserted the
   *words* of the licence file ("evaluation", "commercially"); a patch of the fork's lint rule
   required the banner in the tree. Three mechanisms, all pointing the wrong way, all green.
3. **The generator did what it was told.** `codkit gen` writes the header the product passes
   (`GEN-HEADER-IS-THE-PRODUCTS`) and never invents one. The product passed the placeholder, and
   the generator spread it over 169 files. The design was right about *whose* header it is and
   silent about *where the product's answer is kept*: a flag on a command line, repeated by hand.
4. **The built product declared one licence and shipped another.** The manifest overlay set the
   licence name to a proprietary identifier, but the licence *file* the build copies into the
   application stayed the upstream's permissive text, the installer showed that text as the end
   user agreement, the package manifest kept the upstream's licence field, and the third-party
   notices never mentioned the tool's own runtime the product ships. No question of the contract
   covers "where does this family declare its licence", so no verb could notice.
5. **The policy machinery existed and was not wired.** PROP-019 already gives a trusted
   organization policy (holders, expressions, canonical texts with digests, notice requirements),
   a consumer source check and a release-time selection file. All of it is optional: `verify`
   does not look at it, `package` only records "evidence incomplete" and continues, `gen` does
   not read it, and `license annotate` serves the tool's own packages, not a consumer's own code.
6. **The tool's block header does not pass the tool's own check.** `gen --header-style block`
   writes `Copyright (c) <year> <holder>. All rights reserved.`; the carrier parser reads the
   holder as everything after the year to the end of the line, so the holder becomes
   `<holder>. All rights reserved.` and the consumer check calls the file third-party. The two
   halves were never run against each other.
7. **The tool's notice undersells its own footprint.** `LICENSE-CODKIT.md` says the tool's files
   live under three paths "and nowhere else"; the skill projections `vibe skill install` builds
   (`.claude/.agents/.opencode/skills/ck-*`) carry the tool's UPL header and are not listed.

The lesson the rest of this document applies: a licence posture is a decision of the rights
holder, kept in one trusted place, and every surface that states it — the header of an own file,
the licence file of the product, the fields of its manifests, the installer, the notices — is
derived from that place by the tool and checked back against it by the tool. A product that
writes those surfaces by hand will drift, and its own proofs will defend the drift.

## 2. Decisions

- **D1. Licensing is the twelfth area of the contract**, optional, paired with the capability
  `licensing` in `OPTIONAL_AREAS` exactly like `brand-images` and `preview`. The type answers
  where this family *states* a licence: the shape of own-file headers, the directory of the
  product's licence file, the manifest fields that name the licence, the upstream's own licence
  files, the renderings the family's installers read, the directory of component licences, the
  subsystem of licensing interventions and the place and runner words of the guard. The engine
  owns everything else: reading the policy, laying out headers, writing artifacts, scanning,
  refusing. Rejected: a type-specific verb (`vscode license ...`) — the roster stays the same for
  every family; a `licence` layer — the surfaces are ordinary overlays, add-file patches and own
  files, and the existing layers carry them.
- **D2. The organization policy stays the single authority.** Holders, the own licence expression
  (per path scope), approved third-party expressions, the canonical texts and their digests come
  from the trusted store on the machine (`~/.codkit/organization-policies.json`,
  `ORGANIZATION-POLICY-TRUST`). The patch set selects a profile in `codkit.licensing.json` and may
  add *display* choices in a `product` block of a version-2 declaration: the licence file's name,
  the human title of the licence, which of the policy's holders the notices name, the year, an
  optional URL, and the retired notices the guard forbids. Nothing in the patch set can widen
  authority: a holder outside the policy, a text, a permission are refused. Rejected: a policy
  format 3 carrying titles and file names — the store would need a new version for a display
  concern; the selection file is the product's and is the right owner of display choices.
- **D3. The header comes from the profile.** With a profile selected, `gen feature`, `gen brand`
  and `gen licensing` lay the header out from the policy (holder, the own expression resolved for
  the generated file's path, the year, the title and the licence file from the product block) in
  the style the type declares. `--holder`, `--license`, `--year`, `--header-style` still work and
  must agree with the profile (a holder outside the policy or an expression other than the own one
  is `CK-E-CONFIG`); `--header-file` is still the house form, and its text must resolve to a
  carrier naming a policy holder and the own expression. Without a profile the behaviour of today
  is kept to the letter. Rejected: a profile making the flags illegal — a product may want the
  house form; it may not want a different licence.
- **D4. The block header is laid out as a carrier.** The copyright line carries the holder and
  nothing after it; "All rights reserved" and the "licensed under" sentence move to the following
  lines; the SPDX line closes the block. A unit test runs the consumer check over a file headed by
  each style, which is the test that was missing. The line style gains the title and the licence
  file in its two middle lines when a profile supplies them.
- **D5. `codkit gen licensing` writes the surfaces from the profile**, in the patch set: the
  overlay operations for every manifest field the type names (merged into an existing overlay of
  the same target, `expectUpstream` read from the pin); an add-file patch for the product's licence
  file with the canonical text of the own licence (the policy's custom text, or its trusted standard
  text); add-file patches for the component licences — each upstream licence file verbatim from the
  pin under the component directory, and the tool's own licence text when the runtime library is
  delivered into the own layer; the renderings the type asks for (an RTF of the canonical text for
  the editor family's installer); and the guard. Ids are the next free numbers in the subsystem the
  type names, the owner comes from `owners.json` or `--owner`, the pin from `codkit.json`. The
  command needs the fork tree (the pin's bytes) and refuses existing targets like every `gen`;
  `--update` rewrites exactly the artifacts it wrote before, which is the path a new edition of
  the licence text takes. Rejected: resource files for the licence texts — the targets are absent
  at the pin, and the resource layer is for replacing what the upstream has.
- **D6. Own files get their carriers from `codkit license annotate --own`.** The walk covers the
  own root and the own extensions of the patch set and skips the tool's delivered paths and the own
  manifest; a file with a comment style gets the family's header (the block of D4 for the editor
  family's `.ts`, `.js` and `.css`, the comment of the extension otherwise); a file that cannot
  carry a comment gets a `.license` sidecar with the same two lines. Idempotent: a conforming
  carrier is `unchanged`. `--replace-retired` removes a leading header that names a holder outside
  the policy and writes the family's header in its place; without the flag such a file is reported
  and left alone. Resource files are not walked: a resource that replaces an upstream file is a
  derivative work until a person says otherwise, so they are annotated by path, deliberately.
- **D7. `verify` is the gate.** With `codkit.licensing.json` present, `verify` resolves the profile
  (a store or profile that is not there is `CK-E-LICENSE-PROFILE`: the machine that verifies must
  carry the policy, the CI machine included), runs the consumer source check over the own layers
  (every problem a `CK-E-LICENSE-HEADER` finding, the tool's delivered paths excluded), and, for a
  type with the area, checks the surfaces back against the profile: every manifest field is set
  by an overlay to the expected value, the licence file's patch carries the canonical text's
  digest, the component licences and renderings are declared (`CK-E-LICENSE-SURFACE`). Rejected
  for this campaign: the refusal of `package`/`publish` on incomplete evidence
  (`ORGANIZATION-DISTRIBUTION-EVIDENCE`): its provenance declaration maps every delivered payload
  file to sources, which a desktop application's build cannot state without a build mapping from
  its bundler; that is a campaign of its own (DEF-3 of the plan).
- **D8. The guard `licence-leftovers` is one template with the type's words.** The engine renders
  it (holders, the expression per own directory of the tree, the licence file and its digest, the
  manifest fields, the component files, the retired phrases); the type gives the path and the
  runner's words for a suite and a test, as the extension family already does for the brand guard.
  The guard proves, in the tree and in the product's own test run: a carrier on every own file
  (header in the first twenty non-empty lines or a sidecar), no retired phrase in any own text file
  or licence surface, the licence file byte-identical to the canonical text, the manifest fields
  equal to the profile, the component licences present. Rejected: a guard that calls the tool —
  the product's test run must not depend on the tool being installed.
- **D9. Modified upstream files carry no second banner.** Their provenance is the markers and the
  inventory; a list of modified upstream files in the distribution NOTICE is deferred (DEF-2) to
  the same campaign as D7's refusal, because it belongs to the NOTICE the provenance renders.
- **D10. The tool's notice names the skill projections** among the paths it licenses, in both
  languages, and the recommendation printed by `standards load` says the same.
- **D11. Scope of types.** The editor family (`vscode`) answers the area in this campaign and is
  proved by the pilot; the extension family answers a smaller set (the manifest's `license` field
  and a licence file in the extension root) when the campaign has time, else next; the
  application family (`theia`) and `generic` answer nothing — `gen licensing` refuses them with
  `CK-E-TYPE-CAPABILITY`, while `verify`'s source check and the header-from-profile rule, which are
  type-neutral, serve them already.
- **D12. The pilot is the acceptance.** Both release trees of the pilot receive the same commands
  (`gen licensing`, `license annotate --own --replace-retired`, their own proofs turned around,
  `verify`, `load --fresh`, a build) and the result is compared file by file; only then is the
  pilot's history squashed, by the owner's separate decision, in its own repository.

## 3. The area, as the contract will state it

```ts
export type LicenceHeaderStyle = 'line' | 'block';
export type LicenceField = {
  readonly target: string;              // an overlay target of the type, e.g. the product manifest
  readonly path: readonly string[];     // the key path inside the document
  readonly role: 'expression' | 'file-name' | 'url';
};
export type UpstreamLicenceFile = { readonly path: string; readonly component: string };
export type LicenceRendering = { readonly path: string; readonly format: 'rtf' | 'text' };
export type LicenceGuard = { readonly path: string; readonly suite: string; readonly test: string };

export type LicensingArea = {
  readonly headerStyle: LicenceHeaderStyle;
  readonly licenceFileDirectory: string;        // '' for the tree root
  readonly componentLicenceDirectory: string;   // what the family's build copies into the distributable
  readonly subsystem: string;                   // the subsystem licensing interventions are numbered in
  readonly fields: readonly LicenceField[];
  readonly upstreamLicenceFiles: readonly UpstreamLicenceFile[];
  readonly renderings: readonly LicenceRendering[];
  guard(ownRoot: string): LicenceGuard;
};
```

Shape rules the contract's own test holds: the directories are tree-relative without slashes at
either end, the fields name declared overlay targets, roles `expression` and `file-name` appear at
most once per target, the subsystem is one of the type's conventions, the guard path lies inside
the own layer of the patch set.

The editor family's answer: `block`; the licence file at the tree root; `licenses/` (the build
copies it into the application beside the licence file); `product`; `product.json` →
`licenseName` (expression), `licenseFileName` (file-name), `licenseUrl` and `serverLicenseUrl`
(url); `package.json` → `license` (expression; the overlay target gains the key); the upstream's
`LICENSE.txt` as the component `code-oss`; `LICENSE.rtf` at the root (the installer prefers it
over the text file); the guard at `delta/own/test/node/licence.leftovers.test.ts` with `suite` and
`test`.

## 4. Commands, flags and codes

- `codkit gen licensing [--owner <name>] [--update] [--dry-run]` — roots: patches and fork;
  capability `licensing`; profile required. `--json`: `data: {files: [{path, action}], overlays:
  [{artifact, target, operations}], reminders: [...]}`. Codes: 0; 1 `CK-E-GEN-EXISTS` without
  `--update`; 2 the environment, a missing profile, a type without the area.
- `codkit gen feature|brand` — unchanged flags; with a profile the header is derived; a disagreeing
  flag is `CK-E-CONFIG`; a headerless result with a profile is `CK-E-CONFIG` too.
- `codkit license annotate --own [--replace-retired] [--dry-run] [<paths…>]` — roots: patches;
  the type's style; paths narrow the walk. `--json` extends the existing data with `action:
  "replaced" | "foreign-holder"` and `scope: "own"`. Codes: 0; 1 (a file left with a foreign
  holder); 2 (no profile).
- `codkit verify` — new findings `LICENSE-PROFILE`, `LICENSE-HEADER` (consumer scope),
  `LICENSE-SURFACE`; the FAQ gains the three entries.
- `codkit.licensing.json` version 2: version 1 keeps reading as today; version 2 adds `product`.

## 5. Specifications touched

PROP-016 (`TYPE-AREA-LICENSING`, `TYPE-TERM-CAPABILITY`); PROP-019 (`LICENSING-DECLARATION-V2`,
`HEADER-FROM-PROFILE`, `GEN-LICENSING`, `ANNOTATE-OWN`, `VERIFY-LICENSING`, `LICENCE-GUARD`, the
amended `CONSUMER-LICENSE-CHECK`); PROP-015 (`GEN-HEADER-IS-THE-PRODUCTS`); PROP-007
(`CMD-GEN-LICENSING`, `CMD-GEN-FEATURE`, `CMD-GEN-BRAND`, `CMD-LICENSE-ANNOTATE`, `CMD-VERIFY`,
the roster); PROP-014 (the notice's scope paths); PROP-012 (the two codes); FEAT-002 (scenarios);
`modules/vscode/PROP-010-licensing.xml` and `modules/vscode/PROP-003` (the manifest key);
`public-formats.json` (the declaration's second version).

## 6. The pilot, in its own repository

Install the profile in the machine store (holders: the legal entity in both its names; the EULA as
a custom licence text with its digest, a draft until counsel approves; the upstream's and the
tool's licences among the approved third-party expressions); write `codkit.licensing.json` v2
(licence file `LICENSE.md`, the title, the retired notices); `gen licensing`; `license annotate
--own --replace-retired`; turn the pilot's own proofs around (its decision record, its static
proof, its lint patch, its product-identity test); `verify` to zero; `load --fresh`; a build; the
checks of the plan's acceptance; then the squash the owner decided, and the same for the second
release tree.

## 7. Open points for the owner

1. One RTF of the whole bilingual text for the installer, or one per installer language
   (`licenses/LICENSE-<language>.rtf`, which the installer script already looks for)? This design
   starts with one at the root.
2. Whether the tool's UPL text belongs under `licenses/` as a component licence (this design) or
   only in the distribution NOTICE of the deferred campaign.
3. The year in headers: the year of first publication, fixed in the product block, never bumped
   by the tool (this design), or the current year at generation time.
