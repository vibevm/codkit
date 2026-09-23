// e2e: a product that declares its image set, through the real launcher
// (PROP-007 ##IMAGESET-DECLARATION, ##IMAGESET-DECLARED-FRAMES,
// ##IMAGESET-DECLARED-SOURCES, ##IMAGESET-FRAME-SOURCES-REPORTED,
// ##IMAGESET-VERIFY-DECLARED). The executable icon of the pin ships 16, 32, 128
// and 256 px; the declaration asks for nine frames, those up to 64 px drawn
// from the key `taskbar` - the case the declaration was made for.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { encodePng, rgba } from '@codkit/type-api';
import { runCli } from '../support/cliFixture.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { CODE_ICO, ICON_SVG, PINNED_ICO, TASKBAR_16, TASKBAR_32, TASKBAR_SVG, SAMPLE_DECLARATION } from '../support/imagesetDeclared.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

const DECLARED = 'from the declared key taskbar';

/** The fixture triple of the imageset e2e suite, the icon of the pin shipping four frames. */
function declaredFixture(label: string, declaration: unknown) {
	const tree = makeImagesetTree(label, { files: new Map([[CODE_ICO, PINNED_ICO]]) });
	const patchset = makeImagesetPatchSet(label, tree);
	const treeDir = join(makeTempRoot(`${label}-fork`), 'fork-tree');
	mkdirSync(join(treeDir, '..'), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', tree.dir, treeDir], cwd: join(treeDir, '..'), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', tree.pin.sha], cwd: treeDir });
	const brandingDir = join(patchset.dir, 'artwork');
	mkdirSync(brandingDir, { recursive: true });
	const masters: Record<string, Uint8Array | string> = {
		'icon.svg': ICON_SVG,
		'taskbar.svg': TASKBAR_SVG,
		'taskbar-16.png': TASKBAR_16,
		'taskbar-32.png': TASKBAR_32,
		'installer-big.png': encodePng(rgba(40, 20, [22, 122, 191, 255])),
		'installer-small.png': encodePng(rgba(12, 12, [22, 122, 191, 255])),
		'imageset.json': `${JSON.stringify(declaration, null, '\t')}\n`
	};
	for (const [file, bytes] of Object.entries(masters)) {
		writeFileSync(join(brandingDir, file), bytes);
	}
	// The imageset verbs are pointed at the masters directory; `load` takes no such flag.
	const run = (args: readonly string[]) =>
		runCli(patchset.dir, [
			'--patches-dir',
			patchset.dir,
			'--fork-dir',
			treeDir,
			...args,
			...(args[0] === 'imageset' ? ['--branding-dir', brandingDir] : [])
		]);
	return { tree, patchset, treeDir, brandingDir, run };
}

describe('a declared frame set and a declared source through the real launcher', () => {
	it('gen --dry-run states the declared frames and where every frame comes from', () => {
		const fixture = declaredFixture('e2e-declared-plan', SAMPLE_DECLARATION);
		const plan = fixture.run(['imageset', 'gen', '--dry-run']);
		expect(plan.status).toBe(0);
		const lines = plan.stdout.split('\n');
		const at = lines.indexOf(
			`would regenerate ${CODE_ICO}: 9 frame(s) 16x16,20x20,24x24,32x32,40x40,48x48,64x64,128x128,256x256, declared in imageset.json in place of the shipped 16x16,32x32,128x128,256x256`
		);
		expect(at).toBeGreaterThan(-1);
		expect(lines.slice(at + 1, at + 10)).toEqual([
			`  16x16: override taskbar-16.png verbatim at 16x16, ${DECLARED}`,
			`  20x20: rendered taskbar.svg at 20x20, ${DECLARED}`,
			`  24x24: rendered taskbar.svg at 24x24, ${DECLARED}`,
			`  32x32: override taskbar-32.png verbatim at 32x32, ${DECLARED}`,
			`  40x40: rendered taskbar.svg at 40x40, ${DECLARED}`,
			`  48x48: rendered taskbar.svg at 48x48, ${DECLARED}`,
			`  64x64: rendered taskbar.svg at 64x64, ${DECLARED}`,
			'  128x128: rendered icon.svg at 128x128',
			'  256x256: rendered icon.svg at 256x256'
		]);
		expect(plan.stderr).not.toContain('ignored');
	});

	it('gen --json and index --json carry the key, the master and the origin of every frame', () => {
		const fixture = declaredFixture('e2e-declared-json', SAMPLE_DECLARATION);
		const gen = fixture.run(['imageset', 'gen', '--json']);
		expect(gen.status).toBe(0);
		const target = JSON.parse(gen.stdout).data.targets.find((candidate: { target: string }) => candidate.target === CODE_ICO);
		expect(target.framesDeclared).toBe(true);
		expect(
			target.frames.map((frame: Record<string, unknown>) => [
				frame['width'],
				frame['key'],
				frame['keyDeclared'],
				frame['master'],
				frame['origin']
			])
		).toEqual([
			[16, 'taskbar', true, 'taskbar-16.png', 'override'],
			[20, 'taskbar', true, 'taskbar.svg', 'vector'],
			[24, 'taskbar', true, 'taskbar.svg', 'vector'],
			[32, 'taskbar', true, 'taskbar-32.png', 'override'],
			[40, 'taskbar', true, 'taskbar.svg', 'vector'],
			[48, 'taskbar', true, 'taskbar.svg', 'vector'],
			[64, 'taskbar', true, 'taskbar.svg', 'vector'],
			[128, 'icon', false, 'icon.svg', 'vector'],
			[256, 'icon', false, 'icon.svg', 'vector']
		]);
		const index = fixture.run(['imageset', 'index', '--json']);
		expect(index.status).toBe(0);
		const sizes = JSON.parse(index.stdout).data.targets.find((candidate: { target: string }) => candidate.target === CODE_ICO);
		expect(sizes.framesDeclared).toBe(true);
		expect(sizes.sizes.map((size: Record<string, unknown>) => [size['width'], size['key'], size['from'], size['origin']])).toEqual(
			target.frames.map((frame: Record<string, unknown>) => [frame['width'], frame['key'], frame['master'], frame['origin']])
		);
		const text = fixture.run(['imageset', 'index']);
		expect(text.stdout).toContain(
			'| 20x20 | - | `generated` | rendered at this size from `taskbar.svg`, from the declared key `taskbar` |'
		);
	});

	it('verify passes the loaded icon against the declaration, one key at a time', () => {
		const fixture = declaredFixture('e2e-declared-verify', SAMPLE_DECLARATION);
		expect(fixture.run(['imageset', 'gen']).status).toBe(0);
		expect(fixture.run(['load']).status).toBe(0);
		const loaded = readFileSync(join(fixture.treeDir, ...CODE_ICO.split('/')));
		expect(loaded.equals(readFileSync(join(fixture.patchset.dir, 'delta', 'resources', 'files', ...CODE_ICO.split('/'))))).toBe(true);
		const verify = fixture.run(['imageset', 'verify', '--json']);
		expect(verify.status).toBe(0);
		const ico = JSON.parse(verify.stdout).data.targets.find((candidate: { target: string }) => candidate.target === CODE_ICO);
		expect(ico.structure).toMatchObject({ matches: true, missing: [], extra: [] });
		expect(ico.masters).toEqual([
			{ key: 'taskbar', label: '64x64' },
			{ key: 'icon', label: '256x256' }
		]);
		// Three runs of the launcher, a load among them: longer than one run, not slower per run.
	}, 120_000);

	it('refuses a declaration it cannot apply, in every verb, with exit 2', () => {
		const fixture = declaredFixture('e2e-declared-refuse', {
			codkitImageset: 1,
			targets: { [CODE_ICO]: { sources: [{ key: 'tray', maxSize: 64 }] } }
		});
		const expected = `error CK-E-CONFIG: ${join(fixture.brandingDir, 'imageset.json')}: ${CODE_ICO}: sources[0]: the key tray has no master in ${fixture.brandingDir}`;
		for (const args of [
			['imageset', 'gen', '--dry-run'],
			['imageset', 'gen'],
			['imageset', 'index'],
			['imageset', 'verify']
		]) {
			const run = fixture.run(args);
			expect(run.status, args.join(' ')).toBe(2);
			expect(run.stderr, args.join(' ')).toContain(expected);
		}
	});
});
