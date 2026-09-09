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
   receipts в tree `node_modules`/`build/node_modules` (включая пустые
   mountpoint-каталоги) → exit `2`, `CK-E-DEPS-MISSING`; stale deps-hash не
   обходится. Tool dependencies восстанавливаются в tool root, не в patch set.
2. Runner восстанавливает cache по `<pin.sha> + lock hash` или выполняет внешний install из внутреннего registry.
3. Повтор команды → dependencies `ok`; lock change может один раз дать `refresh node_modules out of band` warning.
4. Compile запускает один pass `transpile,typecheck`, печатает полный pass и останавливает демоны в `finally`.
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

## Коммит сборки

Сборка пакета апстримными задачами (`gulp vscode-*`) записывает `commit` в `product.json`
из переменной `BUILD_SOURCEVERSION`, а без неё — чтением `.git/HEAD` как каталога. Управляемое
дерево — linked worktree, его `.git` — файл, поэтому пакет остаётся без `commit`, а без
`commit` загрузчик локализации не читает языковые пакеты (PROP-010 §1). Перед упаковкой
экспортируйте `BUILD_SOURCEVERSION` с HEAD дерева (`codkit --json status` печатает вершину
ветки) и `VSCODE_QUALITY` продукта; проверка — поле `commit` в `product.json` собранного пакета.
Наборы слоя `browser` собственного кода `ci --profile build` не запускает: их гонит
electron-раннер апстрима отдельным шагом релиза (`scripts/test.sh --runGlob
'vs/<own>/**/test/browser/**/*.test.js'`, без дисплея — под `xvfb-run`).

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
