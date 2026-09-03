# Реестр рисков standalone Codkit

Статус на 2026-09-03. Это канонический stable-id реестр текущего проекта.
Каждый открытый риск имеет trigger и проверяемый closure proof; наличие примера
или соседнего green test не закрывает его.

| ID | Риск | Severity | Status | Trigger / когда переоценить | Closure proof |
| --- | --- | --- | --- | --- | --- |
| CK-R-NATIVE-MAC-001 | launcher, path/case/symlink semantics, watcher/process truth на native macOS/APFS не доказаны | P1 | open | изменение launcher, path safety, build/watch/process кода; перед release | сохранённый native macOS run: Bash launcher вне source cwd, schema-2 roots, unit/e2e filesystem+process suites, watch up/status/errors/down, exits и OS/tool versions |
| CK-R-NATIVE-WIN-001 | native Windows/NTFS и PowerShell launcher/process cleanup не доказаны | P1 | open | изменение `.ps1`, argv/path/process/build code; перед release | сохранённый Windows run: PowerShell launcher вне source cwd, paths с пробелами, schema-2 roots, relevant suites, watcher lifecycle и byte-preservation negatives |
| CK-R-NATIVE-FS-002 | case-insensitive collision, symlink/junction/reparse-point и rename behavior могут отличаться от Linux | P1 | open | изменение path containment, rename/materialize, lock или cleanup | macOS+Windows negative matrix на real filesystems с traversal, symlink/junction, case collision, atomic rename/lock и no-outside-write evidence |
| CK-R-DOCKER-001 | logical `--ci` может не обеспечивать физический no-network/read-only/UID perimeter | P1 | closed | reopen при смене engine, mounts/runtime model, UID policy, lock mapping или network boundary | [Docker matrix](DOCKER-MATRIX.md): раздельные tool/patch-set/fork mounts, green verify/build, read-only typed-red, lo-only/0-route namespace и byte preservation |
| CK-R-BUILD-PROFILE-001 | неверные fork-specific regex могут пропустить диагностическую строку и дать false-green | P1 | open for custom profiles | любой новый/изменённый `buildWatchFile`, watcher output или upstream pin | strict schema + обязательный detector уже закрыты; каждый custom profile дополнительно хранит реальные green/red log fixtures и доказывает non-zero error count/exit на red pass |
| CK-R-UPSTREAM-001 | локальный Codkit floor не доказывает полный clean-pin и applied-delta VS Code/Electron runner | P1 | open | новый upstream pin, runner config или release candidate | два сохранённых runs на supplied Electron/Node/VSIX inputs: clean pin baseline и applied delta; complete runner list, exits, artifacts, flakes disposition |
| CK-R-TOOL-PACKAGE-001 | npm package Codkit мог не включить исполняемый runtime/lock/spec/docs или потерять executable bit | P1 | closed | reopen при изменении `files`, bin/launcher, runtime emit, dependencies или pack layout | 309 files, automated bound меньше 1 MB tar / 5 MB unpacked; `npm-shrinkwrap.json`, source+dist, specs/docs, Node/Bash/PowerShell launchers present; relative-link test green; offline cached install в temp consumer и npm bin `where` из чужого cwd exit 0/schema 2 |
| CK-R-APP-PACKAGE-002 | npm pack инструмента не доказывает per-OS VS Code/Electron app bundle/install/signing | P1 | open | downstream packaging input, Electron, launcher, signing or release layout change | deterministic app bundles for supported OSes with manifests/checksums; clean install/start; signing/notarization verification; no undeclared network/source/cache dependency |
| CK-R-RELEASE-001 | signing, immutable publish refs, rollback and partial-push recovery не приняты end-to-end | P1 | open | publish code/config, signing policy или first release | rehearsal in isolated remote: approved identity/signature policy, immutable refs/tags, idempotent retry, partial failure recovery, rollback record and operator sign-off |
| CK-R-SUPPLY-001 | air-gapped supply completeness and provenance depend on external organization controls | P1 | open | dependency/lock/Electron/VSIX/image input change | signed/checksummed supply manifest, malware/provenance policy, internal sources, physical import run, cache receipts, full build with `--network none` |
| CK-R-LEGAL-001 | proprietary tool distribution, third-party notices and consumer obligations need release review | P1 | open | dependency/license/bundle or distribution-channel change | owner/legal approval tied to exact bundle; license manifest, dependency-license scan and required notices match shipped bytes |
| CK-R-VIBE-001 | materialized dependencies validate offline, но clean offline reinstall/registry portability не доказаны | P2 | open | lock/vibedeps/Vibe version change; clean-machine bootstrap | published registry provenance or supported Vibe mechanism, then clean HOME/cache `reinstall --offline`, check and validate; current `vendor --offline` skipping all 31 embedded entries is not closure |
| CK-R-AGENT-001 | PreToolUse/root-flag guards are not an OS sandbox; hostile agent host could bypass policy | P1 | open | agent protocol/hook/permissions change or agent-assisted CI enablement | adversarial eval suite on managed host permissions: no-task, stale task, root redirection, symlink escape, shell/network/install/commit attempts; external sandbox evidence |
| CK-R-AGENT-EVAL-002 | resolver/scout/verifier/reviewer/cause profiles may drift from runtime schema and procedures | P2 | open | task/result/journal schema, command envelope or profile changes | versioned eval corpus passes positive and negative cases; generated copies/checkers green; independent reviewed resolver exercise |
| CK-R-RECOVERY-001 | crash/lock/receipt recovery could lose bytes or resume the wrong root | P1 | open | transaction, cycle, lock, receipt, rebase or path-resolution changes | crash-at-each-atom suite plus operator rehearsal: exact resume, digest preservation, stale-lock behavior, wrong-root rejection, restart/rollback record |
| CK-R-HUMAN-001 | protocols 01/02/05/08 are mechanically checked but not independently field-tested for each deployment | P2 | open | protocol/setup/CI change or new consumer | two novice 01/02 runs, independent DRI 05 run, foreign CI engineer 08 run with commands, exits, elapsed time, findings disposition |
| CK-R-TRACE-001 | specmap with zero code edges can be structurally green but semantically vacuous | P2 | open | specmap/extractor/toolchain change | non-zero intended spec-to-code/test edges, reviewed sampling, and gate that fails on unexpected vacuity |

## Правило сопровождения

- `open` переносится в следующий аудит до появления closure proof.
- `closed` переоткрывается только по своему trigger; старое доказательство не
  удаляется.
- `accepted/deferred` без owner, trigger и terminal condition запрещён.
- Риски deployment-specific могут быть дополнены в patch-set repository, но
  не переписывают этот tool-level register.

См. [текущий health audit](../../../AUDIT.md),
[release/CI protocol](../protocol/human/08-release-ci.md) и
[air-gapped supply kit](../ci-examples/air-gapped-supply-kit.md).
