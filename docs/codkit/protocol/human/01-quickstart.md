# Первый час

## Модель

Есть три независимых расположения: установка Codkit, Git-репозиторий patch set
с дельтой и историей форка, а также управляемое дерево форка (семейство
апстрима называет тип проекта, [15](15-project-types.md)). Редактирование
идёт в дереве, истина после `save` — снова в patch set.

```text
patchset/delta ── load ──> дерево форка ── edit ──> save ──> patchset/delta
```

Установи launcher Codkit в `PATH` либо используй абсолютный
`<codkit-tool-root>/bin/codkit`. Нужны Node >= 22.6, git >= 2.40 и git-lfs >=
3.0. Зависимости Codkit устанавливаются в tool root, не в patch set.

До первой команды настрой оба внешних корня флагами, переменными
`CODKIT_PATCHES_DIR`/`CODKIT_FORK_DIR` или строгим
`~/.codkit/settings.json`. Выполни `codkit --json where`: ожидаются schema 2,
три попарно непересекающихся `roots.*.path` и правильные `source`.
Для следующих shell-примеров задай `CODKIT_ACTIVE_PATCHES` из
`roots.patches.path` и `CODKIT_ACTIVE_FORK` из `roots.fork.path`.

## Три команды

1. Выполни `codkit load`.
   Ожидается выбранный fork root, затем `applied ...` или `up to date`, exit `0`.
   Если exit `1` и `CK-E-DIRTY-TREE`, переходи к команде 3; если exit `2`, исполни `hint` и повтори шаг 1.
2. Выполни `codkit status`.
   Exit `0` означает консистентное дерево; exit `1` перечисляет own/upstream dirt или битые маркеры.
   При перечисленной работе продолжай к шагу 3, при битых маркерах исправь названные строки.
3. Выполни `codkit save`.
   Ожидается `saved N file(s)` либо `nothing to save`, exit `0`; дельта появилась в `patchset`.
   Exit `1` называет точный файл/строку и механизм исправления; после него повтори шаг 3.

## Четыре запрета и работа коммитами

Коммитить в дереве можно: коммит — это работа, пока не выполнен `codkit
save`/`sync`; `load` откажет, пока коммиты не извлечены или не отброшены
`load --discard`. В обычном checkout `load` ставит хук-напоминание: ручной
коммит проходит, хук печатает, какой командой работа достигает patchset
(на HEAD вне `codkit/applied/<tag>` — что `save` откажет до возврата).
Linked/custom/foreign конфигурация явно сообщает, что напоминание не
печатает; защищает отказ команд, не хук.

1. Не правь апстрим вне маркера: `save`, `verify` и pre-commit отклонят hunk.
2. Не удаляй апстримные строки: комментируй их внутри маркера; `save` проверяет удаление.
3. Не запускай прямой `tsc`/`npm run compile`: компиляцией владеют `build up/errors`.
4. Не правь materialized config target вручную: используй `config-overlay`;
   `overlay check`/`verify` проверяют ожидание пина.

## Полигон-тренажёр

Используй только выделенную учебную ветку и отдельное дерево. После каждого задания запиши команду, exit и вывод в issue.

### A. Применить и запустить

1. `codkit load` → exit `0`, `applied`/`up to date`.
2. Проверь `CODKIT_ACTIVE_FORK`, ранее полученный из `codkit --json where`.
3. `"$CODKIT_ACTIVE_FORK/scripts/code.sh"` → появляется dev-сборка форка;
   завершение процесса пользователем допустимо.

### B. Изменить own

1. Измени файл из own manifest под `$CODKIT_ACTIVE_FORK`.
2. `codkit status` → exit `1`, `own code` показывает файл.
3. `codkit save` → exit `0`.
4. `git -C "$CODKIT_ACTIVE_PATCHES" diff -- delta/own` → exit `0`, виден тот же смысловой diff.

### C. Создать patch

1. Выполни `codkit marker new <upstream-file> --id CK-<subsystem>-<NNN> --type hook --owner <owner> --reason "training hook"`.
2. Ожидается exit `0`, пара `codkit:begin/end` в дереве и локальная pending-шапка.
3. Добавь код между маркерами; `codkit save <upstream-file>` → exit `0`.
4. `codkit inventory --md` → exit `0`; id виден в `.codkit/out/inventory.md`, patch — в `delta/patches/`.

### D. Увидеть защиту маркера

1. На учебной ветке измени апстримную строку вне блока.
2. `codkit save <upstream-file>` → exit `1`, ожидается `CK-E-HUNK-OUTSIDE-MARKER` или более точный запрет.
3. Верни только эту учебную правку редактором; `codkit status` должен перестать показывать её.

### E. Увидеть drift guard

1. Оставь разрешённую, но ещё не извлечённую правку в дереве.
2. `codkit load` → exit `1`, `CK-E-DIRTY-TREE`, список файлов и `hint` про `save/status`.
3. `codkit save` → exit `0`; затем `codkit load` → exit `0`.

## Самопроверка

- `codkit verify` завершился `0`.
- `git -C "$CODKIT_ACTIVE_PATCHES" status --short` показывает только ожидаемые учебные файлы.
- `git -C "$CODKIT_ACTIVE_FORK" status --short` не показывает незаизвлечённой работы.
- Все пять заданий заняли не более часа; независимый наблюдатель записал время в issue.

Дальше: [ежедневная работа](02-daily.md), затем [вмешательства](03-interventions.md).
