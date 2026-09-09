// The open half of the extraction: the container behaviour and the advisory
// readings still live in the engine, and the type refuses to pretend otherwise
// until phase P2-3 (modules/codkit/PROP-016 ##TYPE-ENGINE-IS-BLIND).

import { describe, expect, it } from 'vitest';
import { advisory } from '../src/advisory.ts';
import { codecs } from '../src/brandImages.ts';
import { DEFERRED_PHASE } from '../src/deferred.ts';

describe("the answers that are still the engine's", () => {
	it('refuses a codec call and names the phase that moves it', () => {
		for (const codec of codecs) {
			expect(() => codec.parse(new Uint8Array())).toThrow(new RegExp(DEFERRED_PHASE));
			expect(() => codec.encode([])).toThrow(/imageset/);
		}
	});

	it('refuses an advisory reading and names the engine module that still owns it', () => {
		for (const reader of advisory.readers) {
			expect(() => reader.read(new Map())).toThrow(/cycleAdvisory/);
			expect(() => reader.meaning(null, null)).toThrow(new RegExp(DEFERRED_PHASE));
		}
	});
});
