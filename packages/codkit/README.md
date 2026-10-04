# Codkit

Codkit maintains a structured patch set over a separate fork tree of the
upstream family its project type names (`codkit types`). It
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

`codkit standards load` delivers the standards package codkit ships (the
default norms of a patch set, UPL-1.0) into the patch-set repository as a
vibe package; `vibe install --offline` materialises it and `codkit standards
check` confirms the installed copy. See
[13-standards.md](../../docs/codkit/protocol/human/13-standards.md).

A commit made in the fork tree is work like any other: `save` extracts it -
replaying each tree commit into the patch-set history - while `load`
refuses over unextracted commits instead of destroying them. The tree's
pre-commit hook never blocks a commit; it reminds which command carries the
work to the patch set.

Configure paths with `--fork-dir` and `--patches-dir`, with
`CODKIT_FORK_DIR` and `CODKIT_PATCHES_DIR`, or with a strict
`{"codkitSettings":1,"forkDir":"/abs/...","patchesDir":"/abs/..."}` object
in `~/.codkit/settings.json`. The precedence is CLI, environment, settings.
There is no implicit sibling-directory fallback.

Release licensing is opt-in through the patch set's fixed `codkit.licensing.json`:

```json
{
  "codkitReleaseLicensing": 1,
  "profile": "organization-reviewed",
  "componentId": "example-component",
  "created": "2026-10-03T00:00:00Z",
  "sourceDirectory": "src/owned",
  "package": {
    "declaration": {
      "codkitDistributionDeclaration": 1,
      "files": [
        {
          "path": "out/product/app.min.js",
          "sources": ["main.ts"],
          "license": "LicenseRef-EXAMPLE-Private"
        }
      ],
      "metadata": ["out/product/NOTICE", "out/product/SBOM.spdx.json"]
    },
    "sbomFile": "out/product/SBOM.spdx.json"
  }
}
```

These example identifiers require a real approved profile; the example supplies
no legal approval. Profiles live in the user/admin-controlled
`~/.codkit/organization-policies.json`, separate from the patch set. A declaration
selects only a profile ID and optional `additionalForbidden` expressions. Every
payload path must map to inspected sources, with source paths relative to
`sourceDirectory`; metadata paths are exactly the required attached notices and
selected SBOM. The policy must carry the exact notice texts and their SHA-256
for every used standard/custom license and exception. A present declaration
with missing or invalid evidence refuses release; absence leaves organization
evidence explicitly incomplete in the component descriptor.

Packaging recipes can use `captureDistributionProvenance` from
`codkit/dist/lib/distributionProvenance.js` and `renderDistributionDocuments` from
`codkit/dist/lib/distributionDocuments.js` to produce canonical attachments. First
inspect payload-only outputs and render the documents, then include them in the
declared output bundle. Metadata hashes are omitted from document content to
avoid self-reference; final receipts bind all delivered bytes. Package verifies
these documents and required carriers before restoration, and verifies final
output receipts afterward. A separate `publish` declaration has the same shape;
its paths cover the actual shaped Git delivery, including hydrated LFS content
when present. Publish reads the declaration from the selected immutable commit
and checks evidence before pushing or creating the requested export.

`codkit license consumer-check <dir> --profile <id>` checks source evidence
independently. A build mapping remains declared provenance, not proof of
compilation, a signature, or a legal-compatibility ruling.

Named local pairs have a user-controlled registry at `~/.codkit/workspaces.json`:

```sh
codkit workspace create task-a --patches-dir /path/to/patchset --fork-dir /path/to/fork \
  --dir /path/to/existing/pairs --owner developer --session task-a-session
codkit workspace list
codkit workspace show task-a
codkit --workspace task-a where
codkit --workspace task-a load
codkit workspace finish task-a
codkit workspace remove task-a
```

Create journals an isolated patchset task worktree and detached fork worktree.
Retry a partial creation with the same owner/session and directory; changed work
or foreign custody refuses. `--ref` selects the source patchset commit. Inspection
and management use the registry and reject external root flags; ambient root
settings do not redirect them. Finish checks the saved installed type declaration
and clean/save evidence. Removal retains both heads in repository refs, refuses
ignored or unowned data, and can resume a journaled partial deletion. These are
local worktree operations; the directories are preserved until explicit removal.
`--workspace <name-or-UUID>` selects both roots of an active pair and rejects
explicit external root flags. `where` names the selected identity; the selecting
flag is the source of both roots. Named execution uses UUID-derived applied,
cycle and release prefixes in memory. Config serialization retains the original
declaration, and no workspace metadata is written into `codkit.json`.
Run build commands with the same selection, for example
`codkit --workspace task-a build down --channel all`. Selected daemon records
bind the workspace UUID and physical tree; copied or mismatching records cannot
authorize teardown or log attribution. Legacy daemon records retain their
previous format and are not silently adopted by a workspace.
Finish records verified saved-source and dev-channel copies in an immutable
receipt outside the checkouts. Removal rechecks their bytes and saved source
blobs, including after an interrupted patchset-first removal. Edited or unowned
material remains protected; the receipt survives checkout deletion.
Version-2 material receipts additionally bind hydrated LFS copies to committed
attributes/pointers and retained backing bytes, and authorize exact saved empty
directories only while they remain empty. Existing version-1 receipts remain
strict and are not rewritten automatically.
Workspace input deliveries have immutable external witnesses and retained Git
blob refs. Cleanup uses material receipt v3 for those copies, verifies their
declared destinations and unchanged bytes, and retains backing blobs after
checkout removal. A mutable input cache alone grants no cleanup authority.
Workspace daemon teardown retains closed log generations outside the checkout
before retiring their records. Finish requires retirement, and cleanup verifies
matching current/rotated log bytes against those archives. Unknown or edited
logs remain protected; retained logs survive pair removal.

`codkit --json where` is configuration-free and returns a schema-2 envelope
with `roots.tool`, `roots.patches`, and `roots.fork`. The three resolved paths
must be pairwise disjoint. Tool dependencies live with the Codkit installation;
the patch set does not need a launcher, `package.json`, or `node_modules`.

For commands, output, and exit statuses, see the
[command reference](../../docs/codkit/reference/commands.md). Operational guidance
lives in the [human protocol](../../docs/codkit/protocol/human/00-index.md) and
[agent protocol](../../docs/codkit/protocol/agent/00-index.md). Current external
evidence gaps and their closure conditions live in the
[risk register](../../docs/codkit/proofs/RISK-REGISTER.md).
