# Протокол работы агентов с codkit

Статус: standalone Codkit. Нормативное ТЗ —
[FEAT-004](../../../../vibevm/vibespecs/modules/codkit/FEAT-004-agent-protocol.xml);
операционные решения людей не дублируются, а читаются в
[human protocol](../human/00-index.md).

## Что читать

| Задача | Обязательно |
| --- | --- |
| Любая агентская работа | сгенерированное ядро в [`CLAUDE.md`](../../../../CLAUDE.md) или [`AGENTS.md`](../../../../AGENTS.md) |
| Резолв blocker | [форматы задания/результата/журнала](01-journal-format.md), [upgrade cycle](../human/05-upgrade-cycle.md) |
| Верификация/ревью | [форматы отчётов](01-journal-format.md), [инвентарь и review](../human/03-interventions.md) |
| Изменение agent protocol | [evals](02-evals.md), [memory policy](03-memory-policy.md), [maintenance](../human/12-maintenance.md) |
| Выбор слоя и отказы по типу проекта | [тип проекта](../human/15-project-types.md), [вмешательства](../human/03-interventions.md) |

Исходники пяти профилей находятся в [`docs/codkit/agents`](../../agents/).
Поставляемый профиль [`packages/codkit/claude/`](../../../../packages/codkit/claude/) —
`settings.json`, `rules/`, `agents/` и `CLAUDE.md`/`AGENTS.md` с управляемым
ядром — синхронизированная копия. Обновление:
`node tools/sync-codkit-agents.mjs`; проверка:
`node tools/sync-codkit-agents.mjs --check`. Навыки в профиле не лежат: они
поставляются пакетом `org.vibevm.codkit/agent-skills` и попадают в репозиторий
продукта через `vibe skill install` (PROP-014 §1a).

## Тип проекта

Patch set объявляет тип проекта — знание Codkit об одном семействе апстримов.
Агент его не выбирает и не меняет: `type` и `typeConfig` живут в `codkit.json`,
а запись туда не разрешена ни одному kind задания (Write открыт только в
проверенные `outputs[]`).

1. `codkit --json where` — поле `codkit.type` называет тип текущего patch set;
   `null` означает, что конфигурация не прочитана, и работа не начинается.
2. `codkit --json types` — `data.types[]` с `capabilities`: какие слои и глаголы
   вообще существуют в этой установке.
3. Глагол или артефакт слоя вне способностей типа — `CK-E-TYPE-CAPABILITY`,
   `exitCode: 2`, ничего не записано. Это останов и отчёт, а не выбор другого
   слоя по своей инициативе: лестница слоёв [03](../human/03-interventions.md)
   сужается ровно на то, чего тип не отвечает
   ([15](../human/15-project-types.md)).

## Где действует периметр

Три репозитория: инструмент Codkit, продукт (patch set) и форк апстрима
(какого семейства — говорит тип проекта).
Агентский периметр — hook, deny-профиль, rules, subagents, skills — действует
только в сессии над репозиторием продукта и его форком. Codkit не применяется
для разработки Codkit, поэтому в репозитории инструмента «сессия codkit» не
имеет смысла: там нет `.claude/settings.json` с hook, нет `.claude/agents` и
`.claude/skills`; единственное локальное правило — clean-room
`.claude/rules/ck-codkit-dev.md`. Нарушение ловят
[`check.mjs`](check.mjs) и `agentProtocol.test.ts`.

Установка профиля в репозиторий продукта — четыре шага; первые три
машинные, четвёртый пока ручной (mechanism gap: команды копирования нет):

1. `codkit standards load` — кладёт в продукт оба поставляемых пакета:
   `standards` (нормы) и `agent-skills` (навыки), плюс блок зависимостей в
   `vibe.toml` (человеческий протокол — [13](../human/13-standards.md)).
2. `vibe install --offline` — материализует пакеты в `vibevm/vibedeps/` и
   пересобирает загрузочную полосу. После `codkit standards load --upgrade`
   нужен `vibe install --offline --force`: номер издания тот же, байты другие.
3. `vibe skill install` — проецирует навыки пакета в каталоги навыков всех
   харнессов, которые знает менеджер пакетов: `.claude/skills/<имя>/`,
   `.opencode/skills/<имя>/`, `.agents/skills/<имя>/`. Каталог навыка копируется
   как есть, вместе с `scripts/` и `agents/`.
4. Скопируй `packages/codkit/claude/{settings.json,rules,agents}` в `.claude/`
   репозитория продукта; в `settings.json` замени `<codkit-tool-root>` на
   абсолютный путь установки Codkit (hook `hooks/pretool.mjs` установки остаётся в
   установке и сам находит tool root по своему расположению); управляемый блок
   из `packages/codkit/claude/CLAUDE.md` и `packages/codkit/claude/AGENTS.md` добавь в корневые
   `CLAUDE.md`/`AGENTS.md` продукта между маркерами
   `codkit-agent-core:begin/end`.

Что откуда берётся:

| Часть периметра | Источник | Как попадает в продукт |
| --- | --- | --- |
| Навыки `ck-orient`, `ck-intervene`, `ck-review-intervention`, `ck-resolve` | пакет `org.vibevm.codkit/agent-skills` | `codkit standards load` → `vibe install --offline` → `vibe skill install` |
| Journal helper `ck-resolve` | тот же пакет, `scripts/` навыка | той же проекцией, рядом с `SKILL.md` |
| Нормы patch set | пакет `org.vibevm.codkit/standards` | `codkit standards load` → `vibe install --offline` |
| `settings.json` (deny + hook), `rules/`, `agents/` | `claude/` установки Codkit | копированием вручную (шаг 4) |
| Ядро `CLAUDE.md`/`AGENTS.md` | `packages/codkit/claude/CLAUDE.md`, `AGENTS.md` | вставкой управляемого блока (шаг 4) |
| Hook `pretool.mjs` | установка Codkit | не копируется: `settings.json` ссылается на tool root |

Journal helper `ck-resolve` вызывается только по пути проекции —
`<skill-dir>/scripts/append-journal.mjs`, для Claude Code
`.claude/skills/ck-resolve/scripts/append-journal.mjs`. Hook разрешает ровно
эту копию внутри patch set и отклоняет любой другой путь: писать в `.claude/`
не разрешено ни одному заданию, поэтому подделать проекцию агент не может.
Свой tool root helper не вычисляет из своего расположения — проекция лежит на
произвольной глубине; три корня он берёт у установленного launcher'а
(`codkit --json where`, schema 2).

Во всех командах `codkit` означает установленный launcher из `PATH`; эквивалент
для явной установки — `<codkit-tool-root>/bin/codkit` (PowerShell:
`& <codkit-tool-root>\bin\codkit.ps1`). Patch set не содержит launcher и не
обязан содержать `package.json`. Перед работой агент выполняет
`codkit --json where`, требует `codkit.schema == 2`, читает три корня из
`roots.tool.path`, `roots.patches.path`, `roots.fork.path` и проверяет, что они
попарно не пересекаются.

## Норма → механизм → отказ

| Норма | Машинный эшелон | Наблюдаемый отказ |
| --- | --- | --- |
| Нет прямого commit/push | `permissions.deny` + PreToolUse | tool denied до запуска |
| Нет Edit/Write без задания | hook каждый раз читает `codkit --json where` и task | нет/битый task → deny везде |
| Тип проекта не выбирается агентом | `type`/`typeConfig` в `codkit.json`; Write только в проверенные `outputs[]` | попытка записи вне `outputs[]` → deny до запуска |
| Глагол вне способностей типа не подменяется другим слоем | проверка возможности в движке до первой записи | `CK-E-TYPE-CAPABILITY`, `exitCode: 2` |
| Нет перенаправления корней агентом | hook запрещает `--patches-dir` и `--fork-dir`; агент принимает schema-2 roots | попытка выбрать другой root → deny до запуска |
| Только периметр blocker | realpath/symlink-проверка против `blockers[].paths` | путь вне списка/root → deny |
| Нет прямой компиляции | deny + shell policy | `tsc`/compile → deny; использовать `build` |
| Нет сети/install | deny + shell policy | curl/wget/fetch/pull/install → deny |
| Design stop | JSON `exitCode:3`, ограниченные tools, result file | `status: stopped`, решение человека |
| Маркеры/дельта/state | scoped rules + `save`/`verify`/`cycle` | соответствующий `CK-E-*` |
| Clean room `codkit/**` | path-rule + локальный deny-профиль | доступ к reference не выдаётся |
| Периметр не действует в репозитории инструмента | `packages/codkit/claude/` вместо `.claude/` инструмента; `check.mjs` и `agentProtocol.test.ts` красные при hook/agents/skills в `.claude/` инструмента | check/test red |
| Навыки — из пакета, не из профиля | `check.mjs` требует ростер в пакете и запрещает `packages/codkit/claude/skills` | check red |

Hook выводит актуальный `hookSpecificOutput.permissionDecision:"deny"`. Пустой
успешный вывод означает только «hook не возражает»; обычные permissions всё ещё
действуют. Невалидный input, JSON `where`, task или путь закрывается отказом.
Task schema поддерживает `resolve`, `scout`, `verify`, `review`, `cause`.
`resolve` разрешает только `blockers[].paths` в дереве и два runtime-выхода.
Остальные задачи не редактируют дерево и разрешают Write ровно в проверенные
`outputs[]` внутри patchset. Любая новая пишущая процедура требует отдельного kind,
а не ослабления no-task default.

## Ограничение path rules

`paths` в `packages/codkit/claude/rules` (после установки — `.claude/rules` продукта)
сопоставляется с путями репозитория `patchset` при чтении файла. Внешнее дерево имеет динамический путь, поэтому glob для него не
коммитится. `ck-markers.md` загружается без path scope, а реальный периметр
принуждает hook через единственный resolver `codkit where --json`.

## Пять профилей

| Профиль | Мутации | Файл-результат |
| --- | --- | --- |
| `ck-upstream-scout` | только task output | `cycle/reports/<targetTag>-scout-<artifact>.md` |
| `ck-conflict-resolver` | только task paths | `.codkit/agent-task-result.json` |
| `ck-verifier` | только task output | `cycle/reports/<targetTag>-verify-<n>.md` |
| `ck-upgrade-reviewer` | только task output | `cycle/reports/<targetTag>-review.md` |
| `ck-cause-finder` | только task output | `.codkit/agent-cause-<artifact>.json` |

Допустимый параллелизм: verifier с reviewer; cause-finder по независимым
blocker; resolver не более одного на подсистему и никогда два на один файл.
Передача между ними — только названные файлы.

## Открытые границы

Граница автономии остаётся решением владельца. До решения действует
консервативный режим: машина может подтвердить уже машинно-clean результат;
содержательный resolve всегда требует human review, а target deletion,
семантический drift и новый слой/артефакт останавливаются. Это не ратифицирует
рекомендацию FEAT-004 как политику.

LLM endpoint/auth для air-gapped CI также остаётся owner-only решением. Без
утверждённого внутреннего endpoint агентских CI jobs нет; локальный human/CI
процесс codkit продолжает работать без LLM.

Shell hook разрешает только один статический command из read-only allowlist;
operators, redirection, variables, substitution и неизвестные executables
отклоняются. Это всё равно не ОС sandbox: hook startup/timeout и уязвимость самого
host требуют managed permissions, trusted-base и физической CI policy.
