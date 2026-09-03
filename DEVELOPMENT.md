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

## Проверки

Перед коммитом выполните:

```sh
npm run floor
vibe check --quiet
```

Если бинарии стека ещё не собраны, один раз выполните `vibe bin build`.
Для короткой итерации доступны `npm run format:check`, `npm run typecheck`,
`npm run trace:check`, `npm test` и `npm run ai-native:structural`.

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
