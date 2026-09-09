# Codkit

Codkit is a standalone tool for maintaining a structured patch set over a fork
of an upstream. Which family of upstreams a patch set belongs to is its
**project type**, declared in `codkit.json` and implemented by a package the
installation carries (`codkit types` prints them). The Codkit checkout, the
managed fork tree, and the patch-set directory are independent locations.

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

The managed tree contains the applied upstream checkout. The patch-set directory
contains the pin, intervention artifacts, inventory, and Codkit runtime state.
Neither path is inferred from the Codkit installation directory or the current
working directory.

Install `codkit` on `PATH`, or invoke
`<codkit-tool-root>/bin/codkit` (PowerShell:
`& <codkit-tool-root>\bin\codkit.ps1`). The patch set never supplies the
launcher or the tool's `package.json`/`node_modules`. Run `codkit --json where`
to obtain the schema-2 `roots.tool`, `roots.patches`, and `roots.fork` values;
the three resolved roots must be pairwise disjoint.

See [Codkit usage](packages/codkit/README.md), the
[human protocol](docs/codkit/protocol/human/00-index.md), and the
[command reference](docs/codkit/reference/commands.md). The harness-specific
part of the agent-session profile for a product repository (Claude Code
settings, rules, agents) ships under `packages/codkit/claude/`; see the
[agent protocol](docs/codkit/protocol/agent/00-index.md). The Codkit tool
repository itself carries no agent perimeter. Current accepted
evidence and open external risks are tracked in the
[risk register](docs/codkit/proofs/RISK-REGISTER.md).

The repository is an npm workspace: `packages/codkit` (the CLI and the engine),
`packages/type-api` (the contract a project type answers), `packages/type-vscode`
(the `vscode` type) and `packages/type-generic` (the `generic` type, a plain git
upstream with no product model). `npm run kit` builds the air-gapped
supply kit — one tarball per package plus `kit-manifest.json` with the version
and sha256 of each — which installs as one offline `npm install` (human
protocol page 15 and [DEVELOPMENT.md](DEVELOPMENT.md)).

Two UPL-1.0 vibe packages ship under `packages/codkit/vibevm/vibepacks/org.vibevm.codkit/`:
`standards`, the default norms for a patch set, and `agent-skills`, the agent
skills `vibe skill install` projects into every coding agent.
`codkit standards load` delivers both into a product repository in one run, and
`--upgrade` takes an edition that was extended in place (human protocol
page 13).
The feature-flag runtime ships as the library under `packages/codkit/runtime/`;
`codkit runtime load` delivers it as a managed copy into the product's own
layer and `codkit gen feature` scaffolds a feature behind a flag (human
protocol page 14).
