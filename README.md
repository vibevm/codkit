# Codkit

Codkit is a standalone tool for maintaining a structured patch set over an
arbitrary fork of Visual Studio Code. The Codkit checkout, the managed fork
tree, and the patch-set directory are independent locations.

Configure the two external locations with command-line flags, environment
variables, or `~/.codkit/settings.json`:

```json
{
	"codkitSettings": 1,
	"forkDir": "/absolute/path/to/vscode-fork",
	"patchesDir": "/absolute/path/to/patch-set"
}
```

Command-line values take precedence over environment variables, which take
precedence over the settings file:

- `--fork-dir` / `CODKIT_FORK_DIR` / `forkDir`
- `--patches-dir` / `CODKIT_PATCHES_DIR` / `patchesDir`

The managed tree contains the applied VS Code checkout. The patch-set directory
contains the pin, intervention artifacts, inventory, and Codkit runtime state.
Neither path is inferred from the Codkit installation directory or the current
working directory.

Install `codkit` on `PATH`, or invoke
`<codkit-tool-root>/bin/codkit` (PowerShell:
`& <codkit-tool-root>\bin\codkit.ps1`). The patch set never supplies the
launcher or the tool's `package.json`/`node_modules`. Run `codkit --json where`
to obtain the schema-2 `roots.tool`, `roots.patches`, and `roots.fork` values;
the three resolved roots must be pairwise disjoint.

See [Codkit usage](codkit/README.md), the
[human protocol](docs/codkit/protocol/human/00-index.md), and the
[command reference](docs/codkit/reference/commands.md). The agent-session
profile for a product repository (Claude Code settings, rules, agents, skills)
ships under `codkit/claude/`; see the
[agent protocol](docs/codkit/protocol/agent/00-index.md). The Codkit tool
repository itself carries no agent perimeter. Current accepted
evidence and open external risks are tracked in the
[risk register](docs/codkit/proofs/RISK-REGISTER.md).
