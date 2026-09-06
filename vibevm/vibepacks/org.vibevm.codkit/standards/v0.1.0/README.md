<!--
Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/
SPDX-License-Identifier: UPL-1.0
-->
# `flow:org.vibevm.codkit/standards` — the default codkit standards {#root}

![codkit](assets/codkit-128.png)

<status stage="doc" state="done" audience="user"/>

@fact:package-lead A vibe package of kind `flow` carrying the **default codkit standards** — the norms a patch-set repository over a VS Code fork follows when codkit maintains it. It is not installed from a registry: codkit itself delivers it. `codkit standards load` copies the package into `vibevm/vibepacks/org.vibevm.codkit/standards/v<version>/` of the product repository and declares it in the product `vibe.toml` as a statically linked dependency; the ordinary `vibe install` materialises it from there. @status:impl/done

@fact:package-contents-lead Edition 0.1.0 ships: @status:impl/done

- @fact:CONTENT-THE-PROTOCOL `vibevm/vibespecs/flows/standards/STANDARDS-PROTOCOL.xml` — what a standard is, how the set is versioned, how a product adopts a standard and records a deviation, who wins on conflict, and where the three licence scopes end. @status:impl/done
- @fact:CONTENT-MINIMAL-INTERVENTION `vibevm/vibespecs/flows/standards/minimal-intervention.xml` — the standard on minimal intervention in the fork: a choice of layer is presented, never made silently; necessity wins over minimality; the three degrees of own-code coupling; one channel per process; two channels per interface string; the seam map per pin. @status:impl/done
- @fact:CONTENT-THE-BOOT-SNIPPET `vibevm/vibespecs/boot/75-flow-codkit-standards.xml` — the boot snippet: the laws in one line each and the never-do list. @status:impl/done
- @fact:CONTENT-THE-ICON `assets/codkit.svg` (the icon), `assets/codkit-mark.svg` (the mark alone, for light backgrounds), `assets/codkit.png` (512 px) and `assets/codkit-128.png` — the codkit logo: a delta held inside its marker brackets, the patch set inside `codkit:begin`/`codkit:end` (own assets: the SVGs carry their licence header, the PNGs their `.license` sidecars), and `assets/third-party/feather/package.svg` — one third-party icon (Feather Icons, MIT) registered in `REUSE.toml` and listed in `THIRD-PARTY-NOTICES.md`: the package's own worked example of the third-party path the licence check enforces. @status:impl/done

## How the package reaches a product {#install}

```bash
codkit standards load        # the copy plus the managed block in the product vibe.toml
vibe install --offline       # materialisation into vibevm/vibedeps/ and the boot lane
codkit standards check       # the installed copy and the manifest block are intact
```

@fact:INSTALLED-COPY-IS-CODKIT-OWNED The installed copy belongs to codkit and is never edited. A local deviation from a standard is recorded in the product's own specs as a four-field decision record citing the standard's anchor; `codkit standards load` refuses over an edited copy and writes nothing. @status:impl/done

@fact:UPGRADE-IS-A-NEW-VERSION-DIRECTORY A new edition arrives with a new codkit version: `codkit standards load` places the new `v<version>` directory beside the old one and moves the manifest block to the exact new version; the old directory is removed by hand after `vibe install`. @status:impl/done

## Composition {#composition}

- @fact:COMPOSES-CODKIT-LAYER-LADDER The layer ladder and the decision tree come from the installed codkit (PROP-005 §1 and `docs/codkit/protocol/human/03-interventions.md` under the install root); the standard cites them and never restates them. @status:impl/done
- @fact:COMPOSES-DECISION-RECORDS `flow:decision-records` — deviations from a standard and layer choices are recorded with their reasons and a revisit trigger. @status:spec/done
- @fact:COMPOSES-ADDRESSABLE-SPECS `flow:addressable-specs` — a standard's norms are cited by anchor, never by paraphrase. @status:spec/done

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

Third-party components keep their original copyright notices and
licenses; they are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), and their license texts
are in `LICENSES/`.

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

Сторонние компоненты сохраняют свои уведомления об авторском праве и свои
лицензии; они перечислены в [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md),
тексты лицензий — в `LICENSES/`.

Названия и логотипы проекта и его автора лицензией не покрываются и могут
использоваться только для указания на проект.

Копируя файлы пакета, в том числе командой `codkit standards load`,
сохраняйте уведомление об авторском праве и ссылку на лицензию — заголовок
файла или файл `.license` — в каждой копии. Это условие, которое UPL ставит
на копии.

@fact:license-line UPL-1.0; the English notice above governs, the Russian one is a notice. @status:impl/done
