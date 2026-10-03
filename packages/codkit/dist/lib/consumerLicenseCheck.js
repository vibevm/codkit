/** @scope spec://codkit/modules/codkit/PROP-019#CONSUMER-LICENSE-CHECK */
// Reuse carrier selection, but apply consumer authority rather than Codkit supply rules.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { readContainedFile } from './containedFile.js';
import { decodeUtf8Strict } from './bytes.js';
import { COPYRIGHT_LINE, MODIFICATIONS_LINE, holderOf, licenseGlobMatches, selectLicenseCarrier } from './licenseCarrier.js';
import { readReuseRegistries } from './reuseRegistry.js';
import { resolveContainedPath } from './pathSafety.js';
import { checkOrganizationExpression } from './organizationPolicy.js';
export const consumerLicenseReportSchema = z.strictObject({
    codkitConsumerLicenseCheck: z.literal(1),
    policy: z.strictObject({ id: z.string().min(1), version: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
    checked: z.array(z.strictObject({
        path: z.string().min(1),
        kind: z.enum(['own', 'third-party']),
        carrier: z.enum(['header', 'sidecar', 'annotation']),
        holders: z.array(z.string().min(1)).min(1),
        license: z.string(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        carrierPath: z.string().min(1),
        carrierSha256: z.string().regex(/^[0-9a-f]{64}$/),
        provenance: z
            .strictObject({
            registry: z.string().min(1),
            sha256: z.string().regex(/^[0-9a-f]{64}$/),
            copyright: z.string().min(1),
            comment: z.string()
        })
            .optional()
    })),
    problems: z.array(z.strictObject({ file: z.string(), message: z.string() })),
    status: z.enum(['complete', 'incomplete'])
});
export function checkConsumerLicenses(root, selected) {
    const problems = [];
    const checked = [];
    const problem = (_code, file, message) => {
        problems.push({ file, message });
    };
    try {
        const physicalRoot = realpathSync(root);
        const paths = sourcePaths(physicalRoot, '', problems);
        const present = new Set(paths);
        const cache = new Map();
        const bytes = (path) => {
            const existing = cache.get(path);
            if (existing !== undefined)
                return existing;
            const read = readContainedFile(physicalRoot, path, { what: 'consumer license carrier' });
            if (read.state === 'absent')
                throw new Error('consumer file disappeared during license scan');
            cache.set(path, read.bytes);
            return read.bytes;
        };
        const text = (path) => {
            const value = decodeUtf8Strict(bytes(path));
            if (value === null)
                throw new Error('consumer text carrier is not UTF-8');
            return value;
        };
        const registry = readReuseRegistries(physicalRoot, paths, text);
        problems.push(...registry.problems.map((entry) => ({ file: entry.file, message: entry.message })));
        for (const path of paths) {
            if (carrierMetadata(path))
                continue;
            try {
                const annotations = registry.annotations
                    .filter((entry) => path.startsWith(entry.base ?? '') &&
                    entry.paths.some((pattern) => licenseGlobMatches(pattern, path.slice((entry.base ?? '').length))))
                    .sort((left, right) => (right.base ?? '').split('/').length - (left.base ?? '').split('/').length);
                const carrier = selectLicenseCarrier(physicalRoot, path, present, annotations, problem, { bytes, text });
                if (carrier === null)
                    continue;
                const spdx = carrier.lines
                    .map((line) => /SPDX-License-Identifier:\s*(.*?)\s*(?:\*\/|-->|-\*\))?\s*$/u.exec(line))
                    .filter((entry) => entry !== null);
                const copyrights = carrier.lines
                    .filter((line) => !MODIFICATIONS_LINE.test(line))
                    .map(copyrightMatch)
                    .filter((entry) => entry !== null);
                if (spdx.length !== 1 || copyrights.length === 0) {
                    problems.push({ file: path, message: 'consumer carrier requires copyright and exactly one SPDX expression' });
                    continue;
                }
                const holders = copyrights.map(holderOf);
                const own = holders.every((holder) => selected.policy.holders.includes(holder));
                const expression = spdx[0]?.[1] ?? '';
                if (own && carrier.kind !== 'header') {
                    const original = decodeUtf8Strict(bytes(path));
                    const stated = original
                        ?.split('\n')
                        .filter((line) => line.trim() !== '')
                        .slice(0, 20)
                        .filter((line) => !MODIFICATIONS_LINE.test(line))
                        .map(copyrightMatch)
                        .filter((entry) => entry !== null) ?? [];
                    if (stated.some((entry) => !selected.policy.holders.includes(holderOf(entry))))
                        problems.push({ file: path, message: 'organization carrier cannot reclassify declared upstream ownership' });
                }
                const carrierPath = carrier.kind === 'sidecar' ? `${path}.license` : carrier.kind === 'annotation' ? (carrier.registry ?? 'REUSE.toml') : path;
                if (own && copyrights.some((entry) => entry.groups?.['years'] === undefined))
                    problems.push({ file: path, message: 'own copyright requires a year' });
                const verdict = checkOrganizationExpression(selected.policy, expression, own, selected.additionalForbidden);
                if (!verdict.ok)
                    problems.push(...verdict.problems.map((message) => ({ file: path, message })));
                const declaration = annotations.find((entry) => entry.license !== null && entry.copyright !== null);
                if (!own && declaration === undefined)
                    problems.push({ file: path, message: 'third-party consumer file requires provenance annotation' });
                if (!own && declaration !== undefined && !/^third-party;\s*\S/u.test(declaration.comment))
                    problems.push({ file: path, message: 'third-party provenance annotation requires a nonempty origin comment' });
                if (!own && declaration !== undefined) {
                    const declaredHolders = declaration.copyright
                        ?.split('\n')
                        .map((line) => copyrightMatch(`SPDX-FileCopyrightText: ${line}`))
                        .filter((match) => match !== null)
                        .map(holderOf) ?? [];
                    if (holders.filter((holder) => !selected.policy.holders.includes(holder)).some((holder) => !declaredHolders.includes(holder)))
                        problems.push({ file: path, message: 'consumer carrier disagrees with provenance copyright holders' });
                }
                if (declaration !== undefined && declaration.license !== expression)
                    problems.push({ file: path, message: 'consumer carrier disagrees with provenance annotation' });
                checked.push({
                    path,
                    kind: own ? 'own' : 'third-party',
                    carrier: carrier.kind,
                    holders,
                    license: expression,
                    sha256: createHash('sha256').update(bytes(path)).digest('hex'),
                    carrierPath,
                    carrierSha256: createHash('sha256').update(bytes(carrierPath)).digest('hex'),
                    ...(!own && declaration !== undefined
                        ? {
                            provenance: {
                                registry: declaration.registry ?? 'REUSE.toml',
                                sha256: createHash('sha256')
                                    .update(bytes(declaration.registry ?? 'REUSE.toml'))
                                    .digest('hex'),
                                copyright: declaration.copyright ?? '',
                                comment: declaration.comment
                            }
                        }
                        : {})
                });
            }
            catch (error) {
                problems.push({ file: path, message: error instanceof Error ? error.message : 'consumer file scan failed' });
            }
        }
        for (const path of paths)
            if (path.endsWith('.license') && !present.has(path.slice(0, -8)))
                problems.push({ file: path, message: 'orphan consumer sidecar' });
    }
    catch (error) {
        problems.push({ file: '.', message: error instanceof Error ? error.message : 'consumer license scan failed' });
    }
    return {
        codkitConsumerLicenseCheck: 1,
        policy: { id: selected.policy.id, version: selected.policy.version, sha256: selected.sha256 },
        checked,
        problems,
        status: problems.length === 0 ? 'complete' : 'incomplete'
    };
}
function sourcePaths(root, directory, problems) {
    const result = [];
    const checked = directory === '' ? { ok: true, absolute: root } : resolveContainedPath(root, directory);
    if (!checked.ok) {
        problems.push({ file: directory, message: 'consumer source directory is not contained' });
        return result;
    }
    for (const entry of readdirSync(checked.absolute, { withFileTypes: true }).sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)))) {
        if (entry.name === '.git')
            continue;
        const path = directory === '' ? entry.name : `${directory}/${entry.name}`;
        if (entry.isSymbolicLink())
            problems.push({ file: path, message: 'consumer source symlink is not followed' });
        else if (entry.isDirectory())
            result.push(...sourcePaths(root, path, problems));
        else if (entry.isFile())
            result.push(path);
        else
            problems.push({ file: path, message: 'consumer source entry is not a regular file' });
    }
    return result.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}
function carrierMetadata(path) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return (name === 'LICENSE' || name.startsWith('COPYING') || name === 'REUSE.toml' || name.endsWith('.license') || path.startsWith('LICENSES/'));
}
function copyrightMatch(line) {
    const existing = COPYRIGHT_LINE.exec(line);
    if (existing !== null)
        return existing;
    if (!/SPDX-FileCopyrightText:\s*/u.test(line))
        return null;
    return COPYRIGHT_LINE.exec(line.replace(/SPDX-FileCopyrightText:\s*/u, 'SPDX-FileCopyrightText: Copyright (c) '));
}
