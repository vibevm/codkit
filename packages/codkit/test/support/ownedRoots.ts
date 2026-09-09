// The owned directories a test works with (PROP-016 ##TYPE-AREA-LAYOUT).
//
// Most engine suites are about a patch set that owns one directory, which is
// what every type answers unless its family has more; they say so with
// `oneOwnedRoot`, and the two that are about the second owned directory build
// the list they need with `ownedRoot`.

import type { OwnedRole } from '@codkit/type-api';
import { deltaDirOfRole } from '../../src/lib/ownedRoots.ts';
import type { OwnedRoot } from '../../src/lib/ownedRoots.ts';

/** One owned directory, with the build outputs a build writes inside it. */
export function ownedRoot(path: string, role: OwnedRole = 'own', buildOutputs: readonly string[] = []): OwnedRoot {
	return { path, role, buildOutputs, deltaDir: deltaDirOfRole(role) };
}

/** The list of a patch set whose type owns exactly the own root. */
export function oneOwnedRoot(path: string, buildOutputs: readonly string[] = []): readonly OwnedRoot[] {
	return [ownedRoot(path, 'own', buildOutputs)];
}
