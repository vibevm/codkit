# Ретроспектива cycle `<target-tag>`

## Evidence

- Cycle issue / final commit / terminal receipt: `<links/shas>`
- JSONL / Markdown / CSV row: `<paths/hashes>`
- Build/CI artifacts: `<links>`
- Start/end/duration: `<ISO> / <ISO> / <seconds>`

## Метрики против предыдущего цикла

| Метрика | Было | Стало | Направление | Объясняющий commit/journal | Действие/owner |
| --- | ---: | ---: | --- | --- | --- |
| inventory entries | | | | | |
| patch + rule | | | | | |
| hunks / patch lines | | | | | |
| duration seconds | | | | | |
| conflicts / resolved | | | | | |
| agent entries / journal entries | | | | | |
| required coverage | | | | | |
| release latency | `metrics gap` | `metrics gap` | n/a | `<immutable refs if calculated>` | `<mechanism issue>` |

## Outcomes

| Outcome | Count | Что сработало | Что потребовало решения |
| --- | ---: | --- | --- |
| clean/shifted/merged | | | |
| conflict | | | |
| target-deleted/renamed | | | |
| rule-broken/contract-failed | | | |

## Проверяемые выводы

- Самый дорогой blocker: `<artifact/cause/duration>`.
- Повторная адаптация patch/rule: `<id + cycle commits|none>`.
- Кандидат на более высокий layer/upstream seam: `<id/action>`.
- Dependency/inotify/runner урок: `<command/output or none>`.
- Непокрытое решение в human protocol: `<document/step or none>`.
- Field-test 01/02/05/08 evidence: `<links/open gate>`.

## Решения

| Решение | Наблюдаемый критерий | Owner | SLA | PR/issue |
| --- | --- | --- | --- | --- |
| | | | | |

Если собрано меньше двух baseline-циклов, budgets = `baseline collecting`.
После двух: subsystem budget `<value>`; alert rule `patch+rule growth two cycles` принят/заменён решением `<link>`.

## Protocol change

- [ ] Урок исправлен в том же PR: `<file/link>`.
- [ ] Новая норма имеет command/hook/CI или mechanism issue: `<mechanism>`.
- [ ] `node docs/codkit/protocol/human/check.mjs` → exit `0`.
- [ ] Независимый участник повторил изменённую процедуру: `<evidence/time>`.
