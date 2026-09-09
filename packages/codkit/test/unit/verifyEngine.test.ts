// unit: the verify engine - one case per check of PROP-007 sec. 11.
//
// The fixture delta is healthy, so the first case is the one that matters most:
// a correct delta produces no findings at all. Every other case breaks exactly
// one thing and asserts that exactly that check speaks, because a verifier whose
// findings do not point at the mistake is worse than no verifier.
//
// The tree is a real one, brought to the pin and carrying the generated branch,
// which is what the completeness check of PROP-006 sec. 6 needs: the branch is
// the record of what was applied.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runVerify } from '../../src/lib/verifyEngine.ts';
import type { Finding } from '../../src/lib/verifyEngine.ts';
import { APP_ICON } from '../fixtures/makeUpstream.ts';
import { OWN_UNIT_ID, PATCH_FILE_NAME, PATCH_ID, REMOVED_ID, RESOURCE_ID, RULE_ID } from '../fixtures/makePatchSet.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import type { SyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';
import type { Capability, ProjectType } from '@codkit/type-api';
import { isCkError } from '../../src/lib/messages.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

let fixture: SyncFixture;

const RULE_ARTIFACT = 'delta/rules/example.ckrule.json';
const OVERLAY_ARTIFACT = 'delta/overlays/product.json.overlay.json';
const RESOURCE_ARTIFACT = 'delta/resources/map.json';
const OWN_MANIFEST_ARTIFACT = 'delta/own/patchset.delta.json';
const REMOVED_ARTIFACT = 'delta/removed.json';
const CONFIG_ARTIFACT = 'codkit.json';
const PATCH_ARTIFACT = `delta/patches/${PATCH_FILE_NAME}`;

beforeAll(() => {
	fixture = makeSyncFixture('verify');
	const applied = fixture.sync();
	expect(applied.exitCode).toBe(0);
});

afterAll(cleanupTempRoots);

function verify(): readonly Finding[] {
	return runVerify({ patchesDir: fixture.patchesDir, resolution: fixture.resolution, config: fixture.config, type: vscodeType }).findings;
}

/** The same run under a type that answers no optional layer at all. */
function verifyUnder(capabilities: readonly Capability[]): unknown {
	const type: ProjectType = { ...vscodeType, id: 'stub', capabilities: new Set(capabilities) };
	try {
		runVerify({ patchesDir: fixture.patchesDir, resolution: fixture.resolution, config: fixture.config, type });
	} catch (error) {
		return error;
	}
	return null;
}

/** Edit a delta file, verify, and put the file back whatever happens. */
function withEdit<T>(relative: string, edit: (text: string) => string, body: () => T): T {
	const path = join(fixture.patchesDir, ...relative.split('/'));
	const saved = readFileSync(path, 'utf8');
	try {
		writeFileSync(path, edit(saved), 'utf8');
		return body();
	} finally {
		writeFileSync(path, saved, 'utf8');
	}
}

/** Add a delta file, verify, and remove it again. */
function withFile<T>(relative: string, content: string, body: () => T): T {
	const path = join(fixture.patchesDir, ...relative.split('/'));
	mkdirSync(dirname(path), { recursive: true });
	try {
		writeFileSync(path, content, 'utf8');
		return body();
	} finally {
		rmSync(path, { force: true });
	}
}

function codes(findings: readonly Finding[]): readonly string[] {
	return [...new Set(findings.map((item) => item.code))].sort();
}

function compactJson(text: string): string {
	return `${JSON.stringify(JSON.parse(text))}\n`;
}

describe('a healthy delta', () => {
	it('produces no findings at all', () => {
		expect(verify()).toEqual([]);
	});

	it('warns instead of failing when the generated branch is not there yet', () => {
		const result = runVerify({
			patchesDir: fixture.patchesDir,
			resolution: fixture.resolution,
			config: { ...fixture.config, pin: { ...fixture.config.pin, tag: 'never-synced' } },
			type: vscodeType
		});
		expect(result.warnings.join('\n')).toContain('run codkit load first');
	});
});

describe('(a) JSON metadata has canonical bytes before a cycle starts', () => {
	it('fails closed on malformed metadata before cross-checking the delta', () => {
		expect(() => withEdit(OVERLAY_ARTIFACT, () => '{\n', verify)).toThrow(/is not valid JSON/);
	});

	it.each([OVERLAY_ARTIFACT, RESOURCE_ARTIFACT, RULE_ARTIFACT, OWN_MANIFEST_ARTIFACT, REMOVED_ARTIFACT])(
		'reports a semantic no-op reformat of %s',
		(artifact) => {
			const findings = withEdit(artifact, compactJson, verify);

			expect(codes(findings)).toEqual(['ARTIFACT-BROKEN']);
			expect(findings[0]?.file).toBe(artifact);
			expect(findings[0]?.message).toContain('metadata bytes are not canonical JSON');
		}
	);

	it('reports a semantic no-op reformat of the base config', () => {
		const findings = withEdit(CONFIG_ARTIFACT, compactJson, verify);

		expect(codes(findings)).toEqual(['CONFIG']);
		expect(findings[0]?.file).toBe(CONFIG_ARTIFACT);
		expect(findings[0]?.message).toContain('metadata bytes are not canonical JSON');
	});
});

describe('(b) ids are unique across the layers', () => {
	it('reports two records that share one id', () => {
		const findings = withEdit(REMOVED_ARTIFACT, (text) => text.split(REMOVED_ID).join(PATCH_ID), verify);

		expect(codes(findings)).toEqual(['MARKER-DUP-ID']);
		expect(findings[0]?.message).toContain(PATCH_ID);
		expect(findings[0]?.message).toContain(REMOVED_ARTIFACT);
	});
});

describe('(c) every owner is declared', () => {
	it('reports an owner that owners.json does not carry', () => {
		const findings = withEdit(RULE_ARTIFACT, (text) => text.split('"workbench-core"').join('"nobody"'), verify);

		expect(codes(findings)).toEqual(['OWNER-UNKNOWN']);
		expect(findings[0]?.message).toContain(`${RULE_ID}: owner "nobody"`);
		expect(findings[0]?.file).toBe(RULE_ARTIFACT);
	});
});

describe('(d) markers', () => {
	it('accepts an entry-module patch whose block carries an entry-module id', () => {
		// ##MR-NO-NESTING: one id may cover blocks in several files only for that
		// layer, so the ids of the entry-module patches are allowed in each
		// other's files - and nowhere else.
		const findings = withEdit(
			PATCH_ARTIFACT,
			(text) => text.replace(`# id: ${PATCH_ID}\n`, `# id: ${PATCH_ID}\n# layer: entry-module\n`),
			verify
		);
		expect(findings).toEqual([]);
	});

	it('reports a block that belongs to no artifact of this delta', () => {
		// The header keeps its id; only the block the patch adds is renamed.
		const rename = (text: string): string =>
			text
				.split(`codkit:begin ${PATCH_ID}`)
				.join('codkit:begin CK-workbench-999')
				.split(`codkit:end ${PATCH_ID}`)
				.join('codkit:end CK-workbench-999');
		const findings = withEdit(PATCH_ARTIFACT, rename, verify);

		// The block now carries an id no artifact declares, and the artifact's own
		// id appears in no block: the two directions of the same check.
		expect(codes(findings)).toEqual(['MARKER-ARTIFACT-MISMATCH']);
	});
});

describe('(e) the guarded records carry a guard test', () => {
	it('reports a guard id that no own test declares', () => {
		const findings = withEdit(OVERLAY_ARTIFACT, (text) => text.split('fixture.guard.product').join('fixture.guard.absent'), verify);

		expect(codes(findings)).toEqual(['GUARD-MISSING']);
		expect(findings[0]?.message).toContain('fixture.guard.absent');
		expect(findings[0]?.file).toBe(OVERLAY_ARTIFACT);
	});

	it('reports an empty contractTests on a hide record of any layer', () => {
		// The patch layer needs no guard until its category says `hide`: the
		// hidden thing is outside the reach of the compiler either way.
		const findings = withEdit(PATCH_ARTIFACT, (text) => text.replace('# category: follow', '# category: hide'), verify);

		expect(codes(findings)).toEqual(['GUARD-MISSING']);
		expect(findings[0]?.message).toContain(`${PATCH_ID}: contractTests is empty`);
	});

	it('reports a removed-registry entry whose guard is gone', () => {
		const findings = withEdit(REMOVED_ARTIFACT, (text) => text.split('fixture.guard.removed').join('fixture.guard.absent'), verify);

		expect(codes(findings)).toEqual(['GUARD-MISSING']);
		expect(findings[0]?.message).toContain('brings the removed thing back in silence');
	});
});

describe('(f) a rule counts what it expects', () => {
	it('reports drift with the per-operation counts', () => {
		const findings = withEdit(RULE_ARTIFACT, (text) => text.replace('"expectedMatches": 1', '"expectedMatches": 5'), verify);

		expect(codes(findings)).toEqual(['RULE-DRIFT']);
		expect(findings[0]?.message).toContain('matches 1 line(s), the rule expects 5');
		expect(findings[0]?.message).toContain('ops[0]');
		expect(findings[0]?.file).toBe(RULE_ARTIFACT);
	});
});

describe('(g) overlays', () => {
	it('reports an expectUpstream that no longer describes the pin', () => {
		const findings = withEdit(OVERLAY_ARTIFACT, (text) => text.replace('"Fixture - OSS"', '"Something Else"'), verify);

		expect(codes(findings)).toEqual(['OVERLAY-DRIFT']);
		expect(findings[0]?.file).toBe(OVERLAY_ARTIFACT);
	});

	it('allows only additions to scripts on a target other than product.json', () => {
		const findings = withFile('delta/overlays/package.json.overlay.json', packageOverlay(['name']), verify);

		expect(codes(findings)).toEqual(['OVERLAY-SCHEMA']);
		expect(findings[0]?.message).toContain('only additions under scripts are allowed for this target');
	});

	it('accepts an addition to scripts on that same target', () => {
		expect(withFile('delta/overlays/package.json.overlay.json', packageOverlay(['scripts', 'patchset-check']), verify)).toEqual([]);
	});
});

describe('(h) own code', () => {
	it('reports an own file that no unit claims', () => {
		const findings = withFile('delta/own/orphan.ts', 'export const orphan = 1;\n', verify);

		expect(codes(findings)).toEqual(['OWN-UNCOVERED']);
		expect(findings[0]?.message).toContain('delta/own/orphan.ts belongs to no unit');
	});

	it('reports an own file that two units claim', () => {
		const findings = withEdit(
			'delta/own/patchset.delta.json',
			(text) => {
				const manifest = JSON.parse(text) as { units: Record<string, unknown>[] };
				const first = manifest.units[0] ?? {};
				manifest.units.push({ ...first, id: 'CK-workbench-905', roots: ['test/'] });
				return `${JSON.stringify(manifest, null, 2)}\n`;
			},
			verify
		);

		expect(findings.some((item) => item.code === 'OWN-UNCOVERED' && item.message.includes('claimed by more than one unit'))).toBe(true);
	});

	it('reports a registerSingleton of a service that must not be overridden', () => {
		const source = [
			"import { registerSingleton } from '../platform.ts';",
			'',
			'registerSingleton(IFileService, FixtureFileService, 0);',
			''
		].join('\n');
		const findings = withFile('delta/own/test/forbidden.ts', source, verify);

		expect(codes(findings)).toEqual(['FORBIDDEN-SERVICE']);
		expect(findings[0]?.message).toContain('registerSingleton(IFileService)');
		expect(findings[0]?.file).toBe('delta/own/test/forbidden.ts');
		expect(findings[0]?.line).toBe(3);
	});

	it('reports a multiline registerSingleton of a forbidden service', () => {
		const source = [
			"import { registerSingleton } from '../platform.ts';",
			'',
			'registerSingleton(',
			'\tIFileService,',
			'\tFixtureFileService,',
			'\t0',
			');',
			''
		].join('\n');
		const findings = withFile('delta/own/test/forbidden-multiline.ts', source, verify);

		expect(codes(findings)).toEqual(['FORBIDDEN-SERVICE']);
		expect(findings[0]?.message).toContain('registerSingleton(IFileService)');
		expect(findings[0]?.line).toBe(3);
	});

	it('resolves an imported alias of registerSingleton', () => {
		const source = ["import { registerSingleton as reg } from '../platform.ts';", '', 'reg(IFileService, FixtureFileService, 0);', ''].join(
			'\n'
		);
		const findings = withFile('delta/own/test/forbidden-alias.ts', source, verify);

		expect(codes(findings)).toEqual(['FORBIDDEN-SERVICE']);
		expect(findings[0]?.line).toBe(3);
	});

	it('ignores registerSingleton text in comments and strings', () => {
		const source = [
			'// registerSingleton(IFileService, FixtureFileService, 0);',
			'const example = "registerSingleton(IFileService, FixtureFileService, 0)";',
			'/*',
			'registerSingleton(',
			'\tIFileService,',
			'\tFixtureFileService,',
			'\t0',
			');',
			'*/',
			''
		].join('\n');

		expect(withFile('delta/own/test/not-a-registration.ts', source, verify)).toEqual([]);
	});

	it('reports a service override whose named module is not delivered', () => {
		const findings = withEdit('delta/own/patchset.delta.json', (text) => addServiceOverride(text, 'services/missing.override.ts'), verify);
		const missing = findings.filter((item) => item.code === 'OWN-UNCOVERED' && item.message.includes('service override module'));

		expect(missing).toHaveLength(1);
		expect(missing[0]?.message).toContain('delta/own/services/missing.override.ts is not a delivered own file');
		expect(missing[0]?.file).toBe('delta/own/patchset.delta.json');
	});

	it('reports when the named override module does not register the declared service id', () => {
		const source = 'registerSingleton(IOtherService, FixtureService, 0);\n';
		const findings = withFile('delta/own/test/service.override.ts', source, () =>
			withEdit('delta/own/patchset.delta.json', (text) => addServiceOverride(text, 'test/service.override.ts', 'IFixtureService'), verify)
		);
		const mismatch = findings.filter((item) => item.code === 'ARTIFACT-BROKEN' && item.message.includes('service override declares'));

		expect(mismatch).toHaveLength(1);
		expect(mismatch[0]?.message).toContain('does not call registerSingleton(IFixtureService)');
		expect(mismatch[0]?.file).toBe('delta/own/test/service.override.ts');
	});

	it('accepts the declared service id when the named module registers it', () => {
		const source = 'registerSingleton(IFixtureService, FixtureService, 0);\n';
		const findings = withFile('delta/own/test/service.override.ts', source, () =>
			withEdit('delta/own/patchset.delta.json', (text) => addServiceOverride(text, 'test/service.override.ts'), verify)
		);

		expect(findings.filter((item) => item.code === 'ARTIFACT-BROKEN' || item.code === 'OWN-UNCOVERED')).toEqual([]);
	});

	it('accepts the declared service id through an imported alias', () => {
		const source = ["import { registerSingleton as reg } from '../platform.ts';", 'reg(IFixtureService, FixtureService, 0);', ''].join(
			'\n'
		);
		const findings = withFile('delta/own/test/service.override.ts', source, () =>
			withEdit('delta/own/patchset.delta.json', (text) => addServiceOverride(text, 'test/service.override.ts'), verify)
		);

		expect(findings.filter((item) => item.code === 'ARTIFACT-BROKEN' || item.code === 'OWN-UNCOVERED')).toEqual([]);
	});

	it('reports a delivered override module outside every own unit', () => {
		const source = 'registerSingleton(IFixtureService, FixtureService, 0);\n';
		const findings = withFile('delta/own/services/service.override.ts', source, () =>
			withEdit('delta/own/patchset.delta.json', (text) => addServiceOverride(text, 'services/service.override.ts'), verify)
		);
		const uncovered = findings.filter((item) => item.code === 'OWN-UNCOVERED' && item.message.includes('service override module'));

		expect(uncovered).toHaveLength(1);
		expect(uncovered[0]?.message).toContain('claimed by no own unit; exactly one is required');
	});
});

describe('(h2) what codkit delivered into the own layer', () => {
	const RUNTIME_FILE = 'delta/own/codkit/common/version.ts';

	/** Put one file where the delivered library lives, then remove the whole root. */
	function withRuntimeCopy<T>(body: () => T): T {
		const root = join(fixture.patchesDir, 'delta', 'own', 'codkit');
		const path = join(root, 'common', 'version.ts');
		mkdirSync(dirname(path), { recursive: true });
		try {
			writeFileSync(path, "export const CODKIT_RUNTIME_VERSION = '0.0.1';\n", 'utf8');
			return body();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it('reports an installed runtime library that is not what codkit ships', () => {
		// PROP-015 ##RT-DELIVERED-NOT-OWN: the copy is managed, so anything but
		// byte equality with the shipped library is drift.
		const drift = withRuntimeCopy(verify).filter((item) => item.code === 'RUNTIME-DRIFT');

		expect(drift.length).toBeGreaterThan(0);
		expect(drift.some((item) => item.file === RUNTIME_FILE)).toBe(true);
		expect(drift[0]?.hint).toContain('codkit runtime load --upgrade');
	});

	it('does not ask a unit to declare the files codkit delivered', () => {
		expect(withRuntimeCopy(verify).filter((item) => item.code === 'OWN-UNCOVERED')).toEqual([]);
	});

	it('says nothing about the runtime library when the product has not installed it', () => {
		expect(verify().filter((item) => item.code === 'RUNTIME-DRIFT')).toEqual([]);
	});

	it('refuses a unit whose root is inside the codkit root', () => {
		// PROP-005 ##OWN-CODKIT-PREFIX-RESERVED: product files there would fall
		// inside the scope the codkit licence notice claims by path.
		const findings = withEdit(OWN_MANIFEST_ARTIFACT, (text) => text.replace('"roots": [', '"roots": [\n        "codkit/extra/",'), verify);
		const under = findings.filter((item) => item.code === 'OWN-UNDER-CODKIT');

		expect(under).toHaveLength(1);
		expect(under[0]?.message).toContain(`${OWN_UNIT_ID}: root codkit/extra/ is inside codkit/`);
		expect(under[0]?.file).toBe(OWN_MANIFEST_ARTIFACT);
	});

	it('refuses a service override whose module is inside the codkit root', () => {
		const findings = withEdit(OWN_MANIFEST_ARTIFACT, (text) => addServiceOverride(text, 'codkit/browser/mine.ts'), verify);
		const under = findings.filter((item) => item.code === 'OWN-UNDER-CODKIT');

		expect(under).toHaveLength(1);
		expect(under[0]?.message).toContain('module codkit/browser/mine.ts is inside codkit/');
	});
});

describe('(h3) the graft budget of a hook patch', () => {
	const COMMENT_LINE = '+\t\t// (hook body lives in patchset/ own code; this block only delegates)';

	/** Replace the one line the fixture grafts, keeping the hunk counts honest. */
	function withGraft<T>(lines: readonly string[], body: () => T): T {
		return withEdit(
			PATCH_ARTIFACT,
			(text) =>
				text
					.replace(
						/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@(.*)$/mu,
						(_match, oldStart, oldCount, newStart, newCount, rest) =>
							`@@ -${oldStart},${oldCount} +${newStart},${Number(newCount) + lines.length - 1} @@${rest}`
					)
					.replace(COMMENT_LINE, lines.map((line) => `+\t\t${line}`).join('\n')),
			body
		);
	}

	it('says nothing about the fixture hook, which names own code and carries no logic', () => {
		expect(verify().filter((item) => item.code === 'HOOK-TOO-LARGE')).toEqual([]);
	});

	it('reports a hook that carries more than three lines of code, with the number', () => {
		// PROP-005 ##PATCH-HOOK-BUDGET: the logic belongs in own code, and the
		// patch is only the seam that reaches it.
		const findings = withGraft(
			[
				'const host = this.instantiationService.createInstance(PatchsetHost);',
				'const two = host.first();',
				'const three = host.second();',
				'const four = host.third(); // patchset/ own code',
				''
			],
			verify
		);
		const budget = findings.filter((item) => item.code === 'HOOK-TOO-LARGE');

		expect(budget).toHaveLength(1);
		expect(budget[0]?.message).toContain('4 lines of code');
		expect(budget[0]?.file).toBe(PATCH_ARTIFACT);
	});

	it('reports a hook that names no own path at all, however small it is', () => {
		const findings = withGraft(['this.doItRightHere();'], verify);
		const budget = findings.filter((item) => item.code === 'HOOK-TOO-LARGE');

		expect(budget).toHaveLength(1);
		expect(budget[0]?.message).toContain('names no path under patchset/');
	});

	it('accepts three lines of code when one of them reaches own code', () => {
		const findings = withGraft(["import { hook } from '../../../patchset/hook.js';", 'const done = hook(this);', 'void done;'], verify);

		expect(findings.filter((item) => item.code === 'HOOK-TOO-LARGE')).toEqual([]);
	});
});

describe('(i) no intervention outside the inventory', () => {
	it('reports a change of the branch that no artifact explains', () => {
		// The branch still carries the patch; the artifact that put it there is
		// gone, so nothing in the delta accounts for the changed file.
		const path = join(fixture.patchesDir, ...PATCH_ARTIFACT.split('/'));
		const saved = readFileSync(path, 'utf8');
		try {
			rmSync(path);
			const findings = verify();
			const untracked = findings.filter((item) => item.code === 'UNTRACKED-INTERVENTION');
			expect(untracked).toHaveLength(1);
			expect(untracked[0]?.message).toContain('src/vs/workbench/browser/parts/example/examplePart.ts');
			expect(untracked[0]?.message).toContain('no artifact of the delta explains it');
		} finally {
			writeFileSync(path, saved, 'utf8');
		}
	});

	it('reports an artifact whose target the branch does not carry', () => {
		// A resource whose source is byte-identical to the pin replaces nothing:
		// the generated branch has no change for it, so the entry is stale.
		const source = join(fixture.patchesDir, 'delta', 'resources', 'files', 'app-icon.bin');
		const saved = readFileSync(source);
		try {
			writeFileSync(source, APP_ICON);
			expect(fixture.sync().exitCode).toBe(0);
			const stale = verify().filter((item) => item.code === 'STALE-ARTIFACT');
			expect(stale).toHaveLength(1);
			expect(stale[0]?.message).toContain(RESOURCE_ID);
			expect(stale[0]?.message).toContain('the resource is not replaced');
		} finally {
			writeFileSync(source, saved);
			expect(fixture.sync().exitCode).toBe(0);
		}
	});

	it('is quiet again once the delta and the branch agree', () => {
		expect(verify()).toEqual([]);
	});
});

/** An overlay on the tree's package.json, with one operation at `path`. */
function packageOverlay(path: readonly string[]): string {
	return `${JSON.stringify(
		{
			codkitOverlay: 2,
			id: 'CK-product-903',
			target: 'package.json',
			type: 'modify',
			category: 'own',
			owner: 'product',
			reason: 'fixture: the non-product overlay target and its scripts-only rule',
			link: 'none',
			cause: 'none',
			pin: fixture.config.pin.tag + '@' + fixture.config.pin.sha,
			contractTests: ['fixture.guard.product'],
			operations: [{ op: 'set', path: [...path], value: 'node ./out/check.js' }]
		},
		null,
		2
	)}\n`;
}

function addServiceOverride(text: string, module: string, serviceId = 'IFixtureService'): string {
	const manifest = JSON.parse(text) as {
		units: Array<{
			owner: string;
			reason: string;
			link: string;
			cause: string;
			pin: string;
		}>;
		serviceOverrides: Record<string, unknown>[];
	};
	const unit = manifest.units[0];
	if (unit === undefined) {
		throw new Error('fixture manifest has no own unit');
	}
	manifest.serviceOverrides.push({
		id: 'CK-workbench-999',
		serviceId,
		module,
		owner: unit.owner,
		reason: unit.reason,
		link: unit.link,
		cause: unit.cause,
		pin: unit.pin,
		contractTests: []
	});
	return `${JSON.stringify(manifest, null, 2)}\n`;
}

describe('(m) the layers the project type does not provide', () => {
	it('refuses an artifact of a layer this type has no capability for, before any finding', () => {
		const refusal = verifyUnder([]);
		expect(isCkError(refusal)).toBe(true);
		if (!isCkError(refusal)) return;
		expect(refusal.code).toBe('TYPE-CAPABILITY');
		expect(refusal.message).toContain('config-overlay');
		expect(refusal.message).toContain('stub');
	});

	it('passes the layer gate when the type declares every optional layer of the delta', () => {
		expect(verifyUnder([...vscodeType.capabilities])).toBeNull();
	});
});
