/** @scope spec://codkit/modules/vscode/PROP-005#VSCODE-ADVISORY-READERS */
// Area 5: what the upgrade advisory reads between two pins.
//
// The frame around these readings - the `deps-advisory` phase, the stop for a
// human, the acknowledgement that unblocks the cycle - belongs to the engine.
// Only the list of readers is this type's.
//
// The `read` and `meaning` halves are the open seam of the extraction: the
// engine's `cycleAdvisory.ts` is still typed by the literal paths below and
// does the reading itself, so those two functions refuse (see `deferred.ts`).
// The identifiers and the paths are the data half and are already the answer.

import type { AdvisoryArea, AdvisoryReader } from '@codkit/type-api';
import { notAnsweredHereYet } from './deferred.ts';

const ENGINE_MODULE = 'lib/cycleAdvisory.ts';

function dataOnlyReader(id: string, paths: readonly string[]): AdvisoryReader {
	return {
		id,
		paths,
		read: () => notAnsweredHereYet(`the advisory reader ${id}`, ENGINE_MODULE),
		meaning: () => notAnsweredHereYet(`the advisory reader ${id}`, ENGINE_MODULE)
	};
}

/**
 * ##VSCODE-ADVISORY-READERS: the toolchain of this distribution, file by file.
 * A reader that finds nothing contributes no line to the report.
 */
export const readers: readonly AdvisoryReader[] = [
	dataOnlyReader('node-version', ['.nvmrc']),
	dataOnlyReader('package-manifest', ['package.json']),
	dataOnlyReader('package-lock', ['package-lock.json']),
	dataOnlyReader('npm-directories', ['build/npm/dirs.ts']),
	dataOnlyReader('built-in-extensions', ['product.json']),
	dataOnlyReader('electron-versions', ['package.json', 'build/lib/electron.ts'])
];

/** Every file the readers of this type need, in a stable order, without repeats. */
export const ADVISORY_PATHS: readonly string[] = [...new Set(readers.flatMap((reader) => reader.paths))];

export const advisory: AdvisoryArea = { readers };
