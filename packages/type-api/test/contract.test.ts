// The contract's own gate: the shape rules a type must satisfy before the
// engine will trust it (##TYPE-CONTRACT-IS-CLOSED, ##TYPE-TERM-CAPABILITY).

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CAPABILITIES, isCapability } from '../src/capabilities.ts';
import { OPTIONAL_AREAS, projectTypeProblems } from '../src/projectType.ts';
import type { Capability } from '../src/capabilities.ts';
import type { ProjectType } from '../src/projectType.ts';

/** The smallest well-formed type: no optional area, no optional layer. */
function bareType(overrides: Partial<ProjectType> = {}): ProjectType {
	const base: ProjectType = {
		id: 'bare',
		capabilities: new Set<Capability>(),
		configSchema: z.object({ ownRoot: z.string().min(1) }),
		identity: { tagPattern: /^v\d+$/u, tagShape: 'v<number>', fingerprints: [] },
		layout: {
			ownRootProblem: () => null,
			ownRoots: (config) => [{ path: config.ownRoot, role: 'own', buildOutputs: [] }],
			ownExtensionPath: () => null,
			cleanupWhitelist: [],
			forbiddenPatchTargets: []
		},
		layers: { overlayTargets: [], ownExtensions: null, serviceOverride: null, entryModule: null },
		build: {
			install: [],
			dependencyRoots: [],
			hygiene: [],
			ownTests: () => null,
			packageBuild: [],
			packageDistributable: [],
			packageStamps: [],
			packageOutputs: [],
			watchProfilePath: 'config/build-watch.json',
			foreignWatcherMarkers: []
		},
		advisory: { readers: [] },
		standards: { packages: [] },
		conventions: { subsystems: [], forbiddenServiceIds: [] },
		generators: { featureSkeleton: () => ({ directory: 'delta/own/x', modules: [], importLine: '', reminders: [] }) }
	};
	return { ...base, ...overrides };
}

describe('capability names', () => {
	it('are a closed list with no duplicate', () => {
		expect(new Set(CAPABILITIES).size).toBe(CAPABILITIES.length);
		expect([...CAPABILITIES].sort()).toEqual([
			'brand-images',
			'build-channels',
			'config-overlay',
			'dev-channel',
			'entry-module',
			'gen-brand',
			'own-extensions',
			'runtime-library',
			'service-override',
			'upgrade-advisory'
		]);
	});

	it('recognise their own members and nothing else', () => {
		for (const name of CAPABILITIES) expect(isCapability(name)).toBe(true);
		expect(isCapability('brand-image')).toBe(false);
		expect(isCapability('')).toBe(false);
	});
});

describe('the shape gate of a type', () => {
	it('passes a type that declares nothing and answers nothing', () => {
		expect(projectTypeProblems(bareType())).toEqual([]);
	});

	it('names an optional area answered without its capability', () => {
		const type = bareType({ runtime: { packageId: 'runtime-bare', targetDirName: 'codkit', nextSteps: () => [] } });
		expect(projectTypeProblems(type)).toEqual(['bare: runtime is answered but the capability runtime-library is not declared']);
	});

	it('names a capability declared without its area, for every optional area', () => {
		for (const { area, capability } of OPTIONAL_AREAS) {
			const type = bareType({ capabilities: new Set<Capability>([capability]) });
			expect(projectTypeProblems(type)).toEqual([`bare: the capability ${capability} is declared but ${area} is not answered`]);
		}
	});

	it('names a layer answered without its capability', () => {
		const type = bareType({
			layers: {
				overlayTargets: [],
				ownExtensions: null,
				serviceOverride: null,
				entryModule: { entries: ['src/main.ts'], why: 'the composition root' }
			}
		});
		expect(projectTypeProblems(type)).toEqual(['bare: layers.entryModule is answered but the capability entry-module is not declared']);
	});

	it('ties overlay targets and their dev channel to their capabilities', () => {
		const withOverlay = bareType({
			capabilities: new Set<Capability>(['config-overlay']),
			layers: {
				overlayTargets: [{ path: 'app.json', devChannel: 'app.overrides.json', stampedKeys: [], allowedKeys: null }],
				ownExtensions: null,
				serviceOverride: null,
				entryModule: null
			}
		});
		expect(projectTypeProblems(withOverlay)).toEqual([
			'bare: a dev channel on an overlay target and the capability dev-channel must agree'
		]);
	});

	it('ties advisory readers to the upgrade-advisory capability', () => {
		const type = bareType({
			advisory: {
				readers: [{ id: 'toolchain', paths: ['toolchain'], changeIsNews: true, read: () => null, meaning: () => null }]
			}
		});
		expect(projectTypeProblems(type)).toEqual(['bare: advisory readers and the capability upgrade-advisory must agree']);
	});

	it('ties the brand graft to the gen-brand capability', () => {
		const declared = bareType({ capabilities: new Set<Capability>(['gen-brand']) });
		expect(projectTypeProblems(declared)).toEqual(['bare: the brand graft and the capability gen-brand must agree']);

		const answered = bareType({
			generators: {
				featureSkeleton: () => ({ directory: 'delta/own/x', modules: [], importLine: '', reminders: [] }),
				brandGraft: () => ({ module: { path: 'delta/own/brand.ts', text: '', role: 'table' }, hookText: '', reminders: [] })
			}
		});
		expect(projectTypeProblems(answered)).toEqual(['bare: the brand graft and the capability gen-brand must agree']);
	});

	it('refuses an image target whose container has no codec', () => {
		const type = bareType({
			capabilities: new Set<Capability>(['brand-images']),
			brandImages: {
				targets: [{ family: 'icon', path: 'resources/icon.png', glob: false, kind: 'png', role: 'the application icon' }],
				codecs: [],
				familyNotes: []
			}
		});
		expect(projectTypeProblems(type)).toEqual(['bare: the image target resources/icon.png needs a codec for png']);
	});

	it('accepts an image target whose container has a codec', () => {
		const type = bareType({
			capabilities: new Set<Capability>(['brand-images']),
			brandImages: {
				targets: [{ family: 'icon', path: 'resources/icon.png', glob: false, kind: 'png', role: 'the application icon' }],
				codecs: [
					{
						kind: 'png',
						extension: '.png',
						layered: false,
						vector: false,
						seedsMasters: true,
						constraints: [],
						parse: () => [],
						legacyTypes: () => [],
						extract: () => [],
						encode: () => new Uint8Array()
					}
				],
				familyNotes: []
			}
		});
		expect(projectTypeProblems(type)).toEqual([]);
	});
});

describe('the owned directories', () => {
	it('accepts one owned directory that is the own root itself', () => {
		expect(projectTypeProblems(bareType())).toEqual([]);
	});

	it('accepts a second owned directory with its own role and build outputs', () => {
		const type = bareType({
			layout: {
				ownRootProblem: () => null,
				ownRoots: (config) => [
					{ path: config.ownRoot, role: 'own', buildOutputs: ['lib/**'] },
					{ path: 'applications/product', role: 'application', buildOutputs: ['lib/**', 'src-gen/**'] }
				],
				ownExtensionPath: () => null,
				cleanupWhitelist: [],
				forbiddenPatchTargets: []
			}
		});
		expect(projectTypeProblems(type)).toEqual([]);
	});

	it('refuses an answer that does not begin with the own root', () => {
		const type = bareType({
			layout: {
				ownRootProblem: () => null,
				ownRoots: () => [{ path: 'applications/product', role: 'application', buildOutputs: [] }],
				ownExtensionPath: () => null,
				cleanupWhitelist: [],
				forbiddenPatchTargets: []
			}
		});
		expect(projectTypeProblems(type)).toEqual(['bare: the first owned directory must be the own root itself, with the role own']);
	});

	it('refuses an owned directory that sits inside another', () => {
		const type = bareType({
			layout: {
				ownRootProblem: () => null,
				ownRoots: (config) => [
					{ path: config.ownRoot, role: 'own', buildOutputs: [] },
					{ path: `${config.ownRoot}/inside`, role: 'application', buildOutputs: [] }
				],
				ownExtensionPath: () => null,
				cleanupWhitelist: [],
				forbiddenPatchTargets: []
			}
		});
		expect(projectTypeProblems(type)).toEqual([
			'bare: the owned directory codkit-probe/own-root/inside sits inside the owned directory codkit-probe/own-root'
		]);
	});
});

describe('the typeConfig schema', () => {
	it('is the gate of the type over typeConfig and refuses by field', () => {
		const parsed = bareType().configSchema.safeParse({ ownRoot: '' });
		expect(parsed.success).toBe(false);
	});
});
