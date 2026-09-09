# commands.md — every command run for this spike

Machine: Linux 7.0.0-30-generic, 32 cores, 92 GiB RAM, 313 GiB free on the target filesystem.
Toolchain found: `node v24.18.0`, `npm 11.16.0`, `python3 3.14.4`.
(Upstream's CI pins Node 24.x/26.x and Python 3.13; the local Python is 3.14.4 and nothing
failed because of it.)

Clone directory: `/home/olegchir/work/sbtgit/theia-master-spike` (outside every repository).
All read-only inspection commands (`ls`, `cat`, `sed -n`, `grep -n`, `find`) were run inside
that directory and are not listed individually; the file:line citations in the area files are
the record of what was read. Listed below are every network, mutating and measuring command.

---

## 1. Clone

```
$ git clone https://github.com/eclipse-theia/theia theia-master-spike
exit: 0
--- last lines ---
Cloning into 'theia-master-spike'...
remote: Enumerating objects ...
Resolving deltas: 100% ...
```
Result: 201 MiB directory at clone time, 8799 commits reachable from `master`.

## 2. Pin identification

```
$ git log -1 --format='%H%n%cI%n%an%n%s'
exit: 0
c8926e4df55986ad77d1f24c297873f1656fc9cb
2026-09-08T17:15:36+02:00
Nina Doschek
chore: remove deprecated @theia/preview extension code (#18002)
```

```
$ git rev-parse --abbrev-ref HEAD
exit: 0
master
```

```
$ git describe --tags
exit: 0
next-3-gc8926e4df
```

```
$ git describe --tags --match 'v*' HEAD
exit: 0
v1.75.0-11-gc8926e4df
```

```
$ git log -1 --format='%H %cI' v1.75.0
exit: 0
52f32db6e32d1f88dbbbbde08c8a01ad75c53e11 2026-08-27T16:38:07+02:00
```

```
$ git log -1 --format='%H %cI' next
exit: 0
7c303b1836421183d7013f0bd679a9a30ff0b5dc 2026-09-07T15:01:25+02:00
```

```
$ git tag --sort=-creatordate | head -10
exit: 0
next
v1.75.0
v1.74.1
v1.74.0
v1.73.1
v1.73.0
v1.72.3
v1.72.2
v1.72.1
v1.72.0
```

```
$ git rev-list --count HEAD
exit: 0
8799
```

## 3. Counting

```
$ ls packages | wc -l          -> 79
$ ls dev-packages | wc -l      -> 12
$ ls -d examples/*/ | wc -l    -> 6
$ find packages dev-packages -name '*.ts' -not -path '*/node_modules/*' -not -path '*/lib/*' | wc -l
                               -> 2956
$ grep -l '"theiaExtensions"' packages/*/package.json | wc -l   -> 77
$ grep -rn "rebind(" packages --include=*.ts -l | grep -v node_modules | wc -l   -> 41
exit: 0 for each
```

```
$ find . -name 'electron-builder*' -not -path './node_modules/*'
exit: 1 (no matches)
--- no output ---
```
This negative result is the evidence for `11-release-packaging.md`.

## 4. Toolchain probe

```
$ node -v; npm -v; python3 --version; nproc; free -g | head -2; df -h /home/olegchir | tail -1
exit: 0
v24.18.0
11.16.0
Python 3.14.4
32
               total        used        free      shared  buff/cache   available
Mem:              92          15          34           2          45          76
/dev/sda4       429G   95G  313G  24% /
```

## 5. Install (network)

Upstream moved from yarn to **npm** (`lerna.json:3`), so the packet's "yarn install" is
`npm ci` at this version.

```
$ NODE_OPTIONS unset; timeout 1200 npm ci
exit: 0    elapsed: 59 s
--- last lines ---
 Lerna (powered by Nx)   Successfully ran target afterInstall for 4 projects
   (@theia/eslint-plugin, @theia/re-exports, @theia/core, @theia/electron)

added 2217 packages, and audited 2323 packages in 59s

344 packages are looking for funding
25 vulnerabilities (10 low, 8 moderate, 6 high, 1 critical)
```
`node_modules` after install: **1.3 GiB**.

Notable: `postinstall` ran `theia-patch`, `node scripts/compile-references.js` and
`lerna run afterInstall` (which runs `theia-re-exports generate`, regenerates
`packages/core/README.md` and `packages/electron/README.md` from templates, and downloads a
JSON schema catalogue).

## 6. The clean-tree gate, after install

```
$ git status --porcelain | wc -l
exit: 0
0
```
Confirms the CI invariant of `.github/workflows/ci-cd.yml`: installing must not change the
tree, even though `postinstall` rewrites every `tsconfig.json` references block and two
`README.md` files.

## 7. Build (network for the Electron/ffmpeg step)

```
$ NODE_OPTIONS=--max_old_space_size=4096 timeout 1080 npm run build
exit: 0    elapsed: 102 s
--- last lines ---
$ ts-clean-dangling && tsc --build
Module not found: find-git-repositories
Processed "keytar"
Processed "drivelist"
Processed "native-keymap"
Processed "node-pty"
Searching dependency tree
Building modules: drivelist, keytar, native-keymap
✔ Rebuild Complete
Downloaded ffmpeg shared library { version: "42.8.1", dist: ".../node_modules/electron/dist" }.
Successfully replaced ".../node_modules/electron/dist/libffmpeg.so".
".../node_modules/electron/dist/libffmpeg.so" does not contain proprietary codecs (13 found).
[build/browser] Build started
[build/browser] Finished with 0 errors in 1878ms.
[build/node] Build started
[build/node] Finished with 0 errors in 876ms.
[build/electron] Build started
[build/electron] Finished with 0 errors in 7ms.
```

`npm run build` = `npm run compile` (`lerna run compile`, 91 workspace projects) +
`build:browser` + `build:browser-only` + `build:electron`.

Two facts confirmed by running, not by reading:

- The **ffmpeg proprietary-codec replacement and check run automatically** as part of
  `theia rebuild:electron` during the electron application's `bundle` step — they are not an
  optional release-time extra (see `11-release-packaging.md`).
- The esbuild bundler reports three build targets (`build/browser`, `build/node`,
  `build/electron`), matching the three `gen-esbuild.*.mjs` files.

## 8. The clean-tree gate, after build

```
$ git status --porcelain | wc -l
exit: 0
0
```

```
$ ./scripts/check_git_status.sh
exit: 0
--- no output ---
```

Everything generated is git-ignored: `.gitignore:4` (`lib`), `:15` (`examples/*/src-gen`),
`:16` (`examples/*/gen-esbuild.*.mjs`), `:18` (`.browser_modules`), `:24` (`plugins`).
`esbuild.mjs` is **not** ignored — it is a committed, user-editable file.

## 9. Sizes after a full install + build

```
$ du -sh . node_modules examples/browser/lib examples/electron/lib examples/browser-only/lib \
        examples/browser/src-gen .browser_modules
exit: 0
3.2G    .                          (whole clone, from 201 MiB at clone time)
1.6G    node_modules
441M    examples/browser/lib
464M    examples/electron/lib
253M    examples/browser-only/lib
52K     examples/browser/src-gen
29M     .browser_modules
```

```
$ du -sch packages/*/lib | tail -1
exit: 0
77M     total
```

Largest single artefacts (`ls -la examples/browser/lib/frontend`):

```
bundle.js          47,504,098
bundle.js.map      83,228,369
bundle.css          2,956,137
bundle.css.map      1,532,600
editor.worker.js    3,704,192
editor.worker.js.map 6,305,690
```
(development mode: `minify: false`, `sourcemap: 'linked'`.)

## Summary of the optional build attempt

| Step | Time | Outcome |
|---|---|---|
| `npm ci` | 59 s | exit 0 |
| `npm run build` | 102 s | exit 0 |
| **Total** | **~2 min 41 s** | well inside the packet's 20-minute cap |
| Disk | 201 MiB → 3.2 GiB | |

`npm run test` / `npm run test:theia` / Playwright were **not** run — the packet did not ask
for them, and the plugin download they need is a further network step.
