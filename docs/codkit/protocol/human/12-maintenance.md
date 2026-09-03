# Сопровождение протокола

Протокол версионируется в patchset. Владелец — мейнтейнер протокола; урок каждого cycle исправляется в том же PR,
что и retrospective follow-up. Словари не копируются: источник — [conventions.json](../../../../codkit/config/conventions.json),
а [03](03-interventions.md) описывает только выбор/действие.

Agent protocol ссылается на human protocol и conventions; права/границы агента определяет FEAT-004.
Дублирование layer/id/owner-словарей в agent rules является дефектом.

## Процедура изменения

1. В issue укажи наблюдаемый trigger: команда, exit, вывод, документ/строка и роль.
2. Измени минимальный human document и используемый шаблон; новый термин сначала меняется в `conventions.json` владельцем механизма.
3. Для новой нормы заполни строку «норма → команда/hook/CI → ветка отказа» в [00](00-index.md).
   Механизма нет → создай mechanism issue и явно пометь gap; не описывай защиту как существующую.
4. `node docs/codkit/protocol/human/check.mjs` → `human protocol check: ok`, exit `0`.
5. `codkit verify` → exit `0`, если PR затрагивает conventions/delta; docs-only PR фиксирует `not applicable` с причиной.
6. Независимый участник выполняет изменённую процедуру на полигоне; issue содержит команды, exits, время и terminal outcome.
7. Reviewer отвечает «да» на self-check: новичок может завершить процедуру без непокрытого выбора.

## Пересмотр на retrospective

- Каждый урок привязан к команде/output или terminal decision.
- Любой новый ручной обход превращён в механизм issue с owner/SLA.
- Ссылки, имена команд и line caps зелёные.
- Изменение conventions потребовало правки не более одного объясняющего human document; ссылки на source остаются стабильными.
- Field-test gates 01/02/05/08 имеют evidence либо явно остаются open.

## Жёсткие пределы строк

`01 <=150`, `02 <=250`, `03 <=350`, `04 <=200`, `05 <=500`, `06 <=120`, `07 <=200`,
`08 <=300`, `09 <=250`, `10 <=200`, `11 <=150`, `12 <=100`. Проверяет `check.mjs`.

## Устаревание

1. Удаляемая команда сначала исчезает из CLI/spec и получает replacement/migration.
2. Мейнтейнер обновляет ровно документы, найденные `rg -n '<old-command>' docs/codkit/protocol/human`.
3. Link/line checker и field test replacement-команды должны быть green до merge.
4. Исторические cycle logs/templates не переписываются; меняется только будущая процедура.
