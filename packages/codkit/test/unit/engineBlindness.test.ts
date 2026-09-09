// The executable form of the blindness gate (PROP-016 ##TYPE-ENGINE-IS-BLIND):
// no module of the CLI package may name a fact of one upstream family.
//
// The campaign that extracted the project types ran this gate by hand, as a
// `git grep` over `packages/codkit/src` with a dictionary of the first family's
// words, and every phase reported its zero. A constant that slipped past it -
// the second dependency root of that family, `build/node_modules`, which the ci
// engine carried as a module constant until a second family met it - is the
// reason the dictionary now lives here, where the floor reads it on every run
// rather than a person remembering to.
//
// A word belongs in this list when it is a fact of ONE family: a path of its
// tree, a script of its build, a call of its runtime, a name of its product
// model. Adding one is how a future defect of the same shape is prevented; the
// list may only grow.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const engineSourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

/** Words that name a fact of one upstream family and never a fact of the engine. */
export const FAMILY_DICTIONARY: readonly string[] = [
	'product\\.json',
	'src/vs/',
	'extensions/',
	'registerSingleton',
	'npm run hygiene',
	'watch-client',
	'test-node',
	'BUILD_SOURCEVERSION',
	'icns',
	'product\\.overrides',
	'workbench',
	'nls\\.ts',
	'code-import-patterns',
	'electron',
	'build/node_modules',
	// A channel name of one family: the pair `transpile,typecheck` was a module
	// constant of the wrapper until a family whose channels are `typecheck` and
	// `bundle` met it, and the profile of that family therefore never bundled.
	'transpile'
];

const dictionary = new RegExp(FAMILY_DICTIONARY.join('|'), 'u');

function sourceFiles(directory: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(directory).sort()) {
		const path = join(directory, entry);
		if (statSync(path).isDirectory()) {
			found.push(...sourceFiles(path));
			continue;
		}
		if (entry.endsWith('.ts')) {
			found.push(path);
		}
	}
	return found;
}

describe('the engine is blind to any one upstream family', () => {
	it('reads a source tree that is actually there', () => {
		expect(sourceFiles(engineSourceDir).length).toBeGreaterThan(100);
	});

	it('names no fact of one family anywhere in the CLI package', () => {
		const hits: string[] = [];
		for (const path of sourceFiles(engineSourceDir)) {
			const lines = readFileSync(path, 'utf8').split('\n');
			lines.forEach((line, index) => {
				if (dictionary.test(line)) {
					hits.push(`${path.slice(engineSourceDir.length + 1)}:${index + 1}: ${line.trim()}`);
				}
			});
		}
		expect(hits).toEqual([]);
	});
});
