# Codkit как универсальная платформа управления Git-форками

Синтез проверок Codex и Claude Fable
Дата: 2026-09-20
Статус: архитектурный отчёт и план; кодирование не начиналось.

## Итог

Текущая архитектура не требует переписывания. Её правильное ядро — один
component patchset над одним Git repository — следует сохранить. Но Codkit пока
не feature-proof для произвольных больших, patch-heavy, polyglot,
multi-repository и коммерческих форков.

Feature-proof здесь не означает заранее реализовать поддержку Brave, GitLab,
каждого build system или каждой лицензии. Это означает, что новый consumer
добавляется через versioned extension points и policies, а не заставляет менять
core state model, публичные formats и security boundary.

До новых consumers нужны четыре обязательных архитектурных решения:

1. Версионировать type contract и определить trusted external type supply.
2. Отделить discipline policy от project type и от core invariants.
3. Разделить лицензионные policies Codkit, организации, patchset и
   дистрибутива.
4. Зафиксировать component/release-set coordinator model без обещания
   cross-repository atomicity.

Практически также важно закончить local workspace model для нескольких задач и
агентов: это отдельная задача и не должна смешиваться с product-level
multi-repository coordination.

## Согласованная модель системы

```text
Codkit installation
├── engine + public formats
├── trusted type registry (locked/integrity-pinned)
├── discipline registry
└── immutable Codkit-supply licence policy

Organization control plane
├── allowed type registry overlays
├── organization licence policies
└── trust/signing configuration

Local task workspace
├── patchset worktree + task branch
└── fork worktree + unique generated-ref namespace

Component patchset (существующий атом)
├── one upstream Git repository
├── one immutable revision/pin
├── one project type
├── one discipline profile
└── artifacts + inventory + component release descriptor

Release set / coordinator (новый верхний уровень)
├── immutable references to component patchsets
├── dependency/order graph
├── prepare/apply/record journal
└── aggregate build, licence and distribution evidence
```

## Что остаётся в core навсегда

Эти свойства не должны становиться flags или type answers:

- Git как substrate;
- contained filesystem operations и disjoint roots;
- deterministic serialization и reproducible generated history;
- явное происхождение каждого artifact;
- запрет silent data loss;
- durable transaction records и idempotent recovery;
- fail-closed schema/security diagnostics;
- patchset не может указать executable module/path для загрузки;
- immutable inputs и hashes в release evidence;
- JSON output и стабильные exit semantics.

## Что должно стать extension point

### Project type

Описывает факты upstream family: identity/provenance, layout, build recipes,
semantic readers, packaging, product-specific layers и generators.

### Discipline profile

Описывает допустимые формы вмешательства: markers, deletions, renames,
full-file replacement, hook budgets, обязательные guards и разрешённые artifact
kinds. Discipline выбирает владелец patchset, а не type.

### Organization policy

Описывает доверие и юридические ограничения организации: доступные external
types, license expressions, proprietary namespaces, required evidence и
release gates. Patchset может только сузить policy.

### Release coordinator

Координирует несколько независимых components. Не управляет внутренними bytes
component patchset и не обещает межрепозиторную транзакцию.

## Улучшения, которые стоит сделать сейчас

## P0.1. Инвентаризация и заморозка публичных форматов

Составить один normative список:

- `codkit.json` / `codkit.local.json`;
- `.ckpatch` и path encoding;
- all delta manifests;
- tree marks, caches, transaction records;
- JSON envelope и exit codes;
- generated commit trailers и ref naming;
- type-api contract;
- supply-kit manifest;
- licence policy/evidence formats.

Для каждого определить:

- owner и trust boundary;
- current schema version;
- forward/backward compatibility;
- migration command или правило отказа;
- что входит в fingerprint;
- conformance tests.

Acceptance: checker выводит перечень formats и не допускает public schema без
version/migration policy.

## P0.2. Version handshake type-api

Добавить в declarative type metadata:

- `typeManifestVersion`;
- `contractVersion`;
- type package version;
- supported engine range;
- declared capabilities;
- digest/integrity identity.

Loader обязан до импорта executable adapter проверить manifest и compatibility.
`codkit types` показывает обе версии и источник регистрации.

Acceptance:

- старый/новый несовместимый type отказывается до вызова его кода;
- ошибка называет expected/actual versions и package;
- official types проходят тот же путь, что external;
- conformance kit можно запустить в отдельном type repository.

## P0.3. Trusted type registry

Специфицировать installation-level registry. Patchset продолжает содержать
только type ID.

Registry entry:

```text
id
package identity/version
integrity digest
contract version
manifest path
adapter presence
trust source
```

Источники registry должны иметь строгий precedence: shipped installation →
administrator-approved overlay. Произвольный package из cwd, patchset или env
не загружается.

Supply kit фиксирует все packages и hashes. Signature support может быть
добавлен позже; hash pinning необходимо сразу.

Acceptance: tampered package отказывается до dynamic import; offline install в
пустом каталоге воспроизводит тот же registry.

## P0.4. Declarative type manifest / executable adapter boundary

Не нужно немедленно физически ломать packages. Нужно зафиксировать boundary.

В manifest идут простые данные:

- identity patterns и fingerprints;
- capabilities;
- owned roots/build outputs;
- overlay targets;
- build actions и dependency receipts;
- package outputs/scratch;
- conventions и forbidden targets.

В trusted adapter остаются функции:

- parsing/semantic comparison bytes;
- codecs;
- dynamic configuration;
- generators;
- content/service verifiers.

Acceptance: `codkit types` и registry inspection не исполняют adapter code.

## P0.5. Versioned discipline profiles

Рекомендуется новый config schema до появления внешних consumers. Варианты:

- предпочтительно `codkitConfig: 3` с явным migration v2 → v3;
- допустимо оставить v2 только после отдельного решения, что добавление optional
  fields является совместимым изменением schema.

Новый field:

```json
"discipline": "minimal-intervention@1"
```

Отсутствующее поле при чтении v2 означает текущий profile. Поведение существующих
patchsets должно остаться byte-identical.

Profile входит в:

- delta fingerprint;
- generated history fingerprint;
- inventory;
- verify/CI output;
- release descriptor.

Unknown profile — config refusal до записи.

Сейчас реализуется только текущий profile. `patch-heavy@1` ждёт реальный case.

## P0.6. Artifact representation seam

Не реализовывать binary/delete codecs сейчас, но перестать считать `.ckpatch`
единственной возможной формой изменения upstream bytes.

Внутренний контракт artifact codec должен уметь:

- identify targets;
- plan/apply/extract;
- fingerprint deterministic bytes;
- report operations (`add/modify/delete/move/replace`);
- declare compatibility с discipline profile;
- produce inventory metadata.

Текущий codec регистрируется как `text-patch-v2`.

Отдельный migration design нужен для path encoding. Будущий формат не должен
полагаться на `/ → __`; target должен быть явным полем/manifest record, а имя
artifact — безопасным ID или однозначной reversible encoding. Нужно покрыть
paths с spaces, quotes и `__`.

Разногласие проверок: Fable предлагает полностью отложить codec seam, пока
`resource-file` покрывает binaries. Codex рекомендует зафиксировать interface
сейчас, но не добавлять новые codecs. Синтез принимает вариант Codex: это
маленький архитектурный seam, который защищает public format от замерзания.

## P0.7. Component release descriptor

Каждый однокомпонентный publish/package должен выдавать immutable descriptor:

- component ID;
- upstream revision/provenance;
- patchset commit;
- type ID/package/contract version;
- discipline profile;
- generated tip;
- artifact hashes;
- build recipe identity;
- licence policy digest;
- distribution evidence references.

Этот descriptor станет входом будущего coordinator и не требует multi-repo
implementation сейчас.

## P0.8. Coordinator contract без реализации

Определить внешний release-set document, который ссылается на component release
descriptors. Не помещать список components в существующий `codkit.json`.

Public state machine:

```text
pending -> prepared -> applied -> recorded
                     \-> failed
```

Правила:

- coordinator journal durable и versioned;
- каждый component operation идемпотентен;
- resume продолжает с последнего доказанного atom;
- recorded result автоматически не откатывается;
- compensation является отдельной явной операцией;
- partial result выводит состояние каждого component;
- broken/foreign journal — fail closed.

## P0.9. Git boundary и pin evolution

Ратифицировать Git как постоянный substrate. Не строить VCS abstraction.

При следующей config version разделить pin на:

- immutable revision SHA;
- optional human label/tag;
- resolved date;
- provenance evidence, которое может дать type/topology adapter.

Не требовать tag там, где upstream работает по commit revisions.

## P0.10. Лицензионная модель для private/commercial consumers

Нужно разделить пять слоёв.

### 1. Codkit supply policy

Текущий immutable `toolRoot/config/license-policy.json`. Проверяет только bytes,
поставляемые Codkit. Consumer не может ослабить её.

### 2. Organization enforcement policy

Хранится в administrator/user-controlled location, не в patchset. Содержит:

- organization policy ID/version/digest;
- own holders и own license expression;
- allowed/forbidden third-party expressions;
- allowed exceptions;
- namespace `LicenseRef-<org>-*`;
- canonical texts и hashes custom licences;
- required notices/SBOM/evidence;
- optional human/legal review reference.

### 3. Patchset declaration

Выбирает policy profile по ID и может добавлять ограничения. Не содержит путь к
policy и не может расширить allowlist.

### 4. Upstream obligations

Лицензии и notices upstream анализируются как отдельный scope. Codkit их не
перелицензирует и не смешивает с own policy.

### 5. Distribution evidence

Для фактического package artifact создаются:

- sha256;
- component/provenance list;
- third-party notices;
- selected SBOM export;
- результат проверки требуемого notice/reference.

Инструмент сообщает `evidence complete/incomplete`, а не «юридически
совместимо».

`NOASSERTION` остаётся запрещённым. `LicenseRef` принимается только из
organization namespace при наличии текста и hash.

Acceptance cases:

- proprietary own file проходит под соответствующей trusted policy;
- тот же patchset не может сам разрешить proprietary expression;
- undeclared LicenseRef — отказ;
- declared LicenseRef без text/hash — отказ;
- package с удалёнными minifier'ом carriers и без NOTICE — красный gate;
- тот же package с требуемым attached notice — evidence green;
- текущие Codkit packages/runtime проходят byte-identically по supply policy.

## P0.11. Local workspace model для нескольких агентов

Не смешивать с release coordinator.

Workspace — локальная пара:

```text
workspaceId
patchset worktree + task branch
fork worktree + unique generated ref namespace
selected type/pin
owner/session metadata
```

Нужны команды create/list/show/finish/remove и named root selection через
launcher/orchestrator. Agent получает resolved roots через `where`, но не меняет
их flags.

Safety:

- один writer на физический patchset checkout;
- отдельный patchset worktree для каждого writing task;
- generated refs включают stable workspace ID;
- build daemons принадлежат workspace/tree ID;
- finish сначала доказывает save/clean state и только затем предлагает cleanup.

## P0.12. Build recipe v2 design

Зафиксировать type-neutral vocabulary, но не реализовывать adapters всех build
systems.

```text
action: one-shot | daemon
argv, cwd, declared env inputs
network policy
pass/error protocol
dependency manifests
dependency receipts
outputs and scratch roots
cleanup/restore semantics
```

Убрать из будущего public contract слово npm `script`. Текущий type adapter
может продолжить преобразовывать свои scripts в generic actions.

Fable считает реализацию этого изменения P2. Синтез: design и compatibility
tests — P0; implementation — вместе с первым non-Node type.

## Последовательность реализации после утверждения плана

### Phase 1 — Public-contract hardening

P0.1–P0.5, P0.7 и Git decision. Результат: public formats, type ABI и
discipline semantics больше не зависят от monorepo coincidence.

Gate: все существующие tests green; serialized existing patchset unchanged;
fixtures incompatibility fail before writes.

### Phase 2 — Licensing and release evidence

P0.10 implementation и artifact evidence часть P0.7.

Gate: proprietary/LicenseRef differential suite, minified artifact negative,
deterministic evidence output, unchanged Codkit supply checks.

### Phase 3 — Local multi-agent workspaces

P0.11 implementation: named workspaces, unique refs, writer protection,
lifecycle.

Gate: два параллельных tasks load/build independently; concurrent writers into
one patchset checkout refuse; separate patchset worktrees save independently.

### Phase 4 — Trusted external type supply

P0.3/P0.4 implementation при наличии партнёра.

Gate: clean offline install, integrity refusal, version mismatch refusal,
manifest inspection without execution.

### Phase 5 — Measured expansion

Только с реальным consumer:

- patch-heavy profile + new artifact codecs;
- build recipe v2 implementation;
- release coordinator;
- composite checkout graph.

Каждый добавляется отдельным polygon, а не условием по имени продукта.

## Test strategy

Новые generic fixtures не должны копировать layout реального consumer.

Обязательные polygons:

1. External type wrong contract/integrity.
2. Non-Node one-shot build recipe и non-npm dependency receipt.
3. Paths с spaces, quotes и double underscores.
4. Proprietary organization policy и controlled LicenseRef.
5. Packaged artifact, потерявший source headers.
6. Два local workspaces одного upstream repository.
7. Concurrent patchset writer refusal.
8. Coordinator crash at each atom после его реализации.
9. Patch-heavy delete/move/replace после появления profile.
10. Backward fixture старого patchset: generated tip/fingerprint не меняется.

## Что сейчас не делать

- Не помещать несколько repositories внутрь одного component `codkit.json`.
- Не обещать cross-repository rollback.
- Не загружать code из patchset.
- Не давать type package управлять discipline rules.
- Не вводить десятки boolean policy flags.
- Не строить non-Git VCS abstraction.
- Не писать adapters Brave/GitLab без отдельного исследования их реального
  workflow и license obligations.
- Не объявлять SBOM format вечным до первого distribution evidence prototype.
- Не менять текущий minimal profile под видом универсализации.

## Решения владельца перед кодированием

1. Утвердить Git как постоянную границу.
2. Утвердить отдельную ось discipline profile.
3. Выбрать schema migration strategy: рекомендован `codkitConfig: 3`.
4. Утвердить component patchset как атом и coordinator как внешний уровень.
5. Выбрать location/trust model organization policies и type registry.
6. Решить, нужен ли Codkit runtime в конечном commercial artifact или возможно
   оставить его build-time-only для части types.
7. Перед первым коммерческим release получить юридическое решение о форме UPL
   notice в minified/bundled artifacts.
8. Определить владельца signing keys и namespace сторонних type packages.

## Definition of done архитектурной подготовки

Codkit можно считать feature-proof, когда:

- внешний type имеет versioned handshake и integrity-pinned install;
- patchset не способен выполнить недоверенный code;
- discipline явно названа и входит в fingerprints;
- `.ckpatch` не является неявственно единственным возможным codec;
- лицензия consumer-кода задаётся trusted organization policy;
- final artifact имеет проверяемое licence/provenance evidence;
- local tasks изолированы в workspace pairs;
- multi-component release может быть добавлен coordinator'ом без изменения
  component patchset semantics;
- новые build systems выражаются recipes, а не branches в engine;
- текущие consumers продолжают давать byte-identical materialization.
