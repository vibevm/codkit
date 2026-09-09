# Air-gapped supply kit

An air-gapped run is the primary Codkit CI mode. Codkit does not make `ci` install, clone, fetch, pull LFS, or push: the job must physically or internally supply every input before invoking `codkit ci`.

## Kit contents

| Input | Supplier-side preparation | Air-gapped use |
| --- | --- | --- |
| Codkit packages (CLI + project types) | Build the kit with `npm run kit`: one `npm pack` tarball per workspace package plus `kit-manifest.json` naming each with its version and sha256. | Verify every sha256 against the manifest, then run the manifest's `install.command` — one offline `npm install` of every tarball — in an empty directory. |
| Codkit third-party dependencies | Mirror the closure of the shipped `npm-shrinkwrap.json` files in the internal registry, or prepare an npm cache/`node_modules` from it. | `npm install --offline` resolves them from that cache/registry; with neither, the install stops at the first package with `ENOTCACHED`. |
| Patch-set repository | Export the selected patch-set commit with `codkit.json`, delta, cycle records, and required Git refs. | Mount separately from the tool and fork; provide a writable `.codkit` runtime. |
| Fork repository | Export a bundle/mirror containing upstream history, generated refs, the configured pin, and required future/base refs. Include LFS objects. | Import into internal Git hosting or materialize the mounted fork-tree checkout. |
| Fork-tree npm dependencies | Mirror every upstream workspace package in an internal npm registry and/or prepare a cache keyed by pin SHA plus lock-file hash. | Restore/mount tree `node_modules` before `ci --profile build`. Codkit never installs it. |
| Electron and Node build inputs | Mirror approved headers/binaries in internal feeds or prepare the upstream `.build/` cache. | Configure the upstream-supported feed settings/overlay or restore `.build/`. |
| Built-in extensions | Mirror the VSIX inputs declared by product configuration or prepare `.build/builtInExtensions`. | Restore them before the build profile. |
| CI environment image | Build the supplied Dockerfile with Node 24, Git, and Git LFS where approved package mirrors are reachable. | Promote by digest to the internal image registry; run with `--network none`. |
| Extension marketplace service | Provide the organization’s internal gallery service and product overlay values. | The built product uses the internal service; this is not contacted by `codkit ci`. |

The fork-tree dependency cache key is the configured pin SHA plus the hash of its lock files. Only the main-branch job should publish a shared cache; other jobs consume it. A toolchain advisory changes the key and causes a deliberate cold rebuild.

## Acceptance manifest

The supplier should accompany each delivery with a signed/checksummed manifest maintained by the organization’s release process. At minimum record:

- Codkit commit/version, the `kit-manifest.json` of the delivered kit (every package name, version and sha256), `npm-shrinkwrap.json` checksum, and dependency-cache identity;
- patch-set commit and `codkit.json` checksum;
- fork bundle/mirror identity, configured pin tag/SHA, and LFS-object completeness;
- dependency-cache keys and lock-file checksums for Codkit and the fork tree;
- CI image immutable digest and its Node/Git/Git-LFS versions;
- Electron/Node input and built-in extension inventory;
- internal registry/feed/gallery endpoints by logical name, without credential values.

After import, perform read-only presence checks, restore the Codkit and fork
dependency sets, and confirm that the fork cache contains npm's
`node_modules/.package-lock.json` and `build/node_modules/.package-lock.json`
receipts. An empty bind-mount directory is not a restored cache. Then run:

```bash
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev \
  --workdir /work/patchset \
  --volume "/import/codkit:/opt/codkit:ro" \
  --volume "/import/patchset:/work/patchset" \
  --volume "/import/fork-tree:/work/tree" \
  --env CODKIT_PATCHES_DIR=/work/patchset \
  --env CODKIT_FORK_DIR=/work/tree \
  registry.internal.example/codkit-ci@sha256:<approved-digest> \
  /opt/codkit/bin/codkit --json ci --profile verify
```

The three mounts must be pairwise disjoint. The resolver rejects nesting or
aliasing before loading patch-set configuration.

Use `--profile build` only after the fork tree’s `node_modules` and build inputs are present. A missing tree dependency produces `CK-E-DEPS-MISSING` and exit 2; Codkit will not fall back to an external registry.

## Installing the Codkit kit

The kit installs as one unit. A patch set names its project type, the type is a
package the CLI package depends on, and no registry answers for `@codkit/*` in
the circuit — so every tarball the manifest lists goes into the same command:

```bash
cd /import/codkit-kit
sha256sum --check kit-manifest.sha256   # or compare against kit-manifest.json
npm install --offline \
  ./codkit-<version>.tgz ./codkit-type-api-<version>.tgz ./codkit-type-vscode-<version>.tgz
./node_modules/.bin/codkit types
```

`codkit types` prints one row per registered type with its package, version and
capabilities; that row set is the acceptance check that the delivery is
complete. Installing the CLI tarball alone fails with `ENOTCACHED` on
`@codkit/type-api`: the missing tarball, not a broken package.

## Network and publication boundaries

Mirror synchronization and release publication run only on the supplier side. The mirror bot fetches upstream and pushes the internal/export mirror. The distinct publish bot runs `codkit publish <immutable-patchset-ref> --yes-i-am-publish-bot`; it must not add `--ci`, and it needs a configured `publishRemoteUrl`. Customer-side `codkit ci` never pushes.

Checkout, cache restore, image distribution, and artifact upload belong to the CI wrapper. Disable the container network (for example, Docker `--network none`) as a physical enforcement layer in addition to Codkit’s logical no-network gate.

## Deliberate infrastructure deferrals

Codkit and these examples define required artifacts and the command boundary; they do not choose or implement the organization’s physical transfer media, malware scanning, signing PKI, checksum/signature format, retention policy, internal registry products, service-account provisioning, secret rotation, or network-segment approval. Those controls must be completed in the deployment/security runbook before production acceptance. No credential or external endpoint is embedded in this repository.

If agent-assisted jobs are introduced inside the closed network, their internal model endpoint and authentication are also an infrastructure decision. The normal human/CI Codkit flow remains usable without that endpoint.

See the [CI wrapper examples](README.md), [command reference](../reference/commands.md), and [failure guidance](../reference/faq.md).
