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
/**
 * The `line` shape: the copyright line first and the SPDX line last, which is
 * the shape every licence scanner reads; the two lines between them say where
 * the full text lives. The identifier is the product's, and codkit never
 * substitutes its own.
 */
function lineHeader(header) {
    return [
        `// Copyright (c) ${header.year} ${header.holder}`,
        `// Licensed under the ${header.license} licence.`,
        '// The full licence text is the licence file of this repository.',
        `// SPDX-License-Identifier: ${header.license}`,
        ''
    ].join('\n');
}
/**
 * The `block` shape: the same four statements inside the ruled comment the
 * upstream sources carry, so own code reads as one system with the code it
 * sits beside - the standard ##GEN-HEADER-IS-THE-PRODUCTS cites as
 * `MI-SAME-SHAPE-AS-UPSTREAMS-PARALLEL-SYSTEM`.
 */
function blockHeader(header) {
    return [
        BLOCK_RULE_OPEN,
        ` *  Copyright (c) ${header.year} ${header.holder}. All rights reserved.`,
        ` *  Licensed under the ${header.license} licence. The full licence text is the licence file of this repository.`,
        ` *  SPDX-License-Identifier: ${header.license}`,
        BLOCK_RULE_CLOSE,
        ''
    ].join('\n');
}
