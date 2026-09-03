# Project boot snippet — Codkit

User-owned. `vibe install` / `vibe uninstall` never touch this file.

## About this project

Codkit is a standalone TypeScript/Node tool for maintaining a structured patch
set over an arbitrary fork of Visual Studio Code. The tool checkout, managed
fork tree, and patch-set directory are independent.

## Session boot sequence

1. Read the generated boot lane (`STATIC.xml` and every `INDEX.md` entry).
2. Load task-specific contracts from `vibevm/vibespecs/common/` and
   `vibevm/vibespecs/modules/codkit/`.
3. Treat `docs/codkit/` as operational guidance, not a second normative source.

## Runtime boundaries

- `toolRoot`: this Codkit installation; it owns code, tests, specs, and docs.
- `forkDir`: external managed VS Code fork checkout.
- `patchesDir`: external patch-set repository with config, intervention
  artifacts, inventory, and runtime state.

Resolve external paths only through Codkit. Precedence is CLI, environment,
then `~/.codkit/settings.json`; no sibling-directory fallback exists.

## Conflict resolution

Priority: **Human > Spec > Tests > Code.** If a contract appears wrong,
implement it as written, surface the disagreement, and let the owner decide.
