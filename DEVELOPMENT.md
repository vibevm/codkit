# Разработка Codkit

Этот файл описывает локальную среду и проверки самого Codkit. Контракты
поведения живут в `vibevm/vibespecs/`.

## Требования

- Node.js 24 или новее;
- npm;
- Git и Git LFS для работы с реальным форком VS Code;
- `vibe` для проверки спецификаций и AI-native structural floor.

Установка зависимостей:

```sh
npm ci
```

## Раскладка workspace

Репозиторий — npm workspace из четырёх публикуемых пакетов
([PROP-016 §3](vibevm/vibespecs/modules/codkit/PROP-016-project-types.xml)):

| Пакет | Что это |
| --- | --- |
| `packages/codkit` | CLI и движок, бинарь `codkit`, реестр типов |
| `packages/type-api` | контракт типа проекта: интерфейс, кодек PNG обмена, форма отказа |
| `packages/type-vscode` | тип `vscode` — знание об одном семействе апстримов |
| `packages/type-generic` | тип `generic` — простой git-апстрим без модели продукта |

Движок слеп к семейству: он спрашивает тип и не называет его фактов. Гейт —
`git grep` апстримных токенов по `packages/codkit/src` печатает `0`.

## Как добавить тип

1. Заведи `packages/type-<id>/` по образцу `packages/type-vscode`:
   `package.json` (`@codkit/type-<id>`, версия `1.0.0`, зависимость
   `@codkit/type-api`), `tsconfig.json`, `tsconfig.runtime.json`,
   `vitest.config.ts`, `LICENSE.md`, `README.md`.
2. Реализуй `ProjectType` и экспортируй его как `projectType`; тесты ответов
   типа живут в этом же пакете. Если ответы типа зависят от `typeConfig`
   (как у `generic`), объяви `configurableCapabilities` и `configure`:
   движок вызывает его один раз после валидации секции и дальше спрашивает
   результат.
3. Добавь строку в `TYPE_REGISTRY` (`packages/codkit/src/types/registry.ts`) и
   зависимость на пакет в `packages/codkit/package.json`.
4. Допиши tsconfig нового пакета в `typecheck` и `runtime:build` корневого
   `package.json`.
5. `npm install` (обновит `npm-shrinkwrap.json`), затем `npm run floor`.
6. `npm run kit` — комплект обязан нести новый пакет; сборка комплекта
   отказывает, когда реестр называет пакет, которого нет в workspace.

## Комплект поставки

`npm run kit` кладёт в `target/supply-kit/` тарбол каждого публикуемого пакета
(`npm pack`) и `kit-manifest.json`: версия CLI-пакета и строка на каждый
тарбол — имя пакета, версия, идентификатор типа, роль, файл, размер, sha256, —
плюс готовая строка `install.command`. Комплект ставится целиком одной
командой в пустом каталоге, без сети:

```sh
npm run kit
cd target/supply-kit
npm install --offline ./codkit-1.0.0.tgz ./codkit-type-api-1.0.0.tgz \
  ./codkit-type-generic-1.0.0.tgz ./codkit-type-vscode-1.0.0.tgz
./node_modules/.bin/codkit types
```

Тарболы типов нужны в той же команде: `@codkit/type-*` не лежат ни в одном
реестре, и установка одного CLI-тарбола уходит за ними в сеть. Сторонние
зависимости `--offline` берёт из npm-кэша или внутреннего реестра — их пины
лежат в `npm-shrinkwrap.json` внутри тарболов. Человеческая процедура приёмки —
[08-release-ci](docs/codkit/protocol/human/08-release-ci.md).

## Проверки

Перед коммитом выполните:

```sh
npm run floor
vibe check --quiet
```

Если бинарии стека ещё не собраны, один раз выполните `vibe bin build`.
Для короткой итерации доступны `npm run format:check`, `npm run typecheck`,
`npm run trace:check`, `npm test` и `npm run ai-native:structural`.

## Агентские сессии в этом репозитории

Codkit не применяется для разработки Codkit, поэтому агентского периметра
здесь нет: в `.claude/` лежит только clean-room правило
`rules/ck-codkit-dev.md`, без hook, deny-профиля, subagents и skills. Сессия
над этим репозиторием работает свободно по обычному permission flow.

Профиль для сессий над репозиторием продукта (patch set) и его форком
поставляется под `packages/codkit/claude/` и устанавливается туда вручную; порядок и
проверки — в `docs/codkit/protocol/agent/00-index.md`. Проверка, что
периметр не просочился в этот репозиторий:
`node docs/codkit/protocol/agent/check.mjs`.

## Запуск

Из Bash:

```sh
/path/to/codkit/bin/codkit where
```

Из PowerShell:

```powershell
& C:\path\to\codkit\bin\codkit.ps1 where
```

Wrappers находят только установку Codkit. Расположение управляемого дерева и
набора патчей задаётся независимо:

```sh
codkit --fork-dir /path/to/vscode-fork --patches-dir /path/to/patch-set where
```

Те же значения можно передать через `CODKIT_FORK_DIR` и
`CODKIT_PATCHES_DIR` либо записать как `forkDir` и `patchesDir` в
`~/.codkit/settings.json`. Приоритет: CLI → environment → settings. Codkit не
предполагает соседства каталогов и не выводит их из текущего каталога.

Структурная политика лежит в `conform.toml`, трассировка — в `specmap.toml`,
ратифицированная brownfield-база — в
`typescript-ai-native-conform-baseline.json`. Временные отключения structural
floor записываются только в `[[typescript.floor_disable]]`.

### Переносимая проверка форматов

`npm run format:check` использует заключённые в кавычки рекурсивные globs
TypeScript: npm передаёт один набор source/test файлов в Windows и POSIX.
`npm run formats:check` проверяет каталог публичных форматов и негативные
fixtures без импорта адаптеров продукта. Обе проверки входят в `npm run floor`.

### Манифест типа

Каждый type-пакет поставляет и экспортирует `type-manifest.json`. Версии
manifest и contract проверяются до импорта адаптера; capabilities декларации
сверяются при использовании. После изменения декларации запустите
`codkit-type-conform packages/type-<id>`. `codkit types` читает только данные.

### Целостность installation registry

`npm run runtime:build` обновляет byte receipts официальных типов в
`packages/codkit/config/type-registry.json`; `npm run types:check` доказывает,
что они соответствуют текущей публикации. Отдельное `npm run types:refresh` —
явное одобрение source-изменений, а не runtime-операция над patch set.

### Явный discipline profile

Config v2 остаётся читаемым и побайтно стабильным. `codkit config migrate`
показывает переход к v3 с `minimal-intervention@1`; `--write` применяет его
под config-lock и отказывает при активной операции или сменившихся bytes.
Тесты `configMigration.test.ts` удерживают старый fingerprint и новую область.
