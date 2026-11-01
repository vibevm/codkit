/** @scope spec://codkit/modules/codkit/PROP-014#LIC-CHECK-ALGORITHM */
// Checking that every file of a package says who owns it and under which
// licence (PROP-014 sec. 3).
//
// ##LIC-CHECK-ALGORITHM: walk the directory in one deterministic order, pick
// each file's carrier by the REUSE precedence, read the copyright and SPDX
// lines out of it, classify the file as ours or someone else's, then check the
// package as a whole. Nothing here writes, and nothing here runs git: this is
// the gate that decides whether copying may start at all
// (##LIC-NEVER-BYPASS), so it must be able to say "no" without having touched
// anything.
//
// Every problem is reported, not the first one: a person fixing licence
// markup wants the whole list once.
import { COPYRIGHT_LINE, SPDX_LINE, MODIFICATIONS_LINE, holderOf, licenseGlobMatches as globMatches, selectLicenseCarrier as selectCarrier } from './licenseCarrier.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { UPL_1_0_ID, UPL_1_0_TEXT, normalizeLicenseText, noticeLines } from './licenseTexts.js';
import { renderThirdPartyNotices } from './licenseNotices.js';
import { readReuseRegistries } from './reuseRegistry.js';
import { LICENSE_REF_PREFIX, NO_ASSERTION, expressionIds, spdxIdHint, unknownIds } from './spdxIds.js';
export const EMPTY_REGISTRY = { annotations: [], problems: [] };
/**
 * ##LIC-UNSCANNED-SET: the licence texts of REUSE - `LICENSE`, `LICENCE` and
 * `COPYING`, with or without one extension - are the text of a licence and carry
 * no markup of their own; the consumer check shares the rule.
 */
const LICENCE_TEXT_NAME = /^(LICENSE|LICENCE|COPYING)(\.[A-Za-z0-9]+)?$/u;
export function isLicenceTextName(name) {
    return LICENCE_TEXT_NAME.test(name);
}
/** ##LIC-UNSCANNED-SET: files that carry no markup and are never scanned. */
function isUnscanned(relative) {
    const name = relative.slice(relative.lastIndexOf('/') + 1);
    return (isLicenceTextName(name) ||
        name.startsWith('COPYING') ||
        relative.startsWith('LICENSES/') ||
        name.endsWith('.license') ||
        name === 'REUSE.toml');
}
/** Every entry under `dir`, lexicographic by path, `.git` excluded. */
function walk(dir) {
    const found = [];
    const visit = (absolute, prefix) => {
        const entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1));
        for (const entry of entries) {
            if (entry.name === '.git')
                continue;
            const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
            if (entry.isSymbolicLink()) {
                found.push({ path: relative, symlink: true });
                continue;
            }
            if (entry.isDirectory()) {
                visit(join(absolute, entry.name), relative);
                continue;
            }
            found.push({ path: relative, symlink: false });
        }
    };
    visit(dir, '');
    return found;
}
/** ##LIC-ANNOTATION-OWN: third-party annotations declare it in their comment; the rest are our own. */
function isThirdPartyAnnotation(annotation) {
    return annotation.comment.startsWith('third-party;');
}
export function checkLicenseCarriers(dir, policy, spdx, options = {}) {
    const problems = [];
    const problem = (code, file, message) => {
        problems.push({ code, file, message });
    };
    const entries = walk(dir);
    const paths = [];
    for (const entry of entries) {
        if (entry.symlink) {
            problem('LICENSE-PACKAGE', entry.path, 'symlink inside the package');
            continue;
        }
        paths.push(entry.path);
    }
    const present = new Set(paths);
    // Step (3): the registry, read once. A caller may supply it instead, which is
    // how the unit tests exercise annotations without writing a TOML file.
    const registry = options.registry ?? readReuseRegistries(dir, paths);
    problems.push(...registry.problems);
    const expectedNotices = options.expectedNotices !== undefined
        ? options.expectedNotices
        : renderThirdPartyNotices(registry, policy.holders, noticeLines(packageNoticeYear(dir, present), policy.holders[0] ?? ''));
    const holders = new Set(policy.holders);
    const allowed = new Set(policy.allowedThirdParty);
    const exceptions = new Set(policy.allowedExceptions);
    const licencesInUse = new Set();
    const thirdPartyLicences = new Set();
    const checked = [];
    // ##LIC-REGISTRY-NESTED: an annotation applies below its own registry, its
    // paths relative to that directory; the deepest registry speaks first.
    const annotationsFor = (relative) => registry.annotations
        .filter((annotation) => {
        const base = annotation.base ?? '';
        return relative.startsWith(base) && annotation.paths.some((pattern) => globMatches(pattern, relative.slice(base.length)));
    })
        .sort((left, right) => (right.base ?? '').split('/').length - (left.base ?? '').split('/').length);
    for (const relative of paths) {
        if (isUnscanned(relative))
            continue;
        const annotations = annotationsFor(relative);
        const carrier = selectCarrier(dir, relative, present, annotations, problem);
        if (carrier === null)
            continue;
        // ##LIC-ANNOTATION-OWN: an annotation without the third-party comment is
        // ours, and must name a policy holder and the own licence.
        const ownShaped = annotations.find((annotation) => !isThirdPartyAnnotation(annotation));
        if (ownShaped !== undefined &&
            (![...holders].some((holder) => (ownShaped.copyright ?? '').includes(holder)) || ownShaped.license !== policy.ownLicense)) {
            problem('LICENSE-HEADER', relative, 'own annotation names a foreign holder or licence');
            checked.push({
                path: relative,
                carrier: carrier.kind,
                ...(carrier.registry === undefined ? {} : { registry: carrier.registry }),
                kind: 'own',
                license: ''
            });
            continue;
        }
        // ##LIC-HEADER-BLOCK-ENDS-AT-SPDX: the block stops at the SPDX line.
        // Copyright-looking text below it is content - the header row of the
        // notices table is the case that found this rule.
        const spdxIndex = carrier.lines.findIndex((line) => SPDX_LINE.test(line));
        const block = spdxIndex === -1 ? carrier.lines : carrier.lines.slice(0, spdxIndex + 1);
        const copyrights = block
            .map((line) => ({ line, match: COPYRIGHT_LINE.exec(line) }))
            .filter((item) => item.match !== null);
        const spdxMatches = carrier.lines.map((line) => SPDX_LINE.exec(line)).filter((match) => match !== null);
        if (copyrights.length === 0) {
            problem('LICENSE-HEADER', relative, 'no copyright line');
            checked.push({ path: relative, carrier: carrier.kind, kind: 'own', license: '' });
            continue;
        }
        if (spdxMatches.length !== 1) {
            problem('LICENSE-HEADER', relative, `${spdxMatches.length} SPDX-License-Identifier lines, expected exactly one`);
            checked.push({ path: relative, carrier: carrier.kind, kind: 'own', license: '' });
            continue;
        }
        const expression = spdxMatches[0]?.groups?.['expr'] ?? '';
        const unknown = unknownIds(expression, spdx);
        if (unknown.length > 0) {
            problem('LICENSE-HEADER', relative, `not an SPDX identifier: ${unknown.join(', ')}${spdxIdHint(unknown)}`);
            checked.push({ path: relative, carrier: carrier.kind, kind: 'own', license: expression });
            continue;
        }
        const stated = copyrights.filter((item) => !MODIFICATIONS_LINE.test(item.line));
        const ours = stated.filter((item) => holders.has(holderOf(item.match)));
        const foreign = stated.filter((item) => !holders.has(holderOf(item.match)));
        const kind = ours.length > 0 && foreign.length === 0 ? 'own' : 'third-party';
        checked.push({
            path: relative,
            carrier: carrier.kind,
            ...(carrier.registry === undefined ? {} : { registry: carrier.registry }),
            kind,
            license: expression
        });
        if (kind === 'own') {
            // A header or sidecar under an own annotation agrees with it.
            if (ownShaped !== undefined && carrier.kind !== 'annotation' && ownShaped.license !== expression) {
                problem('LICENSE-HEADER', relative, `carrier says "${expression}" but the REUSE.toml annotation says "${ownShaped.license}"`);
            }
            if (!ours.every((item) => item.match.groups?.['years'] !== undefined)) {
                problem('LICENSE-HEADER', relative, 'own copyright line without a year');
            }
            if (expression !== policy.ownLicense) {
                problem('LICENSE-HEADER', relative, `SPDX-License-Identifier must be exactly ${policy.ownLicense} for an own file, got "${expression}"`);
            }
            else {
                licencesInUse.add(policy.ownLicense);
            }
            continue;
        }
        classifyThirdParty(relative, expression, annotations, { allowed, exceptions }, problem, (id) => {
            licencesInUse.add(id);
            thirdPartyLicences.add(id);
        });
    }
    // ##LIC-CARRIER-SIDECAR: a sidecar and its file are one indivisible pair.
    for (const relative of paths) {
        if (relative.endsWith('.license') && !present.has(relative.slice(0, -'.license'.length))) {
            problem('LICENSE-HEADER', relative, 'orphan sidecar: its file does not exist');
        }
    }
    if (options.packageShape !== false) {
        checkPackageConsistency(dir, policy, present, licencesInUse, problem);
        checkNotices(dir, present, expectedNotices, problem);
    }
    return {
        dir,
        files: paths.length,
        checked,
        problems,
        licences: {
            own: licencesInUse.has(policy.ownLicense) ? [policy.ownLicense] : [],
            thirdParty: [...thirdPartyLicences].sort(),
            notices: present.has('THIRD-PARTY-NOTICES.md') ? 'THIRD-PARTY-NOTICES.md' : null
        }
    };
}
/**
 * The year the package states in its own `LICENSE` notice. The generated
 * notices header must be stable for a given package: taking the current year
 * would make every package go stale on the first of January, with no edit.
 */
function packageNoticeYear(dir, present) {
    if (present.has('LICENSE')) {
        const first = readFileSync(join(dir, 'LICENSE'), 'utf8').split('\n')[0] ?? '';
        const stated = COPYRIGHT_LINE.exec(first)?.groups?.['years'];
        if (stated !== undefined)
            return stated;
    }
    return String(new Date().getUTCFullYear());
}
/** ##LIC-FILE-CLASSIFICATION, third-party half: registry, agreement, allowlist. */
function classifyThirdParty(relative, expression, annotations, policy, problem, accept) {
    const declared = annotations.find((annotation) => annotation.copyright !== null && annotation.license !== null && isThirdPartyAnnotation(annotation)) ??
        annotations.find((annotation) => annotation.copyright !== null && annotation.license !== null);
    if (declared === undefined) {
        problem('LICENSE-THIRD-PARTY', relative, 'holder not in policy and no REUSE.toml annotation covers the file (typo in the holder, or an undeclared third-party file)');
        return;
    }
    if (declared.license !== expression) {
        problem('LICENSE-THIRD-PARTY', relative, `carrier says "${expression}" but the REUSE.toml annotation says "${declared.license}"`);
        return;
    }
    const ids = expressionIds(expression);
    for (const id of ids) {
        if (id.startsWith(LICENSE_REF_PREFIX) || id === NO_ASSERTION) {
            problem('LICENSE-THIRD-PARTY', relative, `${id} is not allowed`);
            return;
        }
        if (expression.includes('WITH') && policy.exceptions.has(id))
            continue;
        if (!policy.allowed.has(id) && !policy.exceptions.has(id)) {
            problem('LICENSE-THIRD-PARTY', relative, `licence ${id} is outside the allowlist`);
            return;
        }
    }
    for (const id of ids) {
        if (!policy.exceptions.has(id))
            accept(id);
    }
}
/** ##LIC-MANIFEST-FIELD, ##LIC-LICENSE-FILE-SHAPE, ##LIC-LICENSES-DIR. */
function checkPackageConsistency(dir, policy, present, licencesInUse, problem) {
    if (present.has('vibe.toml')) {
        const manifest = readFileSync(join(dir, 'vibe.toml'), 'utf8');
        const stated = /^license = "(.*)"$/mu.exec(manifest);
        if (stated === null || stated[1] !== policy.ownLicense) {
            problem('LICENSE-PACKAGE', 'vibe.toml', `license field must be "${policy.ownLicense}"`);
        }
    }
    else {
        problem('LICENSE-PACKAGE', 'vibe.toml', 'missing');
    }
    const texts = new Map();
    for (const relative of present) {
        if (!relative.startsWith('LICENSES/'))
            continue;
        const id = relative.endsWith('.txt') ? relative.slice('LICENSES/'.length, -'.txt'.length) : relative;
        texts.set(id, readFileSync(join(dir, relative), 'utf8'));
    }
    for (const id of [...licencesInUse].sort()) {
        if (!texts.has(id))
            problem('LICENSE-PACKAGE', `LICENSES/${id}.txt`, 'missing licence text');
    }
    for (const id of [...texts.keys()].sort()) {
        if (!licencesInUse.has(id)) {
            problem('LICENSE-PACKAGE', `LICENSES/${id}.txt`, 'licence text present but no file uses this licence');
        }
    }
    // ##LIC-CANONICAL-TEXT-EMBEDDED: our own licence text is the one oracle for
    // "the licence was not modified"; other licences are checked for presence
    // only (##LIC-OTHER-TEXTS-PRESENCE-ONLY).
    const upl = texts.get(UPL_1_0_ID);
    if (upl !== undefined && normalizeLicenseText(upl) !== normalizeLicenseText(UPL_1_0_TEXT)) {
        problem('LICENSE-PACKAGE', `LICENSES/${UPL_1_0_ID}.txt`, 'differs from the canonical SPDX text of UPL-1.0');
    }
    for (const [id, text] of texts) {
        if (id !== UPL_1_0_ID && text.trim() === '') {
            problem('LICENSE-PACKAGE', `LICENSES/${id}.txt`, 'licence text is empty');
        }
    }
    checkLicenseFile(dir, policy, present, texts, problem);
}
function checkLicenseFile(dir, policy, present, texts, problem) {
    if (!present.has('LICENSE')) {
        problem('LICENSE-PACKAGE', 'LICENSE', 'missing');
        return;
    }
    const canonical = texts.get(policy.ownLicense);
    if (canonical === undefined)
        return;
    const lines = readFileSync(join(dir, 'LICENSE'), 'utf8').split('\n');
    const blank = lines.indexOf('');
    if (blank === -1) {
        problem('LICENSE-PACKAGE', 'LICENSE', 'no blank line after the header');
        return;
    }
    const header = lines.slice(0, blank);
    const first = header[0] === undefined ? null : COPYRIGHT_LINE.exec(header[0]);
    if (header.length < 2 || first === null || !policy.holders.includes(holderOf(first))) {
        problem('LICENSE-PACKAGE', 'LICENSE', 'line 1 must be a copyright line with a policy holder');
    }
    const body = lines.slice(blank + 1).join('\n');
    if (normalizeLicenseText(body) !== normalizeLicenseText(canonical.split('\n').slice(2).join('\n'))) {
        problem('LICENSE-PACKAGE', 'LICENSE', `body differs from LICENSES/${policy.ownLicense}.txt`);
    }
}
/** ##LIC-NOTICES-FILE: generated, never hand-edited, and never silently stale. */
function checkNotices(dir, present, expected, problem) {
    const path = 'THIRD-PARTY-NOTICES.md';
    if (expected === null) {
        if (present.has(path)) {
            problem('LICENSE-PACKAGE', path, 'present but no third-party files are registered');
        }
        return;
    }
    if (!present.has(path)) {
        problem('LICENSE-THIRD-PARTY', path, 'missing: third-party files are registered but no notices file exists (run codkit license notices)');
        return;
    }
    if (readFileSync(join(dir, path), 'utf8') !== expected) {
        problem('LICENSE-THIRD-PARTY', path, 'stale: differs from what codkit license notices would generate');
    }
}
