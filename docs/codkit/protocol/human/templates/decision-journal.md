# Решение `<короткое имя>`

## Контекст

- Cycle / artifact / id: `<tag> / <path> / <id>`
- Outcome: `<conflict|target-deleted|rule-broken|contract-failed|design-stop>`
- Immutable cause: `<full-sha>`; `approx: <true|false>`
- Owner / reviewer / DRI: `<names>`
- Deadline: `<ISO, не более 1 рабочего дня для cycle blocker>`
- Наблюдаемый stop: `<command, exit 3/1, exact output>`

## Варианты

| Вариант | Effective diff | Сохраняемый upstream contract | Test-критерий | Стоимость/риск |
| --- | --- | --- | --- | --- |
| A | | | | |
| B | | | | |
| Старый pin | none | current production | current green build | задержка bump |

## Решение

- Выбран вариант: `<A/B/old pin>`
- Причина: `<наблюдаемые факты>`
- Изменённые paths: `<exact list>`
- Проверки: `<exact command> => <exit>`
- Reviewer approval: `<link/name/time>`
- Follow-up/upstream seam: `<issue|none>`

## Terminal cycle JSONL record

Добавляется одной compact JSON строкой в `cycle/log/<tag>.jsonl`; ключи и порядок сохраняются:

```json
{"codkitCycleJournal":1,"ts":"<ISO-offset>","artifact":"<repo-relative-artifact>","outcome":"<outcome>","resolution":"<выбранное решение и сохранённый contract>","cause":{"sha":"<full-sha>","approx":<true|false>},"by":"human","verified":[{"command":"<exact command>","exitCode":0}]}
```

Проверка: `codkit cycle continue`. Exit `0` и отдельный `fix(cycle): resolve <id>` — terminal success;
`CK-E-LOG-INCOMPLETE`/journal mismatch/green proof missing возвращает к записи и verification.
