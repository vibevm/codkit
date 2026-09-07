<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->

# Codkit runtime 0.1.0

This directory is delivered into a product's own layer by `codkit runtime load`
and kept there as a managed copy: Codkit compares it byte for byte with the
version it ships, `codkit verify` and `codkit runtime check` report any
difference, and `codkit save` refuses to mirror an edit made here. Change the
runtime in Codkit, then run `codkit runtime load --upgrade`.

## What it is

- **Feature flags** — `IFeatureFlagsService` resolves each declared feature
  from layered sources (build → policy → remote-forced → user → remote-default →
  declaration default) into an observable state; `when` clauses follow the
  `<id>.enabled` context key.
- **Features as instances** — `registerFeature(descriptor, ctor)` declares a
  feature; a host creates the class through dependency injection while the
  flag is on and disposes it when the flag turns off. A cold feature
  (`hotToggle: false`) is frozen at startup and asks for a restart.
- **Remote source and its simulator** — a snapshot port a server will
  implement; until then the inspector edits a simulated snapshot kept in
  application storage, walking the very same path.
- **Inspector** — the command *Feature Flags: Inspect* lists every feature,
  the layer that decided it and lets you flip the user setting or the
  simulated snapshot.
- **Brand engine** — `createBrandTransform(rules)` builds the pure message
  transform a product hooks into its localization funnel.

## Wiring in a product

1. `import '../codkit/browser/featureFlags.contribution.js';` once from the
   product's composition root, after the feature declarations.
2. Add the `code-import-patterns` targets described in `LAYERS.md`.
3. Declare a feature (`codkit gen feature <id> --title ...`) and let the host
   create it.

## Tests

`test/**` are upstream-style suites. They typecheck against the upstream
sources on the verified pin and run inside the fork tree with upstream's own
unit-test runners after `codkit load`.

## Licence / Лицензия

Copyright (c) 2026 Oleg Chirukhin. Licensed under the Universal Permissive
License v 1.0 as shown at https://oss.oracle.com/licenses/upl/. Every file in
this directory carries the notice; the repository-level notice is
`LICENSE-CODKIT.md` next to this directory.

Лицензировано на условиях Universal Permissive License версии 1.0; текст
лицензии: https://oss.oracle.com/licenses/upl/. Каждый файл каталога несёт
уведомление; уведомление уровня репозитория — `LICENSE-CODKIT.md` рядом.
