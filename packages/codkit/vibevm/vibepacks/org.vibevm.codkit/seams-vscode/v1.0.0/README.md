<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->
# `flow:org.vibevm.codkit/seams-vscode` — the seam catalogue of the vscode type {#root}

<status stage="doc" state="done" audience="user"/>

@fact:package-lead A vibe package of kind `flow` carrying the **catalogue of upstream seams of the vscode family of forks**. It is not installed from a registry: codkit delivers it, and only to a patch set that declares the project type `vscode`. `codkit standards load` copies the package into `vibevm/vibepacks/org.vibevm.codkit/seams-vscode/v<version>/` of the product repository and declares it in the product `vibe.toml` as a statically linked dependency, beside the universal packages; the ordinary `vibe install` materialises it from there. @status:impl/done

@fact:package-contents-lead Version 1.0.0 — the development version, mutable in place under that number (`DEV-VERSION-IS-1-0-0`) — ships: @status:impl/done

- @fact:CONTENT-SEAM-CATALOGUE `vibevm/vibespecs/flows/standards/seam-catalogue.xml` — the catalogue itself: eight tiers from a pull request upstream, through the data upstream reads, its own extension mechanisms, a graft into an entry, a hook in a body, types and the build registries, down to the internals of a module, with example locations given as paths and line numbers on one upstream tag and no line of upstream code quoted. @status:impl/done
- @fact:CONTENT-THE-BOOT-SNIPPET `vibevm/vibespecs/boot/77-flow-codkit-seams-vscode.xml` — the boot snippet: the address of the catalogue, that it is a menu and not the product's seam map, and that a patch set carries the catalogue of its own type only. @status:impl/done

## Why the catalogue is a package of the type {#why-a-type-package}

@fact:WHY-THE-TYPE-OWNS-THE-CATALOGUE The standard of minimal intervention is universal: a delta is a parallel system, a patch is a graft, a feature is one folder behind a flag — that holds over any upstream. The seams are not: `product.json`, the workbench contribution registry, the extension points and the string funnel are facts about one family of upstreams. So the norms ship in `org.vibevm.codkit/standards` for every patch set, and the catalogue ships here, for the patch sets of this type alone (PROP-016 `TYPE-AREA-STANDARDS`). @status:impl/done

@fact:WHERE-THE-STANDARD-IS The standard this catalogue serves is `@spec://org.vibevm.codkit/standards/flows/standards/minimal-intervention#root`; the rule that a product keeps its own seam map per pin is its `MI-SEAM-MAP-REQUIRED`, and the ranking of the tiers here is that standard's `MI-SEAM-MAP-IS-RANKED`. @status:impl/done

## How the package reaches a product {#install}

```bash
codkit standards load        # every universal package plus the packages of the declared type
vibe install --offline       # materialisation into vibevm/vibedeps/ and the boot lane
codkit standards check       # the installed copies and the manifest block are intact
```

@fact:INSTALLED-COPY-IS-CODKIT-OWNED The installed copy belongs to codkit and is never edited. A local deviation is recorded in the product's own specs as a four-field decision record citing the anchor deviated from; `codkit standards load` refuses over an edited copy and writes nothing, and `codkit standards load --upgrade` is the explicit word that takes the shipped copy instead. @status:impl/done

## License {#license}

Copyright (c) 2026 Oleg Chirukhin.

This package is licensed under The Universal Permissive License (UPL),
Version 1.0 (SPDX: `UPL-1.0`). The full text is in [LICENSE](LICENSE);
a verbatim copy is also kept in [LICENSES/UPL-1.0.txt](LICENSES/UPL-1.0.txt).

Unless a file states otherwise, every file in this package — specifications,
documentation, and non-code assets — is covered by this license. License
information is recorded per file following the [REUSE](https://reuse.software)
specification: in a comment header at the top of the file, or in an adjacent
`<filename>.license` file for files that cannot carry comments. Where a file's
own notice differs from the above, the file's own notice governs.

This package carries no third-party files: the catalogue cites upstream
locations as paths and line numbers and quotes no upstream code.

The names and logos of this project and of its author are not covered by
this license and may be used only to refer to the project.

When you copy files from this package, including via `codkit standards
load`, keep the copyright notice and the license reference — the file
header or the `.license` file — with every copy. This is the condition
the UPL places on copies.

## Лицензия {#licence-ru}

Copyright (c) 2026 Oleg Chirukhin.

Этот пакет распространяется на условиях The Universal Permissive License
(UPL), версии 1.0 (SPDX: `UPL-1.0`). Полный текст лицензии — в файле
[LICENSE](LICENSE); дословная копия хранится в
[LICENSES/UPL-1.0.txt](LICENSES/UPL-1.0.txt). Текст лицензии существует
только на английском языке; этот раздел — уведомление, и при расхождении
юридически значим английский текст.

Если файл не говорит иного, каждый файл пакета — спецификации, документация и
прочие материалы — покрыт этой лицензией. Лицензионная информация записана в
каждом файле по спецификации [REUSE](https://reuse.software): в заголовке-
комментарии в начале файла либо в соседнем файле `<имя файла>.license` для
файлов, которые не могут нести комментарий. Если собственное уведомление файла
отличается от сказанного здесь, действует уведомление файла.

Сторонних файлов в пакете нет: каталог ссылается на места в апстриме путями и
номерами строк и не цитирует чужой код.

Названия и логотипы проекта и его автора лицензией не покрываются и могут
использоваться только для указания на проект.

Копируя файлы пакета, в том числе командой `codkit standards load`,
сохраняйте уведомление об авторском праве и ссылку на лицензию — заголовок
файла или файл `.license` — в каждой копии. Это условие, которое UPL ставит
на копии.

@fact:license-line UPL-1.0; the English notice above governs, the Russian one is a notice. @status:impl/done
