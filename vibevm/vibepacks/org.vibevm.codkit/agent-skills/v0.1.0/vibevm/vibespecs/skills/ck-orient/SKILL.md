---
name: ck-orient
description: Orient in a codkit patch set without editing anything: roots, tree state, verify, inventory, and the owning specification of each area
allowed-tools: Read, Grep, Glob, Bash
---
<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->

# Orient in a codkit patch set

Use this skill at the start of any work on a repository maintained by codkit, and whenever the state of the fork tree is in doubt. It reads; it never writes, and it never runs a command that materialises or extracts (`load`, `save`, `sync`, `cycle continue`, `overlay apply`).

## Procedure

1. Run `codkit --json where`. Require `codkit.schema == 2` and three pairwise disjoint roots: `roots.tool.path`, `roots.patches.path`, `roots.fork.path`. If a root is missing, stop and report which flag or setting selects it; do not guess a path.
2. Run `codkit --json status`. Read, in this order: the pin, the branch and whether it is up to date, `loadedFrom`, own code changes, own extensions, upstream files changed, marker errors, tree commits not in the patch set. A tree with unextracted work belongs to a person: report it, do not touch it.
3. Run `codkit --json verify`. Every finding has a `code`, a `file` and a `hint`; report them verbatim, grouped by code.
4. Run `codkit inventory --md`. Report the count per layer and the artifacts whose `reason` does not open with a rejected upper leaf.
5. Read the own catalogue's README in the patch set (`delta/own/README.md`). Its router table names, for every area of the delta, the owning specification and tests. Report the row that owns the area you were asked about, and read only that specification.
6. Report: the four command results, the owning specification of the area, and what a person must decide before anyone edits (unextracted work, red verify, missing roots).

## What this skill does not do

It does not edit files, does not run `load`, `save`, `sync`, `cycle`, `overlay apply`, `ci` or `publish`, does not install dependencies, and does not read the fork tree beyond what the commands print and what the owning specification points at.
