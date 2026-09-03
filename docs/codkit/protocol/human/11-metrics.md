# Метрики

Канонический ряд — `<patchesDir>/docs/codkit/metrics/inventory-history.csv`.
Строку пишет terminal finalization; ручная правка CSV не является частью цикла.
Базовая линия — первый accepted cycle конкретного patch set; сравниваются его
тренды, а не чужие абсолюты. Установка Codkit не поставляет готовую CSV или
baseline форка.

## Что читать

| Показатель | Поля CSV | Интерпретация |
| --- | --- | --- |
| Вмешательства по слоям | `by_layer_json`, `artifacts`, `inventory_entries` | размер/структура дельты |
| Вмешательства по подсистемам | `by_subsystem_json` | куда направить de-intrusion/reviewer capacity |
| Дорогие слои | `patch_and_rule`, `hunks`, `patch_lines` | целевой тренд rule+patch — вниз |
| Время цикла | `duration_seconds` | дели на 3600; сравнивай одинаковый класс target |
| Исходы | `clean..contract_failed`, `resolved`, `renames` | автоматичность и тип upstream drift |
| Доля agent resolutions | `agent_entries / journal_entries` | только с human review; не цель сама по себе |
| Contract coverage | `coverage_covered`, `coverage_required_covered/total` | required должен оставаться 100% |
| Полнота доказательства | `journal_entries`, `inventory_entries` | terminal receipt связывает ряд с журналом/inventory |

Latency `VS Code release -> наш release` в текущей CSV не хранится: `pin.date` — не timestamp upstream release,
а publish timestamp отсутствует. До добавления поля/CI-артефакта это открытый metrics gap; ретроспектива может показать
вычисление из immutable release refs, но не выдаёт его за канонический CSV-ряд.

## Процедура чтения после цикла

1. `tail -n 2 <patchesDir>/docs/codkit/metrics/inventory-history.csv` → две последние canonical строки, exit `0`.
2. `codkit inventory --diff <previous-cycle-ref> --md` → exit `0`; открой `.codkit/out/inventory-diff.md`.
3. Для каждого показателя запиши `направление`, `объяснение по commit/journal`, `действие/owner` в [ретроспективе](templates/retrospective.md).
4. Рост без объясняющего artifact/commit → metrics defect; DRI сверяет target/tag и terminal receipt, не исправляет CSV вручную.
5. Required coverage `< total` → release blocker: `verify`/CI должны быть красными; расхождение green CI и CSV эскалируется как bug.

## Baseline

Первый успешно завершённый цикл создаёт одну точку конкретного patch set. По
одной точке нельзя назначать числовой budget; данные другого форка не являются
заменой.

## Alerts и решения

1. После двух циклов owners + DRI утверждают subsystem budgets; до этого поле в retrospective = `baseline collecting`.
2. Рекомендуемый первый alert: `patch_and_rule` растёт два цикла подряд; терминальное действие — de-intrusion issue с owner.
3. Любое падение `coverage_required_covered/total` ниже 100% — немедленный release blocker.
4. Любой cycle duration/latency spike объясняется конкретным outcome/advisory/runner incident, а не оценочным текстом.
5. Раз в цикл метрики читает DRI на retrospective; раз в четыре цикла — reviewer/owners проводят de-intrusion review до изменения периода владельцем.

Dashboard отложен. До него source — CSV + inventory diff + таблица retrospective; копия чисел без ссылок на эти артефакты неканонична.
