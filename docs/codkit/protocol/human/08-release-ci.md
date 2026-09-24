# Релиз и CI

Версия выпуска patch set независима от upstream pin. Машинная координата пина
живёт в `codkit.json` и generated trailers. Имена release refs/tags задаёт
конкретный patch set; CI не выводит их из имени установки Codkit.

## Порог PR

1. CI предоставляет три попарно непересекающихся корня: immutable Codkit tool
   root с зависимостями, checkout patch set и полный fork tree.
2. Launcher вызывается как `codkit` из `PATH` или абсолютный
   `<codkit-tool-root>/bin/codkit`; patch set не поставляет executable или npm
   dependencies.
3. `codkit --json ci --profile verify --pin-guard-base <base-ref> --effective-diff <base-ref>`.
   Exit `0` — PR threshold green; exit `1` — guard/verify red; exit `2` — среда/supply kit.
4. CI публикует `.codkit/out/effective-diff.patch` и `.codkit/out/inventory-diff.md` как review artifacts.
5. Для main/cycle/release выполняется `codkit ci --profile build --pin-guard-base <base-ref>` → exit `0`.

Без `--pin-guard-base` шаг явно `skipped`; такой прогон не доказывает совместимость с target branch.
`ci` подразумевает `--ci` и не делает сетевых вызовов.

## Четыре способа предоставить дерево

| Способ | Рецепт | Ответственный |
| --- | --- | --- |
| Bind-mount постоянного checkout | mirror checkout на агенте; mount read-write в `/work/tree`; `CODKIT_FORK_DIR=/work/tree` | владелец CI-агента |
| CI cache/volume | key `<pin.sha>-<lock-hash>`; restore volume до job; writer только main | cache job main |
| Слой образа | образ содержит полный `.git` + objects/LFS выбранного mirror snapshot; job создаёт writable copy/overlay | владелец base image |
| Второй checkout | checkout fork/mirror с полной историей (`fetch-depth: 0`) в отдельный path | pipeline автора |

Контейнер получает read-only tool root, writable fork tree и patch-set runtime.
Patch-set source может быть read-only только с отдельным writable `.codkit`.
Для bind-mount с чужим uid `ci` сам создаёт локальный
`.codkit/gitconfig-ci` с `safe.directory`; согласование uid/gid и writable
mount остаётся контрактом runner.

Готовая обвязка: [обзор](../../ci-examples/README.md), [Dockerfile](../../ci-examples/Dockerfile),
[Jenkinsfile](../../ci-examples/Jenkinsfile), [GitHub Actions](../../ci-examples/github-actions.yml) и
[поставочный комплект](../../ci-examples/air-gapped-supply-kit.md). Натурная приёмка на чужом runner всё равно обязательна:
наличие примера не является green evidence среды.

## Поставочный комплект air-gapped

| Компонент | Доставка без внешней сети | Единственный писатель |
| --- | --- | --- |
| Fork Git + generated refs + LFS objects | внутреннее mirror/bundle | зеркальный бот; publish-бот только release refs |
| Codkit: CLI-пакет и пакеты типов | тарболы комплекта (`npm pack` каждого пакета workspace) и `kit-manifest.json` с версией и sha256 каждого | сборка релиза инструмента |
| npm-зависимости Codkit | внутренний registry либо заранее наполненный npm-кэш; пины — `npm-shrinkwrap.json` внутри тарболов | dependency image/cache job |
| Patch set | repository bundle/checkout с config, delta и refs; отдельный writable `.codkit` при read-only source | source mirror job |
| Tree npm dependencies (60+ каталогов) | внутренний registry/cache/mount | main cache job |
| Electron/Node artifacts | внутренние feeds или `.build/` cache | supply-kit job |
| Built-in extensions | `vsix` в metadata или `.build/builtInExtensions` | supply-kit job |
| Base images | внутренний image registry | image pipeline |
| Extension marketplace | внутренний gallery service через overlay | product platform |

Новый advisory цикла меняет supply-kit manifest/cache key. Внешняя сеть доступна только зеркальному и publish bot.

### Установка комплекта Codkit

1. Поставщик выполняет `npm run kit` в репозитории инструмента → каталог с
   тарболом на каждый пакет workspace и `kit-manifest.json`: `codkitSupplyKit: 1`,
   версия CLI-пакета и строка на каждый тарбол (`name`, `version`, `type` для
   пакета типа, `role`, `file`, `bytes`, `sha256`), плюс готовая строка
   `install.command`.
2. Приёмка на стороне потребителя: sha256 каждого файла совпадает со строкой
   манифеста. Расхождение — останов приёмки, а не переустановка.
3. В пустом каталоге выполняется ровно `install.command`:
   `npm install --offline ./codkit-<версия>.tgz ./codkit-type-<имя>-<версия>.tgz ...`.
   Комплект ставится целиком: установка одного CLI-тарбола уходит в реестр за
   `@codkit/type-api` и падает `npm error code ENOTCACHED`.
4. Сторонние зависимости `--offline` не скачивает: их даёт внутренний registry
   или заранее наполненный npm-кэш. Пустой кэш даёт тот же `ENOTCACHED` на
   первом стороннем пакете — это отсутствующая половина поставки, а не дефект
   комплекта.
5. Проверка установки: `node_modules/.bin/codkit types` → строка на каждый
   поставленный тип, exit `0`; `codkit --patches-dir <patchset> where` →
   `project type: <id>`, exit `0`. Что означают отказы этих команд — [15](15-project-types.md).

## Холодная сборка и зависимости

1. `codkit ci --profile build` при отсутствии tool dependencies либо npm
   receipts в корнях зависимостей, которые называет тип проекта (включая пустые
   mountpoint-каталоги) → exit `2`, `CK-E-DEPS-MISSING`; сообщение и деталь шага
   перечисляют именно недостающие `.package-lock.json`, а не первый корень
   списка; stale deps-hash не обходится. Tool dependencies восстанавливаются в tool root, не в patch set.
2. Runner восстанавливает cache по `<pin.sha> + lock hash` или выполняет внешний install из внутреннего registry.
3. Повтор команды → dependencies `ok`; lock change может один раз дать `refresh node_modules out of band` warning.
4. Compile запускает один pass по каналам, которые называет тип проекта, печатает полный pass
   и останавливает демоны в `finally`.
5. На Linux inotify warning ниже `262144` лечит владелец runner; рекомендовано `524288`.

## Публикация

Только publish-бот имеет `publishRemoteUrl` и push credentials. Человек не использует bot-флаг интерактивно.

1. Release-инженер выбирает immutable `<patchset-commit>` с green build и утверждённый `<semver>`.
2. Bot выполняет
   `codkit publish <patchset-commit> --profile build --release <semver> --yes-i-am-publish-bot`.
3. Сначала ожидается успешный read-only `ls-remote` gate; затем branch
   `codkit/release/<patchset12>+<pin.tag>` и immutable tag `patchset-v<semver>+<pin.tag>`, exit `0`.
4. Exit `1` — красная проверка либо tag уже указывает на другую вершину; tag не перемещается.
5. Exit `2` — сеть/права/config; до успешного gate refs/дерево не мутируют. Исправь `hint` и повтори тот же commit.
6. Повтор после частичного push идемпотентно доставляет только недостающие refs.

Generated commits несут `Codkit-Patchset-Commit` и `Codkit-Upstream-Pin`. Порядок: patch, own, overlays, resources.

## Упаковка

`ci --profile build` заканчивается компиляцией и собственными тестами; дистрибутив
делает `codkit package` над уже загруженным деревом. Порядок запуска — его, а не
набранный руками:

0. шаг `inputs`: печатаются входы, которые объявляют выбранные цели; офлайн-запуск без
   подготовленного входа останавливается здесь, до первой записи (см. ниже);
1. страж дрейфа как у `load`: неизвлечённая работа останавливает запуск
   (`CK-E-DIRTY-TREE`, exit `1`); флага `--discard` у команды нет;
2. overlay-цели материализуются в дерево — упакованный продукт читает сам файл-цель,
   а не dev-канал;
3. штампы, которые называет тип (`packageStamps`), выставляются в окружение команд;
   имя, которое уже несёт непустое значение в окружении запуска, **сохраняется** и
   печатается как `stamp <имя>=<значение> (from environment)`: штамп типа заполняет
   пустоту, а не спорит с оператором (в `--json` такие имена — `data.stampsFromEnvironment`);
4. выполняется package build типа (или команды выбранных целей — нативно либо в
   контейнере, см. ниже), затем шаг упаковки продукта, если patch set его объявил;
   вывод каждой команды печатается целиком;
5. печатаются существующие артефакты по выходам выбранных целей и `packageOutputs`
   типа; тип, чей упаковщик пишет рядом с деревом, честно не называет ни одного, и
   путь читается из вывода самого упаковщика;
6. откат следа упаковщика: пути, которые тип называет побочным эффектом своей
   упаковки (`packageScratch`), возвращаются к вершине загруженного дерева —
   только отслеживаемые и только изменившиеся; это делается и при `--keep-overlay`
   (флаг оставляет материализацию, а не след);
7. откат overlay: цели, которые материализовал сам запуск, возвращаются к пину,
   dev-канал переписывается. Оба отката выполняются и после падения сборки.

След упаковки — не работа человека: если запуск прервали и след остался,
`codkit status` называет эти пути (`data.upstream.packagingScratch`) и советует
`codkit load --fresh --discard`, а не `codkit save`, который внёс бы побочный эффект
сборки в дельту.

Флаги: `--keep-overlay` (оставить цели материализованными для ручной проверки пакета;
вернуть дерево — `codkit load --fresh`), `--skip-type-build` (только шаг продукта, когда
приложение уже собрано вотчерами), `--timeout <sec>` (ограничение одной команды),
`--json`. Красная команда упаковки — exit `1`, `CK-E-PACKAGE-FAILED` с кодом возврата и
хвостом вывода; команда, которую не удалось запустить, — exit `2`.

### Цели, маршруты и сеть

Тип с каталогом целей (`codkit package <цель|linux|windows|macos|all>`) отвечает для
каждой цели, где она собирается на этом хосте: **натив** — команды в дереве;
**контейнер** — те же команды в контейнере рецепта типа поверх дерева, смонтированного
только для чтения, с Linux-зависимостями в собственном томе контейнера; артефакты
копируются обратно в дерево. Цель без маршрута отказывает с причиной, которую даёт
тип (`CK-E-CONFIG`). У `vscode` цели `linux-x64-tar`, `linux-x64-deb` и `linux-x64-rpm`
собираются нативно на Linux и в контейнере на Windows и macOS, а сырой `linux-x64` —
только на Linux: собранный на Windows бандл несёт виндовые нативные модули.

Контейнеру нужен Docker. Образ `<префикс>-<тип>-<платформа>-<арх>:<хэш рецепта>`
строится при первом запуске; где Docker Hub недоступен, его строят вручную под тем
же именем — команду печатает отказ. `--container-prefix` меняет первое слово имён
образа, тома и контейнера.

Что скачивает сборка, тип объявляет входами, и шаг `inputs` каждого запуска их
печатает. `--inputs <dir>` даёт заранее подготовленные копии; глобальный `--ci`
делает запуск офлайн: недостающий вход, как и отсутствующий образ, —
`CK-E-NET-FORBIDDEN` до первой записи, контейнер идёт с `--network none`, а `curl`
отвечает только подготовленными адресами.

## Коммит сборки

Штамп коммита в пакете — ответ типа, а не ручная переменная: `packageStamps` называет
имена, `codkit package` заполняет их вершиной дерева, пином или собственным словом типа. Это важно потому, что
управляемое дерево — linked worktree, его `.git` — файл, и упаковщик, читающий
`.git/HEAD` как каталог, оставит пакет без коммита (PROP-010 §1). Проверка — поле
коммита в манифесте собранного пакета. Наборы слоя `browser` собственного кода
`ci --profile build` не запускает: их гонит раннер апстрима отдельным шагом релиза
(без дисплея — под `xvfb-run`).

Канал качества у типа `vscode` — не пин, а ответ продукта: `typeConfig.quality`
(`stable` | `insider` | `exploration`). Поле не объявлено — штамп `VSCODE_QUALITY`
остаётся тегом пина, то есть строкой версии, и упаковщик апстрима читает её как
«не выпущенный канал». Разовое исключение делается окружением запуска (пункт 3 выше),
постоянный ответ — полем в `codkit.json`.

Упаковка предпочтительно идёт в одноразовом клоне, как `publish`, чтобы dev-дерево
не получало артефактов сборки; уже полученный артефакт снимается
`codkit load --fresh --discard` ([ежедневная работа](02-daily.md)).

## Release checklist

- [ ] `git status --short` в patchset пуст.
- [ ] `ci --profile build --pin-guard-base <main-ref>` → exit `0`.
- [ ] Cycle terminal receipt/status валиден либо релиз осознанно идёт с прежнего зелёного пина.
- [ ] Supply-kit manifest соответствует advisory и cache key.
- [ ] sha256 каждого тарбола комплекта совпадает с `kit-manifest.json`, и `codkit types` из установленного комплекта → exit `0`.
- [ ] Publish bot output содержит immutable patchset SHA, pin SHA, branch и tag.
- [ ] Повтор publish того же commit/tag → exit `0`, та же вершина.

## Не закрытые проверки среды

Каждый потребитель отдельно доказывает physical `--network none`, read-only
mount/runtime, UID/safe.directory, native macOS/Windows determinism, clean-pin
Electron runner baseline и packaging-airgap. Evidence и risk register живут в
репозитории patch set; CI не превращает отсутствие job в зелёный статус.

Tool-level stable IDs и условия переоткрытия перечислены в
[standalone risk register](../../proofs/RISK-REGISTER.md); принятая Linux
container matrix — в [DOCKER-MATRIX](../../proofs/DOCKER-MATRIX.md). Собственный
npm pack Codkit не заменяет app-bundle/signing proof downstream-форка.
