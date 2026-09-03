# Codkit CI examples

These examples keep the CI contract the same across wrappers:

1. CI supplies an immutable Codkit installation, including its `node_modules`.
2. CI checks out the patch set as a separate repository.
3. CI checks out or mounts the complete fork repository, including the configured pin, required refs, and LFS objects.
4. The environment-only container receives a read-only tool root, writable fork, and writable patch-set runtime, then runs one `codkit ci` command with its network disabled. The patch-set source itself may be read-only when `.codkit` is a separate writable mount.

The [Dockerfile](Dockerfile) contains Node 24, Git, and Git LFS, but no repository code or tree. [Jenkinsfile](Jenkinsfile) shows an internal mirror/reference-cache flow. [github-actions.yml](github-actions.yml) shows two checkouts. Adapt credentials and internal endpoints in the CI system; do not add them to these files.

`codkit ci` implies the no-network policy even without global `--ci`. The wrapper’s checkout, dependency restore, image pull/build, and artifact upload happen outside Codkit’s boundary. `publish` is not part of this job; it is a separate, explicitly confirmed release-bot command that rejects `--ci`.

For offline inputs and ownership, read the [air-gapped supply-kit contract](air-gapped-supply-kit.md). For CLI flags and exit statuses, read the [command reference](../reference/commands.md).

Example container run after all three roots and dependencies have been supplied:

```bash
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev \
  --user "$(id -u):$(id -g)" \
  --workdir /work/patchset \
  --volume "/absolute/path/to/codkit:/opt/codkit:ro" \
  --volume "/absolute/path/to/patchset:/work/patchset" \
  --volume "/absolute/path/to/fork-tree:/work/tree" \
  --env CODKIT_PATCHES_DIR=/work/patchset \
  --env CODKIT_FORK_DIR=/work/tree \
  codkit-ci:node24 \
  /opt/codkit/bin/codkit --json ci --profile verify
```

The three roots are pairwise disjoint. The tool mount is read-only; the fork
mount is writable. The patch-set source may be read-only only when the wrapper
supplies `/work/patchset/.codkit` as a separate writable runtime mount;
otherwise the patch-set mount is writable. A mounted tree with a different
owner is handled through Codkit’s container-local `.codkit/gitconfig-ci`
`safe.directory` file; Unix UID/GID write permission remains the wrapper’s
responsibility.

The accepted physical Linux matrix is recorded in
[DOCKER-MATRIX](../proofs/DOCKER-MATRIX.md). It does not close the native,
upstream-runner, or app-bundle items in the
[standalone risk register](../proofs/RISK-REGISTER.md).
