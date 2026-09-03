---
paths:
  - "delta/**"
---

# Delta artifacts

Use `codkit/config/conventions.json` and the matching terminal leaf in
`docs/codkit/protocol/human/03-interventions.md`; do not duplicate or invent
layer, id, owner, category, or type values.

Patch artifacts are output of tree edit followed by `codkit --json save`.
Do not rewrite a patch by hand to bypass a save failure. Only explicit metadata
header maintenance is hand-authored. Author overlay, resource, rule, and own
sources in their documented source locations; never edit a materialized overlay
target. Finish with `codkit --json verify`.

`codkit` is the installed launcher from `PATH`. Agents consume the roots from
`codkit --json where`; they never select them with root flags.
