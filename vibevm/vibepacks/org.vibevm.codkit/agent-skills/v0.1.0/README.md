<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->
# codkit agent skills

@fact:PACKAGE-PURPOSE The skills a coding agent uses when it works on a patch set maintained by codkit. They are procedures, not norms: the norms are the codkit standards package, and each skill routes to the standard and to the owning specification instead of restating them. @status:impl/done

## Contents {#contents}

- @fact:SKILL-ORIENT `ck-orient` — orient in a patch set without editing: roots, tree state, `verify`, inventory, the owning specification of each area. @status:impl/done
- @fact:SKILL-INTERVENE `ck-intervene` — choose the layer of a new intervention: the ladder, the hook budget, the feature-and-flag form, the owning specification; a proposal before any edit. @status:impl/done
- @fact:SKILL-REVIEW `ck-review-intervention` — review an intervention against the minimal-intervention standard: the conformance checks as a table with evidence. @status:impl/done
- @fact:SKILL-RESOLVE `ck-resolve` — resolve one explicitly assigned upgrade-cycle blocker without committing, widening the task or bypassing the journal; carries its journal helper in `scripts/`. @status:impl/done

## How the skills reach an agent {#install}

@fact:INSTALL-STEPS `codkit standards load` delivers this package next to the standards; `vibe install --offline` materialises it; `vibe skill install` projects every skill into the skill directories of the agents the package manager knows (Claude Code, OpenCode, Codex). The harness-specific parts of the codkit agent profile — the hook, the deny profile, the rules and the subagents — are installed by the agent protocol of the codkit documentation, not by this package. @status:impl/done

## Licence / Лицензия {#licence}

Copyright (c) 2026 Oleg Chirukhin. Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/. Every file of this package carries the notice; the full text is `LICENSE`.

Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/. Каждый файл пакета несёт уведомление; полный текст — в `LICENSE`.
