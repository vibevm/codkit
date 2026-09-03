// resource-file: the map, its sort order and its two existence rules
// (PROP-005 sec. 6, ##RESOURCE-MAP-FORMAT, ##RESOURCE-GUARD-MANDATORY).

import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertTargetAtPin, loadResourceMap } from '../../src/lib/layers/resource.ts';
import type { ResourceEntry } from '../../src/lib/layers/resource.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

function entry(overrides: Partial<ResourceEntry> = {}): Record<string, unknown> {
	return {
		id: 'CK-product-002',
		target: 'resources/linux/code.png',
		source: 'delta/resources/files/linux/app-icon.png',
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'patchset branding: the application icon',
		link: 'none',
		cause: 'none',
		pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
		contractTests: ['patchset.guard.icon'],
		...overrides
	};
}

/** A patchset root with a map and the source files its entries name. */
function makePatchSetWith(label: string, entries: readonly Record<string, unknown>[], sources: readonly string[]): string {
	const root = makeTempRoot(label);
	for (const source of sources) {
		const absolute = join(root, ...source.split('/'));
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, 'bytes\n');
	}
	const mapPath = join(root, 'delta', 'resources', 'map.json');
	mkdirSync(dirname(mapPath), { recursive: true });
	writeFileSync(mapPath, `${JSON.stringify({ codkitResourceMap: 2, entries }, null, 2)}\n`, 'utf8');
	return root;
}

function failure(run: () => unknown): { code: string; message: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return { code: error.code, message: error.message };
		}
		throw error;
	}
	throw new Error('expected the call to fail');
}

describe('loadResourceMap', () => {
	it('returns null when there is no map', () => {
		expect(loadResourceMap(makeTempRoot('resource-none'))).toBeNull();
	});

	it('reads a valid map', () => {
		const root = makePatchSetWith('resource-ok', [entry()], ['delta/resources/files/linux/app-icon.png']);
		const map = loadResourceMap(root);
		expect(map?.entries.length).toBe(1);
		expect(map?.entries[0]?.id).toBe('CK-product-002');
		expect(map?.wasSorted).toBe(true);
	});

	it('sorts by target and says the file was not sorted', () => {
		const root = makePatchSetWith(
			'resource-unsorted',
			[entry({ id: 'CK-product-003', target: 'resources/win32/code.ico', source: 'delta/resources/files/win32/app.ico' }), entry()],
			['delta/resources/files/linux/app-icon.png', 'delta/resources/files/win32/app.ico']
		);
		const map = loadResourceMap(root);
		expect(map?.entries.map((item) => item.target)).toEqual(['resources/linux/code.png', 'resources/win32/code.ico']);
		expect(map?.wasSorted).toBe(false);
	});

	it('requires a guard test on every entry', () => {
		const root = makePatchSetWith('resource-noguard', [entry({ contractTests: [] })], ['delta/resources/files/linux/app-icon.png']);
		const broken = failure(() => loadResourceMap(root));
		expect(broken.code).toBe('ARTIFACT-BROKEN');
		expect(broken.message).toContain('entries[0].contractTests');
	});

	it('refuses a source outside delta/resources/files/', () => {
		const root = makePatchSetWith('resource-outside', [entry({ source: 'delta/own/app-icon.png' })], ['delta/own/app-icon.png']);
		const broken = failure(() => loadResourceMap(root));
		expect(broken.code).toBe('ARTIFACT-BROKEN');
		expect(broken.message).toContain('outside delta/resources/files/');
	});

	it('refuses a traversal that only has the allowed textual prefix', () => {
		const root = makePatchSetWith('resource-traversal', [entry({ source: 'delta/resources/files/../../../secret.txt' })], ['secret.txt']);
		const broken = failure(() => loadResourceMap(root));

		expect(broken.code).toBe('ARTIFACT-BROKEN');
		expect(broken.message).toContain('source');
	});

	it('refuses a resource source symlink before reading its target', () => {
		const source = 'delta/resources/files/linux/app-icon.png';
		const root = makePatchSetWith('resource-symlink', [entry({ source })], [source]);
		const outside = makeTempRoot('resource-symlink-outside');
		const secret = join(outside, 'secret.txt');
		writeFileSync(secret, 'must not enter a generated commit\n', 'utf8');
		const link = join(root, ...source.split('/'));
		rmSync(link);
		symlinkSync(secret, link);

		const broken = failure(() => loadResourceMap(root));
		expect(broken.code).toBe('ARTIFACT-BROKEN');
		expect(broken.message).toContain('symlink');
	});

	it('refuses a source that does not exist', () => {
		const root = makePatchSetWith('resource-missing', [entry()], []);
		const broken = failure(() => loadResourceMap(root));
		expect(broken.code).toBe('ARTIFACT-BROKEN');
		expect(broken.message).toContain('does not exist in patchset');
	});
});

describe('assertTargetAtPin', () => {
	it('accepts a target that exists at the pin and refuses one that does not', () => {
		const upstream = makeUpstream(makeTempRoot('resource-upstream'));
		const present = entry({ target: 'resources/app-icon.bin' }) as unknown as ResourceEntry;
		expect(() => assertTargetAtPin(upstream.dir, upstream.t1.sha, present)).not.toThrow();

		const absent = entry({ target: 'resources/not-there.png' }) as unknown as ResourceEntry;
		const broken = failure(() => assertTargetAtPin(upstream.dir, upstream.t1.sha, absent));
		expect(broken.code).toBe('ARTIFACT-BROKEN');
		expect(broken.message).toContain('does not exist at the pin');
	});
});
