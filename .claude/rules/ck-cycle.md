---
paths:
  - "cycle/**"
---

# Upgrade-cycle state

Use only `codkit --json cycle start|status|continue` for state transitions.
Never edit `cycle/state.json`, recovery records, receipts, or generated history
to force progress.

Use the installed launcher from `PATH` and the schema-2 roots returned by
`codkit --json where`. Agent commands must not contain `--patches-dir` or
`--fork-dir`.

Every non-clean outcome needs the record described in
`docs/codkit/protocol/agent/01-journal-format.md`; `exitCode:3` is a mandatory
human stop. Do not delete a red record or omit a verification to make the latest
state appear green. Preserve full red lists in the prescribed report file.
