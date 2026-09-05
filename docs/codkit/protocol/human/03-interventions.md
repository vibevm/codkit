# Вмешательства в апстрим

Словари `layer`, `type`, `category`, id и запретных сервисов определяет только
[conventions.json](../../../../codkit/config/conventions.json). Ниже — выбор, authoring и ревью.

## Дерево решений слоя

Иди сверху вниз; первый ответ «да» — терминальный лист.

```text
Можно выразить своим кодом в пути из own manifest?
├─ да → own
└─ нет: нужно заменить реализацию сервиса?
   ├─ да, id не в forbiddenServiceIds → service-override
   └─ нет/запрещён: нужен только import собственного root-модуля?
      ├─ да → entry-module
      └─ нет: нужно скрыть апстримное поведение без удаления?
         ├─ да → own + category hide + guard-test
         └─ нет: цель — JSON без комментариев?
            ├─ да → config-overlay
            └─ нет: цель бинарная/ресурсная?
               ├─ да → resource-file
               └─ нет: правка массовая и однотипная?
                  ├─ да, команда апгрейда согласовала → rewrite-rule
                  └─ нет: один узкий шов в апстримном тексте → patch с marker
```

Если сервис есть в `forbiddenServiceIds`, лист `service-override` закрыт: перепроектируй own-композицию
или эскалируй дизайн-решение владельцу; `verify` вернёт `CK-E-FORBIDDEN-SERVICE`.

## Терминальный лист own

1. Создай/измени файл в own-пути, объявленном patch-set manifest.
2. `codkit save <path>` → exit `0`, зеркало изменено под `delta/own/**`.
3. Обнови `delta/own/patchset.delta.json` в patchset, если это новая unit/service запись.
4. `codkit load` → exit `0`; затем `codkit verify` → exit `0`.

## Терминальный лист service-override

1. Взглядом сверь service id с `forbiddenServiceIds` в `codkit/config/conventions.json`; совпадение → терминальный исход «дизайн-эскалация».
2. Реализацию и регистрацию положи в own; DI получай через accessor, не новым параметром апстримного конструктора.
3. Добавь `serviceOverrides` metadata и contract-test в `delta/own/patchset.delta.json`.
4. `codkit load` → exit `0`; затем `codkit verify` → exit `0`.
   `FORBIDDEN-SERVICE`/`GUARD-MISSING` возвращает к шагам 1–3.

## Терминальный лист entry-module

1. Подготовь собственный root-модуль и тест в own; в апстриме требуется ровно одна import/registration точка.
2. `codkit marker new <entry-file> --id CK-<subsystem>-<NNN> --type hook --owner <owner> --reason "load patchset entry module" --layer entry-module` → exit `0`.
3. Между маркерами добавь только import/registration; логика остаётся в own.
4. `codkit save <entry-file>` → exit `0`; затем `codkit verify` → exit `0`.

## Терминальный лист hide

1. Вырази переворот/регистрацию в own, `category: hide` и укажи `contractTests`.
2. Guard-test проверяет наблюдаемое отсутствие/дефолт, а не внутреннюю реализацию.
3. `codkit load` → exit `0`; затем `codkit verify` → exit `0`.
   `CK-E-GUARD-MISSING` возвращает к шагу 2.

## Терминальный лист config-overlay

1. Авторуй `delta/overlays/<name>.overlay.json` в patchset: точный target, `expectUpstream`, операции и общий metadata-словарь.
2. `codkit overlay check <target>` → exit `0`; `CK-E-OVERLAY-DRIFT`, exit `1` требует обновить ожидание по пину и смысл операции.
3. `codkit load` → exit `0`; затем `codkit verify` → exit `0`.

`overlay apply` предназначен для CI/publish. В dev-дереве он создаёт ожиданный drift; возврат target — `codkit load --fresh` (не прямой `git checkout`).

## Терминальный лист resource-file

1. Положи байты под `delta/resources/files/**`; добавь запись в `delta/resources/map.json` и guard-test.
2. Не пытайся извлечь такую цель через `save`: `save` работает только с own/patch и вернёт `CK-E-HEADER-MISSING`.
3. `codkit load` → exit `0`, ресурс материализован.
4. `codkit verify` → exit `0`; `CK-E-GUARD-MISSING` возвращает к шагу 1.

## Терминальный лист rewrite-rule

1. Получи явное согласование DRI в PR/issue; массовость должна быть проверяема `expectedMatches`.
2. Авторуй `delta/rules/*.ckrule.json` в patchset и contract/guard-test, если поведение не ловит компилятор.
3. `codkit load` → exit `0`; затем `codkit verify` → exit `0`.
4. `CK-E-RULE-DRIFT`, exit `1` → правило не расширяется вслепую: владелец сравнивает все матчи и решает «сузить / новый rule / patch».

## Терминальный лист patch

1. Выполни:
   `codkit marker new <file> --id CK-<subsystem>-<NNN> --type <type> --owner <owner> --reason "<reason>" --category <category>`.
   Exit `0` создаёт пустой блок и pending header; exit `1` на занятом id/owner/target требует выбрать валидные данные; exit `2` означает неверный CLI/config.
2. Помести узкий hook между ASCII-маркерами, например:

   ```ts
   // codkit:begin CK-workbench-123
   registerpatchSetContribution(accessor);
   // codkit:end CK-workbench-123
   ```

3. Крючок ставь в `create*`/точке композиции, не раздувай конструктор; зависимости получай через accessor; бизнес-логика остаётся в own.
4. Апстримную строку, которую нужно выключить, комментируй внутри блока вместе с причиной; не удаляй её.
5. `codkit save <file>` → exit `0`, pending header перенесён в новый `.ckpatch` и удалён.
   `CK-E-HEADER-MISSING` → снова выполни шаг 1; `HUNK-OUTSIDE-MARKER`/`DELETES-UPSTREAM-LINE` → исправь границы.
6. `codkit verify` → exit `0`.

## Чек-лист автора PR

- [ ] Лист дерева решений указан в PR; ответ подтверждён путями effective diff.
- [ ] `codkit verify` → exit `0`.
- [ ] `codkit inventory --diff <base-ref> --md` → exit `0`; added/changed id ожидаемы.
- [ ] `codkit ci --profile verify --effective-diff <base-ref> --pin-guard-base <base-ref>` → exit `0`.
- [ ] Для `hide`, overlay, resource и непрозрачного поведения указан зелёный contract-test id.

## Чек-лист ревьюера

1. Открой `.codkit/out/effective-diff.patch`: поведение минимально и совпадает с заявленным листом дерева.
2. Открой `.codkit/out/inventory-diff.md`: id уникален, owner существует, subsystem и metadata соответствуют цели.
3. Сверь `cause`, `pin`, `contractTests` в inventory; canonical JSON/LF уже проверяет `verify`, ручная переформатировка не допускается.
4. Для patch проверь только смысловой effective diff: hook в точке композиции, логика в own, апстримные строки сохранены.
5. Для rule прочитай полный список матчей; для overlay — target operations; для resource/hide — результат guard-test.
6. Если верхний слой возможен, отклони нижний слой с конкретным терминальным листом. Согласовать `rewrite-rule` и спуск в patch может только reviewer вмешательств.
7. Все пункты зелёные → approve; любой «нет» → request changes с наблюдаемым файлом/выводом.

Сырые patch-файлы нужны для диагностики формата, но не заменяют effective diff.

## Де-интрузионная итерация

1. `codkit inventory --md` → exit `0`; отфильтруй `rewrite-rule` и `patch` своей подсистемы.
2. Для каждой записи выбери лист: «поднять в own/override/overlay/resource», «апстримить шов», «оставить с причиной».
3. Порог и период пока организационно открыты; до двух baseline-циклов числовой бюджет не выдумывается.
4. После двух циклов владельцы + DRI фиксируют бюджет; рекомендуемый alert — рост `rule+patch` два цикла подряд.
