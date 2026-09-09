// e2e: `codkit imageset verify` through the real launcher - the acceptance
// bands as an executable gate, its exit codes, its read-only promise and the
// one model behind both renderings (PROP-007 ##IMAGESET-VERIFY,
// ##DECISION-IMAGESET-VERIFY-COMMAND, ##DECISION-IMAGESET-ACCEPTANCE-CRITERION).
//
// The fork tree of each case is written here rather than taken from the shared
// fixture, because the gate only has something to say where a container holds
// layers big enough for a band to be asserted at all.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { rgba } from '@codkit/type-api';
import type { Rgba } from '@codkit/type-api';
import { containerOf, namedFrame, sizedFrame } from '../support/imagesetCodecs.ts';
import { resizeRgba } from '../../src/lib/imagesetRaster.ts';
import { runCli } from '../support/cliFixture.ts';
import { makeImagesetPatchSet, makeImagesetTree } from '../support/imagesetFixture.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** A flat drawing: a filled square of one colour on a transparent ground. */
function block(size: number, color: readonly [number, number, number]): Rgba {
	const image = rgba(size, size);
	const inset = Math.max(1, Math.round(size / 8));
	for (let y = inset; y < size - inset; y += 1) {
		for (let x = inset; x < size - inset; x += 1) {
			const at = (y * size + x) * 4;
			image.data[at] = color[0];
			image.data[at + 1] = color[1];
			image.data[at + 2] = color[2];
			image.data[at + 3] = 255;
		}
	}
	return image;
}

function makeFixture(label: string) {
	const tree = makeImagesetTree(label);
	const patchset = makeImagesetPatchSet(label, tree);
	const treeDir = join(makeTempRoot(`${label}-fork`), 'fork-tree');
	mkdirSync(join(treeDir, '..'), { recursive: true });
	runGit({ args: ['clone', '--quiet', '--no-checkout', tree.dir, treeDir], cwd: join(treeDir, '..'), netAllowed: true });
	runGit({ args: ['checkout', '--quiet', '--detach', tree.pin.sha], cwd: treeDir });
	const write = (relative: string, bytes: Uint8Array) => {
		const absolute = join(treeDir, ...relative.split('/'));
		mkdirSync(dirname(absolute), { recursive: true });
		writeFileSync(absolute, bytes);
	};
	const run = (args: readonly string[]) => runCli(patchset.dir, ['--patches-dir', patchset.dir, '--fork-dir', treeDir, ...args]);
	return { patchset, treeDir, write, run };
}

const master = block(512, [20, 120, 190]);

/** An .icns whose 128 element is a downsize of its own 512 one. */
function faithfulIcns(): Uint8Array {
	return icnsOf([
		['ic09', master],
		['ic13', resizeRgba(master, 256, 256)],
		['ic07', resizeRgba(master, 128, 128)]
	]);
}

/** The same file with a different drawing at 128: what the gate is for. */
function wrongIcns(): Uint8Array {
	return icnsOf([
		['ic09', master],
		['ic13', resizeRgba(master, 256, 256)],
		['ic07', block(128, [240, 30, 10])]
	]);
}

function icnsOf(elements: readonly (readonly [string, Rgba])[]): Uint8Array {
	return containerOf(
		'icns',
		elements.map(([type, image]) => ({ frame: namedFrame(type, image), image }))
	);
}

function faithfulIco(): Uint8Array {
	const drawing = block(256, [20, 120, 190]);
	const small = resizeRgba(drawing, 128, 128);
	return containerOf('ico', [
		{ frame: sizedFrame(drawing), image: drawing },
		{ frame: sizedFrame(small), image: small }
	]);
}

describe('codkit imageset verify', () => {
	it('exits 0 and reports the measured number when every layer is inside its band', () => {
		const fixture = makeFixture('e2e-verify-green');
		fixture.write('resources/darwin/code.icns', faithfulIcns());
		fixture.write('resources/win32/code.ico', faithfulIco());
		const run = fixture.run(['imageset', 'verify']);

		expect(run.status).toBe(0);
		expect(run.stdout).toContain('Every asserted comparison is inside its band.');
		expect(run.stdout).toContain('master layer: `ic09` - the largest layer of this same file');
		expect(run.stdout).toContain('| `ic07` | 128x128 | at most 25/255 |');
		expect(run.stdout).toContain('0 outside');
	});

	it('is the gate: exit 1 when a shipped layer is outside its band', () => {
		const fixture = makeFixture('e2e-verify-red');
		fixture.write('resources/darwin/code.icns', wrongIcns());
		const run = fixture.run(['imageset', 'verify']);

		expect(run.status).toBe(1);
		expect(run.stdout).toContain('OUTSIDE the band');
		expect(run.stdout).toContain('1 comparison(s) outside the band');
		// The 256 element of the same file is a faithful downsize and stays in.
		expect(run.stdout).toContain('| `ic13` | 256x256 | at most 10/255 |');
	});

	it('writes nothing: no branding directory, no patchset change, no lock', () => {
		const fixture = makeFixture('e2e-verify-readonly');
		fixture.write('resources/darwin/code.icns', faithfulIcns());
		const before = runGit({ args: ['status', '--porcelain'], cwd: fixture.patchset.dir }).stdout;
		const run = fixture.run(['imageset', 'verify']);

		expect(run.status).toBe(0);
		expect(existsSync(join(fixture.patchset.dir, 'branding'))).toBe(false);
		expect(existsSync(join(fixture.patchset.dir, 'delta', 'resources', 'map.json'))).toBe(false);
		expect(runGit({ args: ['status', '--porcelain'], cwd: fixture.patchset.dir }).stdout).toBe(before);
	});

	it('carries the same model into --json as into the Markdown', () => {
		const fixture = makeFixture('e2e-verify-json');
		fixture.write('resources/darwin/code.icns', wrongIcns());
		const human = fixture.run(['imageset', 'verify']);
		const run = fixture.run(['--json', 'imageset', 'verify']);
		const envelope = JSON.parse(run.stdout) as {
			ok: boolean;
			exitCode: number;
			data: {
				totals: { outside: number; unverifiable: number; notAsserted: number };
				targets: { target: string; master: string | null; layers: { label: string; measured: number | null; verdict: string }[] }[];
			};
		};
		const icns = envelope.data.targets.find((target) => target.target === 'resources/darwin/code.icns');
		const layer = icns?.layers.find((candidate) => candidate.label === 'ic07');

		expect(run.status).toBe(1);
		expect(envelope.ok).toBe(false);
		expect(envelope.exitCode).toBe(1);
		expect(envelope.data.totals.outside).toBe(1);
		expect(icns?.master).toBe('ic09');
		expect(layer?.verdict).toBe('outside');
		expect(human.stdout).toContain(`| ${(layer?.measured ?? 0).toFixed(2)} | OUTSIDE the band |`);
	});

	it('exits 2 when there is no fork tree to read', () => {
		const fixture = makeFixture('e2e-verify-no-tree');
		const run = runCli(fixture.patchset.dir, [
			'--patches-dir',
			fixture.patchset.dir,
			'--fork-dir',
			join(fixture.treeDir, 'absent'),
			'imageset',
			'verify'
		]);

		expect(run.status).toBe(2);
		expect(run.stderr).toContain('does not exist');
	});

	it('is offered by the namespace, which still does nothing by itself', () => {
		const fixture = makeFixture('e2e-verify-namespace');
		const bare = fixture.run(['imageset']);
		const help = fixture.run(['imageset', '--help']);

		expect(bare.status).toBe(2);
		expect(bare.stderr).toContain('imageset verify');
		expect(help.status).toBe(0);
		expect(help.stdout).toContain('verify [--branding-dir <path>]');
	});
});
