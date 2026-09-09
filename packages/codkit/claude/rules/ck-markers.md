# Managed fork-tree markers

This rule is intentionally unconditional. Claude path-scoped rules match files
inside the Codkit repository; the fork tree has a dynamic external path, so the PreToolUse hook
enforces its perimeter after resolving schema-2 roots with `codkit --json where`.

- Create blocks with `codkit --json marker new ...`.
- Use the installed launcher from `PATH`; do not search the patch set for
  `bin/codkit` or redirect roots with `--patches-dir`/`--fork-dir`.
- Keep paired `codkit:begin/end` lines and the same `CK-...` id.
- Change upstream text only inside the assigned block. Preserve upstream lines;
  disable them inside the block when the procedure requires it.
- Do not remove a marker to silence `verify`, expand a hunk past the block, or
  edit any tree file absent from `blockers[].paths` in the active agent task.
