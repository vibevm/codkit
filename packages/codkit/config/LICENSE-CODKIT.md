# Codkit licence notice / Уведомление о лицензии Codkit

This file was placed here by a Codkit command (`codkit standards load` or
`codkit runtime load`). It is the licence of Codkit — the tool that maintains
this patch set — and of every file Codkit delivered into this repository. Those
files live only under the paths named below, and nowhere else:

- `vibevm/vibepacks/org.vibevm.codkit/**` — packages Codkit installs, and their
  projection `vibevm/vibedeps/org.vibevm.codkit.*/**` that `vibe install` builds;
- `delta/own/codkit/**` — the Codkit runtime library and the own-layer copy of
  this notice; `codkit load` materialises it at `src/vs/<own>/codkit/**` of the
  fork tree;
- `.claude/skills/ck-*/**`, `.agents/skills/ck-*/**` and
  `.opencode/skills/ck-*/**` — the skill projections `vibe skill install`
  builds from the Codkit skills package; they carry the package's notice and
  are rewritten by the install, never edited;
- this file at the repository root.

Nothing outside these paths is licensed by this notice; the licence of this
repository is stated elsewhere. Lines Codkit writes inside marked managed blocks
of this repository's own files (`vibe.toml`, `vibevm/scrape/contract.toml`) are
generated configuration, not licensed material. Codkit rewrites this file on
every delivering command; edits to it are refused, and links to it are the
repository owner's own choice.

Этот файл положила сюда команда Codkit (`codkit standards load` или
`codkit runtime load`). Это лицензия Codkit — инструмента, который ведёт этот
patch set, — и каждого файла, который Codkit доставил в этот репозиторий. Такие
файлы лежат только по путям, названным выше, и нигде больше: пакеты Codkit под
`vibevm/vibepacks/org.vibevm.codkit/**` и их проекция
`vibevm/vibedeps/org.vibevm.codkit.*/**`, которую строит `vibe install`;
библиотека рантайма Codkit и own-копия этого уведомления под
`delta/own/codkit/**` (в дереве форка — `src/vs/<own>/codkit/**`); проекции
навыков `.claude/skills/ck-*/**`, `.agents/skills/ck-*/**` и
`.opencode/skills/ck-*/**`, которые `vibe skill install` строит из пакета
навыков Codkit (они несут уведомление пакета и переписываются установкой, а не
правятся); этот файл в корне репозитория. Вне этих путей уведомление ничего не
лицензирует; лицензия этого репозитория указана отдельно. Строки, которые Codkit
пишет внутри помеченных управляемых блоков в файлах самого репозитория
(`vibe.toml`, `vibevm/scrape/contract.toml`), — сгенерированная конфигурация,
лицензии не подлежащая. Codkit переписывает этот файл при каждой доставляющей
команде; правки в нём отклоняются, а ссылки на него — осознанный выбор владельца
репозитория. Текст лицензии существует только на английском языке; русские
абзацы — уведомление.

Components installed in this repository (kept by Codkit) / Установленные
компоненты (ведёт Codkit):

<!-- codkit:begin components -->
<!-- codkit:end components -->

`vibe install` compiles snippets of the packages into generated boot files
(`vibevm/vibespecs/boot/STATIC.*`, `INDEX.md`), materialises the packages under
`vibevm/vibedeps/` and may convert files (`README.md` → `README.xml`). Those
generated files are copies and derivative works of the packages that this
licence permits; the reference to the UPL they carry is vibe's provenance
comment naming the package together with this file. The repository owner owes
nothing further for them.

`vibe install` компилирует фрагменты пакетов в генерируемые файлы загрузочной
полосы (`vibevm/vibespecs/boot/STATIC.*`, `INDEX.md`), строит проекцию пакетов
под `vibevm/vibedeps/` и может преобразовывать файлы (`README.md` →
`README.xml`). Эти файлы — разрешённые лицензией копии и производные работы
пакетов; ссылкой на UPL для них служат комментарий происхождения vibe с именем
пакета и настоящий файл. Никаких иных обязанностей у владельца репозитория в
связи с ними нет.

Copyright (c) 2026 Oleg Chirukhin
Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/
Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/

The Universal Permissive License (UPL), Version 1.0

Subject to the condition set forth below, permission is hereby granted to any person obtaining a copy of this software, associated documentation and/or data (collectively the "Software"), free of charge and under any and all copyright rights in the Software, and any and all patent rights owned or freely licensable by each licensor hereunder covering either (i) the unmodified Software as contributed to or provided by such licensor, or (ii) the Larger Works (as defined below), to deal in both

(a) the Software, and

(b) any piece of software and/or hardware listed in the lrgrwrks.txt file if one is included with the Software (each a “Larger Work” to which the Software is contributed by such licensors),

without restriction, including without limitation the rights to copy, create derivative works of, display, perform, and distribute the Software and make, use, sell, offer for sale, import, export, have made, and have sold the Software and the Larger Work(s), and to sublicense the foregoing rights on either these or other terms.

This license is subject to the following condition:

The above copyright notice and either this complete permission notice or at a minimum a reference to the UPL must be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
