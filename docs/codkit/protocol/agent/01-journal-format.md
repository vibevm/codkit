# Задания, журнал и отчёты агентов

Все runtime-файлы ниже UTF-8/LF. `.codkit/**` локален и не коммитится; журнал и
reports коммитятся обычным процессом цикла. Значения словарей берутся из
[`conventions.json`](../../../../codkit/config/conventions.json), не из этого
документа.

## Resolve task

Оркестратор/человек атомарно создаёт `.codkit/agent-task.json`:

```json
{"codkitAgentTask":1,"kind":"resolve","targetTag":"<tag>","actor":"agent:ck-conflict-resolver","blockers":[{"artifact":"delta/patches/<id>.ckpatch","outcome":"conflict","paths":["src/<target>.ts"]}]}
```

`blockers[].paths` — непустые точные пути дерева с `/`; absolute, `..`, `.`,
пустые сегменты и `\` запрещены. Hook canonicalizes существующие symlink
компоненты и сравнивает итоговый файл, поэтому alias не расширяет периметр.
Без task любой Edit/Write отклоняется, в том числе внутри `patchset`.

## Read-only report task

Scout/verifier/reviewer/cause-finder получают task без `blockers`, но с exact
file outputs:

```json
{"codkitAgentTask":1,"kind":"verify","targetTag":"1.136.0","actor":"agent:ck-verifier","outputs":["cycle/reports/1.136.0-verify-1.md"]}
```

Поддержаны `kind: scout|verify|review|cause`. Hook проверяет форму имени по kind,
containment и отсутствие symlink, запрещает tree edits и разрешает Write только
в `outputs[]`. Так результат передаётся файлом, а не телом ответа.

## Resolve result

Resolver меняет назначенные tree-файлы и записывает
`.codkit/agent-task-result.json`:

```json
{"codkitAgentTaskResult":1,"targetTag":"<tag>","actor":"agent:ck-conflict-resolver","status":"resolved","blockers":[{"artifact":"delta/patches/<id>.ckpatch","outcome":"conflict","status":"resolved","resolution":"<1-3 предложения>"}],"changedPaths":["src/<target>.ts"],"verifications":[{"command":"git diff --check -- src/<target>.ts","exitCode":0}],"reason":null}
```

`status` результата — `resolved|stopped`. У blocker обязательны `artifact`,
`outcome`, `status`; `resolution` объясняет green, `reason` объясняет stop.
`changedPaths` обязан быть подмножеством task paths. `verifications` содержит
дословные команды и целые exit codes. При неопределённости или design choice:
`status:"stopped"`, непустой `reason`, никаких догадок.

Helper `ck-resolve` сверяет task/result/entry и лишь затем под tree lock добавляет
принятую запись в канонический cycle journal. Missing/stopped/red result
отклоняется. Result не является разрешением на `save`, commit или `cycle continue`.

## Cycle journal

Путь: `cycle/log/<targetTag>.jsonl`. Одна запись — одна compact JSON line и один
LF. Поддерживаемая кодом схема не расширяется описательными полями:

```json
{"codkitCycleJournal":1,"ts":"<ISO-offset>","artifact":"<repo-relative artifact>","outcome":"conflict","resolution":"<решение и обоснование>","cause":{"sha":"<40 hex>","approx":false},"by":"agent:ck-conflict-resolver","verified":[{"command":"<exact command>","exitCode":0}]}
```

Target-файлы и более подробная причина остаются в task/result; `artifact`
указывает authoritative delta path. `cause` берётся из immutable classification.
Каждый non-clean artifact требует latest matching green record; полноту проверяет
`cycle continue` (`CK-E-LOG-INCOMPLETE`). Агент не пишет journal напрямую, если
оркестратор не дал отдельную процедуру его принятия. Кандидат до принятия живёт
только в `.codkit/agent-journal-entry.json`; hook разрешает этот exact runtime
путь во время resolve, но не `cycle/log/**`.

## Verification report

Путь: `cycle/reports/<targetTag>-verify-<n>.md`.

| Поле | Требование |
| --- | --- |
| Header | target tag, pin SHA, автор, время |
| Checks | exact command, exit code, status |
| Red list | полный список, не «есть ошибки» |
| Gaps | что не проверено и почему |

Порядок: `verify --json`, `inventory --json`, один `build errors --json`, затем
адресные upstream runners. `exitCode:3` фиксируется как stop.

## Review notes

Путь: `cycle/reports/<targetTag>-review.md`. Каждое замечание содержит artifact
id/path, наблюдаемую суть, ссылку на правило и предлагаемое действие. Пустой
список — явный `no findings` с перечисленными входами.

Scout и cause-finder используют пути из [индекса](00-index.md); в каждом файле
обязательны inputs, read-only commands/exits, вывод и неопределённости.
