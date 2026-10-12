# Еженедельный цикл апгрейда

DRI проводит один tag за цикл. Батчинг — исключение по решению DRI, максимум два последовательных tag.
Для стабильных тегов из соседних release-веток используется явный
`codkit cycle start <tag> --allow-branch-transition`: общий upstream anchor
проверяется и записывается до изменения пина. Обычный вызов по-прежнему требует
forward ancestry; переход на предка исходного пина и чужой root отказывают.
Пин двигается в main только после зелёного CI; красный цикл оставляет patch set
на старом пине. Команды, exits и terminal receipt сохраняются как evidence в
репозитории patch set. Установка Codkit не содержит baseline конкретного форка:
первый потребитель проводит rehearsal и фиксирует собственную исходную точку.

## Что уже делает код, а что делает DRI

| Уже реализованный механизм | Действие оператора |
| --- | --- |
| Транзакционный rename переносит patch name/header и ссылки own/contract; коммит `refactor(cycle): follow upstream renames ...` каноничен | Проверить пару `from -> to`, similarity и смысл; неизменённый повтор `continue` подтверждает review |
| Классификатор фиксирует immutable `cause` относительно исходного пина | При ручном решении сохранить этот SHA/`approx` в JSONL; не вычислять другой «удобный» SHA |
| Regeneration обновляет metadata всех слоёв и требует canonical UTF-8/LF JSON | Не переформатировать metadata вручную; исправлять только названный source artifact |
| Resolve извлекает patch, проверяет журнал и создаёт отдельный commit с `Cause`/`Codkit-Cycle` | Разрешить один blocker и добавить одну terminal journal record |
| Build понимает timestamped typecheck, проверяет deps, завершает два compiler pass и останавливает демоны | Обновить зависимости вне codkit при advisory; прочитать полный red list |
| Durable records позволяют обычные `status/continue/load` после прерывания | Не удалять `.codkit/*receipt*` и recovery-файлы; повторять штатную команду |
| Terminal receipt связывает commit, JSONL, Markdown, CSV и отсутствие `cycle/state.json` | Проверить `cycle status`, CI и merge без squash |

## Подготовка issue и ветки

1. Создай issue по [шаблону](templates/cycle-issue.md); назначь DRI, владельцев и reviewer.
2. `codkit hooks install` → exit `0`; затем `codkit hooks check` → exit `0`.
3. `git status --short` → пусто. Непустой вывод должен быть сохранён отдельным commit/stash или убран владельцем до шага 4.
4. `codkit check-tree --require-clean` → exit `0`.
5. `git -C <fork> cat-file -e '<target-tag-or-sha>^{commit}'` → exit `0`.
   Exit `1` означает, что зеркальный бот/оператор должен доставить ref; `cycle` сеть не вызывает.
6. `codkit --json cycle start <target-tag-or-sha>`.
   Exit `0` означает, что зелёные фазы прошли до следующего atom; exit `3` — обязательная остановка ниже;
   exit `1` — guard; exit `2` — окружение/граф с точным `hint`.

После любого вызова сохраняй полный stdout/stderr и exit в issue. Команда сама создаёт
`codkit/cycle/<targetTag>` и канонический `codkit cycle: bump pin to <tag>`.

## Универсальная петля

1. `codkit cycle status` → exit `0`, строки `phase`, `outcomes`, `resolved`, `next`.
2. Если status `completed`, переходи к [финалу](#финал-и-слияние).
3. Если `next` называет review/resolve/advisory, выполни соответствующий раздел ниже.
4. Иначе `codkit --json cycle continue` → exit `0/1/3`; сохрани JSON-конверт.
5. Exit `0` → снова шаг 1; exit `3` → раздел по `stop/nextAction`; exit `1` → исправь названный guard; exit `2` → исполни `hint` и повтори ту же команду.

## Rename review

1. Открой сохранённый JSON-конверт команды, которая остановилась: `data.renames` содержит пары review.
   `codkit --json cycle status` → exit `0` и подтверждает `phase`/`nextAction`, но не дублирует список пар.
2. Для каждой пары проверь `git -C <fork> diff --summary <source-sha> <target-sha> -- <from> <to>`.
   Наблюдаемый rename с ожидаемым содержанием → шаг 3; ложная пара/семантическая подмена → design stop.
3. `rg -n '<old-path>|<old-symbol>' delta/own delta/patches delta/resources delta/rules`.
   Exit `0` допустим только для ссылок, которые rename plan перечислил к переносу; неохваченная ссылка → design stop.
4. Для patch rename без ручных правок повтори `codkit cycle continue`.
   Та же неизменённая preview является подтверждением; exit `0` создаёт canonical rename commit.
5. Для resource rename сначала владелец исправляет точный `target` в `delta/resources/map.json`, затем `cycle continue`.

После принятого rename итоговая классификация может стать `merged`; поэтому
нулевой счётчик `target-renamed` в финальном CSV не отменяет отдельную запись
`renames`.

## Классы исходов

| Исход | Кто/что делает | Терминальный критерий |
| --- | --- | --- |
| `clean` | машина | артефакт воспроизведён без journal record |
| `shifted` | машина | regeneration + автоматическая green JSONL record |
| `merged` | машина, reviewer читает effective diff | regeneration + автоматическая green JSONL record |
| `target-renamed` | rename review + машина | target подтверждён, metadata перенесены, automatic record |
| `conflict` | subsystem owner | resolved tree без markers + exact cause + green human record |
| `target-deleted` | subsystem owner | адаптация или отдельное удаление артефакта с объяснением |
| `rule-broken` | владелец rule + reviewer | все новые матчи просмотрены, правило исправлено, record green |
| `contract-failed` | владелец контракта | причина устранена или design decision принят, test green |

«Дивергенции двух upstream branches» в patch-модели нет: source и target пины образуют одну проверяемую линию.
Наличие такого запроса — terminal design stop, не новый outcome.

## Разрешение красного исхода

Работай по одному артефакту. `cycle continue` сам создаёт отдельный fix commit только после точного proof.

### `conflict`

1. Открой названный target в дереве; сохрани новое upstream-поведение и минимальный codkit block.
2. `git -C <fork> diff --check -- <target>` → exit `0`; `rg -n '^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)' <fork>/<target>` → exit `1` (markers нет).
3. Выполни предметную contract/manual-команду → exit `0`; запиши её дословно.
4. Добавь в `cycle/log/<tag>.jsonl` одну **compact JSON** строку без CR и blank lines:

   ```json
   {"codkitCycleJournal":1,"ts":"<ISO-offset>","artifact":"<artifact>","outcome":"conflict","resolution":"<что сохранено и куда поставлен hook>","cause":{"sha":"<classification-sha>","approx":false},"by":"human","verified":[{"command":"<exact command>","exitCode":0}]}
   ```

5. `codkit cycle continue` → exit `0` и commit `fix(cycle): resolve <id>` с точными `Cause` и `Codkit-Cycle`.
   `CK-E-LOG-INCOMPLETE`/journal status → исправь последнюю запись; markers/tree-change-missing → шаги 1–4.

Запись считается завершённой только если она называет сохранённое upstream
поведение, положение intervention, exact/approx cause и все green verification
команды; исторический пример конкретного форка хранится в его patch set.

## Конфликт двустороннего sync

`codkit sync` над файлом, который правили обе стороны, не отказывается и не
сливает сам: он кладёт 3-way слияние в файл дерева diff3-маркерами и выходит 1,
оставляя живую транзакцию (load/save отказывают `CK-E-SYNC-IN-PROGRESS`).
Разрешение — та же дисциплина маркеров, что у `conflict` выше (шаги 1–2:
решай внутри codkit-блока, сохрани обе стороны и id блока; проверка
`rg -n '^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)' <fork>/<target>` → exit `1`),
запись журнала цикла не нужна — это не цикл. Затем:

1. `codkit sync --continue` → exit `0`: обе стороны в артефакте, транзакция
   снята. Маркеры остались → exit `1` с именем файла; «слияние не дошло до
   файла» означает краш между записью и маркерами — это тоже named refusal.
2. `codkit sync --abort` → exit `0`: дерево и patch set байт-в-байт как до
   прогона. Чужой коммит поверх — отказ с его sha и subject, ничего не тронуто.
3. Возврат после успешного sync — не `--abort` (записи уже нет):
   `git reset --hard <до>` в patchset + `codkit load`.

### `target-deleted`

1. Владелец выбирает: заменить target новым швом либо удалить вмешательство.
2. При удалении удали artifact и его metadata/test references в patchset; не создавай новый patch к отсутствующей цели.
3. Добавь green JSONL record с outcome `target-deleted`, exact classified cause и проверкой `codkit verify` exit `0`.
4. `codkit cycle continue` → отдельный fix/delete commit, exit `0`.

### `rule-broken` / `contract-failed`

1. Исправь rule/own/test source в patchset или целевой conflict в дереве; незаявленная грязь запрещает переход.
2. `codkit verify` и предметный test → оба exit `0`.
3. Добавь matching JSONL record с immutable cause и всеми verification exit `0`.
4. `codkit cycle continue` → exit `0`; red возвращает к шагу 1.

## Design stop

Признаки: неоднозначный rename, исчезший публичный контракт, требование нового слоя, расширение rule без конечного множества,
security/API выбор, либо решение меняет поведение форка.

1. Не меняй state/recovery. Создай запись по [decision journal](templates/decision-journal.md) и свяжи её с issue цикла.
2. Владелец подсистемы перечисляет варианты, эффективный diff и тест-критерий; DRI назначает reviewer и SLA 1 рабочий день.
3. Решение принято → реализация по соответствующему outcome и green JSONL record.
4. SLA истёк/решения нет → цикл остаётся красным, patch set остаётся на старом пине.

## Dependency advisory и build

1. На phase `deps-advisory` открой `cycle/report/deps-advisory.json`; проверь `.nvmrc`, `package*.json`, `build/npm/dirs.ts`, built-ins, Electron.
2. `codkit build down --channel all` → exit `0`.
3. Если lock/toolchain изменились, в дереве выполни одобренную установку из внутреннего registry:
   `npm --prefix <fork> install` → exit `0`; затем `git -C <fork> diff -- package-lock.json` → пусто.
   Непустой diff — design stop: target lock и фактический install расходятся.
4. На Linux `codkit build up` может напечатать inotify warning. Администратор выполняет напечатанный `sysctl`;
   повторный `build up` без warning подтверждает среду. Codkit системный параметр не меняет.
5. После чтения advisory выполни `codkit --ci cycle continue`.
   `--ci` фиксирует acceptance и не ждёт stdin; exit `0` — verify/build/tests green, exit `3` — полный red list.
6. Exit `3` переводит в `resolve`: исправь каждый red по разделу выше и снова `cycle continue`.

CI build требует готовые зависимости установки Codkit и fork-tree
`node_modules`; Codkit их не устанавливает. Lock change меняет cache key и
печатает refresh warning. Число downstream/contract tests задаёт конкретный
patch set и его upstream runner; установка Codkit не объявляет их зелёными.

## Возобновление и штатные восстановления

1. После SIGINT/crash выполни `codkit cycle status` → exit `0`, durable phase/checkpoint и `next`.
2. `next` = `run codkit cycle continue` → выполни её; exact durable atom продолжится либо громко отвергнет изменённые bytes.
3. Чистое, но неактуальное дерево в resolve восстанавливает сам `cycle continue` через forced load.
4. Completed rebase receipt потребляется обычным `codkit load` после commit дельты; см. [S12](04-team.md#s12-feature-на-старом-пине).
5. `ARTIFACT-BROKEN` на `.codkit/cycle-*.json`/receipt → приложи `--verbose` и exact файл DRI;
   schema/digest/exact-byte checks отвергают ручную правку, продолжение выполняет только codkit.

## Финал и слияние

1. `codkit cycle continue` → exit `0`, status `completed`, commit `docs(cycle): finalize <tag>`.
2. `codkit cycle status` → `cycle: completed; phase: done`, exit `0`; next — merge without squash.
3. `test ! -e cycle/state.json` → exit `0`.
4. `node -e "const r=JSON.parse(require('node:fs').readFileSync('.codkit/cycle-terminal.json','utf8'));process.exit(r.checkpoint==='committed'?0:1)"` → exit `0`.
   Смысловую/криптографическую валидность receipt уже доказал шаг 2; оператор файл не меняет.
5. `git show HEAD:cycle/log/<tag>.jsonl` и `git show HEAD:cycle/log/<tag>.md` → exit `0`; все non-clean outcomes имеют latest green record.
6. `tail -n 1 <patchesDir>/docs/codkit/metrics/inventory-history.csv` → target SHA/tag, duration, counts, journal и inventory; exit `0`.
7. `codkit ci --profile build --pin-guard-base <main-ref>` → exit `0`.
8. Открой PR по [шаблону](templates/pr-checklist.md); merge commit/no-ff, **squash запрещён**.
9. После merge `codkit cycle status` всё ещё валидирует terminal receipt как ancestor; затем следующий start безопасно очищает старый receipt.

## Минорный security bump

1. DRI фиксирует target SHA/tag и security advisory в issue; batching всё равно не больше двух tag.
2. Выполняется тот же `cycle start` и вся петля; пропуск rename/advisory/stabilize не допускается.
3. При blocker без решения до SLA main остаётся на старом пине; быстрый перенос одного upstream fix выполняется по [09](09-incidents.md#быстрый-security-перенос).

## Ретроспектива

В течение рабочего дня после merge DRI заполняет [шаблон](templates/retrospective.md), читает CSV по [11](11-metrics.md)
и в том же PR исправляет найденный дефект протокола. Числовые бюджеты назначаются только после двух baseline-циклов.
