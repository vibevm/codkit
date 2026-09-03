# Аудит здоровья Codkit

Жанр: health-audit. Это текущая standalone-база Codkit. Полный stable-id список
рисков — в [risk register](docs/codkit/proofs/RISK-REGISTER.md).

## 2026-09-03 — standalone baseline audit

| ID | Категория | Locator | Severity | Disposition | Доказательство / условие закрытия |
| --- | --- | --- | --- | --- | --- |
| CK-A01 | root isolation | `codkit/src/lib/paths.ts`, schema-2 envelope | P1 | fixed | CLI/env/settings precedence покрыта tests; `tool`, `patches`, `fork` разрешаются независимо и должны быть попарно непересекающимися |
| CK-A02 | install independence | launchers, human/agent/CI docs | P1 | fixed | patch set не содержит launcher/package; примеры используют `codkit` из `PATH` либо абсолютный tool-root launcher |
| CK-A03 | policy ownership | built-in conventions + patch-set extension fields | P1 | fixed | safety conventions принадлежат tool root; conventions extension только additive; полный build profile принадлежит явно выбранной patch-set policy, имеет strict schema/error detector и не загружается по скрытому fallback |
| CK-A04 | native portability | macOS, Windows, Bash/PowerShell, APFS/NTFS | P1 | open | нужны нативные прогоны launcher/runtime и filesystem-sensitive suites на физических или доверенных native runners; Linux/Docker это не доказывает |
| CK-A05 | physical container enforcement | `--network none`, read-only mounts/rootfs, UID/GID, `safe.directory` | P1 | fixed | [DOCKER-MATRIX](docs/codkit/proofs/DOCKER-MATRIX.md): раздельные tool/patch-set/fork mounts, read-only rootfs/tool/patch-set, writable nested runtime, green verify/build, read-only fork typed-red и byte preservation |
| CK-A06 | upstream runner baseline | полный VS Code/Electron test runner | P1 | open | локальные unit/e2e Codkit tests не доказывают полный upstream/Electron baseline; нужен clean-pin и applied-delta прогон на поставленных Electron/Node/VSIX inputs |
| CK-A07 | packaging and release | tool npm pack versus downstream app bundles | P1 | open | npm pack Codkit доказан: 309 files, меньше 1 MB tar / 5 MB unpacked по automated bound; shrinkwrap/spec/docs/compiled runtime включены, relative links замкнуты, offline cached install + npm bin `where` из чужого cwd green. Это не закрывает per-OS VS Code/Electron app bundle, signing и publish rehearsal |
| CK-A08 | human protocol acceptance | walkthroughs 01/02/05/08 | P2 | open | документы и checkers не заменяют независимые field-tests; каждый consumer patch set хранит команды, exits и время прохождения |
| CK-A09 | agent perimeter | PreToolUse hook, resolver skill, evals | P2 | open | root-redirection и no-task paths закрываются hook, но hook не является OS sandbox; hostile/agent-assisted CI требует managed host permissions и отдельного acceptance evidence |
| CK-A10 | traceability vacuity | `specmap.json`, TypeScript extractor | P2 | open | spec units строятся, но отсутствие code edges пока не позволяет считать spec-to-code trace полным; закрытие — non-vacuous extraction и gate |
| CK-A11 | dependency registry portability | Vibe embedded lock | P2 | open | materialized `vibedeps` поддерживают текущий offline validate; `vibe registry vendor --offline` пропускает все 31 embedded lock entry из-за отсутствия registry, поэтому clean offline reinstall не доказан и требует опубликованного provenance либо поддержки Vibe |

Открытый finding не считается зелёным из-за наличия примера или успешного
соседнего теста. Он закрывается только сохранённым артефактом, который прямо
выполняет условие последнего столбца. Следующий аудит обязан перенести каждый
открытый ID с новым disposition, а не удалить молча.

Текущий technical floor: format/typecheck/runtime
emit/trace/docs green; `109/109` production scope markers; `88/88` Vitest files
и `1208/1208` tests с детерминированным лимитом `maxWorkers=4`; structural
floor — 8 frozen file-length findings, 0 new; specmap — 624 units, 0 suspects и
одно явно зарегистрированное vacuity warning. `vibe validate --offline` green;
`vibe check` — 0 errors и один открытый embedded-registry warning `CK-A11`.
