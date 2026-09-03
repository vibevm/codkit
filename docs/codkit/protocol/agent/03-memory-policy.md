# Политика памяти агентов

Память project-scope — предложение команде, а не новый источник норм. Агент
создаёт изменение в ветке PR; человек ревьюит его как код. До явного принятия
запись не влияет на resolve.

## Допустимая запись

Один наблюдаемый повторяемый паттерн подсистемы: дата, source/target pin,
artifact ids, симптом, проверенная процедура и trigger устаревания. Ссылки ведут
на journal/report/spec или код; вывод без evidence не сохраняется.

## Запрещено

- пути конкретной машины и имена локальных checkout;
- secrets, credentials, endpoint values и содержимое secret-файлов;
- содержимое reference/old repositories или производные заимствования;
- новая convention, autonomy boundary или решение, противоречащее spec/human
  protocol;
- transcript, скрытый prompt, model rationale или непроверенный «обычно работает».

Неопределённость остаётся в result/report как stop и не превращается в memory.
Память не разрешает commit, network, новый слой, удаление intervention или
обход `exitCode:3`.

## Ревью и срок

Каждая запись проходит PR-review владельца подсистемы. На каждой ретроспективе
DRI проверяет pin/links/trigger: актуальное сохраняется, superseded получает
ссылку на replacement, недоказанное удаляется обычным reviewed commit.
Объём/TTL и обязательность review остаются owner-only вопросом FEAT-004; default
до решения — review каждой записи и пересмотр после трёх циклов.
