/** @scope spec://codkit/modules/codkit/PROP-019#ANNOTATE-OWN */
// The own files of a patch set receive their licence carriers from the selected
// profile: the engine of `codkit license annotate --own` (PROP-019, consumer
// surfaces; PROP-007 ##CMD-LICENSE-ANNOTATE).
//
// ##ANNOTATE-OWN: the walk is the product's own layers - `delta/own/**` without
// the tool's delivered directory and the own manifest, the owned roots, the
// type's own extensions - and never `delta/resources/**`: a resource that
// replaces an upstream file is a derivative work until a person says otherwise,
// so it is annotated by path, deliberately, with the command's other form.
// Registries (`REUSE.toml`), sidecars and the rest of the licence metadata are
// carriers of other files, not files to annotate.
//
// What a file already says is read exactly as the consumer check reads it
// (##CONSUMER-LICENSE-CHECK): the same carrier precedence, the same nested
// registries, the same readers of the holder and the expression - so what this
// command leaves `unchanged` is what `verify` accepts. A carrier naming a policy
// holder and the own expression of the path conforms. A file a registry
// declares `third-party;` is never touched, whatever its carrier says and
// whether it has one: its notice is somebody else's to write (PROP-014
// LIC-NEVER-CLAIM-A-THIRD-PARTY-FILE), and an own annotation covers a directory
// of data files without a sidecar per file (PROP-014 LIC-ANNOTATION-OWN).
//
// ##HEADER-FROM-PROFILE: the header is laid out from the profile - the holder,
// the expression resolved for the path (##ORGANIZATION-OWN-SCOPES), the year,
// the title and the licence file - in the type's style: the ruled block of
// PROP-015 ##GEN-HEADER-IS-THE-PRODUCTS for the comment styles `slash` and
// `block` when the type answers `headerStyle: block`, else the line statements
// wrapped in the comment of the extension (PROP-014 ##LIC-COMMENT-STYLES), right
// after the prelude (##LIC-CARRIER-HEADER). A file that cannot carry a comment
// gets the sidecar of ##LIC-CARRIER-SIDECAR: the copyright and the SPDX line.
//
// `--replace-retired` is for the product's own retired posture, not for other
// people's notices: a foreign carrier is replaced only when the text that would
// be removed carries one of the product's `retiredNotices`, and only when that
// text is the leading comment block of the file (or the whole sidecar). A
// foreign carrier without a retired phrase - the notice of a localisation pack
// the product derives from, say - is `foreign-holder` and left alone with or
// without the flag; replacing it would overwrite a third party's notice.
//
// Every decision is taken before anything is written, so a refusal (a CR in a
// file about to be edited, a registry that does not parse) leaves the patch set
// as it was; `dryRun` stops after the decisions.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeUtf8Strict } from './bytes.js';
import { readContainedFile } from './containedFile.js';
import { SPDX_EXPRESSION, copyrightMatch, isConsumerLicenseMetadata } from './consumerLicenseCheck.js';
import { productHeader } from './genTemplates.js';
import { commentStyleOf, needsSidecar, preludeLength, wrapNotice } from './licenseAnnotate.js';
import { MODIFICATIONS_LINE, holderOf, licenseGlobMatches, selectLicenseCarrier } from './licenseCarrier.js';
import { headerFieldsFor, headerStyleOf, ownLayerPaths, ownLicenseFor } from './licensingProfile.js';
import { ckError } from './messages.js';
import { repoRelativePathProblem } from './pathSafety.js';
import { readReuseRegistries } from './reuseRegistry.js';
/** An annotation whose comment begins so declares a third party (PROP-014 LIC-ANNOTATION-OWN). */
const THIRD_PARTY_COMMENT = /^third-party;/u;
/** ##ANNOTATE-OWN: decide every own file, then write; see the module comment for the rules. */
export function annotateOwn(options) {
    const { patchesDir } = options;
    const walked = ownLayerPaths(patchesDir, options.type);
    const reader = containedReader(patchesDir);
    const registry = readReuseRegistries(patchesDir, walked, reader.text);
    const broken = registry.problems[0];
    if (broken !== undefined) {
        throw ckError('CONFIG', `${broken.file}: ${broken.message}`, 'fix the registry first: the files it covers cannot be decided until it reads', broken.file);
    }
    const walk = {
        patchesDir,
        type: options.type,
        profile: options.profile,
        replaceRetired: options.replaceRetired,
        present: new Set(walked),
        reader,
        annotations: registry.annotations
    };
    const entries = narrow(walked.filter((path) => !isConsumerLicenseMetadata(path)), options.paths);
    const plans = entries.map((path) => decide(path, walk));
    if (!options.dryRun) {
        for (const plan of plans)
            plan.write?.();
    }
    return { files: plans.map(({ path, action }) => ({ path, action })) };
}
/**
 * The given paths narrow the walk to the files equal to one of them or under
 * one of them. A path that narrows to nothing is refused rather than reported
 * as an empty run: a typo that printed nothing and exited 0 would read as done.
 */
function narrow(entries, given) {
    if (given.length === 0)
        return entries;
    const chosen = new Set();
    for (const raw of given) {
        const path = raw
            .split('\\')
            .join('/')
            .replace(/^(\.\/)+/u, '')
            .replace(/\/+$/u, '');
        const problem = repoRelativePathProblem(path);
        if (problem !== null) {
            throw ckError('CONFIG', `${raw}: ${problem}`, 'give a path of the patch set, POSIX-separated, such as delta/own/contrib/sample', raw);
        }
        const matched = entries.filter((entry) => entry === path || entry.startsWith(`${path}/`));
        if (matched.length === 0) {
            throw ckError('CONFIG', `${raw} names no own-layer file`, "give a file or directory of the own layers (delta/own, delta/own-roots, the type's own extensions); the tool's delivered paths, the own manifest, registries and sidecars are never annotated", raw);
        }
        for (const entry of matched)
            chosen.add(entry);
    }
    return entries.filter((entry) => chosen.has(entry));
}
function decide(path, walk) {
    const leave = (action) => ({ path, action, write: null });
    const annotations = annotationsFor(walk.annotations, path);
    // A declared third party is never the product's to head, whatever it
    // carries or lacks: a headerless third-party source is a finding for its
    // own notice, not a place for ours.
    if (declaresThirdParty(annotations))
        return leave('unchanged');
    // The reason a file has no carrier is what this command exists to remove,
    // not a problem to report here.
    const carrier = selectLicenseCarrier(walk.patchesDir, path, walk.present, annotations, () => undefined, walk.reader);
    if (carrier === null)
        return place(path, walk);
    if (conforms(carrier.lines, path, walk.profile))
        return leave('unchanged');
    // An own annotation naming a foreign holder or licence is fixed in its
    // registry, not in the files it covers.
    if (carrier.kind === 'annotation' || !walk.replaceRetired)
        return leave('foreign-holder');
    return carrier.kind === 'sidecar' ? replaceSidecar(path, carrier.lines, walk) : replaceHeader(path, walk);
}
/** The carrier a file lacks: a sidecar when it cannot carry a comment, else the header after the prelude. */
function place(path, walk) {
    const bytes = walk.reader.bytes(path);
    const style = commentStyleOf(path);
    if (style === null || needsSidecar(bytes, path)) {
        return { path, action: 'sidecar', write: sidecarWriter(path, walk) };
    }
    const text = textToEdit(bytes, path);
    const lines = text.split('\n');
    const at = preludeLength(text);
    // One blank line between the header and the first line of the file, the way `gen` lays its files out.
    const updated = [...lines.slice(0, at), headerFor(path, style, walk), '', ...lines.slice(at)].join('\n');
    return { path, action: 'header', write: () => writeFileSync(absoluteOf(walk, path), updated, 'utf8') };
}
/**
 * The product's retired posture, replaced: the leading comment block is cut
 * from right after the prelude to its closing line - or to its SPDX line for a
 * run of line comments, where the carrier ends (PROP-014
 * LIC-HEADER-BLOCK-ENDS-AT-SPDX) and what follows is the file's own comment -
 * together with one blank line after it, and the family's header takes its
 * place. A carrier that sits deeper than the leading block, a leading block
 * without a copyright line, or a block without a retired phrase is left alone.
 */
function replaceHeader(path, walk) {
    const bytes = walk.reader.bytes(path);
    const text = decodeUtf8Strict(bytes);
    const style = commentStyleOf(path);
    // A header carrier was read from UTF-8 text with a comment style; anything else is not ours to cut.
    if (text === null || style === null)
        return { path, action: 'foreign-holder', write: null };
    const lines = text.split('\n');
    const at = preludeLength(text);
    const end = leadingCommentEnd(lines, at, style);
    if (end === null)
        return { path, action: 'foreign-holder', write: null };
    const block = lines.slice(at, end);
    if (!block.some((line) => copyrightMatch(line) !== null) || !carriesRetiredNotice(block, walk.profile)) {
        return { path, action: 'foreign-holder', write: null };
    }
    refuseCarriageReturn(text, path);
    const after = lines[end] === '' ? end + 1 : end;
    const updated = [...lines.slice(0, at), headerFor(path, style, walk), '', ...lines.slice(after)].join('\n');
    return { path, action: 'replaced', write: () => writeFileSync(absoluteOf(walk, path), updated, 'utf8') };
}
/** A sidecar is nothing but a carrier, so the retired one is rewritten whole. */
function replaceSidecar(path, lines, walk) {
    if (!carriesRetiredNotice(lines, walk.profile))
        return { path, action: 'foreign-holder', write: null };
    return { path, action: 'replaced', write: sidecarWriter(path, walk) };
}
/**
 * Where the leading comment block of a file ends (exclusive), or null when the
 * file does not open with a comment of its own style. The markers are the
 * file's (##LIC-COMMENT-STYLES): a `#` heading of a Markdown file is a heading.
 */
function leadingCommentEnd(lines, at, style) {
    const first = lines[at]?.trimStart() ?? '';
    switch (style) {
        case 'xml':
            return first.startsWith('<!--') ? closingLine(lines, at, '-->') : null;
        case 'block':
            return first.startsWith('/*') ? closingLine(lines, at, '*/') : null;
        case 'slash':
            return first.startsWith('/*') ? closingLine(lines, at, '*/') : lineCommentRun(lines, at, /^\/\//u);
        case 'hash':
            return lineCommentRun(lines, at, /^#/u);
        case 'dash':
            return lineCommentRun(lines, at, /^--/u);
        case 'semicolon':
            return lineCommentRun(lines, at, /^;/u);
        case 'percent':
            return lineCommentRun(lines, at, /^%/u);
        default:
            return lineCommentRun(lines, at, /^REM\b/iu);
    }
}
/** The line after the one that closes a block comment opened at `at`; null for an unclosed block. */
function closingLine(lines, at, close) {
    for (let index = at; index < lines.length; index += 1) {
        if (lines[index]?.includes(close) === true)
            return index + 1;
    }
    return null;
}
/** The contiguous run of line comments from `at`, ending at its SPDX line when it has one. */
function lineCommentRun(lines, at, marker) {
    let end = at;
    while (end < lines.length && marker.test(lines[end]?.trimStart() ?? '')) {
        end += 1;
        if (SPDX_EXPRESSION.test(lines[end - 1] ?? ''))
            break;
    }
    return end === at ? null : end;
}
/** The family's header for one file, without its final newline, ready to be joined between lines. */
function headerFor(path, style, walk) {
    if (headerStyleOf(walk.type) === 'block' && (style === 'slash' || style === 'block')) {
        return productHeader({ form: 'fields', ...headerFieldsFor(walk.profile, path, 'block') }).replace(/\n$/u, '');
    }
    const statements = productHeader({ form: 'fields', ...headerFieldsFor(walk.profile, path, 'line') })
        .replace(/\n$/u, '')
        .split('\n')
        .map((line) => line.replace(/^\/\/ /u, ''));
    return wrapNotice(style, statements).replace(/\n$/u, '');
}
/** ##LIC-CARRIER-SIDECAR: the copyright and the SPDX line of the profile, beside the file. */
function sidecarWriter(path, walk) {
    const fields = headerFieldsFor(walk.profile, path, 'line');
    const notice = `Copyright (c) ${fields.year} ${fields.holder}\nSPDX-License-Identifier: ${fields.license}\n`;
    return () => writeFileSync(`${absoluteOf(walk, path)}.license`, notice, 'utf8');
}
/** The text of a file about to receive a header; a CR would leave it with two line endings. */
function textToEdit(bytes, path) {
    const text = decodeUtf8Strict(bytes);
    // needsSidecar already sent undecodable bytes to a sidecar; this keeps the types honest.
    if (text === null)
        throw ckError('CONFIG', `${path} is not UTF-8`, 'a file that cannot be read as UTF-8 takes a sidecar', path);
    refuseCarriageReturn(text, path);
    return text;
}
function refuseCarriageReturn(text, path) {
    if (text.includes('\r')) {
        throw ckError('CRLF', `${path} has CR line endings; the header would be written with LF`, 'normalize the file to LF before annotating it', path);
    }
}
/**
 * Whether a carrier names only policy holders and exactly the own expression
 * of the path - the consumer check's own notion of an own file, so that
 * `unchanged` here and a clean `verify` agree.
 */
function conforms(lines, path, profile) {
    const holders = lines
        .filter((line) => !MODIFICATIONS_LINE.test(line))
        .map(copyrightMatch)
        .filter((match) => match !== null)
        .map(holderOf);
    const expressions = lines.map((line) => SPDX_EXPRESSION.exec(line)?.groups?.['expr']).filter((expression) => expression !== undefined);
    return (holders.length > 0 &&
        holders.every((holder) => profile.selected.policy.holders.includes(holder)) &&
        expressions.length === 1 &&
        expressions[0] === ownLicenseFor(profile, path));
}
/** The annotations covering a path, deepest registry first - the consumer check's selection. */
function annotationsFor(all, path) {
    return all
        .filter((entry) => path.startsWith(entry.base ?? '') &&
        entry.paths.some((pattern) => licenseGlobMatches(pattern, path.slice((entry.base ?? '').length))))
        .sort((left, right) => (right.base ?? '').split('/').length - (left.base ?? '').split('/').length);
}
/** Whether the annotation that declares the file (licence and copyright) calls it a third party's. */
function declaresThirdParty(annotations) {
    const declaration = annotations.find((entry) => entry.license !== null && entry.copyright !== null);
    return declaration !== undefined && THIRD_PARTY_COMMENT.test(declaration.comment);
}
/** Whether any line carries one of the product's retired phrases, case-insensitively. */
function carriesRetiredNotice(lines, profile) {
    const phrases = profile.product.retiredNotices.map((phrase) => phrase.toLowerCase());
    return lines.some((line) => {
        const lowered = line.toLowerCase();
        return phrases.some((phrase) => lowered.includes(phrase));
    });
}
function absoluteOf(walk, path) {
    return join(walk.patchesDir, ...path.split('/'));
}
/**
 * The reader the carrier selection and the registries share: every file through
 * the contained reader of the patch set (PROP-002 CONTAINED-FILE-IO), each read
 * once. The writes below go through `writeFileSync` on the paths this reader
 * proved regular files moments before, because rewriting in place keeps the
 * mode of a file - an executable script stays executable - where an atomic
 * replacement would have to be told the mode.
 */
function containedReader(root) {
    const cache = new Map();
    const bytes = (path) => {
        const cached = cache.get(path);
        if (cached !== undefined)
            return cached;
        const read = readContainedFile(root, path, { what: path });
        if (read.state === 'absent') {
            throw ckError('CONFIG', `${path} disappeared while the own layer was being read`, 'run the command again on a quiet checkout', path);
        }
        cache.set(path, read.bytes);
        return read.bytes;
    };
    const text = (path) => {
        const value = decodeUtf8Strict(bytes(path));
        if (value === null)
            throw ckError('CONFIG', `${path} is not UTF-8`, 'a registry or a sidecar must be UTF-8 text', path);
        return value;
    };
    return { bytes, text };
}
