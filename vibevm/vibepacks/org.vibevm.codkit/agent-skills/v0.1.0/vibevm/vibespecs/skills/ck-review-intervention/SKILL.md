---
name: ck-review-intervention
description: Review an intervention of a codkit patch set against the minimal-intervention standard: the conformance checks as a table, with the evidence for each
allowed-tools: Read, Grep, Glob, Bash
---
<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->

# Review an intervention against the standard

Use this skill to review one or more interventions — a pull request, a phase report, an inventory diff — of a patch set maintained by codkit. The output is a table of conformance checks with evidence; the skill does not approve, merge or edit.

## Procedure

1. Run `codkit --json verify` and `codkit inventory --md` in the patch set; keep both outputs as evidence.
2. Open the conformance section of the installed standard: `vibevm/vibepacks/org.vibevm.codkit/standards/v*/vibevm/vibespecs/flows/standards/minimal-intervention.xml`, the checks whose anchors begin with `CONF-`. Read them from the installed copy, not from memory: editions change.
3. For every intervention under review and every `CONF-` check, decide `done`, `not done` or `not applicable`, and name the evidence: the inventory line, the `reason` text, the verify output, the specification anchor, the test name, the lint or hygiene run. Evidence is a command output or a file location, never an assurance.
4. For every check marked `not done`, name the smallest change that would make it `done`, and whether it is a change of the artifact, of the specification or of a test.
5. Where the change adds a patch, confirm the graft budget and the own path in the marker block from the patch artifact itself, and confirm the entry in the seam map of the current pin.
6. Where the change adds a feature folder, confirm the flag declaration through the delivered runtime, or the decision record that says why there is none.
7. Write the review: the table `intervention × check → verdict, evidence`, the list of `not done` with the smallest fix, and the numbered rules of the owning specification that the tests cite (or the rules no test cites).

## What this skill does not do

It does not approve, does not edit, does not weaken a check to make a table green, and does not review code style that upstream's lint already owns.
