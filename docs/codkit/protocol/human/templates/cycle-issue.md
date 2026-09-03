# Cycle `<source-tag> -> <target-tag>`

## Назначения

- DRI / merge captain: `<name>`
- DRI deputy: `<name>`
- Upstream watcher: `<name>`
- Release engineer: `<name>`
- Protocol maintainer: `<name>`
- Owners/reviewers by red item: `<table/link>`
- Cadence decision: `one tag` / `batch two tags approved by DRI: <reason>`

## Exact inputs

- Source: `<tag>@<full-sha>`
- Target: `<tag>@<full-sha>`
- patchSet base: `<full-sha>`
- Fork path/source: `<absolute path> (<resolver source>)`
- Forecast artifact/full SHA: `<link/sha>`
- Supply-kit/cache key: `<pin.sha>-<lock-hash>`

## Preflight

- [ ] `hooks install` → exit `0`; `hooks check` → exit `0`.
- [ ] `git status --short` → empty.
- [ ] `check-tree --require-clean` → exit `0`.
- [ ] `git -C <fork> cat-file -e '<target>^{commit}'` → exit `0`.
- [ ] Roles/SLA announced; owner routing checked against `delta/owners.json`.

## Timeline

| Time | Command | Exit | Phase/output SHA | Next branch |
| --- | --- | ---: | --- | --- |
| `<ISO>` | `cycle start <target>` | `<0/1/2/3>` | `<artifact>` | `<next>` |

## Rename review

| From | To | Similarity | Reference scan | Decision/reviewer |
| --- | --- | ---: | --- | --- |
| | | | | |

## Outcomes and owners

| Artifact/id | Outcome | Cause + approx | Owner | Resolution | Verification exit | JSONL latest |
| --- | --- | --- | --- | --- | ---: | --- |
| | | | | | | |

## Dependency advisory / stabilization

- Advisory report: `cycle/report/deps-advisory.json@<sha>`
- `build down --channel all` exit: `<code>`
- Dependency refresh command/exit: `<command> / <code|not needed>`
- inotify observed/value/action: `<value/action|not Linux>`
- Stabilize report: `cycle/report/stabilize.json@<sha>`
- Hygiene/ESLint/compiler channels/downstream+contract tests: `<green/red details>`
- Red list and return-to-resolve commits: `<links|none>`

## Terminal

- [ ] `cycle status` → completed, exit `0`.
- [ ] `test ! -e cycle/state.json` → exit `0`.
- [ ] JSONL/Markdown/CSV hashes bound by finalization: `<receipt/final commit>`.
- [ ] `ci --profile build --pin-guard-base <main>` → exit `0`.
- [ ] PR merged without squash: `<merge sha>`.
- [ ] Retrospective: `<link>`.

## Gaps / deferrals

| Claim not proven | Evidence missing | Owner | Mechanism/SLA |
| --- | --- | --- | --- |
| | | | |
