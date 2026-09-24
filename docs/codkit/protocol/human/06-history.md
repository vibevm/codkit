# История и коммиты

История patchset — часть доказательства стоимости дельты. Её не переписывают; ветку цикла не squash-merge.

## Канонический набор цикла

В порядке появления:

1. `codkit cycle: bump pin to <tag>`.
2. `refactor(cycle): follow upstream renames for <tag>` — только если есть перенесённые пути.
3. `chore(cycle): regenerate delta for <tag>`.
4. `chore(cycle): record dependency advisory for <tag>` и `test(cycle): record stabilization for <tag>`; повтор допустим после red.
5. По одному `fix(cycle): resolve <id>`; удаление исчезнувшего artifact — отдельный объяснённый commit.
6. `docs(cycle): finalize <tag>` — журнал, Markdown, CSV и удаление state.

`codkit hooks install` ставит trailer hook; `hooks check` проверяет его. Каждый commit цикла получает
`Codkit-Cycle: <targetTag>`, а fix — ещё `Cause: <full upstream SHA>`. Cause берётся из immutable classification,
а не из догадки автора. CI независимо проверяет формат и историю.

## Проверка перед merge

1. `git log --reverse --format='%H %s%n%(trailers)' <bump-parent>..HEAD` → виден порядок выше и trailers.
2. `codkit cycle status` → completed, exit `0`.
3. `codkit ci --profile build --pin-guard-base <main-ref>` → exit `0`.
4. Выбери merge commit/no-ff в UI. Squash/rebase merge → терминальный отказ reviewer.

Почему нельзя squash: CSV хранит итоговые числа, но отдельные rename/regeneration/fix commits дают проверяемое число
и характер человеческих адаптаций. Один commit уничтожает эту историю причин.

## Обычная история

- Feature commits живут в patchset; `save --commit` коммитит только извлечённые own/patch пути.
- Generated branch дерева создаёт codkit с техническим автором `codkit <codkit@patchset.invalid>` и детерминированными датами.
- patchset commits принадлежат людям/ботам, которые приняли изменение; дерево не является местом ручной истории.
- Репозиторные bytes — UTF-8/LF. Git-вызовы codkit принудительно используют `core.autocrlf=false` и `core.eol=lf`, поэтому checkout codkit пишет LF на любой ОС; файлы, которые пишет дельта, после каждого `load` держат байты patchset.
- На Windows `core.longpaths=true` в дереве проверяется `check-tree` и предупреждением резолвера.

## Blame в generated tree

Апстрим уже использует `.git-blame-ignore-revs`, но текущий `publish` не добавляет туда динамические SHA generated commits.
До появления CI-механизма это открытый дефект механизации, а не выполненная гарантия.

Диагностический обход для конкретного release ref:

1. `git -C <fork> log --format=%H --author='codkit <codkit@patchset.invalid>' <pin-sha>..<release-ref> > <ci-artifacts>/codkit-generated-revs` → exit `0`.
2. `git -C <fork> blame --ignore-revs-file <ci-artifacts>/codkit-generated-revs <release-ref> -- <path>` → exit `0`.

Владелец механизма — релиз-инженер; закрытие требует, чтобы publish/CI само обновляло tracked ignore-list или выпускало
канонический blame-artifact. Текстовая просьба вручную вести список не считается решением.

Ответы для ревью: squash нельзя из-за метрики адаптаций; Cause даёт классификатор; blame дерева использует
generated-revs artifact до закрытия механизационного разрыва.
