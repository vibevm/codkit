# Наблюдение за апстримом

Наблюдатель ежедневно читает iteration plans/release notes VS Code и машинный прогноз. Сеть/fetch выполняет зеркальный бот;
`codkit forecast` работает только с уже доставленным локальным ref и ничего не меняет.

## Ночной прогноз

1. Зеркальный бот обновляет точный `<upstream-ref>` во внутреннем mirror; его job фиксирует полный SHA.
2. CI выполняет `codkit --ci forecast --ref <upstream-ref>`.
   Exit `0` — все артефакты clean; exit `1` — информационная краснота с id, owner, outcome, cause;
   exit `2` — ref/окружение, выполняется точный `hint` и job повторяется.
3. Job сохраняет stdout/JSON как артефакт и маршрутизирует каждую красную запись контакту из `delta/owners.json`.
4. Владелец отвечает в течение одного рабочего дня: `адаптация начата`, `ложный сигнал с доказательством` или `design stop`.
5. Наблюдатель помещает в weekly issue ссылку на отчёт, release-note summary и ответы владельцев.

Codkit группирует данные по owner, но репозиторий пока не содержит готового notification job. Пока CI-маршрутизация
не настроена, это открытый дефект механизации: nightly job не считается введённым в эксплуатацию.

## Дерево действий по красной записи

```text
outcome = conflict / target-deleted / rule-broken / contract-failed?
├─ да → владелец создаёт draft adaptation branch сейчас, не ждёт release tag
└─ нет: merged / shifted / target-renamed?
   ├─ да → reviewer проверяет effective diff; adaptation branch при семантическом изменении
   └─ clean → запись не красная; проверить, что job анализировал ожидаемый full SHA
```

Terminal outcomes: green adaptation PR; design issue с DRI/SLA; доказанный false positive с командой и exit.

## Процедура ранней адаптации

1. В issue зафиксируй forecast SHA, artifact id, owner, cause и outcome.
2. Создай draft-ветку patchset от main; не меняй production pin.
3. Проверяй изменения на отдельном дереве через `codkit forecast --ref <same-full-ref>`.
4. Exit `0` после адаптации + `codkit verify` exit `0` → draft готов к будущему циклу.
5. При появлении tag DRI переносит решение каноническим [циклом](05-upgrade-cycle.md); forecast не заменяет cycle journal.

## Апстримить швы, не фичи

Кандидат удовлетворяет хотя бы одному проверяемому условию:

- patch пережил не меньше двух ручных адаптаций, что видно по cycle commits/JSONL;
- минимальный extension point навсегда удаляет patch, не неся нашу функциональность;
- hook полезен другим downstream-потребителям и не раскрывает внутренний продукт.

1. `codkit inventory --diff <two-cycles-ago-ref> --md` → exit `0`; найди повторно меняемый patch/rule.
2. Владелец формулирует минимальный seam API и contract-test без patchset feature.
3. PR в `microsoft/vscode` содержит только seam, мотивацию расширяемости и upstream-style tests.
4. До принятия upstream PR artifact остаётся в дельте и проходит обычный cycle.
5. После попадания seam в новый пин удали artifact отдельным patchset commit, `inventory --diff` и `verify` → exit `0`.

## Кадэнс

- Forecast — каждую ночь.
- Release notes/iteration plan summary — раз в неделю до решения о target tag.
- Rule+patch review — рекомендуемо каждый четвёртый цикл; окончательный период назначается после двух baseline-циклов.
- Любой conflict forecast запускает адаптацию в тот же рабочий день, не на следующей ретроспективе.
