/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-REGISTRY */
// Verify approved execution bytes without evaluating them.
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { readContainedFile } from '../lib/containedFile.ts';
import { resolveContainedPath } from '../lib/pathSafety.ts';
import type { TypePackageApproval } from './installation.ts';

export function typeIntegrityProblems(packageRoot: string, approval: TypePackageApproval): readonly string[] {
	try {
		const expected = new Set(approval.files.map((file) => file.path));
		for (const file of approval.files) {
			const read = readContainedFile(packageRoot, file.path, { what: `${approval.package} integrity receipt ${file.path}` });
			if (read.state === 'absent' || createHash('sha256').update(read.bytes).digest('hex') !== file.sha256)
				return [`package integrity mismatch for ${approval.package}: ${file.path}`];
		}
		for (const root of approval.integrityRoots) {
			const problem = unexpectedFile(packageRoot, root, expected);
			if (problem !== null) return [`package integrity mismatch for ${approval.package}: ${problem}`];
		}
		return [];
	} catch (error) {
		return [`package integrity cannot be established for ${approval.package}: ${error instanceof Error ? error.message : String(error)}`];
	}
}

function unexpectedFile(packageRoot: string, path: string, expected: ReadonlySet<string>): string | null {
	const resolved = resolveContainedPath(packageRoot, path, { allowMissing: true });
	if (!resolved.ok) return `${path}: ${resolved.reason}`;
	if (!existsSync(resolved.absolute)) return null;
	const info = lstatSync(resolved.absolute);
	if (info.isSymbolicLink()) return `${path}: symlink is not approved`;
	if (!info.isDirectory()) return expected.has(path) ? null : `${path}: unapproved file`;
	for (const entry of readdirSync(resolved.absolute)) {
		const found = unexpectedFile(packageRoot, `${path}/${entry}`, expected);
		if (found !== null) return found;
	}
	return null;
}
