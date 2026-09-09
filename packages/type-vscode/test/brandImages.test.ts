// The brand image set as data: one pattern per file, a codec for every
// container the patterns name, and roles worded without a downstream product
// (modules/vscode/PROP-006 ##IMAGESET-TARGET-DISCOVERY, ##DECISION-IMAGESET-ROLE-TABLE).

import { describe, expect, it } from 'vitest';
import { brandImages, codecs, familyNotes, targets } from '../src/brandImages.ts';

describe('the target table', () => {
	it('covers the five families of the brand surface', () => {
		expect([...new Set(targets.map((target) => target.family))].sort()).toEqual([
			'filetype',
			'icon',
			'installer-big',
			'installer-small',
			'letterpress'
		]);
	});

	it('names every path once, so no file can end up in two families', () => {
		expect(new Set(targets.map((target) => target.path)).size).toBe(targets.length);
	});

	it('keeps the application icon out of the file-type globs by an explicit exclusion', () => {
		const filetypes = targets.filter((target) => target.family === 'filetype');
		expect(filetypes.flatMap((target) => target.exclude ?? [])).toEqual(['code.ico', 'code.icns']);
	});

	it('takes the artwork from the file stem exactly where a family holds several drawings', () => {
		const several = new Set(['filetype', 'letterpress']);
		for (const target of targets) {
			expect(target.artworkFromStem !== undefined, target.path).toBe(several.has(target.family));
		}
	});

	it('says where a person sees each image without naming a downstream product', () => {
		for (const target of targets) {
			expect(target.role.length, target.path).toBeGreaterThan(0);
			expect(/vs ?code|visual studio/i.test(target.role), target.path).toBe(false);
		}
		expect(familyNotes.length).toBe(4);
	});
});

describe('the codecs', () => {
	it('has one codec per container the targets name, and none spare', () => {
		expect([...new Set(codecs.map((codec) => codec.kind))].sort()).toEqual(['bmp', 'icns', 'ico', 'png', 'svg', 'xpm']);
		for (const target of targets) {
			expect(
				codecs.some((codec) => codec.kind === target.kind),
				target.path
			).toBe(true);
		}
	});

	it('marks exactly the containers a guard compares frame by frame', () => {
		expect(
			codecs
				.filter((codec) => codec.layered)
				.map((codec) => codec.kind)
				.sort()
		).toEqual(['icns', 'ico']);
	});

	it('writes each container with its own extension', () => {
		for (const codec of codecs) {
			expect(codec.extension).toBe(`.${codec.kind}`);
		}
	});

	it('is the area the type declares alongside its capability', () => {
		expect(brandImages.targets).toBe(targets);
		expect(brandImages.codecs).toBe(codecs);
	});
});
