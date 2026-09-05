# Командная работа

Непересекающиеся файлы не требуют координации. Блокировка codkit сериализует одну операцию над одним деревом;
Git координирует историю patchset. Ниже ветки выбираются только по наблюдаемому симптому.

## R1: Git-конфликт в `.ckpatch`

Симптом: merge main/target показывает конфликт в `delta/patches/*.ckpatch`.

1. В конфликтующем patch прими версию target/main и заверши Git merge так, чтобы patchset был чист.
2. `codkit load` → exit `0`, target-версия материализована в дереве.
3. `codkit reresolve <upstream-file>` → `resolved, run codkit save`, exit `0`, либо conflict markers и exit `1`.
4. При exit `1` исправь только стандартные conflict markers в названном файле дерева; `git -C <fork> diff --check -- <file>` → exit `0`.
5. `codkit save <upstream-file>` → exit `0`; затем `codkit verify` → exit `0`.
6. Коммит результата создаётся в patchset. Терминальный исход: один согласованный patch и чистое дерево.

Если `reresolve` не нашёл прежний patch, он перечисляет источники; передай сохранённый blob явно:
`codkit reresolve <file> --patch <old.ckpatch>`.

## R4: `load` видит незаизвлечённое

1. `codkit load` → exit `1`, `CK-E-DIRTY-TREE`, список путей.
2. `codkit status` → exit `1`, классификация own/upstream/markers.
3. Работа нужна → `codkit save` → exit `0`; работа чужая → владелец процесса завершает/сохраняет её.
4. `codkit load` → exit `0`. Терминальный исход: материализована выбранная ветка без потери байтов.

## `CK-E-LOCKED`

1. Прочитай pid/command/tree из ошибки; `codkit build status` и список процессов подтверждают живого владельца.
2. Живой процесс → дождись его терминального вывода и повтори исходную команду.
3. Процесса нет → не удаляй lock вслепую; повтор команды сам валидирует фактическое состояние. Повторный `LOCKED` эскалируется DRI с `.codkit/locks` и `--verbose`.

## Переключение веток

1. `codkit save` → exit `0`; `codkit status` → exit `0`.
2. `git switch <branch>` → exit `0`.
3. `codkit load` → exit `0`. Только после этого редактируй дерево.

## S12: feature на старом пине

Симптом: CI `pin guard` красный, exit `1`, выводит `branch pin ... != target branch pin ...`
и hint `merge the base branch, then re-pin the delta: codkit rebase-onto-pin`.

Нужны два чистых checkout patchset: feature и target; один fork-tree на время процедуры, без параллельного codkit.

1. В target-checkout выполни `codkit --fork-dir <fork> load`.
   Ожидается target-пин, exit `0`. Это штатное восстановление managed own bytes, подтверждённое S12.
2. В feature-checkout: `git status --short` → пусто.
3. Оставаясь на feature, выполни `git merge --no-ff <target-ref>` → exit `0`.
   Проверь `git rev-list --parents -n 1 HEAD`: ровно два родителя, `HEAD^1` — feature до merge, `HEAD^2` — target.
4. `codkit --fork-dir <fork> rebase-onto-pin`.
   Exit `0` печатает `rebase saved N feature patch(es) onto <tag>`; переход к шагу 6.
5. Exit `1` разбирается только по симптому:
   - `patchset work tree and index must be clean` → заверши/отмени незакоммиченное и повтори шаг 4;
   - `ignored own bytes are not the source or target managed state` → повтори target `load` из шага 1, затем шаг 4;
   - conflict markers → разреши их в дереве, `codkit save <file>` → exit `0`, затем повтори шаг 4.
   Exit `2` означает неверный merge graph/окружение; исправь точный `hint`, не переставляй родителей новым squash/rebase.
6. `git diff -- delta/patches` показывает feature patch с target `pin`; закоммить этот diff отдельным patchset-коммитом.
7. `codkit --fork-dir <fork> load` → exit `0`; команда сверяет и потребляет completed receipt.
   Не удаляй `.codkit/rebase-onto-pin-move.json`/pending records вручную: команда проверяет exact bytes и очищает их сама.
8. `codkit --fork-dir <fork> ci --profile verify --pin-guard-base <target-ref>` → exit `0`.

Реализация уже обеспечивает точный двухродительский граф, durable receipt, перенос patch metadata и проверку own bytes.
Действия команды — target `load`, no-ff merge в правильном порядке, commit извлечённой дельты и финальный `load`.
