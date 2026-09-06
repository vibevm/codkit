# TREE-COMMITS-SAVE-PLAN v1 — коммиты в дереве форка становятся работой; `load`, `save` и двусторонний `sync`; `gc`

_Status: PLANNED, ACCEPTED with owner amendments 2026-09-05 (RP-0…RP-9
RESOLVED, RP-10 RESOLVED и выполнен; RP-4 открыт и ничего не блокирует) · написан против
worktree `/home/olegchir/work/sbtgit/codkit-linked-worktree-fix`, ветка
`fix/linked-worktree-git-path`, HEAD `f56866b` плюс незакоммиченная цепочка
REPAIR-001…010 (снимок `codkit-jobs/linked-worktree-paths/snapshots/20260905T1352Z-post-audit/`,
98 файлов) · **предусловие старта: REPAIR-011 закрыт, цепочка закоммичена,
`git status` пуст** (§8 «Предусловие») · cold-executable: любая граница фазы —
безопасная остановка; floor зелёный на каждой границе._

Жанр: campaign plan (не нормативен). Нормы, которые кампания устанавливает,
переезжают в спеки по мере закрытия фаз; после `EXECUTED` файл можно удалить.

## 2. Execution record

_(пусто до закрытия; заполняет исполняющая сессия — см. §14)_

## 3. Мандат

Мандат (владелец, 2026-09-05), дословно, с одной редактурой: владелец назвал
downstream-репозиторий продукта по имени, а этот репозиторий — generic-инструмент и
не несёт токен продукта ни на одной поверхности, поэтому имя заменено на
`<репозиторий patch set>`. Замена отмечена здесь, а не сделана молча: смысл
сценария от неё не меняется, а тихая правка цитаты меняла бы её статус.

> напиши в виде файла план, что нужно разработать, чтобы осуществить следующий
> сценарий:
>
> - Репозиторий `<репозиторий patch set>`: codkit sync
> - Репозиторий vscode: сделали несколько коммитов
> - Репозиторий vcscode: codkit save
> - Репозиторий `<репозиторий patch set>`: получили все изменения, включая промежуточные коммиты
>
> я хочу чтобы план делал Opus, а ты разработала - что именно он должен
> сделать, во всех детальных подробностях

Дополнения владельца того же дня, дословно:

> 1) Можем ли мы сделать какой-нибудь codkit gc, который почистит мусор в
> consumed (и может еще какой-нибудль ненужный мусор). 2) Можем ли мы сейчас
> переименовать sync в load. Чтобы в будущем сделать настоящую команду sync
> которая будет делать двусторонний save+load.

> Может быть нам сразу стоит спроектировать sync и вписать это в план?

> можно ли как-то остановить sync или это слишком сложно и дорого? Типа как у
> гита есть abort для rebase

Контекст: диалог владельца с Opus, где Opus по коду утверждал, что `save`
видит только `git status`, поэтому закоммиченная в дереве работа либо молча
игнорируется («nothing to save», exit 0), либо при частично незакоммиченной
работе перезаписывается внутренним rebuild'ом до `CK-E-INTERNAL`; и что
`sync` над закоммиченной работой молча пересоздаёт ветку. Все четыре
утверждения подтверждены прогоном реального CLI на fixture (§5, F7–F12).

Чтение мандата (RP-0, RP-3): «получили все изменения, включая промежуточные
коммиты» = (1) итоговое содержимое дерева попадает в patchset целиком,
закоммичено оно или нет; (2) история patchset получает по одному коммиту на
каждый промежуточный коммит дерева с исходным сообщением, автором и датой —
режим по умолчанию; `--squash` сворачивает их в один коммит. Аналогия,
названная владельцем: кнопки слияния pull request'а («rebase and merge» по
умолчанию, «squash and merge» по флагу; «merge commit» аналога не имеет).

Где выполняется кампания: в worktree
`/home/olegchir/work/sbtgit/codkit-linked-worktree-fix` (ветка
`fix/linked-worktree-git-path`) репозитория инструмента Codkit — там, где
лежит незакоммиченная цепочка REPAIR (F28). Роль писателя в этом каталоге
передана владельцем от центральной сессии (Opus) исполнителю этой кампании
2026-09-05; центральная сессия туда не пишет и воркеров не запускает, пока
роль не возвращена. Агентского периметра в репозитории инструмента нет
(`.claude/settings.json` worktree — только deny-список, хук снят самим
владельцем, F29); работа идёт по правилам boot-ленты:
атомарные коммиты Conventional Commits, без трейлеров с именем модели
(git-attribution-policy), `npm run floor` зелёный на каждой границе.

## 4. Арифметика цели

Baseline (2026-09-05, проверено командами из §11; перемерено 2026-09-06
на закоммиченной базе `c598581`+`e44e395` — спайк S0.11):

| Величина | Baseline | Exit |
| --- | --- | --- |
| Пути тихой/деструктивной потери работы, закоммиченной в дереве (F7, F9, F10/F11) | 3 | 0, каждый закрыт красным e2e |
| Скрытый `CK-E-INTERNAL` при сдвиге patch-артефакта на стороне patchset между load и save (H1) | 1 (гипотеза, S0.7) | 0: честный `CK-E-PATCHSET-MOVED` в `save`, слияние в `sync` |
| Публичные команды (`##COMMAND-ROSTER`) | 18 | 20: `sync` → `load`; новые `sync` (двусторонний) и `gc` |
| Приёмочные сценарии FEAT-002 | S01–S16 = 16 | 28 (S17–S28) |
| `ERROR_CODES` в `codkit/src/lib/messages.ts` | 40 | 43 (`TREE-HEAD`, `PATCHSET-MOVED`, `SYNC-IN-PROGRESS`) |
| `WARNING_CODES` | 3 | 3 |
| Флаги CLI (`argv.ts`): `save --squash`; `load --discard`; `sync --squash/--commit/--message/--discard/--fresh/--dry-run/--abort/--continue`; `gc --dry-run/--keep-consumed/--older-than` | 0 | 12 |
| Команды, отказывающие над коммитами дерева (`load`, `ci`, `publish`, `cycle start`, `clone` поверх, `cycle restart`) | 0 | 6 |
| Vitest: файлы / тесты | 109 / 1547 | ≥ 112 / ≥ 1515 (целевые значения ниже новой базы — пересчитывает владелец, S0.11) |
| E2e-файлы `codkit/test/e2e` | 23 | 26 (`treeCommits`, `syncTwoWay`, `gc`; `sync.test.ts` → `load.test.ts`) |
| `@scope`-маркеры (`npm run trace:check`) | 118/118 | 124/124 (6 lib + 2 command модулей) |
| Structural floor: file-length findings | 8 frozen, 0 new | 8 frozen, 0 new |
| Specmap units | 646 | 646 + новые анкеры (точное число фиксирует ledger) |

Все числа — по worktree на 2026-09-05 (снимок post-audit); REPAIR-011 может
их сдвинуть, поэтому quick-start (§11) перемеряет их на закоммиченной базе и
исполнитель правит эту таблицу первым коммитом Phase 0. Всё остальное
(format, typecheck, runtime emit, trace, docs, `vibe check` 0 errors / 1
известный warning CK-A11) остаётся зелёным без движения.

## 5. Факты о текущем состоянии (проверены при написании; не переоткрывать)

Указатели даны как `файл:строка` на байтах worktree (снимок post-audit
2026-09-05). Здесь «`sync`» — сегодняшнее имя односторонней команды; после
Phase 1 она называется `load`.

- **F1** Отбор файлов в `save` — только `git status --porcelain -z`:
  `codkit/src/lib/saveEngine.ts:303-323` (`upstreamChanges`). Коммиты по
  построению невидимы; диапазон коммитов от последнего apply нигде не
  вычисляется.
- **F2** Ветка «нечего сохранять»: `saveEngine.ts:222-225` — при
  `written === 0 && own.copied === 0 && own.removed === 0 && dirty.length === 0`
  печатается `nothing to save`, `status: 'nothing'`, exit 0.
- **F3** Порядок «сначала разрушение, потом проверка»: `saveEngine.ts:239-259`
  вызывает `runSync({ skipDriftGuard: true })`, внутри которого
  `syncEngine.ts:461-478` под общим замком репозитория и после проверки
  `assertGeneratedRefExclusive` делает `updateRef` + `moveWorkTree`, и лишь
  после возврата `assertNothingMoved` (`saveEngine.ts:734-757`) бросает
  `CK-E-INTERNAL` с hint «attach the output to a bug report».
- **F4** Страж дрейфа `driftDirty` (`codkit/src/lib/driftGuard.ts:78-95`) —
  две половины: `git status --porcelain` вне own-каталога (`upstreamDirt`,
  `:101-123`, с предикатом `isKnownMaterialization` из цепочки REPAIR) и
  побайтовое сравнение own. Коммиты не видит. Вызывающие: `sync`
  (`syncEngine.ts:330`),
  `cycle start`, `ci`, `publish`, `clone` поверх, `cycle restart`
  (PROP-008 `##DRIFT-GUARD-PREDICATE`).
- **F5** Fast-path `sync` замечает расхождение tip (`treeCache.ts:241-283`,
  условие `tip`), но это повод для полной пересборки, не отказ. `status`
  печатает `resync needed (6/7 conditions): branch … is at X, the cache
  recorded Y` (`codkit/src/commands/status.ts:67-82`), то есть подсказывает
  разрушительное действие.
- **F6** Хук дерева: `sync` переписывает `<tree>/.git/hooks/pre-commit`
  (`syncEngine.ts:1657-1700` `TREE_PRE_COMMIT_HOOK`, `writeTreeHook`
  `:1704-1788`: contained-запись, чужой хук не перезаписывается, effective
  hook path проверяется строго — REPAIR-006, PROP-008
  `##TREE-HOOK-LAYOUT-CANONICAL`), отклоняющий `git commit` без
  `CODKIT_INTERNAL_COMMIT=1`. **В linked worktree хук не ставится вовсе**
  (хуки общие для всех worktree репозитория; `writeTreeHook` печатает
  `CK-W-MARK-RO` и выходит) — там ручные коммиты уже сегодня ничем не
  сдерживаются. Норма PROP-012 `##FORK-TREE-PRECOMMIT-HOOK` (решение
  владельца 2026-08-31, текст уточнён цепочкой REPAIR) и PROP-008
  `##TREE-HOOK-STEP`; e2e `codkit/test/e2e/sync.test.ts` (описание «the
  fork-tree hook»). Обход тривиален: `--no-verify`, переменная окружения,
  `core.hooksPath`, `merge`/`cherry-pick`/`rebase`. Codkit сам «коммитит» в
  дереве только через `commit-tree`/`update-ref` в `buildBranch`
  (`syncEngine.ts:723-816`).
- **F7** Воспроизведение S-B (fixture `makeCliFixture`, два коммита
  `--no-verify` на `codkit/applied/t1`, дерево чистое): `codkit --json save` →
  exit 0, `data.status = "nothing"`, сообщение `nothing to save`; артефакты
  не созданы/не изменены.
- **F8** Там же `codkit --json status` → exit 0, `branch.upToDate = false`,
  6/7 условий, красное `tip`; `upstream.changed = 0`, `own.changed = 0`.
- **F9** Воспроизведение S-C (один коммит `--no-verify` с правкой внутри
  блока `CK-workbench-901` в `examplePart.ts` + незакоммиченный блок
  `CK-base-905` в `util.ts`): `codkit --json save` → exit 2,
  `CK-E-INTERNAL` «the rebuilt branch does not match the working tree: 1
  file(s) had to be rewritten (…examplePart.ts)…». До ошибки напечатано
  `…util.ts.ckpatch: created`, `applied 3 artifact(s) … at 52254a82`,
  `updated 1 file(s) in the work tree`. После: незакоммиченная часть
  извлечена, закоммиченная нет, рабочий файл потерял строку, HEAD
  `3c7776f → 52254a8`, коммит доступен только через reflog.
- **F10** S-B, затем `codkit --json sync` → exit 0, `applied`,
  `changedFiles = 2`, ни одного warning; оба коммита не предки HEAD;
  вставленные строки исчезли; reflog — единственный след.
- **F11** Тот же результат при «коммит → сразу `sync`, без `save`».
- **F12** `git commit` с хуком → exit 1 (три строки `codkit: …`);
  `--no-verify` → exit 0. Обёртка `runGit` в тестах добавляет
  `-c core.hooksPath=/dev/null` (`gitx.ts:97`): хук видим только через
  `gitLocal`. Следствие: `save --commit` коммитит в patchset через `runGit`
  (`saveEngine.ts:801`), **хуки patchset при этом не выполняются**.
- **F13** Сгенерированные коммиты распознаваемы: автор
  `codkit <codkit@patchset.invalid>` (`syncEngine.ts:78-79`), сообщение
  `codkit: <id> <target>` с трейлерами `Codkit-Artifact`,
  `Codkit-Patchset-Commit`, `Codkit-Upstream-Pin: <tag>@<sha>`
  (`syncEngine.ts:968-979`); дата — дата пина. Git на машине 2.53.0;
  `%(trailers:key=…,valueonly)` доступен с git 2.22.
- **F14** Own-код локально не в git (`.git/info/exclude`, PROP-005
  `##OWN-EXCLUDED-LOCALLY`): коммиты дерева never несут own-файлы.
- **F15** `save <paths>` при оставшейся вне путей грязи не перестраивает
  ветку (`saveEngine.ts:184-188, 231-235`, PROP-007 `##SAVE-SCOPED-BRANCH-RULE`).
- **F16** Цикл: `cycle continue` (resolve) вызывает `runSave` с
  `forcedPaths`/`patchHeaderOverrides`/`deferSync` (`saveEngine.ts:63-68,
  150-152`); сам цикл перед этим регенерирует и коммитит артефакты в
  patchset (PROP-009 `##PHASE-APPLY`, `##PHASE-RESOLVE`). Агентам коммиты в
  дереве запрещены (FEAT-004 `GR-NO-COMMITS`), это не меняется.
- **F17** Ограничения репозитория инструмента: `conform.toml`
  `max_file_lines = 600`, 8 file-length findings заморожены по пути файла
  (`saveEngine.ts` 889, `syncEngine.ts` 1976 после цепочки REPAIR — уже в
  baseline); каждый
  production `.ts` начинается с `/** @scope spec://codkit/modules/codkit/PROP-0NN#root */`
  (`tools/check-ts-scopes.mjs`); `commands.md`/`faq.md` генерируются
  `tools/generate-codkit-docs.mjs` (флаги из `argv.ts`, FAQ из реестра
  сообщений); `specmap.json` перегенерируется
  `vibe bin exec typescript-ai-native -- specmap`.
- **F18** Полный floor `npm run floor` ≈ 4–5 мин (vitest 105 файлов / 1452
  теста при `maxWorkers=4`); `vibe check --quiet` → 0 errors, 1 warning
  (CK-A11). Проверено на байтах worktree 2026-09-05: format, typecheck,
  runtime build/check (116 файлов), trace (116/116) зелёные; vitest
  104/105 файлов, 1450/1452 теста — два красных в `agentProtocol.test.ts`
  и шаг `docs:check` красный по одной причине: `docs/codkit/protocol/agent/check.mjs`
  и тест требуют PreToolUse-хук в `.claude/settings.json`, а хук снят (F29,
  RP-10). После переноса профиля (F29) полный `npm run floor` на тех же
  байтах: format, typecheck, runtime 116, trace 116/116, `docs:check`
  зелёные; vitest 104/105 файлов, 1451/1452 — единственный красный
  `ciTeardownTreeBound.test.ts` («does not let the poisoned teardown replace
  the real compile verdict»: exit 2 вместо 1 под нагрузкой полного набора),
  в изоляции 3/3 зелёный — флейк зоны REPAIR-011, не этой кампании;
  structural отдельно: 8 frozen, 0 new; specmap `--check` clean (645). AUDIT.md worktree в шапке ещё называет `96/96`/`1409` —
  рассинхрон, который закрывает REPAIR-011, не эта кампания.
  Перемерено 2026-09-06 на закоммиченной базе `e44e395`: format, typecheck,
  runtime build/check (118 файлов), trace 118/118, `docs:check` зелёные;
  vitest 109/109 файлов, 1547/1547 теста; полный `npm run floor` exit 0
  (S0.11).
- **F19** Пустой patchset: `buildBranch` начинает с `parent = pin.sha`
  (`syncEngine.ts:756`) и при пустом плане возвращает `top = pin.sha`
  (`:814`): ветка указывает на пин, трейлеров нет вовсе. До первого `sync`
  ветки нет, HEAD после `clone` detached на пине (`cliFixture.ts:77`,
  `clone.ts:164`). Sha пина известен из `codkit.json` всегда.
- **F20** `CK-E-BOTH-SIDES-EDITED` существует (`messages.ts`,
  `syncEngine.ts:1904-1911`), но только для own-кода; hint «resolve
  manually: keep one side, then codkit sync/save».
- **F21** Прецеденты транзакций с crash-тестами: `renameTransaction.ts`
  (595 строк, `applyBoundRenameBatch`/`resumeBoundRenameBatch`),
  `rebaseOntoPinMove.ts` (pending/completed receipts, `completedRebaseMoveForSync`),
  цикл (`cycleEngineTransactions.ts`, e2e `cycleCrashResume.test.ts`);
  seam `checkpoint` в `runSync`/`runSave` (`SyncEngineOptions.checkpoint`,
  `saveEngine.ts:69-71`); в цепочке REPAIR добавлены `worktrees.ts`
  (`acquireCommonRepositoryLock`, `mutateGeneratedRef` с checkpoints) и
  `daemonChannelLock.ts` (contained hard-link lock с nonce).
- **F22** Машинерия конфликтов: `classifyEngine.ts`, `replayPatch.ts`,
  `reresolve.ts` (3-way, diff3-маркеры), `cycleMaterialize.ts`
  (`materializeCycleApply`), `cycleResolve.ts` (`planCycleResolve`,
  `runCycleResolve`); `applyUnified.ts` применяет патч к байтам пина в
  памяти.
- **F23** Слово `sync` (как отдельное слово): `codkit/src` 85 вхождений,
  `codkit/test` 219, `docs/codkit` 50, спеки модуля 85, `tools` 8,
  `codkit/README.md` 4. Пользовательские подсказки со словом:
  `verifyEngine.ts` (6 мест: `grep -n 'codkit sync' codkit/src/lib/verifyEngine.ts`),
  `status.ts:82,109`, `syncEngine.ts:1908`, hint `CK-E-DIRTY-TREE` «run
  codkit save, or codkit status», новые тексты цепочки REPAIR про `sync
  --fresh` и linked worktree (`syncEngine.ts` §exclude/hook). Анкеры спек: `CMD-SYNC`, `COMP-SYNC`, `COMP-SYNC-RESP`,
  `DOES-SYNC`, `FLOW-SYNC`, `MVP-SYNC-SAVE`, `NFR-SYNC-NOOP`, `AP-SYNC-RULE`
  (последний про синхронизацию агентских копий, не трогать). В
  `codkit/claude` и `docs/codkit/agents` слово не встречается.
- **F24** Runtime-состояние patchset `.codkit/` (не коммитится): `trees/`
  (кэши деревьев, `treeCache.ts`), `locks/` (`lock.ts` — замок дерева;
  после цепочки REPAIR здесь же contained per-channel operation locks
  демонов `daemonChannelLock.ts` с протоколом «каждый артефакт несёт
  доказуемого владельца» — REPAIR-011 P1 №1), `tmp/` (индексы/blob'ы
  `buildBranch`, чистятся в `finally`, после крэша остаются), `out/`
  (инвентари), `build/` (записи и логи демонов `buildRuntime.ts`, строгая
  схема, CAS по generation), `pending/` (черновики `marker new`), файлы
  транзакций/квитанций `cycle-*.json`, `rename-transaction.json`,
  `rename-completions`, `rebase-onto-pin*` — записи восстановления. Всё,
  кроме `trees/`, `tmp/`, `out/`, имеет собственный протокол владения и
  руками/`gc` не трогается (PROP-009, `ck-cycle` rule, REPAIR-011).
- **F25** Цепочка REPAIR-001…010 в worktree (67 изменённых + 32 новых
  файла, +4535/−1239): linked-worktree поддержка (`worktrees.ts`:
  `listWorktrees`, `otherWorktreesOnRef`, `assertGeneratedRefExclusive`,
  `acquireCommonRepositoryLock`, `mutateGeneratedRef`; код
  `CK-E-WORKTREE-REF-SHARED`; PROP-008 `##GENERATED-REF-WORKTREE-PREFLIGHT`,
  `##FRESH-REF-PREFLIGHT`), contained-запись административных файлов
  (`containedFile.ts`: `readContainedFile`, `writeContainedFileAtomic`,
  `writeContainedFileExclusive`; метка дерева и хук пишутся только через них.
  С REPAIR-011 выборы поколения замка — `linkContainedFileExclusive`,
  `removeContainedHardlinkGeneration`, `removeContainedOrphanGeneration` —
  живут в отдельном модуле `containedGeneration.ts`: им нужен инъецируемый
  оракул живости), `gitCommonDirOf`/`effectiveGitPath` в `treeCache.ts`,
  per-worktree exclude (PROP-005 `##OWN-EXCLUDE-ACTIVATION`,
  `##OVERLAY-KNOWN-MATERIALIZATION`), демоны сборки (`buildRuntime.ts`,
  `buildChannel.ts`, `daemonChannelLock.ts`), `configPin.ts`. Ничего из
  этого не трогает `saveEngine.ts`, `status.ts`, `argv.ts`, `commands/save.ts`,
  `commands/sync.ts`.
- **F26** В linked worktree сгенерированная ветка общая для всех worktree
  репозитория; `sync` отказывает `CK-E-WORKTREE-REF-SHARED` (exit 2), если
  её держит соседний worktree (`syncEngine.ts:461-478`). Refs
  `refs/codkit/consumed/*` по той же причине общие: их создание идёт под
  `acquireCommonRepositoryLock`, а `gc` видит их из любого worktree.
- **F27** `hooksPatchSet.ts` экспортирует `badCause(message)` (`:295`) и
  `runCommitMsg` (`:262`) — валидация `Cause:` переиспользуема (закрывает
  спайк S0.6 положительно; спайк остаётся как подтверждение).
- **F28** REPAIR-011 (`codkit-jobs/linked-worktree-paths/REPAIR-011.md`)
  открыт: два независимых аудита вернули P1 (заклинивание канала замка
  при крэше восстановителя; четыре незакреплённые охраны containment),
  коммит цепочки заблокирован до чистого повторного аудита. Центральный
  план ведёт держатель custody (`~/.vibe/steward/contexts/ed264e27…`,
  holder `central-opus-20260905b`, ревизия 8, узел CODKIT-REPAIR-011);
  2026-09-05 по прямому распоряжению владельца («абей на то, что custody
  держит Opus») исполнитель добавил в `plan.toml` (ревизия 9, резервная
  копия `plan.toml.rev8.bak`) мандаты C-008/C-009 и узлы
  `CODKIT-TREE-COMMITS`, `CODKIT-AGENT-PERIMETER-SCOPE`, дополнил evidence
  `CODKIT-REPAIR-011` и перерендерил `GOAL.md`/`GOAL-CLAUDE.txt` эталонным
  `render_goal.py` под ids держателя; custody не трогалась; для
  перезапущенной центральной сессии записан
  `codkit-jobs/linked-worktree-paths/HANDOFF-FABLE-20260905.md`.
- **F29** `.claude/settings.json` в worktree изменён: блок `hooks.PreToolUse`
  удалён, остался deny-список. Владелец подтвердил 2026-09-05, что правку
  сделал сам («settings.json … я изменил сам»); вопрос атрибуции из снимка
  post-audit закрыт. 2026-09-05 по распоряжению владельца («и сама перенеси
  все имзенения») перенос агентского профиля в `codkit/claude/` внесён в
  worktree (unstaged), файл `.claude/settings.json` удалён намеренно,
  `check.mjs`/`agentProtocol.test.ts` требуют отсутствия периметра; основной
  checkout `codkit` сброшен к `f56866b`, где закоммиченный хук владелец
  снимает руками до коммита переноса. Узел `CODKIT-AGENT-PERIMETER-SCOPE` в
  центральном плане (F28).
- **H1 (гипотеза, проверяет S0.7)** По коду: если между load и save на
  стороне patchset изменился patch-артефакт файла F (pull/switch/чужой
  коммит), а в дереве работали над G, то `save` извлечёт G, перестроит
  ветку, перепишет F в дереве и упадёт с `CK-E-INTERNAL`: в
  `assertNothingMoved` объяснимы только цели resource/overlay/own
  (`nonPatchTargets`, `syncEngine.ts` `saveMaterializationTargets`), patch-цели
  — нет.

## 6. Решения D1–D22

### D1 — что считается «работой в дереве»

- (α) только незакоммиченное (сегодня) — отвергнуто: это и есть дефект.
- (β) незакоммиченное + любые коммиты, недостижимые из последней
  сгенерированной вершины (CHOSEN). Работа = *foreign-коммиты* (D2) ∪
  изменения рабочего дерева относительно HEAD.

### D2 — поиск foreign-коммитов (модуль `treeCommits.ts`)

1. `git rev-list --first-parent --format=%H%x00%ae%x00%(trailers:key=Codkit-Upstream-Pin,valueonly)%x00%aN%x00%aE%x00%aI%x00%s <ref> ^<pin.sha>`
   для `<ref>` ∈ {`HEAD`, `refs/heads/<branch>`} (если существует); порядок
   от новых к старым.
2. Коммит *сгенерированный*, если автор `codkit@patchset.invalid` **и**
   трейлер непуст. `base` = самый верхний сгенерированный; если ни одного
   (пустой patchset F19, ветка ещё не создана) — `base = pin.sha`. Нижняя
   граница всегда пин; трейлер лишь исключает то, что Codkit сам положил
   поверх.
3. `foreign` = коммиты выше `base` (от старых к новым).
4. Аномалия: несгенерированный коммит ниже самого верхнего
   сгенерированного → `CK-E-TREE-HEAD` («history of <branch> below the
   generated tip was rewritten; reset the branch to <sha> or restore it from
   refs/codkit/consumed/…»), exit 1.
5. Результат: `{ base, head, headRef, onGeneratedBranch, commits: [{sha, subject, authorName, authorEmail, authorDate}] }`.
- Отвергнуто: база из `cache.branchTip`/`mark.branchTip` — неавторитетны
  (PROP-006 `##TREE-IS-TRUTH`); `rev-list` без `--first-parent` — состояния
  боковых веток никогда не существовали на линии ветки.
- Fallback git < 2.22: парсить `%B`; решает S0.2.

### D3 — семантика `save` при foreign-коммитах (RP-0/RP-3)

- Всегда извлекается **итоговое состояние** дерева относительно `base`
  (D4), никогда относительно HEAD.
- **По умолчанию**: каждый foreign first-parent коммит воспроизводится
  отдельным коммитом patchset (D5), «rebase and merge». Незакоммиченный
  остаток ложится в рабочее дерево patchset и не коммитится, как сегодня;
  `--commit` коммитит и его (`--message` — только для этого коммита).
- `--squash`: все foreign-коммиты одним коммитом patchset («squash and
  merge»); сообщение по умолчанию `codkit save: squash of N tree commit(s)`
  с перечнем `sha subject` в теле, `--message` при `--squash` задаёт его;
  трейлер `Codkit-Tree-Commit` на каждый свёрнутый sha.
- В `##CMD-SAVE` сказано явно: «merge commit» аналога не имеет (две истории
  в двух репозиториях).
- Следствие: `save` **создаёт коммиты в patchset сам**, как только в дереве
  есть коммиты; без них поведение прежнее.
- `save <paths>`: итоговое состояние только названных путей, без
  воспроизведения, ветка не трогается (`##SAVE-SCOPED-BRANCH-RULE`);
  `info`: `N tree commit(s) stay in the tree until a full save`.
- Отвергнуто: сворачивание по умолчанию; отказ без `--commit`.

### D4 — отбор файлов состояния относительно `base` (модуль `treeState.ts`)

- `TreeState = { kind: 'worktree' } | { kind: 'commit'; sha }`.
- `changesSince(treeDir, base, state, ownDirName, forcedPaths)`: worktree —
  `git diff --name-status -z --no-renames <base>` ∪ записи `??` из
  `git status --porcelain -z`; commit — `git diff --name-status -z
  --no-renames <base> <sha>`. Own-префикс отфильтрован, `forcedPaths` как
  сегодня. `D` → `CK-E-DELETES-UPSTREAM-FILE`; rename при `--no-renames` =
  удаление + новый файл, как сегодня.
- `bytesOf(state, path)`: worktree → `readFileSync`; commit →
  `git cat-file blob <sha>:<path>` (буфер). `bytesAtPin` не расширять.
- `upstreamChanges` заменяется `changesSince(worktree)`; `planFile`
  получает bytes через провайдер.
- Отвергнуто: два списка `diff base..HEAD` + `status` — дублирует пути,
  теряет staged.

### D5 — воспроизведение коммитов (модуль `saveReplay.ts`)

- Состояния `S_1…S_n` = foreign first-parent коммиты от старых к новым,
  затем `S_wt` = рабочее дерево. При `--squash` промежуточные состояния
  всё равно валидируются, но пишется и коммитится только `S_n`.
- **Два прохода.** Проход 1 без записи: `planFile` для каждого `S_i` поверх
  in-memory `ArtifactStore` (overlay над `delta/patches` и `.codkit/pending`,
  фиксирует потребление pending'ов). Любая ошибка → `blocked`, exit 1,
  **ничего не записано**, в тексте `sha` и `subject` состояния. Проход 2:
  для `S_1…S_n` запись артефактов (`commitArtifacts`) + коммит patchset;
  для `S_wt` own (`mirrorOwnBack`) + артефакты, коммит только при
  `--commit`.
- Коммит patchset для `S_i`: пути = изменённые артефакты; сообщение =
  исходное дословно + `Codkit-Tree-Commit: <sha40>`; `GIT_AUTHOR_*` = автор
  коммита дерева; committer = запускающий (`commitIdentity()`). Состояние
  без изменений артефактов → коммит пропущен с сообщением.
- Валидация `Cause:` тем же кодом, что `hooks commit-msg` (F12), в проходе
  1.
- **Идемпотентность:** `git log --fixed-strings --grep="Codkit-Tree-Commit: <sha>" -1`
  в patchset; найденный пропускается; `--squash` после частичного replay
  доигрывает оставшиеся одним коммитом.
- Отвергнуто: однопроходная запись; squash по умолчанию; own по коммитам
  (F14).

### D6 — дерево после извлечения

- Ветка пересобирается как сегодня (`runSync({ skipDriftGuard: true })`);
  сгенерированная история детерминирована (S16). **Предусловие** перед
  пересборкой: множество foreign равно множеству только что потреблённых;
  иначе `CK-E-INTERNAL` **до** `updateRef`/`moveWorkTree` (закрывает F3 по
  порядку).
- Потреблённые коммиты остаются достижимы: `refs/codkit/consumed/<UTC
  yyyymmddThhmmssZ>-<short7>` → старый HEAD, `update-ref` под
  `acquireCommonRepositoryLock` (refs общие для всех worktree, F26);
  сообщение `tree commits consumed: N (<first>..<last>); kept as
  refs/codkit/consumed/…`. Refs — диагностика, не истина (PROP-006
  `##TREE-IS-TRUTH`); чистит только `gc` (D22).
- `assertNothingMoved` остаётся; объяснимое множество расширяется в D16.
- Отвергнуто: строить ветку «поверх» чужих коммитов (ломает S16).

### D7 — третья половина стража

- `driftDirty` возвращает `commits: readonly TreeCommit[]`;
  `dirty = upstream ∨ own ∨ commits.length > 0`; список для человека
  включает `commit <short> "<subject>" (not in patchset)`.
- Разрушительные команды (`load`, `cycle start`, `ci`, `publish`, `clone`
  поверх, `cycle restart`) отказывают `CK-E-DIRTY-TREE`: `N commit(s) in
  the fork tree since the last codkit apply are not in patchset yet`, hint
  `run codkit save or codkit sync (or codkit load --discard to drop them)`.
  Код переиспользуется: FAQ-рецепт верен и здесь.
- `load --fresh` не снимает отказ; `load --dry-run` страж не запускает (как
  сегодня); `skipDriftGuard` — единственный обход, только для `save`/`sync`.
- Отвергнуто: отдельный код `CK-E-TREE-COMMITS`.
- **Правка от 2026-09-06 по красному спайку S0.12 (владелец решения —
  центральная сессия).** Спайк показал, что при разделённой сгенерированной
  ветке коммит в соседнем worktree сдвигает общий ref и тем самым делает индекс
  ЭТОГО дерева staged-dirty, хотя здесь никто ничего не менял. Сегодня `sync`
  отказывает `CK-E-DIRTY-TREE` раньше, чем срабатывает преflight
  `CK-E-WORKTREE-REF-SHARED`, и его подсказка «run codkit save» здесь **вредна**:
  она предлагает втянуть чужую работу в этот patch set как собственную правку.
  **Решение: преflight разделённого ref идёт ПЕРЕД проверкой грязного дерева,
  безусловно.** Причина диагностируется раньше симптома, а подсказка про `save`
  остаётся только для настоящей локальной грязи. Отказ по разделённому ref
  обязан называть соседний worktree и не советовать `save`.
  Отвергнуто: определять «фантомную» грязь эвристикой внутри `CK-E-DIRTY-TREE` —
  это оставляет верный диагноз зависящим от угадывания, а порядок проверок
  задаёт его прямо. Отвергнуто: разрешать `save` при разделённом ref — сосед
  может сдвинуть ref под извлечением. Пересмотр: если появится режим, где
  разделённый ref штатен и безопасен, порядок пересматривается вместе с ним.

### D8 — HEAD не на сгенерированной ветке

- Ветка ещё не существует (первый `load` после `clone`, F19): цепочка HEAD
  над пином — работа, где бы HEAD ни был; `save` извлекает её с
  `base = pin.sha`, создаёт ветку при пересборке; `load` отказывает (D7).
- Ветка есть, foreign нет — как сегодня (`load` возвращает HEAD на ветку).
- Ветка есть, foreign на HEAD, HEAD не на ветке — `save`/`load`/`sync`
  отказывают `CK-E-TREE-HEAD`: «HEAD is on <ref|detached> with N commit(s)
  not in patchset; switch to codkit/applied/<tag> (git switch) or merge them
  there, then run codkit save». Аномалия D2 п.4 — тот же код.
- Отвергнуто: молча извлекать с detached HEAD при существующей ветке.
- **Правка от 2026-09-06 (S0.12).** `CK-E-TREE-HEAD` и `CK-E-DIRTY-TREE`
  подчиняются тому же порядку, что и D7: если ref сгенерированной ветки разделён
  с другим worktree, первым говорит `CK-E-WORKTREE-REF-SHARED`. Ни один из этих
  отказов не советует `save`, пока разделение не снято.

### D9 — хук дерева (RP-1: «вместо запрета сделать напоминание»)

- Хук **никогда не отклоняет** коммит. На ветке `codkit/applied/*`:
  `codkit: this commit is work in the fork tree; it reaches patchset only
  when you run codkit save or codkit sync`; вне ветки при существующей
  ветке: `codkit: HEAD is not on codkit/applied/<tag>; codkit save will
  refuse until you switch back (git switch codkit/applied/<tag>)`.
  `CODKIT_INTERNAL_COMMIT=1` подавляет напоминание.
- Переустанавливается каждым `load`, как сегодня, через существующий
  `writeTreeHook` (contained-запись, чужой хук не трогается); в linked
  worktree по-прежнему не ставится (F6) — там напоминание невозможно, и
  единственная защита — отказ `save`/`load`/`sync`, что и требовалось.
- Отвергнуто: удалить хук; оставить запрет; отклонять вне ветки — защитой
  служит отказ `save`/`load` (D7/D8).
- PROP-012 `##FORK-TREE-PRECOMMIT-HOOK` переписывается с записью решения и
  рулингом дословно.

### D10 — `status`

- Строка `tree commits not in patchset: N` + до 20 `  <short> <subject>`;
  `data.treeCommits: { base, count, commits: [{sha, subject}] }`.
- При `N > 0` строка `reload needed …` не печатается; вместо неё существующая
  подсказка про `save`; exit 1.
- Новая строка `loaded from patchset commit: <sha|dirty>` (из трейлера
  `Codkit-Patchset-Commit` базы или `mark.patchSetCommit`, D17) и при
  сдвиге patchset — `patchset moved since load: N artifact(s)` с перечнем
  (D16); это данные для ручного рецепта D18.

### D11 — `load --discard` (RP-2: «Сделай флаг, для краткости просто --discard»)

- Снимает третью половину стража на один запуск: старый HEAD → `refs/codkit/consumed/…`,
  сообщение `discarded N commit(s): <first>..<last>; kept as …`.
- Без foreign — no-op с `info`; с `--ci` — usage error (exit 2).
- Тот же флаг принимает двусторонний `sync` (D15).
- Отвергнуто: «пусть человек делает `git reset --hard`».

### D12 — цикл апгрейда

- `cycle continue` использует отбор D4 (коммиты человека в фазе resolve
  попадают в извлечение), воспроизведение D5 в цикле не применяется
  (коммиты цикла канонические с `Cause:`), проверка D18 в цикле
  отключается флагом `skipPatchsetMovedCheck` (цикл сам регенерировал и
  закоммитил артефакты, F16). `cycleResolve*`/`cycleEngine*` не меняются;
  Phase 3 доказывает это зелёными сьютами (P3); иначе — явное вхождение в
  фазу через ledger.

### D13 — раскладка кода (F17)

- Новые модули, каждый с `@scope`-маркером и < 600 строк:
  `lib/treeCommits.ts` (D2, consumed refs), `lib/treeState.ts` (D4),
  `lib/saveReplay.ts` (D5), `lib/syncMerge.ts` (D16, D17),
  `lib/syncTransaction.ts` (D20, D21), `lib/gc.ts` (D22);
  `commands/load.ts` (переименованный `sync.ts`), новый `commands/sync.ts`
  (двусторонний), `commands/gc.ts`. `saveEngine.ts`/`syncEngine.ts` меняются
  точечно; S0.4 решает, допустим ли их рост.
- Внутренние имена `runSync`, `syncEngine.ts`, `SyncEngineOptions`,
  `skipDriftGuard` **не** переименовываются: файл заморожен в baseline по
  пути, переименование сделало бы его «новым» finding'ом (DEF-6:
  переименовать при распиле файла).

### D14 — переименование `sync` → `load` (RP-6)

- Публичная команда `sync` переименовывается в `load` целиком: имя,
  флаги (`--fresh`, `--dry-run`, `--clone-if-missing`), все подсказки (F23),
  `status` (`resync needed` → `reload needed`), текст хука, `commands.md`/`faq.md`
  (генерация), протокол людей 01–12, `codkit/README.md`, FEAT-002 тексты,
  `sync.test.ts` → `load.test.ts` и все `run(['sync'…])` в тестах.
- До появления двустороннего `sync` (Phase 8) команда `sync`
  регистрируется как заглушка: usage error, exit 2, stderr `codkit sync was
  renamed to codkit load; the name sync is reserved for the two-way
  save+load command` (без конверта, как у неизвестных команд). Алиас
  отвергнут: когда имя получит новый смысл, скрипты со старым смыслом молча
  сломались бы.
- Анкеры спек **не** переименовываются (addressable-specs
  `NEVER-RENAME-OR-DELETE-A-CITED-ANCHOR`): `CMD-SYNC`, `COMP-SYNC`,
  `COMP-SYNC-RESP`, `DOES-SYNC`, `FLOW-SYNC`, `MVP-SYNC-SAVE`, `NFR-SYNC-NOOP`
  становятся надгробиями с указателем на новые `CMD-LOAD`, `COMP-LOAD`,
  `COMP-LOAD-RESP`, `DOES-LOAD`, `FLOW-LOAD`, `MVP-LOAD-SAVE`, `NFR-LOAD-NOOP`.
  `AP-SYNC-RULE` (FEAT-004) не касается команды и не трогается. Термины
  `apply`/`applied` (ветка `codkit/applied/<tag>`, PROP-008 §3) — про
  механизм, не про команду, не трогаются.
- Идёт **первой** фазой: все последующие правки спек, документов и тестов
  ложатся под новое имя один раз.

### D15 — тройка команд (RP-7: «Согласен»)

- `load`: patchset → дерево; отказывает над неизвлечённой работой (D7).
- `save`: дерево → patchset; извлекает коммиты и рабочие изменения,
  перестраивает дерево; отказывает, если patchset сдвинулся с последнего
  load (D18).
- `sync`: обе стороны; извлекает работу дерева, принимает сдвиг patchset,
  правило D16 на каждый файл, перестраивает дерево. Флаги: `--squash`,
  `--commit`, `--message`, `--discard`, `--fresh`, `--dry-run`, `--abort`,
  `--continue`.
- Смысл: у каждой команды одно направление или явно обе; ни одна не
  сливает молча. Отвергнуто: `save` = двусторонний по умолчанию.

### D16 — правило слияния на каждый файл (RP-8: остановка без автослияния)

- Метка дерева (`.git/codkit/applied.json`, `TreeMark`) получает
  необязательные поля `artifacts: Record<artifactPath, sha256>` (все файлы
  под `delta/`, кроме `delta/own/**`, которые уже покрыты `ownFiles`) и
  `patchSetCommit`; пишутся каждым rebuild (`writeTreeMark` в `runSync`);
  карта берётся из расширенного `deltaFingerprint` (`fingerprint.ts` уже
  хэширует каждый файл); запись — существующим `writeTreeMark` через
  `writeContainedFileAtomic` (F25), схема `treeMarkSchema` с `.optional()`.
  Старые метки без полей читаются: классификатор
  отвечает «unknown» → для `sync` это `CK-E-PATCHSET-MOVED` с hint «run
  codkit load once to record the loaded state».
- Классификация цели F: `treeChanged(F)` = F ∈ `changesSince(base,
  worktree)` (own — через `classifyOwn`); `patchsetChanged(F)` = артефакт F
  добавлен/удалён/изменён относительно `mark.artifacts` (own — как сегодня
  по `ownFiles`).
- Только дерево → извлекаем; только patchset → применяем версию patchset,
  перезапись F в дереве при rebuild **объяснима** (расширение множества
  `assertNothingMoved`); обе стороны → остановка `CK-E-BOTH-SIDES-EDITED`
  с именем файла и обеих сторон (сообщение обобщается с own на patch-слой,
  F20); слои overlay/resource/rule/removed авторуются только в patchset и
  всегда «только patchset».
- Отвергнуто: автослияние патчей (это 3-way территория цикла; в 8b —
  материализация diff3 для человека, не автослияние).

### D17 — проверка родословной (RP-7)

- «Из чего загружено дерево» = `Codkit-Patchset-Commit` трейлера базы
  (D2), либо `mark.patchSetCommit` при `base = pin` (F19). Значение —
  sha, `dirty` или `none`.
- `save`, `sync`: если sha и он не предок HEAD patchset (`git merge-base
  --is-ancestor`) → `CK-E-PATCHSET-MOVED`: «the tree was loaded from
  patchset commit <sha>, which is not an ancestor of HEAD <sha2>; the tree's
  work belongs to that state» + рецепт D18. Если `dirty`/`none` —
  предупреждение и продолжение.
- Отвергнуто: молча извлекать в чужую ветку (сегодняшнее поведение после
  `git switch` без `save`).

### D18 — `save` при сдвиге patchset (RP-7: «отказывать») и ручной рецепт

- `save`: если `patchsetChanged` непусто (D16) или родословная нарушена
  (D17) → `CK-E-PATCHSET-MOVED`, exit 1, ничего не записано. Текст ошибки
  содержит: sha загрузки, список сдвинувшихся артефактов и ручной рецепт:
  1. вернуть артефакты patchset к загруженному состоянию (`git stash`, либо
     `git switch <ветка>`, либо `git checkout <sha> -- delta/`);
  2. `codkit save`;
  3. вернуть сдвиг (`git stash pop` / `git merge` / `git rebase`);
  4. `codkit load`;
  либо `codkit sync` одной командой. Проверка сравнивает **байты**
  артефактов с картой метки, а не sha коммита: любой способ, возвращающий
  те же байты, проходит.
- Исключение по флагу `skipPatchsetMovedCheck` — только цикл (D12) и
  `rebase-onto-pin`/completed-rebase пути, которые сами двигают артефакты.
- Тот же рецепт — в FAQ у `CK-E-PATCHSET-MOVED` и в `02-daily.md`.
- Отвергнуто: `save` молча делает то, что `sync`.

### D19 — конфликт обеих сторон: сначала остановка, затем diff3 (RP-8)

- Phase 8: `sync` работает в два прохода, конфликты обнаруживаются до
  первой записи; при конфликте — `CK-E-BOTH-SIDES-EDITED`, exit 1, ничего не
  записано, в тексте ручной рецепт «выбери сторону»: взять дерево —
  `git checkout <sha> -- delta/patches/<F>.ckpatch` в patchset, затем
  `save`; взять patchset — откатить правку F в дереве, затем `sync`.
- Phase 8b: вместо остановки `sync` **материализует** 3-way в файл дерева
  стандартными diff3-маркерами внутри блока `codkit:begin/end`: база =
  `<base>:<F>` (файл, каким он был загружен, лежит в вершине
  сгенерированной ветки), наша = рабочий файл (или HEAD:F), их = пин +
  текущий артефакт через `applyUnified` (F22). Пишется транзакция (D20),
  печатается список, exit 1. Человек делает то же, что в фазе resolve
  цикла (05-upgrade-cycle: сослаться, не дублировать): решает маркеры,
  сохраняет оба блока и id, запускает `codkit sync --continue`. Пока в
  файлах остались маркеры конфликта, `--continue` отказывает и называет
  файлы.
- Отвергнуто: автослияние; diff3 сразу в Phase 8 без спайка S0.8.

### D20 — транзакция `sync` (RP-9)

- До первой мутации `sync` пишет `.codkit/sync-transaction.json` через
  `writeContainedFileExclusive(patchesDir, '.codkit/sync-transaction.json', …)`
  (F25; повторная запись при живой транзакции невозможна по построению):
  `{ codkitSyncTransaction: 1, id, startedAt, patchset: { head, dirtyBefore },
  tree: { head, branchTip, markSnapshot }, rewrite: [{ path, repo, blob }],
  patchsetCommits: [], consumedRef: null, conflicts: [] }`. Снимки —
  `git hash-object -w` **только** файлов, которые транзакция собирается
  переписать (артефакты patchset, конфликтные файлы дерева); список
  `patchsetCommits` дописывается после каждого созданного коммита; каждый
  такой коммит несёт трейлер `Codkit-Sync-Transaction: <id>`.
- Пока файл существует: `load`, `save`, `sync` без `--abort`/`--continue`
  отказывают `CK-E-SYNC-IN-PROGRESS` (exit 1, hint с двумя командами);
  `status` печатает `sync in progress: <id>, conflicts: N`.
- Успешное завершение удаляет файл. Крэш посередине: следующий `sync
  --continue`/`--abort` действует по записи; замок `withLock` как у всех
  пишущих команд.
- Crash-тесты: seam `checkpoint` на каждом атоме (запись артефакта, коммит
  patchset, материализация маркера, update-ref, mark, удаление файла) по
  образцу `cycleCrashResume.test.ts`.

### D21 — `sync --abort` и `sync --continue` (RP-9)

- `--abort`: дерево — `update-ref refs/heads/<branch> <tree.head>` с
  guard-значением текущего tip, HEAD туда же, переписанные файлы
  восстанавливаются из снимков, метка — из `markSnapshot`; patchset —
  коммиты выше `patchset.head` снимаются (`git reset --soft`/`update-ref`)
  **только** если каждый несёт трейлер этой транзакции, иначе отказ с
  объяснением (человек коммитил поверх); артефакты — к снимкам; файл
  транзакции удаляется; `refs/codkit/consumed/…` остаётся (безвреден).
- `--continue`: проверка отсутствия маркеров конфликта во всех
  `conflicts[]`, извлечение результата (вторая половина `sync`),
  пересборка, удаление файла. По сути `save`, но с проверкой полноты по
  списку транзакции.
- «Undo» после успешного `sync` не делается: это `git reset --hard <до>`
  в patchset + `codkit load` (рецепт D18).
- Отвергнуто: отдельная команда `undo`.

### D22 — `codkit gc` (RP-5: «почистит мусор в consumed (и может еще какой-нибудль ненужный мусор)»)

- `codkit gc [--dry-run] [--keep-consumed <n>] [--older-than <days>]`
  (по умолчанию 5 и 30). Берёт замок дерева; печатает план; удаляет
  **только** безопасные классы: `refs/codkit/consumed/*` старше N дней
  сверх последних n (во всех worktree, F26); `.codkit/tmp/*`;
  `.codkit/trees/<id>.json`, чей `treePath` не существует; `.codkit/out/*`.
  **Никогда** не трогает `.codkit/locks/*` и `.codkit/build/*` (у замков
  каналов и записей демонов собственный протокол владения с доказуемым
  владельцем, REPAIR-011; протухший замок дерева снимает следующий захват,
  как сегодня), транзакции/квитанции (F24) и `.codkit/pending/*` — их
  только перечисляет с пояснением. Git-объекты дерева не трогает (`git gc`
  на дереве VS Code — решение человека).
- `--dry-run` печатает то же без удаления; `--json` — `data.plan`,
  `data.removed`, `data.kept`.
- Отвергнуто: автоматическая чистка внутри `load --fresh` (неявная
  разрушительность); `git gc` дерева; чистка `build/`-логов по возрасту —
  отдана владельцу протокола демонов (DEF-9).

## 7. Предсказания

- **P1** Phase 2 (страж + status) ломает ≤ 2 существующих теста
  (`status.test.ts` «says a resync is needed…» и, возможно, один в
  `load.test.ts`); cycle-тесты не краснеют.
- **P2** Замена отбора (Phase 3) не ломает ни одного теста `save.test.ts`:
  во всех fixture `base == HEAD`.
- **P3** После Phase 3 сьюты `cycleCommand`, `cycleResolveRebuildGuard`,
  `cycleCrashResume`, `reresolve`, `rebase*`, `doubleRegen` зелёные без
  правок.
- **P4** Наивная однопроходная реализация D5 не проходит S17c; overlay
  `ArtifactStore` необходим.
- **P5** Рост `saveEngine.ts` на +50 строк не создаёт нового conform
  finding'а (S0.4); иначе D13 обязателен для каждой строки. (`syncEngine.ts`
  после REPAIR уже 1976 строк и остаётся замороженным — та же логика.)
- **P6** Воспроизведение 10 foreign-коммитов на fixture < 10 с.
- **P7** `moveWorkTree`/`updateRef` не требуют изменений.
- **P8** Новых анкеров ≤ 30; specmap — 0 suspects, 1 известный warning.
- **P9** Переименование (Phase 1) — один механический коммит, после
  которого весь floor зелёный без единой правки логики; в diff нет ни
  одной строки, меняющей поведение (проверка: `git diff --stat` только
  переименования/строки).
- **P10** H1 подтверждается S0.7: `save` после сдвига patch-артефакта на
  стороне patchset падает `CK-E-INTERNAL` после перестановки ref.
- **P11** Машинерию diff3 из `reresolve.ts`/`replayPatch.ts` можно вызвать
  вне цикла без изменения её сигнатур (S0.8); если нет — 8b выносится в
  deferrals.
- **P12** Транзакция `sync` укладывается в < 400 строк модуля и повторяет
  форму `rebaseOntoPinMove.ts` (pending/complete/retire).

## 8. Фазы

Порядок: 0 → 1 (переименование) → 2 (стражи) → 3 (`save` итог) → 4
(воспроизведение) → 5 (хук, документы) → 6 (`load --discard`) → 7 (карта
артефактов, `CK-E-PATCHSET-MOVED`, родословная) → 8 (`sync` с остановкой и
транзакцией) → 8b (diff3, `--abort`/`--continue`) → 9 (`gc`) → закрытие.
Фазы 2–6 не зависят от 7–9; 8b зависит от S0.8.

### Предусловие кампании (до Phase 0)

1. REPAIR-011 закрыт по своему пакету: оба P1 устранены, чистый повторный
   независимый аудит, панель зелёная; цепочка REPAIR закоммичена на
   `fix/linked-worktree-git-path` (по собственному процессу проекта, не этой
   кампанией); `git status --short` в worktree пуст.
2. Роль писателя в worktree явно у исполнителя кампании (handoff от
   центральной сессии 2026-09-05 остаётся в силе, либо возобновляется
   владельцем после REPAIR-011).
3. RP-10 выполнен (F29): перенос агентского профиля лежит в worktree и
   должен уйти отдельным коммитом до или вместе с safety-коммитом.
4. Quick-start §11 выполнен, таблица §4 перемерена и поправлена первым
   коммитом Phase 0.

Пока п.1 не выполнен, кампания **не начинается**: второго писателя в
worktree протокол замка не допускает, а Phase 1 (переименование) поверх
незакоммиченной цепочки сделала бы её коммит неревьюируемым.

### Phase 0 — спайки и пробы (без коммитов)

1. **S0.1** Подтвердить F7–F12 временным тестом
   `codkit/test/e2e/zzCommitLossRepro.test.ts`; удалить.
2. **S0.2** Формат D2 на fixture после `sync`: сгенерированные коммиты несут
   трейлер, чужие нет; зафиксировать минимальную версию git.
3. **S0.3** D4 на fixture: `git diff --name-status -z --no-renames <base>`
   перечисляет закоммиченное и незакоммиченное; `status` добавляет только
   untracked.
4. **S0.4** Ratchet: +50 строк в `saveEngine.ts`, `vibe bin exec
   typescript-ai-native -- conform check` → «0 new» или нет; откатить.
5. **S0.5** `cycle continue` в fixture-цикле проходит через `runSave` с
   `forcedPaths` (F16); в fixture нет коммитов дерева — основание P3.
6. **S0.6** Подтвердить, что `badCause`/`runCommitMsg` из `hooksPatchSet.ts`
   (F27) вызываются с сообщением без файла и без цикла.
7. **S0.7** H1: после `sync` изменить `.ckpatch` файла F на стороне patchset
   (например, `git checkout` другой fixture-ветки или правка внутри тела
   патча), сделать незакоммиченную правку G в дереве, `codkit --json save` →
   ожидаемо `CK-E-INTERNAL` после перестановки ref. Записать точный вывод.
8. **S0.8** Можно ли вызвать diff3-материализацию (`reresolve.ts`/
   `replayPatch.ts`, `cycleMaterialize.ts`) для одного файла с тремя
   версиями байтов вне цикла: какая функция, какая сигнатура, что она
   пишет. Результат решает 8b.
9. **S0.9** `TreeMark` с дополнительными необязательными полями читается
   старым и новым кодом (zod-схема `treeMarkSchema` `.optional()`).
10. **S0.10** `git update-ref` с guard-значением и `hash-object -w` в
    дереве fixture: снимок и восстановление файла байт-в-байт.
11. **S0.11** Перепроверить указатели §5 (F1–F6, F13, F19–F23) на
    закоммиченной базе после REPAIR-011 и обновить их одним коммитом
    `docs(campaign): …` вместе с таблицей §4.
12. **S0.12** Linked-worktree fixture (`syncLinkedWorktree.test.ts` уже
    есть): foreign-коммиты в соседнем worktree на той же сгенерированной
    ветке → какой отказ раньше: `CK-E-WORKTREE-REF-SHARED` (существующий)
    или новый `CK-E-DIRTY-TREE` с коммитами. Зафиксировать порядок в D7/D8.

*Exit:* findings S0.1–S0.10 записаны под этой фазой; красный спайк
переписывает D в месте. Коммитов нет (допустим один
`docs(campaign): record phase 0 findings` с переводом в `EXECUTING`).

#### Phase 0 findings (2026-09-06, база `e44e395`+`c598581`; исполнитель — кампания)

Спайки S0.1–S0.12 исполнены; решения D1–D22 не переписывались — уточнения,
меняющие решение, помечены «владельцу». Полные команды и выводы — отчёт
`codkit-jobs/linked-worktree-paths/WORKER-REPORT-CAMPAIGN-P0.md`.

- **S0.1** F7–F12 подтверждены временным e2e `zzCommitLossRepro.test.ts`
  (13 тестов, exit 0; файл удалён той же сессией). Уточнения к фактам:
  потерянный коммит НЕ предок нового HEAD (reflog — единственный след);
  F10 «changedFiles = 2» воспроизводится, когда два коммита лежат в двух
  файлах (в одном файле — changedFiles = 1).
- **S0.2** Формат D2 работает, но запись НЕ NUL-чистая: перед каждой
  записью печатается строка `commit <sha>`, а `%(trailers:…,valueonly)`
  добавляет свой `\n`, поэтому запись с трейлером занимает две физические
  строки, без трейлера — одну. Парсер D2: резать по `/^commit [0-9a-f]{40}\n/m`,
  затем по `\0`, снимая хвостовой `\n`. Git машины 2.53.0; минимум для
  трейлер-формата 2.22 (R1 в силе).
- **S0.3** Подтверждено: `git diff --name-status -z --no-renames <base>`
  видит и закоммиченное, и незакоммиченное (`M examplePart.ts`); untracked
  добавляет только `status --porcelain` (`?? …`).
- **S0.4** P5 подтверждён: +52 строки в `saveEngine.ts` (инструмент увидел
  942 строки) → conform «8 finding(s) … 8 frozen, 0 new», exit 0; откат —
  байт-в-байт, снова 8/8/0. Заморозка file-length терпит рост файла;
  решётка D13 не принуждает (дисциплина 600 строк остаётся нормой).
- **S0.5** Основание P3: `cycle continue` → `runCycleResolve`
  (cycleEngine.ts:318) → адаптер `extract: runSave` (cycleResolve.ts:477,
  paths + patchHeaderOverrides), rebase-путь — `saveAutomatic` с
  paths/allowNewFile/patchHeaderOverrides/forcedPaths/deferSync
  (rebaseOntoPin.ts:392-405); в e2e-фикстурах цикла ручных коммитов в
  дереве нет. D4 обязан сохранить merge `forcedPaths` (saveEngine.ts:150-152),
  иначе сломает цикл.
- **S0.6** Подтверждено (F27): `badCause(message: string): string | null` —
  чистая функция сообщения; `runCommitMsg(patchesDir: string, message:
  string): CommitMsgOutcome` вызывается без файла и без цикла (tag=null →
  exitCode 0, rewritten=null). Проверено прямым вызовом в фикстуре.
- **S0.7** H1 подтверждён дословно (P10): сдвиг тела `.ckpatch` файла F на
  стороне patchset + незакоммиченная правка G в дереве → `codkit --json save`
  exit 2 `CK-E-INTERNAL` «…examplePart.ts…» ПОСЛЕ сообщений
  `util.ts.ckpatch: created`, `applied …`, `updated …`; ref сдвинут, F в
  дереве переписан под сдвинутый артефакт, G извлечён.
- **S0.8** Phase 8b существует. Прямой вызов для трёх произвольных версий
  байтов — `runMergeFile` (classifyEngine.ts:276, экспортирован):
  `{ treeDir, targetPath, ours, base, theirs }` → `{ bytes, hasConflicts }`,
  внутри `git merge-file -p --diff3 -L ours -L base -L theirs` по личным
  файлам в `tmpdir()/codkit-classify-*` (удаляются в finally), в дерево не
  пишет; метки конфликтов `<<<<<<< ours` / `>>>>>>> theirs`. `replayPatch`
  (replayPatch.ts:58) — чистая композиция base+patch→theirs; для sync-случая
  напрямую НЕ подходит (там theirs = пин+текущий артефакт, а не base+patch) —
  обёртке 8b звать `runMergeFile`. Прецеденты durable-записи одного файла:
  `runReresolve`/`atomicReplace` (reresolve.ts:79, :240 — wx-temp+rename с
  сохранением mode) и `writeCycleConflicts`
  (cycleMaterializeMoveWorktree.ts:109 — идемпотентная wx-temp+rename).
  Сигнатуры менять не нужно; P11 подтверждён с уточнением про replayPatch.
- **S0.9** Подтверждено: `treeMarkSchema` — обычный `z.object` (strip), метка
  с новыми полями `artifacts`/`patchSetCommit` читается текущим кодом
  (поля отбрасываются), схема с `.optional()`-полями принимает старую метку.
  Проверено на живой метке фикстуры.
- **S0.10** Подтверждено в дереве фикстуры: `hash-object -w` + `cat-file
  blob` восстанавливают файл байт-в-байт; `update-ref <ref> <new> <old>`
  принимает верный guard и отказывает «cannot lock ref» на неверном.
- **S0.11** Указатели §5/§4 перемерены, правки внесены (F5, F6, F18, F19,
  F20, F23; таблица §4). Существенное: F19 «publish.ts:253» устарел —
  detached-checkout теперь в `clone.ts:164`; счётчики F23 сдвинулись
  (`codkit/test` 198→219, `tools` 7→8); §4 baseline: vitest 109/1547,
  trace 118/118, specmap 646 (целевые значения §4 ниже новой базы —
  пересчитывает владелец). Тест `syncLinkedWorktree.test.ts` лежит в
  `codkit/test/unit/`, не в `e2e`.
- **S0.12** Порядок отказов НЕ тот, что предполагало D7/D8 (владельцу;
  R17). Коммит соседа по общей ветке немедленно делает индекс ЭТОГО
  worktree «staged M» (HEAD символьный, ref общий): `codkit status` —
  exit 1 (tip красный, upstream.changed = 1), сегодняшний `codkit sync`
  отказывает `CK-E-DIRTY-TREE` («not in patchset yet», exit 1) ДО
  предусловия `CK-E-WORKTREE-REF-SHARED`. `CK-E-WORKTREE-REF-SHARED`
  (exit 2) достигается только когда сосед держит ветку БЕЗ коммитов
  (unit/worktreeRefGuard). Третья половина D7 увидит те же коммиты (refs
  общие) и тоже будет первой; D7/D8 нуждаются в рулинге о «фантомной» грязи
  от сдвига общего ref — сегодняшний hint «run codkit save» в этом сценарии
  неверен.

### Phase 1 — переименование `sync` → `load`

1. `git mv codkit/src/commands/sync.ts codkit/src/commands/load.ts`;
   `name: 'load'`, summary без изменений по смыслу; регистрация в
   `main.ts`/роутере; заглушка `sync` (D14) с exit 2.
2. `argv.ts`: секция флагов `load` (те же три флага).
3. Подсказки F23: `verifyEngine.ts` ×6, `status.ts` (`reload needed`,
   строка про direction of truth), `syncEngine.ts:1322`, hint
   `CK-E-DIRTY-TREE`, текст хука (`codkit save`, без изменений), FAQ-строки
   в `tools/generate-codkit-docs.mjs`; регенерация `commands.md`/`faq.md`.
4. Тесты: `git mv sync.test.ts load.test.ts`; все `run(['sync'…])` →
   `['load'…]` (176 вхождений, `sed` по слову с ручной проверкой diff);
   новый e2e-кейс **S21**: `codkit sync` → exit 2, stderr содержит `renamed
   to codkit load`.
5. Спеки: PROP-007 `CMD-SYNC` → надгробие + новый `CMD-LOAD` (текст
   прежний), `COMMAND-ROSTER` (`load`), `CMD-STATUS` (`reload needed`);
   PROP-008 §3 заголовок/текст (`load`), анкеры не трогать; PROP-001
   `MVP-SYNC-SAVE` → надгробие + `MVP-LOAD-SAVE`, `DOES-SYNC` → `DOES-LOAD`;
   PROP-002 `COMP-SYNC`/`COMP-SYNC-RESP` → `COMP-LOAD*` (файл
   `loadCmd.ts`… по факту `commands/load.ts` — привести таблицу к реальным
   именам файлов); common PROP-002 `FLOW-SYNC` → `FLOW-LOAD`; PROP-006
   `FAST-PATH-RULE` (текст); PROP-012 `NFR-SYNC-NOOP` → `NFR-LOAD-NOOP`,
   `FORK-TREE-PRECOMMIT-HOOK` (текст «каждый load»); PROP-013 (тексты);
   FEAT-002 S01–S16 (тексты); FEAT-003 human protocol (тексты). Specmap.
6. Документы: `docs/codkit/protocol/human/01…12`, `templates/*`,
   `codkit/README.md`, `docs/codkit/ci-examples/*` — `sync` → `load`
   (47 вхождений); `node docs/codkit/protocol/human/check.mjs`.
7. `npm run floor`, `vibe check --quiet`.

*Exit:* `codkit load` работает как прежний `sync`; `codkit sync` → exit 2;
`grep -rnw sync codkit/src docs/codkit codkit/README.md` показывает только
надгробия/заглушку/внутренние имена (`runSync`, `syncEngine`,
`skipDriftGuard`); floor зелёный.
*Prediction:* P9.
*Commits:* `refactor(cli): rename sync to load and reserve sync for the two-way command`
· `docs(protocol): the one-way command is load`.

### Phase 2 — обнаружение и стражи: потеря становится невозможной

1. `lib/treeCommits.ts`: `foreignCommits()` (D2), `TreeCommit`,
   `recordConsumedRef()` (D6), парсер; unit `treeCommits.test.ts`: нет
   foreign; 1 и 3; foreign только на ветке при detached HEAD; аномалия;
   ветки нет; `base = pin` без сгенерированных коммитов.
2. `driftGuard.ts`: третья половина (D7).
3. Вызывающие `driftDirty` — отказ с новым текстом; `--fresh` не снимает;
   ветка `forceApply` (`syncEngine.ts:218`) тоже проверяет.
4. `saveEngine.ts`: временно (до Phase 3) при foreign — отказ
   `CK-E-DIRTY-TREE` «save does not extract tree commits yet; see campaign
   TREE-COMMITS-SAVE» до любой записи.
5. `messages.ts`: `'TREE-HEAD'` (D8); FAQ-строка.
6. `commands/status.ts`: D10 (без строки про загрузку — она в Phase 7).
7. E2e `codkit/test/e2e/treeCommits.test.ts`: **S18** (два коммита
   `--no-verify` → `load` exit 1 `CK-E-DIRTY-TREE`, HEAD/файлы не тронуты,
   коммиты предки HEAD; `ci --profile verify` — тот же отказ; `status` exit 1
   с `treeCommits.count = 2`, без `reload needed`), кейс `CK-E-TREE-HEAD`.
   Коммиты в тестах — через `gitLocal --no-verify` или
   `CODKIT_INTERNAL_COMMIT=1` (F12).
8. Спеки: PROP-008 `##DRIFT-GUARD-PREDICATE` (третья половина, запись
   решения), новый `TREE-COMMITS-ARE-WORK`; PROP-007 `##CMD-LOAD`
   (отказ), `##CMD-STATUS`; PROP-006 §1 `CONSUMED-REFS`; FEAT-002 S18;
   docs/specmap.
9. Floor.

*Exit:* S18 зелёный; `grep -n commits codkit/src/lib/driftGuard.ts` ≥ 1;
floor зелёный.
*Prediction:* P1.
*Commits:* `feat(guard): refuse destructive commands over commits made in the fork tree`
· `feat(status): report fork-tree commits that are not in patchset`.

### Phase 3 — `save` извлекает итоговое состояние

1. `lib/treeState.ts` (D4) + unit `treeState.test.ts`: staged/unstaged/
   untracked/deleted/committed-only/committed+modified; own-префикс;
   `forcedPaths`.
2. `saveEngine.ts`: `upstreamChanges` → `changesSince(worktree)` с `base`;
   `planFile` через провайдер; «nothing to save» учитывает
   `commits.length`; удалить отказ Phase 2 п.4.
3. Предусловие перед `runSync` (D6), `recordConsumedRef` после пересборки.
4. D8 в `save`.
5. Временно (до Phase 4) при foreign — поведение будущего `--squash`: один
   коммит patchset `codkit save: squash of N tree commit(s)` с трейлерами
   `Codkit-Tree-Commit`.
6. E2e: **S17a** (всё закоммичено → `save` exit 0, артефакты содержат
   строки обоих коммитов, `refs/codkit/consumed/*` → старый HEAD, один
   коммит patchset с двумя трейлерами, дерево чисто, повторный `save` →
   `nothing to save`); **S19** (частично → exit 0, обе части извлечены,
   `examplePart.ts` сохранил строку); `save <path>` при foreign (ветка не
   тронута, `info`, коммиты на месте); `load` после S17a → `up to date`.
7. Спеки: PROP-008 §4 fence (шаг 0 диапазон, шаг 2 отбор относительно
   base, шаг 3 предусловие + consumed ref), `SAVE-CONSUMES-TREE-COMMITS`;
   PROP-007 `##CMD-SAVE`; FEAT-002 S17, S19; PROP-013 §4. Docs/specmap.
8. Floor + P3.

*Exit:* S17a, S19 зелёные; в `saveEngine.ts` нет `'status', '--porcelain',
'-z'` как источника отбора; floor зелёный.
*Prediction:* P2, P3, P7.
*Commits:* `feat(save): extract the fork tree relative to the last applied tip, commits included`
· `test(e2e): S17/S19 tree commits reach patchset`.

### Phase 4 — воспроизведение промежуточных коммитов по умолчанию, `--squash`

1. `lib/saveReplay.ts`: `ArtifactStore`, `planStates()`, `writeStates()`,
   трейлер, идемпотентность, валидация `Cause:` (D5); `commitDelta`
   обобщается `{ message, author, paths }`.
2. `saveEngine.ts`: при foreign — `saveReplay` по умолчанию; `--squash` —
   поведение Phase 3; остаток только при `--commit`. `argv.ts`: `--squash`;
   `commands/save.ts` пробрасывает; `--squash` без foreign — no-op с `info`.
3. Unit `ArtifactStore`.
4. E2e: **S17b** (три коммита → `save` → три коммита patchset с теми же
   subject/author/date + трейлер, остаток незакоммичен; с `--commit
   --message` — четвёртый; с `--squash` — один с тремя трейлерами;
   `git show <patchset-commit>:delta/patches/…` воспроизводит состояние
   соответствующего коммита дерева); **S17c** (второй коммит с правкой вне
   маркера → exit 1 `CK-E-HUNK-OUTSIDE-MARKER` с sha/subject, patchset без
   новых коммитов/артефактов, дерево не тронуто); идемпотентность через seam
   `replayCheckpoint`; пропуск пустого состояния; некорректный `Cause:` →
   blocked.
5. Спеки: `##CMD-SAVE` (default replay, `--squash`, `--commit`, трейлер,
   идемпотентность, аналогия PR, «merge commit не существует»);
   PROP-008 `SAVE-REPLAYS-TREE-COMMITS` с записью решения; FEAT-002 S17
   a/b/c; `commands.md`. Specmap.
6. Floor.

*Exit:* S17b/S17c зелёные; повторный `save` — no-op; floor зелёный.
*Prediction:* P4, P6.
*Commits:* `feat(save): replay fork-tree commits into patchset history, --squash folds them`
· `test(e2e): S17b/S17c replay, idempotency and blocked intermediate state`.

### Phase 5 — хук дерева и протокол людей

1. `TREE_PRE_COMMIT_HOOK` по D9; e2e `load.test.ts` (бывший
   `sync.test.ts:362-388`): коммит на ветке проходит с напоминанием, на
   detached HEAD — с другим текстом, `CODKIT_INTERNAL_COMMIT=1` молча.
   **S20**.
2. PROP-012 `##FORK-TREE-PRECOMMIT-HOOK`: новая формулировка + запись
   решения (рулинг дословно); PROP-008 `##TREE-HOOK-STEP`.
3. Документы людей: `01-quickstart.md` запрет 1 → «коммить можно; коммит —
   работа, пока не выполнен `codkit save`/`sync`; `load` откажет, пока
   коммиты не извлечены или не отброшены `load --discard`»; `02-daily.md`
   (цикл дня, «Что в дереве запрещено», «Переключение ветки»: теперь
   `save` откажет `CK-E-PATCHSET-MOVED` после switch — ссылка на рецепт
   D18 после Phase 7); `04-team.md`; `codkit/README.md`; FAQ.
   `node docs/codkit/protocol/human/check.mjs` (лимиты строк!).
4. Агентские документы без изменений; `docs/codkit/protocol/agent/check.mjs`.

*Exit:* S20 зелёный; human check зелёный; floor зелёный.
*Commits:* `feat(load): the fork-tree hook reminds about save instead of refusing commits`
· `docs(protocol): commits in the fork tree are work that save extracts`.

### Phase 6 — `load --discard`

1. `argv.ts` (`--discard`, секция load), `commands/load.ts`, `syncEngine.ts`
   (D11).
2. E2e: после S18-подготовки `load --discard` → exit 0, ref создан, файлы
   вернулись, коммиты недостижимы из HEAD, достижимы из ref; `--ci
   --discard` → exit 2; без коммитов → exit 0 с `info`.
3. PROP-007 `##CMD-LOAD`; `commands.md`; FAQ hint для `CK-E-DIRTY-TREE`.

*Exit:* тест зелёный; help показывает флаг; floor зелёный.
*Commits:* `feat(load): --discard drops fork-tree commits deliberately and keeps them under refs/codkit/consumed`.

### Phase 7 — карта артефактов в метке, `CK-E-PATCHSET-MOVED`, родословная

1. `fingerprint.ts`: `deltaFiles(patchesDir)` → `{ fingerprint, files:
   Record<path, sha256> }` (один обход вместо двух); `treeCache.ts`:
   `TreeMark.artifacts?`, `TreeMark.patchSetCommit?` (S0.9); `runSync`
   пишет оба поля.
2. `lib/syncMerge.ts`: `classifyTargets(patchesDir, tree, mark, base)` →
   `{ treeOnly, patchsetOnly, both, unknown }` (D16); `loadedFrom(base,
   mark)` и `checkLineage(patchesDir, loadedFrom)` (D17).
3. `saveEngine.ts`: перед любой записью — D17, затем D16: `patchsetOnly ∪
   both` непусто → `CK-E-PATCHSET-MOVED` с рецептом; флаг
   `skipPatchsetMovedCheck` для цикла и rebase-путей (D12/D18);
   `messages.ts` `'PATCHSET-MOVED'`, FAQ.
4. `status.ts`: строки «loaded from patchset commit» и «patchset moved
   since load» (D10).
5. E2e: **S22** (после `load` изменить артефакт F в patchset, правка G в
   дереве → `save` exit 1 `CK-E-PATCHSET-MOVED`, ничего не записано, ref не
   сдвинут; выполнить рецепт руками: `git stash` → `save` exit 0 → `stash
   pop` → `load` exit 0 → оба изменения в дереве); **S23** (`git switch` на
   другую fixture-ветку patchset → `save` exit 1 с текстом родословной;
   `dirty` при загрузке → warning и продолжение); H1-кейс из S0.7 теперь
   даёт `CK-E-PATCHSET-MOVED` вместо `CK-E-INTERNAL`.
6. Спеки: PROP-006 `##TREE-MARK` (поля), PROP-008 §4 (шаг «сдвиг
   patchset»), новые анкеры `PATCHSET-MOVED-RULE`, `LINEAGE-CHECK`,
   обобщённый `##PATCHSET-SIDE-EDIT-RULE` (own → все слои); `##CMD-SAVE`;
   FEAT-002 S22, S23; `02-daily.md` «Переключение ветки» (рецепт). Specmap.
7. Floor; cycle/rebase сьюты зелёные благодаря `skipPatchsetMovedCheck`.

*Exit:* S22, S23 зелёные; H1-кейс больше не даёт `CK-E-INTERNAL`.
*Prediction:* P10 (проверен в S0.7), cycle-сьюты без правок.
*Commits:* `feat(save): refuse when patchset moved since the last load and print the manual merge recipe`
· `feat(mark): record loaded artifacts and patchset commit in the tree mark`.

### Phase 8 — двусторонний `sync` с остановкой на конфликте и транзакцией

1. `lib/syncTransaction.ts` (D20): create/read/append/retire; snapshot
   через `hash-object -w`; проверка трейлера транзакции; seam `checkpoint`.
2. `commands/sync.ts` (новый, заменяет заглушку), `argv.ts` (флаги D15).
   Поток: замок → `checkTree` → транзакция есть → `CK-E-SYNC-IN-PROGRESS`
   → D17 → `classifyTargets` → `both` непусто → `CK-E-BOTH-SIDES-EDITED`
   с рецептом «выбери сторону» (D19, ничего не записано) → `--dry-run`:
   печать классификации и выход → запись транзакции → половина `save`
   (`saveReplay`, только `treeOnly`) → половина `load` (`runSync` с
   `skipDriftGuard` и объяснимым множеством `patchsetOnly`) → consumed ref
   → mark с новой картой → удаление транзакции.
3. `load`/`save`: отказ `CK-E-SYNC-IN-PROGRESS` при живой транзакции;
   `status`: строка `sync in progress`.
4. `messages.ts` `'SYNC-IN-PROGRESS'`, FAQ.
5. E2e `codkit/test/e2e/syncTwoWay.test.ts`: **S24** (артефакт F сдвинут в
   patchset, G закоммичен и H незакоммичен в дереве → `sync` exit 0: три
   коммита/артефакта на своих местах, дерево содержит F от patchset, G и H
   от дерева, `git status` чист, `load` → `up to date`); **S25** (обе
   стороны меняют F → `sync` exit 1 `CK-E-BOTH-SIDES-EDITED`, ничего не
   записано, ни одного файла транзакции; рецепт «взять дерево» руками →
   `save` exit 0); `--dry-run`; `--discard`; crash на каждом атоме через
   seam: после крэша `load`/`save` → `CK-E-SYNC-IN-PROGRESS`, `sync
   --continue` доводит (Phase 8b) — в этой фазе минимум: файл транзакции
   существует и содержит записанные атомы.
6. Спеки: PROP-007 новый `CMD-SYNC-TWO-WAY` (анкер `CMD-SYNC` остаётся
   надгробием Phase 1, чтобы не менять смысл анкера), `COMMAND-ROSTER`;
   PROP-008 новый раздел «5a. sync: слияние двух сторон» с fence и
   анкерами `SYNC-TWO-PASS`, `SYNC-TRANSACTION`; PROP-006 §1
   `SYNC-TRANSACTION-FILE`; FEAT-002 S24, S25; PROP-013 §5 (crash-тесты
   sync). Docs/specmap.
7. Floor.

*Exit:* S24, S25 зелёные; `codkit sync` без транзакции и без сдвига →
`up to date`; floor зелёный.
*Prediction:* P12.
*Commits:* `feat(sync): two-way save+load with a per-target merge rule and a durable transaction`
· `test(e2e): S24/S25 sync merges non-overlapping work and stops on conflicts`.

### Phase 8b — diff3-материализация, `sync --abort`, `sync --continue` (ждёт S0.8)

1. `syncMerge.ts`: `materializeConflict(tree, F, base, ours, theirs)` через
   функцию из S0.8; транзакция получает `conflicts[]` и снимки `ours`.
2. `commands/sync.ts`: при `both` — материализация всех конфликтов,
   транзакция, exit 1 с перечнем; `--continue` и `--abort` (D21).
3. E2e: **S26** (конфликт → маркеры в файле внутри блока, транзакция
   есть, `load`/`save` отказывают; человек-имитация решает маркеры →
   `sync --continue` exit 0, оба изменения в артефакте, транзакции нет);
   **S27** (`sync --abort` после материализации: файлы дерева байт-в-байт
   как до `sync`, HEAD/ветка на месте, коммиты patchset выше записанного
   HEAD сняты, артефакты восстановлены, транзакции нет; `--abort` при
   чужом коммите поверх → отказ с объяснением); crash-at-each-atom +
   `--continue`/`--abort` после каждого.
4. Спеки: PROP-008 5a (`SYNC-CONFLICT-DIFF3`, `SYNC-ABORT`, `SYNC-CONTINUE`),
   `##CMD-SYNC-TWO-WAY` флаги, FEAT-002 S26, S27; `05-upgrade-cycle.md`
   ссылка из `02-daily.md` на процедуру разрешения маркеров (не
   дублировать). Docs/specmap.
5. Floor.

*Exit:* S26, S27 зелёные; floor зелёный.
*Prediction:* P11.
*Commits:* `feat(sync): materialize both-sides conflicts as diff3 in the tree; --continue and --abort`.

### Phase 9 — `codkit gc`

1. `lib/gc.ts` (D22): план/исполнение по классам; `commands/gc.ts`;
   `argv.ts` флаги.
2. E2e `gc.test.ts`: **S28** (после трёх `save` с коммитами и одного крэша
   `buildBranch` через seam: `gc --dry-run` перечисляет consumed refs,
   `tmp`, протухший lock, кэш несуществующего дерева, файл транзакции
   как «kept»; `gc` удаляет только безопасное, `--keep-consumed 1` оставляет
   один ref; транзакции и `pending` не тронуты).
3. PROP-007 `CMD-GC`, `COMMAND-ROSTER`; PROP-006 §1 (что чистится);
   FEAT-002 S28; `02-daily.md` одна строка; `commands.md`/FAQ. Specmap.
4. Floor.

*Exit:* S28 зелёный; floor зелёный.
*Commits:* `feat(gc): remove consumed refs and stale runtime state, never transactions`.

### Закрытие

1. Прогнать §12 на зелёном floor; заполнить §2 и §14; P1–P12 — held /
   falsified / surprised; §15.
2. Убедиться, что ничто не ссылается на план; нормы уже в спеках по фазам.
3. `docs/codkit/proofs/RISK-REGISTER.md`: `CK-R-TREE-COMMITS-001`
   «производительность отбора относительно base и классификации D16 на
   реальном дереве VS Code не измерена» (open; trigger: первый реальный
   `save`/`sync` на полном дереве; closure: замер ≤ времени `git status`).
   `AUDIT.md` не трогать (аудит запускает владелец).

## 9. Риски и запасные планы

- **R1 git < 2.22 у потребителя.** Сигнал: S0.2. План B: парсер `%B`,
  минимальная версия в документации.
- **R2 rename в foreign-коммитах.** Сигнал: тест. План B: FAQ; DEF-3.
- **R3 слияния в foreign-диапазоне.** First-parent (D2); боковые коммиты
  не воспроизводятся по одному (в `##CMD-SAVE`). План B: нет, решение.
- **R4 conform file-length.** Сигнал: S0.4. План B: D13.
- **R5 хуки patchset не выполняются при replay** (F12). План B: `Cause:` в
  D5; `verify --staged-fast` — DEF-4.
- **R6 производительность на реальном дереве.** План B: реестр рисков
  (закрытие §8), не блокирует.
- **R7 cycle/rebase сьюты краснеют** (P3 фальсифицирован или
  `skipPatchsetMovedCheck` не покрыл путь). План B: явное вхождение
  `fix(cycle): …` в фазу через ledger.
- **R8 `ci`/`publish` на detached HEAD.** foreign только выше `base`;
  сгенерированная вершина — не работа. План B: уточнить D8 для них.
- **R9 completed-rebase receipts в `runSync`.** Третья половина и
  предусловие D6 не применяются при `completedRebase !== null`; тест.
- **R10 переименование ломает скрипты потребителей.** Сигнал: заглушка
  exit 2 с текстом. План B: нет алиаса по решению D14; текст заглушки
  называет замену.
- **R11 diff3-машинерия не вызывается вне цикла** (P11 фальсифицирован).
  План B: 8b → deferrals как отдельная кампания; Phase 8 (остановка с
  рецептом) остаётся полной и безопасной.
- **R12 `--abort` при чужих коммитах поверх транзакции.** Отказ с
  объяснением (D21); План B: человек снимает свои коммиты, повторяет.
- **R13 старые метки без карты артефактов** у уже развёрнутых деревьев.
  `sync` → `CK-E-PATCHSET-MOVED` с hint «run codkit load once» (D16);
  `save` при отсутствии карты — предупреждение и старое поведение только
  если `deltaFingerprint` совпал с меткой (значит patchset не двигался),
  иначе тот же hint.
- **R15 REPAIR-011 сдвигает байты в зонах плана.** Реализовано 2026-09-05:
  пакет затронул `containedFile.ts`, `containedPath.ts`, `daemonChannelLock.ts`,
  `buildWrap.ts`, AUDIT.md и вынес выборы поколения замка в новый
  `containedGeneration.ts`; из зон кампании пересекается только `writeTreeHook`
  (contained-запись). F25 обновлён под перенос. Сигнал: S0.11. План B:
  остальные указатели правятся в Phase 0, решения не меняются.
- **R16 два писателя в worktree.** Центральная сессия (Opus) держит custody
  и может вернуться в каталог после REPAIR-011. Сигнал: файлы новее
  последнего снимка, не сделанные исполнителем. План B: остановка,
  снимок, разбор дельты — как в снимках `codkit-jobs/…/snapshots/`.
- **R17 linked worktree и foreign-коммиты в соседнем worktree.** Сигнал:
  S0.12. План B: порядок отказов фиксируется в D7/D8; семантика «работа
  соседа — не моя работа» не меняется.
- **R14 `gc` удаляет нужное.** Классы перечислены закрыто (D22),
  транзакции/pending только перечисляются; `--dry-run` в тесте
  сравнивается с реальным удалением один в один.

## 10. Не-цели

- Воспроизведение коммитов боковых веток — отвергнуто (D2).
- Коммиты разработчика внутри сгенерированной ветки — отвергнуто (D6).
- Коммиты агентов в дереве — держит владелец; FEAT-004 без изменений.
- Аналог «merge commit» — не существует по построению (D3).
- Автослияние патчей — отвергнуто (D16); человек решает diff3 (8b).
- Команда `undo` после успешного `sync` — отвергнуто (D21).
- Переименование внутренних `runSync`/`syncEngine.ts` — DEF-6.
- `git gc` дерева — не задача Codkit (D22).
- Замер на полном дереве VS Code — риск в реестре (R6).

## 11. Quick-start исполняющей сессии

```sh
cd /home/olegchir/work/sbtgit/codkit-linked-worktree-fix
git branch --show-current                     # fix/linked-worktree-git-path
git log --oneline -3                          # коммит(ы) цепочки REPAIR сверху, f56866b ниже
git status --short                            # пусто (предусловие п.1)
npm run floor; echo "EXIT=$?"                 # 0 (≈4–5 мин)
vibe check --quiet; echo "EXIT=$?"            # 0 errors, 1 warning CK-A11
awk '/^export const ERROR_CODES/,/^\] as const/' codkit/src/lib/messages.ts | grep -c "^\s*'"   # 40 (baseline §4)
ls codkit/test/e2e/*.test.ts codkit/test/unit/*.test.ts | wc -l   # 105
grep -o '<S[0-9][0-9] fact' vibevm/vibespecs/modules/codkit/FEAT-002-acceptance-scenarios.xml | sort -u | wc -l   # 16
grep -rIwo sync codkit/src | wc -l            # 85 (baseline F23)
grep -c '"anchor"' specmap.json               # 644
```

Затем Phase 0. Правила исполнителя: один коммит — одна идея; subject ≤ 60
символов, тип из `feat|fix|docs|test|refactor|chore|build|ci`; тело
объясняет *почему* и цитирует `spec://codkit/modules/codkit/PROP-0NN#ANCHOR`;
никаких трейлеров с именем модели; спеки правятся в той же фазе, что и код;
после правки спек — `vibe bin exec typescript-ai-native -- specmap`; после
правки `argv.ts`/реестра сообщений — `node tools/generate-codkit-docs.mjs`;
анкеры спек никогда не переименовываются и не удаляются (надгробие +
новый анкер).

## 12. Приёмка всей кампании

```sh
set -e
npm run floor; echo "EXIT=$?"                                              # 0
vibe check --quiet; echo "EXIT=$?"                                         # 0
npx vitest run --root codkit test/e2e/treeCommits.test.ts test/e2e/syncTwoWay.test.ts test/e2e/gc.test.ts test/e2e/load.test.ts   # S17–S28 зелёные
codkit 2>&1 | grep -cE '^\s*(load|sync|gc)\b'                             # 3: help без аргументов перечисляет все три команды
grep -c "'status', '--porcelain', '-z'" codkit/src/lib/saveEngine.ts       # 0
grep -c "Codkit-Tree-Commit" codkit/src/lib/saveReplay.ts                  # ≥ 1
grep -c "commits" codkit/src/lib/driftGuard.ts                             # ≥ 1
grep -o '<S[0-9][0-9] fact' vibevm/vibespecs/modules/codkit/FEAT-002-acceptance-scenarios.xml | sort -u | wc -l   # 28
for c in TREE-HEAD PATCHSET-MOVED SYNC-IN-PROGRESS; do grep -c "'$c'" codkit/src/lib/messages.ts; done   # 1 1 1
for f in --squash --discard --abort --continue --keep-consumed --older-than; do grep -c "'$f'" codkit/src/lib/argv.ts; done   # ≥1 каждый
test -f codkit/src/commands/load.ts && test -f codkit/src/commands/gc.ts && test -f codkit/src/lib/syncTransaction.ts
grep -rIwo sync docs/codkit/protocol/human | wc -l                         # только упоминания двустороннего sync (ручная проверка diff)
node docs/codkit/protocol/human/check.mjs                                  # ok
```

Плюс ручной прогон на fixture (manual-tests flow): `load` → два коммита
`git commit` (хук печатает напоминание) → `save` → `git log` patchset
показывает оба сообщения → `load` печатает `up to date`; отдельно сдвиг
артефакта в patchset + правка в дереве → `sync` сливает; конфликт на одном
файле → diff3 → `sync --continue`; `sync --abort` возвращает всё; `gc
--dry-run` перечисляет consumed refs.

## 13. Точки ревью владельца

0. **RP-0 — чтение мандата.** RESOLVED (2026-09-05): «вариант б».
1. **RP-1 — хук дерева.** RESOLVED: «вместо запрета сделать напоминание».
2. **RP-2 — флаг отбрасывания.** RESOLVED: «Сделай флаг, для краткости
   просто --discard».
3. **RP-3 — поведение `save` при коммитах.** RESOLVED: «режим с коммитами
   сделать по-умолчанию. Добавить флаг --squash для схлопывания коммитов
   в один. Кстати, это похоже на флаги мерджа пулл-риквеста в репозиторий!
   Можно продолжить эту аналогию».
4. **RP-4 — имя и срок жизни `refs/codkit/consumed/*`.** OPEN. Рекомендация:
   `refs/codkit/consumed/<UTC-stamp>-<short7>`, чистка только `gc` (D22)
   с умолчаниями 5 последних / 30 дней. Ни одна фаза не блокируется;
   исполнитель применяет рекомендацию, если рулинга нет к Phase 3.
5. **RP-5 — `codkit gc`.** RESOLVED (владелец предложил сам): «Можем ли мы
   сделать какой-нибудь codkit gc, который почистит мусор в consumed (и
   может еще какой-нибудль ненужный мусор)». D22, Phase 9.
6. **RP-6 — переименование `sync` → `load`.** RESOLVED (владелец предложил
   сам): «Можем ли мы сейчас переименовать sync в load. Чтобы в будущем
   сделать настоящую команду sync которая будет делать двусторонний
   save+load». Уточнения исполнителя приняты «обнови план» (заглушка exit 2
   без алиаса; анкеры-надгробия; внутренние имена не трогать). D14,
   Phase 1.
7. **RP-7 — тройка `load`/`save`/`sync`, родословная, `save` при сдвиге.**
   RESOLVED: «1. Согласен 2. отказывать». D15, D17, D18.
8. **RP-8 — конфликт обеих сторон.** RESOLVED («обнови план» после
   рекомендации): остановка без автослияния в Phase 8; diff3-материализация
   и процедура фазы resolve цикла в Phase 8b. D16, D19.
9. **RP-9 — `sync --abort`.** RESOLVED («обнови план» после рекомендации):
   транзакция с Phase 8, `--abort`/`--continue` в Phase 8b, без `undo`.
   D20, D21.

10. **RP-10 — `.claude/settings.json` worktree и перенос агентского
    профиля.** RESOLVED (владелец, 2026-09-05: «и сама перенеси все
    имзенения») — вариант (α) выполнен исполнителем, см. F29. Исходная
    постановка: В worktree файл содержит только deny-список (хук снят
    владельцем, F29), и из-за этого `docs:check` красный: старый
    `docs/codkit/protocol/agent/check.mjs` требует хук. В основном checkout
    `codkit` staged перенос профиля в `codkit/claude/` (удаляет этот файл,
    переносит rules/agents/skills, переписывает `check.mjs` так, что он
    **требует отсутствия** хука в репозитории инструмента). Варианты:
    (α) перенести staged-изменение из `codkit` в worktree отдельным
    коммитом до Phase 1 — рекомендация: один источник истины, `docs:check`
    снова зелёный, файл больше не расходится; (β) оставить deny-список в
    worktree, вернуть хук ради зелёного `docs:check` и закоммитить перенос
    отдельно в `main` после слияния ветки; (γ) отказаться от переноса и
    вернуть хук. Не блокирует REPAIR-011 по коду, но блокирует его зелёную
    панель (`docs:check`) и первый коммит кампании (предусловие п.3).

## 14. Execution ledger

### Phase 0 — EXECUTED (2026-09-06); findings recorded, no commits

База: `c598581`+`e44e395` на `fix/linked-worktree-git-path`, `git status`
чист до старта. Quick-start §11 выполнен, таблица §4 и указатели §5
поправлены (S0.11) — правки лежат в worktree незакоммиченными: пакет
кампании (2026-09-06) запретил коммиты, включая допустимый планом один
`docs(campaign): …`, поэтому перехода в `EXECUTING` в шапке не делал
исполнитель — статус меняет владелец. S0.1–S0.12 закрыты находками (блок
«Phase 0 findings» в §8). Подтверждены P5 (заморозка file-length терпит
рост), P10 (H1 дословно), P11 (ядро вызова — `runMergeFile`, не
`replayPatch`); P3 — основание кодом и фиксстурами, финальное доказательство
за Phase 3. Красных (опровергающих решение) спайков нет; уточнение порядка
отказов S0.12 передано владельцу D7/D8/R17. Продуктовый код не менялся;
временный тест S0.1 удалён той же сессией; `npm run floor` exit 0 до и после
фазы (109/109 файлов, 1547/1547 теста, structural 8 frozen / 0 new, specmap
646), `vibe check --quiet` — 0 errors, 1 warning.

## 15. Deferrals ledger

- **DEF-7** — DRAINED (Phase 5, 2026-09-06). Упоминания `sync` в текстах
  спеков вне списка анкеров Phase 1 (`CMD-CLONE`, `DOC-README`, пример
  конверта `"command": "sync"`, PROP-008 §4) исправлены на `load`
  (PROP-007 `##CMD-CLONE` — `load --clone-if-missing`; PROP-012
  `##DOC-README` — `load`/`status`/`save`; конверт — `"command": "load"`;
  PROP-008 §4 — fence «перестроить ветку как load шаги 1–2»,
  `##SAVE-INTERRUPT-SAFE`, `##PATCHSET-SIDE-EDIT-RULE`). Остаточные
  прозаические `sync`-в-смысле-load вне этих четырёх текстов (например,
  PROP-007 `##CMD-CHECK-TREE` hint «run codkit sync», PROP-004 §5, PROP-005
  §2/§5, PROP-006 §5, PROP-007 `##CMD-OVERLAY`) — не входили в маршрут
  DEF-7, перечислены в отчёте Phase 5 для решения владельца — и ЗАКРЫТЫ
  отдельным родительским коммитом `docs(spec): spec prose says load where it
  meant the one-way command` (2026-09-06): 29 вхождений в семи текстах
  переведены на `load`, надгробия/имена элементов/`syncOwnCode`/тексты про
  будущую двустороннюю команду сохранены намеренно. Найденное при этом
  расхождение: PROP-006 `##COMPLETENESS-CHECK` предписывал hint «run codkit
  sync first», а `verifyEngine` печатает `run codkit load first` с Phase 1 —
  спек противоречил поставленным байтам. Ворота: docs:check, trace 121/121,
  structural, specmap 666 units, `vibe check` 0 errors, полный прогон
  113 файлов / 1610 тестов, выход 0. DEF-7 больше не имеет остатка.
- **DEF-1** — воспроизведение коммитов боковых веток: rejected (D2); owner.
- **DEF-2** — чистка `refs/codkit/consumed/*`: закрывается Phase 9 (D22);
  остаётся только вопрос умолчаний RP-4.
- **DEF-3** — распознавание rename в foreign-коммитах: deferred; owner.
- **DEF-4** — `verify --staged-fast` для коммитов, создаваемых `save`/`sync`
  в patchset (F12): deferred; owner.
- **DEF-5** — замер на полном дереве VS Code: risk register
  `CK-R-TREE-COMMITS-001`; open.
- **DEF-6** — переименование внутренних `runSync`/`syncEngine.ts`/
  `SyncEngineOptions` при распиле файла под лимит 600 строк: deferred;
  owner.
- **DEF-8** — закрыт 2026-09-05: узел `CODKIT-TREE-COMMITS` добавлен в
  центральный `plan.toml` исполнителем по распоряжению владельца (F28).
- **DEF-9** — чистка логов демонов `.codkit/build/*.log` по возрасту:
  отдана владельцу протокола демонов (REPAIR-цепочка); owner.
- **DEF-7** — `sync` в `--ci` (сегодня `ci` — отдельная команда с
  собственным периметром): двусторонний `sync` в CI не предусмотрен;
  deferred; owner.
