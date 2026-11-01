/** @scope spec://codkit/modules/codkit/PROP-015#GEN-HEADER-IS-THE-PRODUCTS */
// The header `codkit gen` puts in front of a generated file, and nothing else.
//
// What a skeleton says is the project type's answer (PROP-016
// ##TYPE-AREA-GENERATORS); what goes above it is the engine's rule, and it is
// one rule: ##GEN-HEADER-IS-THE-PRODUCTS says the header is built from what the
// product passed - its fields, or its own text - and that codkit's own
// four-line notice is never written into a product file.
// The rules of the block form. The widths are the ones upstream files carry,
// so a product file lines up with the upstream file next to it rather than
// almost lining up, which is the one thing a reader would notice.
const BLOCK_RULE_OPEN = `/*${'-'.repeat(93)}`;
const BLOCK_RULE_CLOSE = ` *${'-'.repeat(92)}*/`;
/** ##GEN-HEADER-IS-THE-PRODUCTS: the product's header, ending in one newline. */
export function productHeader(header) {
    if (header.form === 'text') {
        // Byte for byte: the caller has already proved the file ends in a newline.
        return header.text;
    }
    return header.style === 'block' ? blockHeader(header) : lineHeader(header);
}
/** ##CMD-GEN-FEATURE: the name `--json` gives the header a run wrote. */
export function headerStyleName(header) {
    if (header === null)
        return null;
    return header.form === 'text' ? 'file' : header.style;
}
/** `Licensed under the <title>`, or the identifier with the word licence when no title is declared. */
function licensedUnder(header) {
    return `Licensed under the ${header.title ?? `${header.license} licence`}`;
}
/** Where the full text lives: the declared licence file, or the words every product can honour. */
function fullText(header) {
    return `the full text is ${header.file ?? 'the licence file'} of this repository`;
}
/**
 * The `line` shape: the copyright line first and the SPDX line last, which is
 * the shape every licence scanner reads; the two lines between them say under
 * what and where the full text lives. The identifier is the product's, and
 * codkit never substitutes its own.
 */
function lineHeader(header) {
    return [
        `// Copyright (c) ${header.year} ${header.holder}`,
        `// ${licensedUnder(header)}.`,
        `// The full text is ${header.file ?? 'the licence file'} of this repository.`,
        `// SPDX-License-Identifier: ${header.license}`,
        ''
    ].join('\n');
}
/**
 * The `block` shape: the same statements inside the ruled comment the upstream
 * sources carry, so own code reads as one system with the code it sits beside -
 * the standard ##GEN-HEADER-IS-THE-PRODUCTS cites as
 * `MI-SAME-SHAPE-AS-UPSTREAMS-PARALLEL-SYSTEM`. The copyright line carries the
 * year and the holder and nothing after them: the carrier parser of PROP-014
 * reads the holder to the end of the line, and the earlier form, which put
 * `. All rights reserved.` there, made the consumer check of PROP-019 read a
 * foreign holder (decision of 2026-11-01).
 */
function blockHeader(header) {
    return [
        BLOCK_RULE_OPEN,
        ` *  Copyright (c) ${header.year} ${header.holder}`,
        ` *  All rights reserved. ${licensedUnder(header)}; ${fullText(header)}.`,
        ` *  SPDX-License-Identifier: ${header.license}`,
        BLOCK_RULE_CLOSE,
        ''
    ].join('\n');
}
