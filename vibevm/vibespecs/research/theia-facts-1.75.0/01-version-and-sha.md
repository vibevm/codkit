# 01 — Version, sha, and the pin

All paths are relative to the root of the upstream clone
(`https://github.com/eclipse-theia/theia`, branch `master`).

## The pin

| Fact | Value | Evidence |
|---|---|---|
| Branch | `master` | `git rev-parse --abbrev-ref HEAD` |
| HEAD sha | `c8926e4df55986ad77d1f24c297873f1656fc9cb` | `git log -1 --format=%H` |
| HEAD committer date | `2026-09-08T17:15:36+02:00` | `git log -1 --format=%cI` |
| HEAD subject | `chore: remove deprecated @theia/preview extension code (#18002)` | `git log -1 --format=%s` |
| Declared version | `1.75.0` | `lerna.json:4` |
| Nearest reachable release tag | `v1.75.0` (11 commits behind HEAD) | `git describe --tags --match 'v*' HEAD` → `v1.75.0-11-gc8926e4df` |
| `v1.75.0` tag commit / date | `52f32db6e32d1f88dbbbbde08c8a01ad75c53e11`, `2026-08-27T16:38:07+02:00` | `git log -1 --format='%H %cI' v1.75.0` |
| Rolling `next` tag | `7c303b1836421183d7013f0bd679a9a30ff0b5dc`, `2026-09-07T15:01:25+02:00` | `git log -1 --format='%H %cI' next` |
| Commits reachable from HEAD | 8799 | `git rev-list --count HEAD` |

## Where the version is written

- `lerna.json:4` — `"version": "1.75.0"`. This is the single monorepo version; Lerna
  runs in fixed-version mode, so every workspace package carries the same number.
- `packages/core/package.json:3` — `"version": "1.75.0"`.
- `dev-packages/cli/package.json:3` — `"version": "1.75.0"`.
- `examples/browser/package.json:4`, `examples/electron/package.json:5` — `"1.75.0"`.
- The monorepo root itself is *not* versioned: `package.json:1-3` declares
  `"private": true`, `"name": "@theia/monorepo"`, `"version": "0.0.0"`.

Consequence for a project type: **the pin's version is read from `lerna.json`, not from the
root `package.json`.** Every `@theia/*` dependency inside the tree is pinned to the exact same
literal string (see `examples/browser/package.json:26-99`), so a version bump is a whole-tree
rewrite performed by `lerna publish`/`lerna version` (`package.json:96-99`).

## Tag shape

`git tag --sort=-creatordate | head` gives `next`, `v1.75.0`, `v1.74.1`, `v1.74.0`,
`v1.73.1`, `v1.73.0`, `v1.72.3`, … — i.e. the release tag pattern is `v<major>.<minor>.<patch>`
plus one *mutable* `next` tag that upstream moves onto the canary commit. A pin resolver must
ignore `next` (it is not stable) and match `v[0-9]+\.[0-9]+\.[0-9]+`.

## Notable at this exact version

Theia 1.75.0 is the release **in which webpack bundling was removed** and replaced by esbuild:
`dev-packages/application-manager/src/generator/bundler-generator.ts:43-45` warns
"webpack bundling was removed in Theia 1.75.0, 'esbuild.mjs' is used instead". Any Theia
knowledge older than 1.75.0 describes a build that no longer exists (see `03` and `11`).
