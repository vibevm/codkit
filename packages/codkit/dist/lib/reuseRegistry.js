/** @scope spec://codkit/modules/codkit/PROP-014#LIC-THIRD-PARTY-REGISTRY */
// Reading and extending the REUSE.toml registry of a package (PROP-014 sec. 2).
//
// ##LIC-THIRD-PARTY-REGISTRY: every third-party file is declared here with its
// holder, its licence and where it came from, and this table is the single
// source THIRD-PARTY-NOTICES.md is generated from. A file that is someone
// else's and is not in here is a defect, whether that is a typo in a holder or
// an undeclared import.
//
// ##DECISION-LIC-TOML-PARSER: the file is parsed with a real TOML parser rather
// than by hand. It is someone else's format, people edit it, and a
// hand-rolled subset fails on the first construct nobody thought of. The
// managed blocks of `vibe.toml` and the scrape contract are the opposite case
// and stay a byte scan (##LIC-NEVER-REWRITE-THROUGH-A-PARSER).
//
// Appending never reserialises: `annotate --third-party` writes one
// `[[annotations]]` element at the end of the file, so comments and the order a
// person chose survive untouched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
export const REUSE_REGISTRY_NAME = 'REUSE.toml';
const annotationSchema = z
    .object({
    path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    precedence: z.enum(['closest', 'aggregate', 'override']).default('closest'),
    'SPDX-FileCopyrightText': z.string().min(1).optional(),
    'SPDX-License-Identifier': z.string().min(1).optional(),
    'SPDX-FileComment': z.string().default('')
})
    .strict();
const registrySchema = z
    .object({
    version: z.literal(1),
    'SPDX-PackageName': z.string().optional(),
    'SPDX-PackageSupplier': z.string().optional(),
    'SPDX-PackageDownloadLocation': z.string().optional(),
    annotations: z.array(annotationSchema).default([])
})
    .strict();
/**
 * The registry of `dir`, or the empty one when the package has no REUSE.toml.
 * A file that does not parse or does not validate yields no annotations and one
 * package-level problem, so the run still reports every other file.
 */
export function readReuseRegistry(dir, present) {
    return present ? readOneRegistry(dir, REUSE_REGISTRY_NAME) : { annotations: [], problems: [] };
}
/**
 * ##LIC-REGISTRY-NESTED: every REUSE.toml of the tree, each annotation
 * remembering the registry it came from and the directory its paths are
 * relative to. `paths` are the POSIX-relative files of the tree.
 */
export function readReuseRegistries(dir, paths, readText) {
    const annotations = [];
    const problems = [];
    for (const relative of paths) {
        const name = relative.slice(relative.lastIndexOf('/') + 1);
        if (name !== REUSE_REGISTRY_NAME)
            continue;
        const registry = readOneRegistry(dir, relative, readText);
        annotations.push(...registry.annotations);
        problems.push(...registry.problems);
    }
    return { annotations, problems };
}
/** The directory prefix of a registry path, with a trailing slash; `''` for the root registry. */
export function registryBase(registryPath) {
    const slash = registryPath.lastIndexOf('/');
    return slash === -1 ? '' : registryPath.slice(0, slash + 1);
}
function readOneRegistry(dir, registryPath, readText) {
    const fail = (message) => ({ code: 'LICENSE-PACKAGE', file: registryPath, message });
    let raw;
    try {
        raw = parseToml(readText === undefined ? readFileSync(join(dir, ...registryPath.split('/')), 'utf8') : readText(registryPath));
    }
    catch (error) {
        return { annotations: [], problems: [fail(`cannot parse: ${error instanceof Error ? error.message : String(error)}`)] };
    }
    const parsed = registrySchema.safeParse(raw);
    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where = issue === undefined ? 'document' : issue.path.map((segment) => String(segment)).join('.');
        return { annotations: [], problems: [fail(`${where === '' ? 'document' : where}: ${issue?.message ?? 'failed validation'}`)] };
    }
    const problems = [];
    const annotations = [];
    const base = registryBase(registryPath);
    for (const [index, annotation] of parsed.data.annotations.entries()) {
        const copyright = annotation['SPDX-FileCopyrightText'] ?? null;
        const license = annotation['SPDX-License-Identifier'] ?? null;
        if (copyright === null || license === null) {
            problems.push(fail(`annotations[${index}]: needs both SPDX-FileCopyrightText and SPDX-License-Identifier`));
            continue;
        }
        annotations.push({
            paths: typeof annotation.path === 'string' ? [annotation.path] : annotation.path,
            precedence: annotation.precedence,
            copyright,
            license,
            comment: annotation['SPDX-FileComment'],
            registry: registryPath,
            base
        });
    }
    return { annotations, problems };
}
/** Annotations whose holder is nobody in the policy: the third-party rows. */
export function thirdPartyAnnotations(registry, holders) {
    return registry.annotations.filter((annotation) => annotation.copyright !== null && annotation.license !== null && !holders.some((holder) => annotation.copyright?.includes(holder)));
}
/**
 * One `[[annotations]]` element, in the shape `annotate --third-party` appends.
 * The caller writes it at the end of the file; nothing above is touched.
 */
export function renderAnnotation(annotation) {
    return [
        '',
        '[[annotations]]',
        `path = ${JSON.stringify(annotation.path)}`,
        'precedence = "closest"',
        `SPDX-FileCopyrightText = ${JSON.stringify(annotation.copyright)}`,
        `SPDX-License-Identifier = ${JSON.stringify(annotation.license)}`,
        `SPDX-FileComment = ${JSON.stringify(`third-party; ${annotation.source}`)}`,
        ''
    ].join('\n');
}
/** The header of a REUSE.toml that `annotate` creates when there is none. */
export function emptyRegistryText(packageName, supplier) {
    return `version = 1\nSPDX-PackageName = ${JSON.stringify(packageName)}\nSPDX-PackageSupplier = ${JSON.stringify(`Person: ${supplier}`)}\n`;
}
