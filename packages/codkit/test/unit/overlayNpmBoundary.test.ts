import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { loadOverlays } from '../../src/lib/layers/overlay.ts';
import { projectType, stubType } from '../fixtures/stubType.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'codkit-overlay-family-'));
	roots.push(root);
	mkdirSync(join(root, 'delta', 'overlays'), { recursive: true });
	writeFileSync(
		join(root, 'delta', 'overlays', 'package.overlay.json'),
		JSON.stringify({
			codkitOverlay: 2,
			id: 'CK-build-901',
			target: 'package.json',
			type: 'modify',
			category: 'own',
			owner: 'build',
			reason: 'fixture dependency identity',
			link: 'none',
			cause: 'none',
			pin: `t1@${'a'.repeat(40)}`,
			contractTests: ['guard.dependencies'],
			operations: [{ op: 'set', path: ['dependencies', 'own-package'], value: '1.0.0', expectUpstream: '0.0.0' }]
		})
	);
	return root;
}

it('does not impose npm lockfile pairing on a type with an unrestricted application manifest', () => {
	const type = stubType({
		layers: {
			...projectType.layers,
			overlayTargets: [...projectType.layers.overlayTargets, { path: 'package.json', devChannel: null, stampedKeys: [], allowedKeys: null }]
		}
	});
	expect(loadOverlays(fixture(), type)).toHaveLength(1);
});

it('retains pairing refusal for a declared npm manifest/lockfile pair', () => {
	const type = stubType({
		layers: {
			...projectType.layers,
			overlayTargets: [
				...projectType.layers.overlayTargets,
				{ path: 'package.json', devChannel: null, stampedKeys: [], allowedKeys: [], allowedDependencyUpdates: ['dependencies'] },
				{ path: 'package-lock.json', devChannel: null, stampedKeys: [], allowedKeys: [], npmLockfile: true }
			]
		}
	});
	expect(() => loadOverlays(fixture(), type)).toThrow('matching dependency-free lockfile update');
});
