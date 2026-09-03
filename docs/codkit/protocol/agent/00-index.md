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

Исходники пяти профилей находятся в [`docs/codkit/agents`](../../agents/).
`.claude/agents` и управляемое ядро корневых инструкций — синхронизированные
копии. Обновление: `node tools/sync-codkit-agents.mjs`; проверка:
`node tools/sync-codkit-agents.mjs --check`.

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
| Нет перенаправления корней агентом | hook запрещает `--patches-dir` и `--fork-dir`; агент принимает schema-2 roots | попытка выбрать другой root → deny до запуска |
| Только периметр blocker | realpath/symlink-проверка против `blockers[].paths` | путь вне списка/root → deny |
| Нет прямой компиляции | deny + shell policy | `tsc`/compile → deny; использовать `build` |
| Нет сети/install | deny + shell policy | curl/wget/fetch/pull/install → deny |
| Design stop | JSON `exitCode:3`, ограниченные tools, result file | `status: stopped`, решение человека |
| Маркеры/дельта/state | scoped rules + `save`/`verify`/`cycle` | соответствующий `CK-E-*` |
| Clean room `codkit/**` | path-rule + локальный deny-профиль | доступ к reference не выдаётся |

Hook выводит актуальный `hookSpecificOutput.permissionDecision:"deny"`. Пустой
успешный вывод означает только «hook не возражает»; обычные permissions всё ещё
действуют. Невалидный input, JSON `where`, task или путь закрывается отказом.
Task schema поддерживает `resolve`, `scout`, `verify`, `review`, `cause`.
`resolve` разрешает только `blockers[].paths` в дереве и два runtime-выхода.
Остальные задачи не редактируют дерево и разрешают Write ровно в проверенные
`outputs[]` внутри patchset. Любая новая пишущая процедура требует отдельного kind,
а не ослабления no-task default.

## Ограничение path rules

`paths` в `.claude/rules` сопоставляется с путями репозитория `patchset` при чтении
файла. Внешнее дерево имеет динамический путь, поэтому glob для него не
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
