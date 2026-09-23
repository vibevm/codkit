// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the
// targets and masters below are that family's.
// `imageset verify` over a declared target (PROP-007 ##IMAGESET-VERIFY-DECLARED):
// the file in the tree is compared with the declaration rather than with the
// frames the pin shipped, and every layer is round-tripped within the key that
// serves it - the taskbar drawing is never measured against the main one. The
// drift it has to catch: a frame missing, a frame too many, a frame drawn from
// the wrong key.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { resizeRgba } from '../../src/lib/imagesetRaster.ts';
import { verificationExitCode } from '../../src/lib/imagesetVerify.ts';
import type { ImagesetVerification } from '../../src/lib/imagesetVerify.ts';
import { renderImagesetVerification, verificationData } from '../../src/lib/imagesetVerifyReport.ts';
import { containerOf, imagesOf, sizedFrame } from '../support/imagesetCodecs.ts';
import { CODE_ICO, DECLARED_SIZES, SAMPLE_DECLARATION, declaredPolygon } from '../support/imagesetDeclared.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** The code.ico `gen` writes for a declaration, as bytes a tree can ship. */
function generated(label: string, declaration: unknown): Buffer {
	const { patchset, run } = declaredPolygon(label, { declaration });
	expect(run(false).exitCode).toBe(0);
	return readFileSync(join(patchset.dir, 'delta', 'resources', 'files', ...CODE_ICO.split('/')));
}

/** Verify a tree whose code.ico is `shipped`, against the declaration of the case. */
function verifyShipping(label: string, shipped: Uint8Array, declaration: unknown = SAMPLE_DECLARATION): ImagesetVerification {
	const { verify } = declaredPolygon(label, { declaration, tree: new Map([[CODE_ICO, shipped]]) });
	return verify();
}

const icoOf = (verification: ImagesetVerification) => verification.targets.find((target) => target.target === CODE_ICO);

/** The frames of an .ico, re-encoded after `edit` - a file somebody changed by hand. */
function reencoded(bytes: Uint8Array, edit: (images: ReturnType<typeof imagesOf>) => ReturnType<typeof imagesOf>): Uint8Array {
	return containerOf(
		'ico',
		edit(imagesOf('ico', bytes)).map((image) => ({ frame: sizedFrame(image), image }))
	);
}

describe('imageset verify over a declared target', () => {
	it('passes the file gen wrote, round-tripping each key on its own', () => {
		const verification = verifyShipping('verify-declared-pass', generated('verify-declared-pass-gen', SAMPLE_DECLARATION));
		expect(verificationExitCode(verification)).toBe(0);
		const ico = icoOf(verification);
		expect(ico?.framesDeclared).toBe(true);
		expect(ico?.structure?.matches).toBe(true);
		expect(ico?.structure?.declared).toBe(`ICO ${DECLARED_SIZES.map((size) => `${size}x${size}`).join(' ')}`);
		expect(ico?.masters).toEqual([
			{ key: 'taskbar', label: '64x64' },
			{ key: 'icon', label: '256x256' }
		]);
		expect(ico?.layers.map((layer) => [layer.label, layer.key, layer.verdict])).toEqual([
			['16x16', 'taskbar', 'not-asserted'],
			['20x20', 'taskbar', 'not-asserted'],
			['24x24', 'taskbar', 'not-asserted'],
			['32x32', 'taskbar', 'not-asserted'],
			['40x40', 'taskbar', 'not-asserted'],
			['48x48', 'taskbar', 'not-asserted'],
			['64x64', 'taskbar', 'master'],
			['128x128', 'icon', 'inside'],
			['256x256', 'icon', 'master']
		]);
		const markdown = renderImagesetVerification(verification).split('\n');
		expect(markdown).toContain(
			'- Container: ICO; family: `icon`; master layers: `64x64` for key `taskbar`, `256x256` for key `icon` - the largest layer of each key in this same file'
		);
		expect(markdown).toContain(`- Structure: the file matches the declaration - \`${ico?.structure?.declared ?? ''}\``);
		expect(markdown).toContain(
			'| `64x64`, key `taskbar` | 64x64 | the master | - | the layer the other layers of key `taskbar` are regenerated from |'
		);
		const data = verificationData(verification) as { declaration: string | null; targets: { target: string; layers: { key: string }[] }[] };
		expect(data.declaration).not.toBeNull();
		expect(data.targets.find((target) => target.target === CODE_ICO)?.layers.map((layer) => layer.key)).toEqual([
			...Array.from({ length: 7 }, () => 'taskbar'),
			'icon',
			'icon'
		]);
	});

	it('catches a declared frame the file lacks', () => {
		const shipped = reencoded(generated('verify-missing-gen', SAMPLE_DECLARATION), (images) => images.filter((image) => image.width !== 20));
		const verification = verifyShipping('verify-missing', shipped);
		expect(verificationExitCode(verification)).toBe(1);
		const ico = icoOf(verification);
		expect(ico?.structure).toMatchObject({ matches: false, missing: ['20x20'], extra: [] });
		expect(renderImagesetVerification(verification).split('\n')).toContain('- Declared and missing from the file: 20x20');
	});

	it('catches a frame the file carries and the declaration does not', () => {
		const shipped = reencoded(generated('verify-extra-gen', SAMPLE_DECLARATION), (images) => {
			const large = images.find((image) => image.width === 128);
			return large === undefined ? images : [...images, resizeRgba(large, 96, 96)];
		});
		const verification = verifyShipping('verify-extra', shipped);
		expect(verificationExitCode(verification)).toBe(1);
		expect(icoOf(verification)?.structure).toMatchObject({ matches: false, missing: [], extra: ['96x96'] });
		expect(renderImagesetVerification(verification).split('\n')).toContain('- In the file and not declared: 96x96');
	});

	it('catches a frame drawn from the wrong key', () => {
		// The file of a declaration that gave the 128 px frame to the taskbar
		// drawing, verified against the one that gives it to the main icon.
		const wrong = {
			codkitImageset: 1,
			targets: { [CODE_ICO]: { frames: [...DECLARED_SIZES], sources: [{ key: 'taskbar', maxSize: 128 }] } }
		};
		const verification = verifyShipping('verify-wrong-key', generated('verify-wrong-key-gen', wrong));
		expect(verificationExitCode(verification)).toBe(1);
		const ico = icoOf(verification);
		expect(ico?.structure?.matches).toBe(true);
		const layer = ico?.layers.find((candidate) => candidate.label === '128x128');
		expect(layer).toMatchObject({ key: 'icon', verdict: 'outside' });
		expect(layer?.measured ?? 0).toBeGreaterThan(25);
	});

	it('keeps a key with a single layer out of the comparison, and says why', () => {
		const single = {
			codkitImageset: 1,
			targets: { [CODE_ICO]: { frames: [...DECLARED_SIZES], sources: [{ key: 'taskbar', sizes: [16] }] } }
		};
		const verification = verifyShipping('verify-alone', generated('verify-alone-gen', single), single);
		expect(verificationExitCode(verification)).toBe(0);
		const ico = icoOf(verification);
		expect(ico?.layers.filter((layer) => layer.verdict === 'alone').map((layer) => [layer.label, layer.key])).toEqual([
			['16x16', 'taskbar']
		]);
		expect(verification.totals.comparisons).toBe(
			verification.targets.flatMap((target) => target.layers).filter((layer) => layer.verdict !== 'master' && layer.verdict !== 'alone')
				.length
		);
		expect(renderImagesetVerification(verification).split('\n')).toContain(
			'| `16x16`, key `taskbar` | 16x16 | not compared | - | the only layer of key `taskbar` in this file, so nothing here regenerates it |'
		);
	});
});
