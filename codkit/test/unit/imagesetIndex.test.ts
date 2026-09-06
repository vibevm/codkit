// The read-only index (PROP-007 ##IMAGESET-INDEX): the three states of the
// masters directory - absent, freshly seeded, and carrying a hand-made
// per-size master - and the one property that makes the document trustworthy:
// the Markdown and the envelope are two renderings of one model.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildImagesetIndex, indexData, renderImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import type { ImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import { encodePng } from '../../src/lib/imagesetPng.ts';
import { seedMasters } from '../../src/lib/imagesetMasters.ts';
import { discoverTargets } from '../../src/lib/imagesetTargets.ts';
import { makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

function indexOf(label: string, prepare?: (brandingDir: string, treeDir: string) => void): ImagesetIndex {
	const tree = makeImagesetTree(label);
	const brandingDir = join(makeTempRoot(`${label}-branding`), 'branding');
	prepare?.(brandingDir, tree.dir);
	return buildImagesetIndex({ treeDir: tree.dir, brandingDir, onReport: () => {} });
}

/** A flat square PNG, the shape an operator hand-draws for a small size. */
function squarePng(size: number): Uint8Array {
	const data = new Uint8Array(size * size * 4);
	for (let at = 0; at < data.length; at += 4) {
		data[at] = 200;
		data[at + 1] = 30;
		data[at + 2] = 30;
		data[at + 3] = 255;
	}
	return encodePng({ width: size, height: size, data });
}

const sizeLines = (index: ImagesetIndex) =>
	index.targets.flatMap((target) =>
		target.sizes.map((size) => `${target.target} ${size.width}x${size.height} ${size.type ?? '-'} ${size.source} ${size.from ?? '-'}`)
	);

describe('imageset index on a distribution with no masters directory', () => {
	it('lists every target with source missing and names the seeding command', () => {
		const index = indexOf('index-absent');
		expect(index.brandingDirExists).toBe(false);
		expect(index.seedCommand).toBe('codkit imageset gen');
		expect(index.targets.length).toBeGreaterThan(0);
		expect(index.targets.flatMap((target) => target.sizes.map((size) => size.source))).toEqual(
			index.targets.flatMap((target) => target.sizes.map(() => 'missing'))
		);
		expect(index.totals.master).toBe(0);
		expect(index.totals.generated).toBe(0);
		expect(index.totals.missing).toBe(index.targets.reduce((count, target) => count + target.sizes.length, 0));
		expect(renderImagesetIndex(index)).toContain('codkit imageset gen');
	});
});

describe('imageset index after seeding', () => {
	it('reports every size as generated from the seeded base master', () => {
		const index = indexOf('index-seeded', (brandingDir, treeDir) => {
			seedMasters(
				brandingDir,
				treeDir,
				discoverTargets(treeDir, () => {})
			);
		});
		expect(index.brandingDirExists).toBe(true);
		expect([...index.masters]).toEqual(['icon.png', 'installer-big.png', 'installer-small.png']);
		expect(index.totals.master).toBe(0);
		expect(index.totals.missing).toBe(0);
		for (const target of index.targets) {
			for (const size of target.sizes) {
				expect(size.source).toBe('generated');
				expect(size.from).toBe(`${target.family}.png`);
			}
		}
	});
});

describe('imageset index with a hand-made per-size master', () => {
	it('flips exactly the one size that gained a master, and no other line', () => {
		const seed = (brandingDir: string, treeDir: string) => {
			seedMasters(
				brandingDir,
				treeDir,
				discoverTargets(treeDir, () => {})
			);
		};
		const before = indexOf('index-flip-before', seed);
		const after = indexOf('index-flip-after', (brandingDir, treeDir) => {
			seed(brandingDir, treeDir);
			writeFileSync(join(brandingDir, 'icon-16.png'), squarePng(16));
		});
		const beforeLines = sizeLines(before);
		const changed = sizeLines(after).filter((line, at) => line !== beforeLines[at]);
		expect(changed).toEqual(['resources/win32/code.ico 16x16 - master icon-16.png']);
		expect(after.totals.master).toBe(1);
		expect(after.totals.generated).toBe(before.totals.generated - 1);
		expect(renderImagesetIndex(after)).toContain('`icon-16.png`, used verbatim');
	});

	it('names a file the convention does not know instead of silently ignoring it', () => {
		const index = indexOf('index-ignored', (brandingDir, treeDir) => {
			seedMasters(
				brandingDir,
				treeDir,
				discoverTargets(treeDir, () => {})
			);
			writeFileSync(join(brandingDir, 'sketch.jpeg'), 'not a master', 'utf8');
		});
		expect([...index.ignored]).toEqual(['sketch.jpeg']);
		expect(renderImagesetIndex(index)).toContain('sketch.jpeg');
	});
});

describe('one model, two renderings', () => {
	it('carries the same per-size source in the envelope and in the Markdown table', () => {
		const index = indexOf('index-model', (brandingDir, treeDir) => {
			seedMasters(
				brandingDir,
				treeDir,
				discoverTargets(treeDir, () => {})
			);
			writeFileSync(join(brandingDir, 'icon-16.png'), squarePng(16));
		});
		const data = indexData(index) as { targets: { target: string; sizes: { width: number; height: number; source: string }[] }[] };
		const markdown = renderImagesetIndex(index);
		expect(data.targets.length).toBe(index.targets.length);
		for (const target of data.targets) {
			for (const size of target.sizes) {
				const row = markdown.split('\n').filter((line) => line.startsWith(`| ${size.width}x${size.height} |`));
				expect(row.some((line) => line.includes(`\`${size.source}\``))).toBe(true);
			}
		}
		// The one hand-made size is master on both sides, and nowhere else.
		const jsonMasters = data.targets.flatMap((target) => target.sizes.filter((size) => size.source === 'master'));
		expect(jsonMasters).toHaveLength(1);
		expect(markdown.split('\n').filter((line) => line.includes('| `master` |'))).toHaveLength(1);
	});

	it('states the preference rule with the measurement that justifies it', () => {
		const markdown = renderImagesetIndex(indexOf('index-rule'));
		expect(markdown).toContain('Hand-made masters win over generated sizes');
		expect(markdown).toContain('65.6 / 255');
		expect(markdown).toContain('1.0-2.3 / 255');
	});

	it('describes a role for every target without naming any downstream product', () => {
		const index = indexOf('index-roles');
		const markdown = renderImagesetIndex(index).toLowerCase();
		for (const target of index.targets) {
			expect(target.role.length).toBeGreaterThan(0);
		}
		// The role table is codkit's knowledge of the distribution's layout; a
		// product name in it would leak a downstream brand into a generic tool.
		for (const forbidden of ['visual studio', 'vscode', 'vs code']) {
			expect(markdown).not.toContain(forbidden);
		}
	});
});
