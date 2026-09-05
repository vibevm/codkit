# Codkit

Codkit maintains a structured patch set over a separate VS Code fork tree. It
resolves both external directories explicitly, applies the configured upstream
pin and patch set, detects unextracted work, and saves valid changes back into
the patch set.

Install `codkit` on `PATH`, or use the supplied launchers from any current
directory:

```bash
codkit load
/path/to/codkit/bin/codkit load
```

```powershell
& C:\path\to\codkit\bin\codkit.ps1 load
```

The everyday loop is:

1. `load` brings the managed fork tree to the configured pin and applies the
   patch set.
2. Edit and run code in the fork tree.
3. `status` shows work not represented by the patch set.
4. `save` extracts that work into the patch-set directory.

Configure paths with `--fork-dir` and `--patches-dir`, with
`CODKIT_FORK_DIR` and `CODKIT_PATCHES_DIR`, or with a strict
`{"codkitSettings":1,"forkDir":"/abs/...","patchesDir":"/abs/..."}` object
in `~/.codkit/settings.json`. The precedence is CLI, environment, settings.
There is no implicit sibling-directory fallback.

`codkit --json where` is configuration-free and returns a schema-2 envelope
with `roots.tool`, `roots.patches`, and `roots.fork`. The three resolved paths
must be pairwise disjoint. Tool dependencies live with the Codkit installation;
the patch set does not need a launcher, `package.json`, or `node_modules`.

For commands, output, and exit statuses, see the
[command reference](../docs/codkit/reference/commands.md). Operational guidance
lives in the [human protocol](../docs/codkit/protocol/human/00-index.md) and
[agent protocol](../docs/codkit/protocol/agent/00-index.md). Current external
evidence gaps and their closure conditions live in the
[risk register](../docs/codkit/proofs/RISK-REGISTER.md).
