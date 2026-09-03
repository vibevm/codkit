# Инциденты и откаты

Каждая процедура заканчивается наблюдаемым green-критерием. История patchset не переписывается,
recovery/receipt-файлы не редактируются, старый зелёный пин остаётся допустимым релизным состоянием.

## Дерево первичной сортировки

```text
Есть active cycle и он ещё не merged?
├─ да, нужно отказаться от цикла → rollback до merge
└─ нет: cycle уже merged и новый pin нужно снять?
   ├─ да → rollback после merge
   └─ нет: критичный upstream seam сломан?
      ├─ нужен один быстрый upstream fix → security-перенос
      ├─ нужен релиз с прежнего pin → hotfix старого pin
      └─ нужна адаптация дельты → seam incident
```

## Апстрим сломал критичный шов

Симптом: contract-test красный либо forecast/cycle даёт `conflict`, `target-deleted`, `rule-broken`, `contract-failed`.

1. `codkit forecast --ref <exact-upstream-ref>` либо `codkit cycle status` фиксирует artifact, owner, outcome, cause и exit `1/0`.
2. Владелец выполняет `git -C <fork> show --stat --oneline <cause>` → exit `0` и прикладывает upstream change.
3. В течение рабочего дня выбери терминальный лист:
   - переработать вмешательство по [03](03-interventions.md) и добавить/починить contract-test;
   - оставить production на прежнем green pin;
   - создать минимальный upstream seam issue/PR по [07](07-upstream-watch.md#апстримить-швы-не-фичи).
4. Адаптация: `codkit verify` и предметный test → exit `0`; в active cycle — matching JSONL record и `cycle continue` → exit `0`.
5. Завершение: `codkit ci --profile build --pin-guard-base <target-ref>` → exit `0`, либо release issue явно указывает прежний pin.

## Rollback до merge

`cycle restart` делает `reset --hard`, поэтому точная цель проверяется до команды.

1. `codkit cycle status` → active, ожидаемые `<targetTag>` и branch.
2. `git branch --show-current` → ровно `codkit/cycle/<targetTag>`; иначе switch по `nextAction` и повтор шага 1.
3. `codkit cycle restart --yes` → exit `0`, `restarted <branch>: reset to <sha>`.
4. `codkit cycle status` → absent, exit `0`; `codkit.json` снова несёт source pin.
5. Удаление draft-ветки выполняет DRI отдельным Git-действием только после сохранения incident evidence.

## Rollback после merge

Runbook требует no-ff merge, поэтому revert merge сохраняет обе истории и возвращает всю дельту/пин атомарно.

1. `git show --no-patch --format='%H %P %s' <cycle-merge-sha>` → merge SHA и два родителя; первый — прежний main.
2. Создай incident branch от текущего main: `git switch -c incident/revert-<targetTag>` → exit `0`.
3. `git revert -m 1 <cycle-merge-sha>` → exit `0`; конфликт разрешается обычным Git merge с фиксацией каждого файла.
4. `git show HEAD^:codkit.json` и `git show HEAD:codkit.json` подтверждают возврат exact source pin в каноническом JSON.
5. `codkit sync` → exit `0`; `codkit ci --profile build --pin-guard-base <main-before-cycle-ref>` → exit `0`.
6. Merge revert PR без squash. Завершение: main и generated branch снова проверены на старом pin, исходный цикл остаётся в истории.

## Hotfix поверх старого пина

1. Выбери immutable `<last-release-patchset-commit>` и проверь `git show <commit>:codkit.json` → ожидаемый старый pin.
2. `git switch -c hotfix/<incident-id> <last-release-patchset-commit>` → exit `0`.
3. `codkit sync` → exit `0`; внеси изменение по [02](02-daily.md) и [03](03-interventions.md).
4. `codkit save` → exit `0`; затем `codkit verify` → exit `0`; commit/PR остаётся на этой release line.
5. `codkit ci --profile build` → exit `0` на self-consistent old pin.
6. Publish-бот выполняет [публикацию](08-release-ci.md#публикация) с новым product semver → exit `0`.

## Быстрый security-перенос

Используется, когда один upstream fix нужен до полного bump; cause — полный SHA upstream security commit.

1. `git -C <fork> show --stat --oneline <security-sha>` → exit `0`; владелец подтверждает ограниченный набор файлов.
2. Для существующего upstream файла создай marker patch по [03](03-interventions.md#терминальный-лист-patch), перенеси минимальный fix внутрь блока.
3. Для нового upstream файла используй явное authoring: создай файл в дереве и
   `codkit save <file> --allow-new-file <file>` → exit `0`; metadata/cause оформляется отдельным артефактом по правилам слоя.
4. Добавь contract-test, который красный без fix и зелёный с ним; `codkit verify` и test → exit `0`.
5. `codkit ci --profile build --pin-guard-base <main-ref>` → exit `0`; обычный PR/release.
6. На следующем cycle, где fix уже в pin, regeneration показывает пустой/лишний artifact.
   Удали artifact отдельным commit, `inventory --diff <base>` и `verify` → exit `0`.

## Tabletop

Для каждого из четырёх сценариев независимый участник выполняет команды на полигоне. В incident issue фиксируются
start/end, каждый exit, terminal criterion и место, где документ потребовал непокрытое решение. Такое место создаёт
задачу механизации/правку протокола по [12](12-maintenance.md).
