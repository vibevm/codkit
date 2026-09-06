# Протокол работы людей с codkit

Статус: рабочая норма standalone Codkit. Натурные доказательства хранятся в
репозитории конкретного patch set, а не в установке Codkit.
Определения данных задаёт только [conventions.json](../../../../codkit/config/conventions.json);
контракты команд — [PROP-007](../../../../vibevm/vibespecs/modules/codkit/PROP-007-cli.xml).

## Launcher и корни

Во всех примерах `codkit` — установленная команда из `PATH`. Без установки в
`PATH` используй абсолютный `<codkit-tool-root>/bin/codkit`; в PowerShell —
`& <codkit-tool-root>\bin\codkit.ps1`. Launcher и зависимости принадлежат
установке Codkit: patch set не обязан иметь `bin/codkit`, `package.json` или
`node_modules`.

Перед процедурой выполни `codkit --json where`. Конверт должен содержать
`codkit.schema: 2` и три попарно непересекающихся корня:
`roots.tool.path`, `roots.patches.path`, `roots.fork.path`. Внешние корни
выбираются независимо: flag → environment → `~/.codkit/settings.json`.
Человеческий запуск может передать `--patches-dir`/`--fork-dir`; агентский не
может перенаправлять уже выбранные корни.

Patch set может указать versioned `buildWatchFile` и
`conventionsExtensionFile` в `codkit.json`. Первый выбирает полный build
profile выбранного проекта: его strict channel schema требует error detector,
а проект обязан хранить green/red log fixtures. Второй только добавляет
разрешённые значения к встроенным safety conventions и не может ослабить
запреты Codkit.

## Кто ты и что читать

| Роль | Обязательно | По событию |
| --- | --- | --- |
| Разработчик | [01](01-quickstart.md), [02](02-daily.md) | [03](03-interventions.md), [04](04-team.md) |
| Ревьюер вмешательств | [03](03-interventions.md), [10](10-roles.md) | [11](11-metrics.md) |
| DRI / команда апгрейда | [05](05-upgrade-cycle.md), [06](06-history.md), [07](07-upstream-watch.md), [09](09-incidents.md), [10](10-roles.md) | [08](08-release-ci.md), [11](11-metrics.md) |
| Релиз-инженер | [08](08-release-ci.md), [10](10-roles.md) | [09](09-incidents.md) |
| Мейнтейнер протокола | [12](12-maintenance.md) и весь протокол | шаблоны ниже |

Изменения форка подчиняются той же дисциплине: сначала выбирается верхний допустимый слой,
а `patch` остаётся последним вариантом. Отдельного продуктового процесса нет; дерево решений — в [03](03-interventions.md).

## Карта документов

| Документ | Отвечает на вопрос |
| --- | --- |
| [01-quickstart](01-quickstart.md) | Как пройти первый час на полигоне? |
| [02-daily](02-daily.md) | Как выглядит обычный рабочий день? |
| [03-interventions](03-interventions.md) | В какой слой положить изменение и как его ревьюить? |
| [04-team](04-team.md) | Как пережить гонку веток, конфликт и смену пина? |
| [05-upgrade-cycle](05-upgrade-cycle.md) | Как DRI проводит еженедельный цикл? |
| [06-history](06-history.md) | Почему историю цикла нельзя сплющивать? |
| [07-upstream-watch](07-upstream-watch.md) | Как читать прогноз и апстримить швы? |
| [08-release-ci](08-release-ci.md) | Как проверить и опубликовать в закрытом контуре? |
| [09-incidents](09-incidents.md) | Как откатить цикл, сделать hotfix или security-перенос? |
| [10-roles](10-roles.md) | Кто принимает решение и в какой срок? |
| [11-metrics](11-metrics.md) | Как читать стоимость дельты? |
| [12-maintenance](12-maintenance.md) | Как менять сам протокол? |

## Норма → механизм → текст

| Норма | Исполнимый механизм | Где человеку действовать |
| --- | --- | --- |
| Правка дерева не теряется | `load` отказывает с `CK-E-DIRTY-TREE`; `status` перечисляет грязь | [02: синхронизация](02-daily.md#цикл-дня) |
| Апстрим правится только внутри маркеров | `marker new`, `save`, `verify`, patchset pre-commit | [03: patch](03-interventions.md#терминальный-лист-patch) |
| Коммиты дерева — работа до извлечения | tree pre-commit hook напоминает про `codkit save`; `load`/`ci`/`publish` отказывают над неизвлечёнными коммитами; внутренние коммиты имеют `CODKIT_INTERNAL_COMMIT=1`; в linked worktree напоминание отключено с предупреждением | [02: коммиты и запреты](02-daily.md#коммиты-в-дереве-и-что-в-нём-запрещено) |
| Пин PR равен пину target | `ci --pin-guard-base`; перенос — `rebase-onto-pin` | [04: S12](04-team.md#s12-feature-на-старом-пине) |
| Коммиты цикла несут трейлеры | `hooks install`; commit-msg hook; независимая проверка CI | [06](06-history.md) |
| Дельта ложится на чистый пин | `ci --profile verify` на каждом PR | [02: PR](02-daily.md#pr) |
| Журнал цикла полон | `cycle continue` отказывает `CK-E-LOG-INCOMPLETE` | [05: журнал](05-upgrade-cycle.md#разрешение-красного-исхода) |
| Компиляцией владеют демоны | `build up/errors/down`; CI запускает один проход | [02: сборка](02-daily.md#сборка-и-запуск) |
| Metadata каноничны | `verify` проверяет schema, UTF-8/LF и канонические JSON bytes | [03: ревью](03-interventions.md#чек-лист-ревьюера) |
| Цикл возобновляем | durable records + `cycle status/continue`; receipt нельзя редактировать | [05: восстановление](05-upgrade-cycle.md#возобновление-и-штатные-восстановления) |
| Метрики связаны с финалом | terminal finalization связывает SHA256 JSONL, Markdown и CSV | [11](11-metrics.md) |
| Ссылки и лимиты документации проверяются | `node docs/codkit/protocol/human/check.mjs` | [12](12-maintenance.md) |

Если новая текстовая норма не имеет команды, хука или CI-проверки, это дефект механизации:
в PR добавляется issue со столбцами «норма / наблюдаемый риск / требуемый механизм / владелец / SLA».
До появления механизма документ обязан пометить разрыв, а не изображать защиту.

## Общие коды выхода

- `0` — команда завершила заявленный шаг; переходи к следующему шагу процедуры.
- `1` — проверка или guard красные; выбирай ветку по напечатанному `CK-E-*` либо `failed`.
- `2` — запуск/окружение; выполняй ровно напечатанный `hint`, затем повторяй ту же команду.
- `3` — точка остановки цикла; решение принимает роль из [10](10-roles.md), затем выполняется [05](05-upgrade-cycle.md).

Ошибки использования без `CK-E-*` тоже дают `2`. Каждая доменная ошибка печатает `hint:`.

## Шаблоны

- [PR checklist](templates/pr-checklist.md)
- [Issue цикла](templates/cycle-issue.md)
- [Ретроспектива](templates/retrospective.md)
- [Журнал решения](templates/decision-journal.md)

## Ворота приёмки

Ключевые документы считаются организационно принятыми только после натурных проверок:
два новых разработчика проходят 01 и сценарий 02, независимый мейнтейнер проходит 05,
а инженер чужого CI — 08. Результат фиксируется в issue цикла командами, кодами выхода и временем.
