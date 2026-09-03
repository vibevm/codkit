# Физическая Docker-матрица CI

Статус: **accepted 2026-09-03**. Доказательство покрывает физические
`--network none`, read-only mount/rootfs и разделение трёх корней. Оно не
доказывает native macOS/Windows, полный Electron runner или consumer app bundle.

## Среда и топология

- Docker Engine `29.7.2`, storage driver `overlayfs`, cgroup v2, kernel
  `7.0.0-30-generic`.
- Environment image построен из
  [`Dockerfile`](../ci-examples/Dockerfile):
  `sha256:a69a37b067fbbef04510df97194d42d0fd71ad82844db5f600bd64c575dc6835`;
  Node `v24.20.0`, npm `11.19.0`, Git `2.39.5`, Git LFS `3.3.0`.
- `/opt/codkit:ro` — toolRoot с runtime dependencies.
- `/work/patches:ro` — patch-set; `/work/patches/.codkit` — отдельный writable
  nested bind mount.
- `/work/fork:rw` для green CI и `/work/fork:ro` для negative case.
- Container rootfs — `--read-only`, `/tmp` — tmpfs, сеть — `--network none`.

## Результаты

| Сценарий | Результат |
| --- | --- |
| Network namespace | Единственный interface `lo`; маршрутов в `/proc/net/route` — `0` |
| `ci --profile verify` | exit `0`; `fork tree`, `safe.directory`, `check-tree`, `fresh apply`, `verify` — `ok`; optional pin/effective-diff gates — явно `skipped` |
| `ci --profile build --timeout 30000` | exit `0`; dependencies, hygiene, overlay, verify, compile и downstream tests — `ok`; демоны завершены |
| Fork mount `:ro` | exit `2`, `CK-E-TREE-READONLY`; fork status digest до/после совпал |
| Missing dependency supply | build profile завершился на шаге `dependencies`: exit `2`, `CK-E-DEPS-MISSING`; hygiene не запускался |
| UID `10001` против owner `1000`, без write permission | local `safe.directory` создан для patch-set/fork; exit `2`, `CK-E-TREE-READONLY` |
| UID `10001` с явно выданным write permission | `safe.directory` содержит только `/work/patches` и `/work/fork`; verify — `ok`, exit `0` |
| Byte preservation | До green run и после green/read-only run digest равен `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

Re-open trigger: смена container engine, mount/runtime model, UID policy,
lock/error mapping или network boundary. Consumer app bundle закрывается
отдельным proof из [risk register](RISK-REGISTER.md).
