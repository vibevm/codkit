# Ежедневная работа

Формула дня: **история, ветки, PR — в patchset; редактирование — в дереве форка**.

## Получить дерево

1. `codkit --json where` печатает schema-2 конверт с `roots.tool`,
   `roots.patches`, `roots.fork`, их источниками и `exists`, а также `codkit.type`
   — тип проекта этого patch set ([15](15-project-types.md)); exit `0`.
   Exit `2` с `CK-E-CONFIG` о `type`/`typeConfig` либо с `CK-E-TYPE-UNKNOWN` —
   конфигурация не объявляет тип этой установки; чини по [15](15-project-types.md#отказы-и-что-по-ним-делать).
2. При `exists: no` выполни `codkit clone --from <approved-url>`.
   Ожидается checkout пина и exit `0`; `--ci` для clone запрещён и даёт `CK-E-NET-FORBIDDEN`, exit `2`.
3. `codkit check-tree --require-clean` → таблица из `ok`, exit `0`.
   Exit `1` с hint `load` ведёт к `codkit load`; exit `2` требует исправить путь/LFS/доступность пина по `hint`.

Каждый внешний путь выбирается отдельно: соответствующий flag,
`CODKIT_PATCHES_DIR`/`CODKIT_FORK_DIR`, затем поле
`patchesDir`/`forkDir` в `~/.codkit/settings.json`. Скрытых default и
sibling fallback нет; личный settings-файл не коммитится. Tool, patch-set и
fork roots должны быть попарно непересекающимися.

## Патч-сет над апстримом без модели продукта

Тип `generic` описывает простой git-апстрим: ни расширений, ни подмены
сервисов, ни входного модуля, ни dev-канала, ни изображений, ни рантайма
([15](15-project-types.md#тип-generic)). Всё, что он отвечает, объявляет сам
patch set — секцией `typeConfig`.

1. `codkit types` → строка `generic` с пустым списком возможностей и строкой
   `from typeConfig: build-channels, config-overlay`; exit `0`.
2. В `codkit.json` — `"type": "generic"` и секция:

```json
{
	"typeConfig": {
		"ownRoot": "src/own",
		"commands": {
			"install": "npm ci",
			"lint": ["npm run lint"],
			"test": { "command": "npm test", "ownGlobArg": "--" }
		},
		"overlayTargets": ["app.json"],
		"cleanupWhitelist": ["node_modules/", "build/out/"],
		"identity": { "manifest": { "path": "app.json", "nameField": "name" } }
	}
}
```

   `ownRoot` — любой каталог дерева. `commands` пустые — шаги сборки просто
   ничего не запускают, а не угадывают имя скрипта. `overlayTargets` — JSON-файлы,
   которые вообще разрешено трогать слою `config-overlay`; объявишь хотя бы
   один — появится возможность `config-overlay`, не объявишь — `verify` над
   overlay-артефактом отказывает `CK-E-TYPE-CAPABILITY`.
3. `codkit where` → `project type: generic`, exit `0`;
   `codkit check-tree --require-clean` → exit `0`.
4. Дальше — обычный [цикл дня](#цикл-дня): `load`, правка в дереве, `save`,
   `verify`, `ci --profile verify`, `cycle` на следующий тег.
5. Отличие в overlay: dev-канала у этого типа нет, поэтому `load` не трогает
   цель, а материализует её `codkit overlay apply <файл>`; вернуть пин —
   `codkit load --fresh`.
6. `build up|down|status|errors` отказывает, пока в `commands.compile` не
   объявлены каналы вместе с границами прохода — угадывать их инструмент не
   станет ([PROP-010 §2](../../../../vibevm/vibespecs/modules/codkit/PROP-010-build-integration.xml)).

## Цикл дня

1. `git status --short` в patchset должен быть пуст, либо показывать только осознанную незавершённую работу текущей ветки.
2. `codkit load` → `applied ...`/`up to date`, exit `0`; переходи к шагу 3.
   Exit `1` + `CK-E-DIRTY-TREE` → `codkit status`, затем `codkit save`, затем повтор шага 2.
   Отказ покрывает и правки, и коммиты дерева: строка `N commit(s) in the fork tree ...` — та же незаизвлечённая работа.
   Exit `1` + `CK-E-ARTIFACT-BROKEN` → не редактируй артефакт вслепую; владелец исправляет названный артефакт в patchset.
   Exit `2` → исполни точный `hint` и повтори шаг 2.
3. Редактируй только пути own manifest в дереве; корень собственного кода —
   `typeConfig.ownRoot`, и его границы задаёт тип проекта. Для апстримного файла сначала
   выполни дерево решений [03](03-interventions.md).
4. `codkit status` → exit `1` при ожидаемой неизвлечённой работе; сверь каждый названный путь.
   Неожиданный путь — остановка: верни/сохрани его отдельно до шага 5.
5. `codkit save [<path> ...]` → `saved N file(s)`, exit `0`.
   Адресный save при другой грязи предупреждает, что generated branch не перестроена; после извлечения всего выполни полный `codkit save`.
6. `codkit status` → exit `0`; при exit `1` повтори шаги 4–5 только для перечисленных путей.
7. `codkit verify` → exit `0`; exit `1` исправляется по каждой строке `code: file:line ... + hint`.
8. `git add <expected-patchset-paths>` → exit `0`; затем `git commit` → exit `0` и новый commit в patchset.
   Для одного шага допустимо `codkit save --commit --message "<message>"` → commit и exit `0`.

## Снятая декларация own-расширения

`codkit status` печатает строку `own extensions: D declared, P path(s) differ between tree and
patchset, S stranded materialization(s)`. Третье число — брошенные материализации: неотслеживаемые
каталоги `extensions/<name>/` дерева, которые не объявлены ни одной записью секции `extensions`
манифеста `delta/own/patchset.delta.json` и не существуют на пине.

Снятие декларации каталог не убирает: `load` зеркалирует только объявленные расширения, а
неотслеживаемый каталог остаётся в дереве — удаляет его единственная команда `codkit load --fresh`
(чистка неотслеживаемых путей). Поэтому при `S > 0` `status` называет каждый путь строкой
`  extensions/<name>/ - codkit load --fresh removes it`, перечисляет пути в `--json` как
`data.ownExtensions.stranded` и выходит `1`. Правило смотрит на декларацию и на пин, а не на
содержимое: каталог без `package.json` назван так же, а каталог расширения с пина не назван никогда.
Проверь каждый названный путь до `load --fresh`: неотслеживаемый каталог под `extensions/` может
быть и локальным экспериментом, который эта команда сотрёт вместе с брошенной материализацией.
Обычный `codkit load` над деревом с брошенной материализацией проходит и каталога не касается:
в него `load` не пишет и его не удаляет, поэтому страж дрейфа не считает его грязью (исключение
только для `load`; `cycle start` и `sync` над таким деревом по-прежнему отказывают, а `ci` и `publish`
убирают неотслеживаемое свежим проходом).
Убирает каталог `codkit load --fresh` — после `codkit status`, который его называет.

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

## Коммиты в дереве и что в нём запрещено

Коммит в дереве — работа: он достигает patchset только через `codkit save`
(или двусторонний `codkit sync`), а `load`/`ci`/`publish` отказывают
`CK-E-DIRTY-TREE`, пока такие коммиты не извлечены или не отброшены
(`load --discard`); `save` воспроизводит каждый коммит отдельным коммитом
patchset. Конфликт обеих сторон при `codkit sync` материализуется diff3-маркерами
в файле дерева; процедура разрешения и возврата —
[конфликт двустороннего sync](05-upgrade-cycle.md#конфликт-двустороннего-sync).
В обычном checkout `load` ставит хук-напоминание, проверяемый
каждым `load`: ручной коммит проходит, и хук печатает, какой командой
работа доедет до patchset; на HEAD вне `codkit/applied/<tag>` — что `save`
откажет до возврата (`git switch codkit/applied/<tag>`). Linked worktree,
custom/global/system `core.hooksPath`, `/dev/null`, foreign hook или
неразрешимый effective path дают явное предупреждение: напоминание не
печатает, Codkit не пишет shared/custom location; защищает отказ команд.
Накопившиеся consumed refs и мусор крэшей чистит `codkit gc` (сначала
`--dry-run`: план перечисляет и kept-классы); транзакции остановленного
`sync`, pending-черновики и чужие замки команда не трогает.

Запрещено в дереве:

- Правка generated/managed результата вместо источника в patchset: `save` извлекает только own и patch.
- Ручная правка `product.json`: authoring идёт через `delta/overlays/`, проверка — `overlay check`/`verify`.
- Удаление апстримного файла/строки: `save` возвращает `CK-E-DELETES-UPSTREAM-*`.
- Новый апстримный файл без явного `--allow-new-file`: `save` возвращает `CK-E-NEW-FILE-IN-UPSTREAM-ZONE`.
- `overlay apply` в живом dev-дереве: это упаковочная операция; обычный `load` после неё честно красный, возврат в dev-режим — `codkit load --fresh` (заменяет только точную композицию overlay).

## Возврат в dev-режим после сборки в дереве

Сборка пакета в дереве переписывает отслеживаемые апстримные файлы артефактами:
по байтам это неотличимо от правки человека, поэтому следующий `load` честно
красный `CK-E-DIRTY-TREE`. Возврат — `codkit load --fresh --discard`: план печатает
`discard <path>` на каждый такой файл до первой записи, отбрасывание совпадает с
планом, файл возвращается к пину плюс дельта; сводка — `discarded N working-tree
edit(s)`, `--json` перечисляет пути в `data.discardedPaths`, `--dry-run` печатает
план и ничего не пишет. Флаг не трогает: файлы с маркерными блоками (там может
стоять неизвлечённое вмешательство — отказ `CK-E-DIRTY-TREE` с подсказкой про
`codkit save`), собственный код и own-расширения, неотслеживаемые пути вне списков
очистки. Без `--fresh` `--discard` по-прежнему касается только коммитов дерева;
под `--ci` он запрещён. Упаковку предпочтительно вести в одноразовом клоне —
[релиз и CI](08-release-ci.md).

## Переключение ветки

1. Полный `codkit save` → exit `0`; затем `codkit status` → exit `0`.
2. `git switch <branch>` в patchset → exit `0`.
3. `codkit load` → exit `0`; это обязательная материализация дельты выбранной ветки.
4. Если шаг 3 дал `CK-E-DIRTY-TREE`, ветка не материализована: вернись к прежней ветке, извлеки грязь, повтори процедуру.
5. `save` после переключения, но до шага 3, отказывает `CK-E-PATCHSET-MOVED`:
   дерево загружено из состояния patchset, которого ветка больше не несёт. Рецепт,
   который печатает отказ (и FAQ `CK-E-PATCHSET-MOVED`):
   (1) вернуть delta к загруженному состоянию — `git stash`, `git switch <ветка>`
   или `git checkout <sha> -- delta/`; (2) `codkit save`; (3) вернуть сдвиг —
   `git stash pop` / `git merge` / `git rebase`; (4) `codkit load`.
   Поэтому полный `save` — шаг 1, до switch: рецепт существует для забытого
   порядка, а не вместо него. Тот же отказ приходит и на правку артефакта
   в patchset при живой правке в дереве — до любой записи.

В multi-root IDE открой корень patchset и корень дерева. Git-панель patchset используется для commit/PR;
панель дерева — для просмотра незаизвлечённой работы: коммит из неё проходит и напоминает о `codkit save`.

## PR

1. Заполни [PR checklist](templates/pr-checklist.md); каждый ответ подтверждается указанной командой/артефактом.
2. `codkit inventory --diff <base-ref> --md` → exit `0`, приложи `.codkit/out/inventory.md`/diff.
3. `codkit ci --profile verify --pin-guard-base <base-ref> --effective-diff <base-ref>` → exit `0`.
   Exit `1` + pin mismatch → [S12](04-team.md#s12-feature-на-старом-пине); другой exit `1` → исправь красный шаг.
4. Ревьюер читает effective diff и inventory diff; сырой `.ckpatch` не является основным объектом ревью.
