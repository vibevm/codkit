# Ежедневная работа

Формула дня: **история, ветки, PR — в patchset; редактирование — в дереве форка**.

## Получить дерево

1. `codkit --json where` печатает schema-2 конверт с `roots.tool`,
   `roots.patches`, `roots.fork`, их источниками и `exists`, exit `0`.
2. При `exists: no` выполни `codkit clone --from <approved-url>`.
   Ожидается checkout пина и exit `0`; `--ci` для clone запрещён и даёт `CK-E-NET-FORBIDDEN`, exit `2`.
3. `codkit check-tree --require-clean` → таблица из `ok`, exit `0`.
   Exit `1` с hint `sync` ведёт к `codkit sync`; exit `2` требует исправить путь/LFS/доступность пина по `hint`.

Каждый внешний путь выбирается отдельно: соответствующий flag,
`CODKIT_PATCHES_DIR`/`CODKIT_FORK_DIR`, затем поле
`patchesDir`/`forkDir` в `~/.codkit/settings.json`. Скрытых default и
sibling fallback нет; личный settings-файл не коммитится. Tool, patch-set и
fork roots должны быть попарно непересекающимися.

## Цикл дня

1. `git status --short` в patchset должен быть пуст, либо показывать только осознанную незавершённую работу текущей ветки.
2. `codkit sync` → `applied ...`/`up to date`, exit `0`; переходи к шагу 3.
   Exit `1` + `CK-E-DIRTY-TREE` → `codkit status`, затем `codkit save`, затем повтор шага 2.
   Exit `1` + `CK-E-ARTIFACT-BROKEN` → не редактируй артефакт вслепую; владелец исправляет названный артефакт в patchset.
   Exit `2` → исполни точный `hint` и повтори шаг 2.
3. Редактируй только пути own manifest в дереве. Для апстримного файла сначала
   выполни дерево решений [03](03-interventions.md).
4. `codkit status` → exit `1` при ожидаемой неизвлечённой работе; сверь каждый названный путь.
   Неожиданный путь — остановка: верни/сохрани его отдельно до шага 5.
5. `codkit save [<path> ...]` → `saved N file(s)`, exit `0`.
   Адресный save при другой грязи предупреждает, что generated branch не перестроена; после извлечения всего выполни полный `codkit save`.
6. `codkit status` → exit `0`; при exit `1` повтори шаги 4–5 только для перечисленных путей.
7. `codkit verify` → exit `0`; exit `1` исправляется по каждой строке `code: file:line ... + hint`.
8. `git add <expected-patchset-paths>` → exit `0`; затем `git commit` → exit `0` и новый commit в patchset.
   Для одного шага допустимо `codkit save --commit --message "<message>"` → commit и exit `0`.

## Сборка и запуск

1. `codkit build up` → `transpile` и `typecheck` started/already living, exit `0`.
   Exit `1` означает чужой watcher/конкурентный `starting`/`unknown` record/чужое дерево; `codkit build status` различает `starting`, `living`, `dead`, `unknown`. Invalid/starting/unknown record не удаляй: сначала докажи владельца или teardown.
   Exit `2` означает непригодное дерево. На Linux предупреждение про inotify передаётся владельцу машины: порог запуска предупреждения `<262144`, рекомендуемое значение `524288`.
2. Один раз выполни `codkit build errors` и прочитай весь напечатанный проход.
   Exit `0` — ошибок нет; exit `1` — исправь все строки; exit `2` без завершённого прохода → `build up` и повтор. Для `starting`/`unknown` exit `2` намеренно не читает старый зелёный log.
3. Для локальной фильтрации допустим `codkit build errors --mine`; зелёный `--mine` не заменяет полный проход в CI.
4. Задай `CODKIT_ACTIVE_FORK=/abs/path` из `roots.fork.path`;
   `"$CODKIT_ACTIVE_FORK/scripts/code.sh"` запускает dev-сборку форка.
5. Перед установкой зависимостей выполни `codkit build down --channel all` → exit `0`; затем разрешённая командой команды установка выполняется в дереве.

Прямой `tsc`, `npm run compile`, `npm install` при живых демонах и чужие watch-скрипты исключены:
обёртка владеет процессами и логами `.codkit/build/`.

## Что в дереве запрещено

- `git commit`: в обычном checkout effective owned hook, проверяемый каждым `sync`, отклоняет его. Linked worktree, custom/global/system `core.hooksPath`, `/dev/null`, foreign hook или неразрешимый effective path дают явное предупреждение: guard неактивен, Codkit не пишет shared/custom location, а запрет остаётся процедурным.
- Правка generated/managed результата вместо источника в patchset: `save` извлекает только own и patch.
- Ручная правка `product.json`: authoring идёт через `delta/overlays/`, проверка — `overlay check`/`verify`.
- Удаление апстримного файла/строки: `save` возвращает `CK-E-DELETES-UPSTREAM-*`.
- Новый апстримный файл без явного `--allow-new-file`: `save` возвращает `CK-E-NEW-FILE-IN-UPSTREAM-ZONE`.
- `overlay apply` в живом dev-дереве: это упаковочная операция; обычный `sync` после неё честно красный, возврат в dev-режим — `codkit sync --fresh` (заменяет только точную композицию overlay).

## Переключение ветки

1. Полный `codkit save` → exit `0`; затем `codkit status` → exit `0`.
2. `git switch <branch>` в patchset → exit `0`.
3. `codkit sync` → exit `0`; это обязательная материализация дельты выбранной ветки.
4. Если шаг 3 дал `CK-E-DIRTY-TREE`, ветка не материализована: вернись к прежней ветке, извлеки грязь, повтори процедуру.

В multi-root IDE открой корень patchset и корень дерева. Git-панель patchset используется для commit/PR;
панель дерева — только для просмотра неизвлечённой грязи. Коммит из панели дерева заблокирует hook.

## PR

1. Заполни [PR checklist](templates/pr-checklist.md); каждый ответ подтверждается указанной командой/артефактом.
2. `codkit inventory --diff <base-ref> --md` → exit `0`, приложи `.codkit/out/inventory.md`/diff.
3. `codkit ci --profile verify --pin-guard-base <base-ref> --effective-diff <base-ref>` → exit `0`.
   Exit `1` + pin mismatch → [S12](04-team.md#s12-feature-на-старом-пине); другой exit `1` → исправь красный шаг.
4. Ревьюер читает effective diff и inventory diff; сырой `.ckpatch` не является основным объектом ревью.
