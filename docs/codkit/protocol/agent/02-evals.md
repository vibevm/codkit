# Evals агентского протокола

Evals проверяют поведение и артефакты, а не совпадение текста модели. Первый
контур — обязательные локальные structural tests; headless model harness
включается после стабилизации skills.

## Локальный J1

Проверяемая версия на момент M3: Claude Code `2.1.252`.

| Вопрос | Локальная проверка | Статус |
| --- | --- | --- |
| `paths` rules | frontmatter parser проверяет массив glob; fixture проверяет ровно `delta/**`, `codkit/**`, `cycle/**` и отсутствие scope у markers | structural green; model-loading smoke остаётся ручным |
| policy JSON | `JSON.parse` шаблона `codkit/claude/settings.json`, deny-only permissions, current PreToolUse exec form `command+args` с placeholder `<codkit-tool-root>`; отсутствие hook/agents/skills в `.claude/` инструмента | structural green; загрузка установленного профиля в репозитории продукта остаётся ручной проверкой |
| hook input/output | Bash wrapper и Node core получают documented stdin; allow даёт пустой stdout, deny — current structured JSON | green на Linux |
| task perimeter | no-task/out-of-list/malformed task/symlink escape red; resolve path и exact report outputs green | green на fixture |
| shell perimeter | redirection/substitution/dynamic/unknown commands red; one static read-only command green | green на fixture |
| source/copies | пять byte-identical copies и одинаковый managed core | green |

Запуск:

```text
node tools/sync-codkit-agents.mjs --check
node docs/codkit/protocol/agent/check.mjs
npx vitest run --root codkit test/unit/agentProtocol.test.ts
```

Native Windows wrapper/PowerShell execution, permissions deny через
`--add-dir`, загрузка инструкций из added directory и реальная Claude session не
выдаются за green в Linux fixture. Они требуют отдельной машины/изолированной
session; до этого settings использует cross-platform Node exec-form, а `.ps1`
сохраняется как проверяемый эквивалент.

Командный hook имеет ограничение платформы: если сам executable не стартовал
или достиг внешнего timeout, Claude Code продолжает обычный permission flow.
Поэтому local green доказывает fail-closed для доставленного input/invalid
resolver/task, но не заменяет managed policy/OS sandbox в hostile CI.

## Regression harness после стабилизации skills

1. Создать fake upstream/patchset/tree по fixture-контракту codkit и локальный bare
   hosting remote; никакой real user state.
2. Передать один task-файл и запустить headless skill с фиксированным budget.
3. Проверить схемы task result, journal/report, точные paths и exits.
4. Сравнить Git refs/index/worktree до/после: запрещённая история дерева/patchset
   не менялась; изменения только в заявленном периметре.
5. Повторить N=5 и принять минимум 4 структурно корректных результата. Текст и
   стиль не входят в pass/fail.

Harness запускается при изменении `codkit/claude/skills/**` и по расписанию. До его
введения каждая ошибка/откат первого реального цикла добавляет regression
fixture и правит соответствующий skill в том же PR.

## J2 и CI

J2 пока не выполнен: CI auth/headless, trusted-base-only instructions, write-role
trigger, bot allowlist и внутренний model endpoint зависят от целевой CI-системы.
Архитектурный минимум будущей job: executable settings только из trusted base;
PR bytes читаются как data; trigger только write-role/allowlisted bot;
нет config/credentials/endpoint — job не запускается. Отсутствующая job не
считается green.

Ретроспектива собирает три метрики: доля конфликтов без человека, доля agent
resolutions, отклонённых reviewer, и время resolve. Значения становятся
каноничными только через принятую ретроспективу/ряд, не из model telemetry.
