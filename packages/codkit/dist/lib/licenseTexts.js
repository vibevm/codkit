/** @scope spec://codkit/modules/codkit/PROP-014#LIC-CANONICAL-TEXT-EMBEDDED */
// The canonical licence text and the normalisation used to compare texts.
//
// ##LIC-CANONICAL-TEXT-EMBEDDED: the bytes below are `text/UPL-1.0.txt` of the
// SPDX licence list, verbatim - 1837 bytes, sha256
// 2f81e75033a0c872ab9725b36081e363f0c9e6c45585c35930edb66043fdc576. They are
// the only oracle for "the licence text was not modified", so a unit test
// asserts that hash rather than trusting this comment. Editing the text here
// is editing the licence (PROP-014 ##LIC-NEVER-MODIFY-THE-UPL-TEXT).
//
// The first line of the SPDX file is the placeholder
// `Copyright (c) [year] [copyright holders]` and the second is empty; a
// package `LICENSE` carries its own notice header instead, so the body it must
// match starts at the third line (##LIC-LICENSE-FILE-SHAPE).
/** `text/UPL-1.0.txt` of the SPDX licence list, byte for byte. */
export const UPL_1_0_TEXT = `Copyright (c) [year] [copyright holders]

The Universal Permissive License (UPL), Version 1.0

Subject to the condition set forth below, permission is hereby granted to any person obtaining a copy of this software, associated documentation and/or data (collectively the "Software"), free of charge and under any and all copyright rights in the Software, and any and all patent rights owned or freely licensable by each licensor hereunder covering either (i) the unmodified Software as contributed to or provided by such licensor, or (ii) the Larger Works (as defined below), to deal in both

(a) the Software, and

(b) any piece of software and/or hardware listed in the lrgrwrks.txt file if one is included with the Software (each a “Larger Work” to which the Software is contributed by such licensors),

without restriction, including without limitation the rights to copy, create derivative works of, display, perform, and distribute the Software and make, use, sell, offer for sale, import, export, have made, and have sold the Software and the Larger Work(s), and to sublicense the foregoing rights on either these or other terms.

This license is subject to the following condition:

The above copyright notice and either this complete permission notice or at a minimum a reference to the UPL must be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
`;
/** SPDX identifier of the licence whose text is embedded above. */
export const UPL_1_0_ID = 'UPL-1.0';
/**
 * ##LIC-TEXT-NORMALIZATION: typographic quotes to ASCII, any run of whitespace
 * (newlines included) to one space, ends trimmed. The SPDX text carries curly
 * quotes in one place (`\u201cLarger Work\u201d`) and line breaks inside a
 * `LICENSE` are editorial; SPDX matching guidelines call such variants
 * equivalent, so comparing raw bytes would report a difference that is not one.
 */
export function normalizeLicenseText(text) {
    let normalized = '';
    for (const character of text) {
        switch (character) {
            case '\u201c':
            case '\u201d':
            case '\u201e':
                normalized += '"';
                break;
            case '\u2018':
            case '\u2019':
                normalized += "'";
                break;
            default:
                normalized += character;
        }
    }
    return normalized.replace(/\s+/gu, ' ').trim();
}
/**
 * The licence body a package `LICENSE` must carry: the SPDX text without its
 * placeholder copyright line and the empty line after it.
 */
export function upl10BodyWithoutPlaceholder() {
    const lines = UPL_1_0_TEXT.split('\n');
    return lines.slice(2).join('\n');
}
/**
 * ##LIC-NOTICE-BILINGUAL: the four lines of an own file's licence notice - the
 * copyright line, the English reference to the UPL, the Russian one, and the
 * SPDX line. The check requires the first and the fourth; the shipped package
 * carries all four, and where the two references differ the English one
 * governs.
 */
export function noticeLines(year, holder) {
    return [
        `Copyright (c) ${year} ${holder}`,
        'Licensed under the Universal Permissive License v 1.0 as shown at https://oss.oracle.com/licenses/upl/',
        'Лицензировано на условиях Universal Permissive License версии 1.0; текст лицензии: https://oss.oracle.com/licenses/upl/',
        `SPDX-License-Identifier: ${UPL_1_0_ID}`
    ];
}
