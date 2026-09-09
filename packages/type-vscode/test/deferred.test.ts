// The open half of the extraction: the advisory readings still live in the
// engine, and the type refuses to pretend otherwise until phase P2-3
// (modules/codkit/PROP-016 ##TYPE-ENGINE-IS-BLIND). The container behaviour is
// answered here now, so it is no longer on this list.

import { describe, expect, it } from 'vitest';
import { advisory } from '../src/advisory.ts';
import { DEFERRED_PHASE } from '../src/deferred.ts';

describe("the answers that are still the engine's", () => {
	it('refuses an advisory reading and names the engine module that still owns it', () => {
		for (const reader of advisory.readers) {
			expect(() => reader.read(new Map())).toThrow(/cycleAdvisory/);
			expect(() => reader.meaning(null, null)).toThrow(new RegExp(DEFERRED_PHASE));
		}
	});
});
