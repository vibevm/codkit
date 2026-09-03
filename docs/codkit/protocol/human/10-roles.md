# Роли, ответственность и SLA

Роль назначается на конкретный цикл/артефакт. Один человек может совмещать роли, но ответственность в issue остаётся явной.

| Роль | Входы | Обязанности и права | Выход | SLA |
| --- | --- | --- | --- | --- |
| DRI / merge captain | target tag, issue, forecast | создаёт cycle branch; запускает `cycle`; останавливает/возобновляет; назначает owners; принимает batching <=2; открывает и merge-ит no-ff PR | terminal receipt, green cycle PR, retrospective | реакция на stop в тот же рабочий день |
| Владелец подсистемы | запись `delta/owners.json`, адресный forecast/red item | анализирует cause; выбирает адаптацию/удаление/design stop; даёт предметный test | green artifact resolution + journal proof | ответ в течение 1 рабочего дня |
| Ревьюер вмешательств | effective diff, inventory diff, layer decision | утверждает спуск по иерархии слоёв, rewrite-rule, metadata/test evidence; проверяет agent resolution как обычное решение | approve/request changes с наблюдаемым критерием | 1 рабочий день |
| Релиз-инженер | immutable patchset commit, green build, supply kit | управляет release gate; запускает publish-бот; проверяет refs/tag/airgap matrix | immutable branch/tag и release evidence | в согласованном release window |
| Наблюдатель апстрима | iteration plans, release notes, forecast artifact | публикует weekly summary; маршрутизирует красное owner; запускает раннюю адаптацию | weekly issue + owner acknowledgements | nightly report к началу рабочего дня |
| Мейнтейнер протокола | retrospective, defect issue, conventions diff | правит один источник; запускает docs checker; координирует field tests | protocol PR + green checks | в том же PR, где найден урок цикла |

Ротация DRI организационно не решена. Рабочая рекомендация до решения владельца: один DRI на цикл,
по кругу команды апгрейда; следующий DRI ассистирует предыдущему один цикл. Это recommendation, не автоматический guard.

## Карта артефактов

| Артефакт/действие | Accountable | Responsible | Reviewer/consumer |
| --- | --- | --- | --- |
| Feature PR | автор | автор | reviewer вмешательств при upstream layer |
| Effective/inventory diff | автор PR | CI | reviewer |
| Красный forecast | владелец подсистемы | наблюдатель маршрутизирует | DRI |
| Cycle state/branch | DRI | codkit | merge captain |
| Human JSONL record | владелец решения | владелец/DRI | reviewer вмешательств |
| Agent JSONL record | владелец подсистемы | agent | human reviewer; права агента задаёт FEAT-004 |
| Dependency advisory | DRI | codkit + владелец runner | релиз-инженер |
| Terminal receipt/CSV | DRI | codkit | merge captain, metrics reader |
| Release ref/tag | релиз-инженер | publish-бот | DRI/product owner |
| Protocol PR | мейнтейнер протокола | автор урока + мейнтейнер | DRI |

Действия без строки в этой карте не начинаются: DRI добавляет роль в issue/протокол до мутации.

## Эскалация SLA

1. Forecast/red item создаёт адресное уведомление owner из `delta/owners.json` с exact id/cause/output.
2. Через один рабочий день без terminal response наблюдатель эскалирует DRI; cycle остаётся красным.
3. DRI может назначить другого исполнителя, оставить старый pin или оформить design stop; не может объявить blocker green.
4. Release без решения идёт только с последнего green pin и фиксируется как такой в release evidence.

## Репетиция до первого настоящего цикла

1. Создай disposable branch от main и отдельное дерево; target — уже доступный следующий commit/tag полигона.
2. Назначь роли в [cycle issue](templates/cycle-issue.md), включая дублёра DRI.
3. Пройди [05](05-upgrade-cycle.md) до terminal receipt либо известного stop; каждый участник выполняет свою роль, а не диктует команды другому.
4. `codkit cycle restart --yes` допустим только в disposable branch после проверки branch/status; exit `0` возвращает rehearsal.
5. Заполни [retrospective](templates/retrospective.md); отсутствие владельца/выхода у действия — дефект карты ролей.
