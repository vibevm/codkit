// The real effective conventions, loaded for the unit tests.
//
// PROP-003 ##CONVENTIONS-SINGLE-DEFINITION: there is one definition of the
// enumerations, and the tests read it rather than restating it. A test that
// invents its own marker forms would pass while the shipped file is wrong.
// Since PROP-016 that definition has two halves - the shipped file and the
// project type's defaults - and the loader is what puts them together.

import { projectType as vscodeType } from '@codkit/type-vscode';
import { loadConventions } from '../../src/lib/conventionsFile.ts';
import type { MarkerConventions } from '../../src/lib/markers.ts';
import type { PatchConventions } from '../../src/lib/patchFormat.ts';

export type TestConventions = MarkerConventions & PatchConventions;

/** The engine's conventions composed with the vscode type, once per process. */
export function conventions(): TestConventions {
	return loadConventions(vscodeType);
}

/** A conventions object with one field replaced, for the negative cases. */
export function conventionsWith(overrides: Partial<TestConventions>): TestConventions {
	return { ...conventions(), ...overrides };
}
