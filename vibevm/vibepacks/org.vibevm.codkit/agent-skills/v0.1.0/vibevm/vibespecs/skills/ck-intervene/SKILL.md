---
name: ck-intervene
description: Choose the layer of a new intervention in a codkit patch set: the ladder, the hook budget, the feature-and-flag form, and the owning specification, presented as a proposal before any edit
allowed-tools: Read, Grep, Glob, Bash
---
<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->

# Choose the layer of an intervention

Use this skill before adding or changing an intervention in a patch set maintained by codkit. Its output is a proposal a person or an orchestrator approves; it does not edit the delta or the fork tree.

## Principles (the standard says them; this skill only routes)

- The delta is a parallel system in upstream's own style: the first question is how upstream would build it — a service through dependency injection, a workbench contribution, a registry, an extension point, a `product.json` field, a built-in extension — and only then which seam carries it.
- The layer chosen is the highest applicable one. The ladder and the decision tree come from the installed codkit: `docs/codkit/protocol/human/03-interventions.md` under `roots.tool.path`.
- A patch is a graft: an import or one call into own code, three lines of code at most between the markers, logic never in a patch. `codkit verify` enforces it.
- A new feature is one own folder behind a flag declared through the delivered runtime; a feature that cannot toggle live is declared cold.
- Own code is not free: what leans on upstream internals is a patch equivalent with a contract test and a seam-map row.
- The choice is presented: the `reason` of every artifact below own names the rejected upper leaf and why.

## Procedure

1. Run `ck-orient` first if you have not: roots, state, verify, inventory, the router README.
2. From the router README (`delta/own/README.md`), find the area the change belongs to and read its owning specification. If no row owns the area, the first output of the proposal is a new row and a new specification home.
3. Read the product's seam map for the current pin (the router names it). If the seam you need is not on the map, look it up in the seam catalogue of the standards package (`vibevm/vibepacks/org.vibevm.codkit/standards/v*/vibevm/vibespecs/flows/standards/seam-catalogue.xml`) and propose the map row.
4. Walk the ladder from the top for the change: own; service override; entry-module graft; config overlay; resource file; rewrite rule; patch. For each leaf you reject, write the reason in the words of the decision tree.
5. Write the proposal: the layer, the artifact ids by the id pattern of `codkit/config/conventions.json`, the owner from `delta/owners.json`, the `reason` opening with the rejected upper leaf, the flag (or why there is none), the contract tests, the specification anchors the change adds or cites, and the gates that prove it (`codkit verify`, the product's static proof, upstream's lint over the own directory, the runners).
6. Stop. The proposal is the output; edits follow only after approval, through the tool's commands (`codkit marker new`, `codkit save`, `codkit load`), never by hand in the fork tree.

## What this skill does not do

It does not edit, does not choose a lower layer to save time, does not restate the standard, and does not invent a specification home: a change without an owning specification is a stop.
