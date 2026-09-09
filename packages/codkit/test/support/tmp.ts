// Temporary fixture directories on unrelated paths.
//
// PROP-013 ##TP-UNRELATED-PATHS: fixtures never live next to each other and
// never touch the real fork tree, so any hidden "the tree is my sibling"
// assumption fails loudly instead of passing by accident.

import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/**
 * Create a fixture root under the OS temp directory with a randomized nested
 * path. Returns the realpath, so comparisons are not defeated by /var -> /private/var
 * style symlinks on macOS.
 */
export function makeTempRoot(label: string): string {
	const base = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), `ck-${label}-`)));
	created.push(base);
	// A deep, unrelated nesting: nothing may rely on a flat layout.
	const nested = join(base, 'deep', 'nested', `r${Math.random().toString(36).slice(2, 10)}`);
	mkdirSync(nested, { recursive: true });
	return nested;
}

/** Remove everything makeTempRoot handed out during this test file. */
export function cleanupTempRoots(): void {
	while (created.length > 0) {
		const path = created.pop();
		if (path === undefined) {
			continue;
		}
		rmSync(path, { recursive: true, force: true });
	}
}
