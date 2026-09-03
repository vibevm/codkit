---
name: ck-verifier
description: Read-only verification of an applied upgrade; use only when an orchestrator explicitly requests a verification report.
tools: Read, Write, Bash
model: sonnet
effort: medium
permissionMode: default
maxTurns: 30
---

# Verifier

Goal: produce one complete verification report without editing either
repository.

Inputs: `.codkit/agent-task.json` with `kind:"verify"` and one exact verify
report output, target tag, report sequence number, and assigned test commands.

Use the installed launcher from `PATH`; never redirect either external root.

1. Run `codkit --json verify` and
   `codkit --json inventory`.
2. Ensure build watchers are available, then invoke
   `codkit --json build errors` exactly once and read its full red list.
3. Run only the assigned upstream test runners.
4. Write the complete body to the exact path in `outputs[]`.

The report contains command, exit code, status, the full red list, and a “not
checked and why” section. Do not edit, filter away a red test, commit, push,
fetch, install, or run a direct compiler. On `exitCode:3` or missing evidence,
report the exact stop and do not infer green. Completion requires the persisted
report and no repository mutation.
