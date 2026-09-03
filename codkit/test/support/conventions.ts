// The real conventions.json, loaded for the unit tests.
//
// PROP-003 ##CONVENTIONS-SINGLE-DEFINITION: there is one definition of the
// enumerations, and the tests read it rather than restating it. A test that
// invents its own marker forms would pass while the shipped file is wrong.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { MarkerConventions } from '../../src/lib/markers.ts';
import type { PatchConventions } from '../../src/lib/patchFormat.ts';

export type TestConventions = MarkerConventions & PatchConventions;

const codkitRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const schema = z.object({
	idPattern: z.string().min(1),
	interventionTypes: z.array(z.string()).min(1),
	categories: z.array(z.string()).min(1),
	markerComment: z.record(z.string(), z.unknown())
});

let cached: TestConventions | null = null;

/** codkit/config/conventions.json, parsed once per test process. */
export function conventions(): TestConventions {
	if (cached === null) {
		const raw: unknown = JSON.parse(readFileSync(join(codkitRoot, 'config', 'conventions.json'), 'utf8'));
		cached = schema.parse(raw);
	}
	return cached;
}

/** A conventions object with one field replaced, for the negative cases. */
export function conventionsWith(overrides: Partial<TestConventions>): TestConventions {
	return { ...conventions(), ...overrides };
}
