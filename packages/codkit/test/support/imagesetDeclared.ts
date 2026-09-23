// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the
// targets and masters below are that family's.
// The polygon of a product that declares its image set (PROP-007
// ##IMAGESET-DECLARATION): a fork tree whose executable icon ships the four
// frames 16, 32, 128 and 256, the masters of the key `icon` and of a separate
// taskbar drawing, and the declaration of the case it was made for - nine
// frames, those up to 64 px from the key `taskbar`.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodePng, rgba } from '@codkit/type-api';
import { projectType as vscodeType } from '@codkit/type-vscode';
import { runImageset } from '../../src/lib/imagesetEngine.ts';
import { buildImagesetIndex } from '../../src/lib/imagesetIndex.ts';
import { verifyImageset } from '../../src/lib/imagesetVerify.ts';
import { containerOf, sizedFrame } from './imagesetCodecs.ts';
import { makeImagesetPatchSet, makeImagesetTree } from './imagesetFixture.ts';

/** The executable icon of the pin: four frames of the upstream mark. */
export const PINNED_ICO = containerOf(
	'ico',
	[16, 32, 128, 256].map((size) => {
		const image = rgba(size, size, [40, 90, 160, 255]);
		return { frame: sizedFrame(image), image };
	})
);

/** The main drawing: a blue rounded square with a white disc. */
export const ICON_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="24" fill="#167abf"/><circle cx="64" cy="64" r="28" fill="#ffffff"/></svg>';

/** The taskbar drawing: an orange square with a heavy white bar - nothing like the main one. */
export const TASKBAR_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e8591a"/><rect x="8" y="26" width="48" height="12" fill="#ffffff"/></svg>';

/** The hand-drawn small taskbar frames. */
export const TASKBAR_16 = encodePng(rgba(16, 16, [250, 200, 0, 255]));
export const TASKBAR_32 = encodePng(rgba(32, 32, [0, 180, 90, 255]));

export const DECLARED_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256] as const;

/** The declaration of the case: nine frames for code.ico, those up to 64 px from `taskbar`. */
export const SAMPLE_DECLARATION = {
	codkitImageset: 1,
	targets: {
		'resources/win32/code.ico': {
			frames: [...DECLARED_SIZES],
			sources: [{ key: 'taskbar', maxSize: 64 }]
		}
	}
};

export const CODE_ICO = 'resources/win32/code.ico';

/**
 * The polygon: `declaration` is written as imageset.json when given (a string
 * as it is, anything else as JSON); `tree` adds or replaces shipped files.
 */
export function declaredPolygon(
	label: string,
	options: {
		readonly declaration?: unknown;
		readonly extended?: boolean;
		readonly tree?: ReadonlyMap<string, Uint8Array>;
		readonly masters?: Readonly<Record<string, Uint8Array | string>>;
	} = {}
) {
	const files = new Map<string, Uint8Array>([[CODE_ICO, PINNED_ICO], ...(options.tree ?? new Map<string, Uint8Array>())]);
	const tree = makeImagesetTree(`${label}-tree`, { extended: options.extended === true, files });
	const patchset = makeImagesetPatchSet(`${label}-patchset`, tree);
	const brandingDir = join(patchset.dir, 'branding');
	const masters: Record<string, Uint8Array | string> = {
		'icon.svg': ICON_SVG,
		'taskbar.svg': TASKBAR_SVG,
		'taskbar-16.png': TASKBAR_16,
		'taskbar-32.png': TASKBAR_32,
		'installer-big.png': encodePng(rgba(40, 20, [22, 122, 191, 255])),
		'installer-small.png': encodePng(rgba(12, 12, [22, 122, 191, 255])),
		...options.masters
	};
	if (options.declaration !== undefined) {
		masters['imageset.json'] =
			typeof options.declaration === 'string' ? options.declaration : `${JSON.stringify(options.declaration, null, '\t')}\n`;
	}
	for (const [file, bytes] of Object.entries(masters)) {
		const path = join(brandingDir, ...file.split('/'));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, bytes);
	}
	const run = (dryRun: boolean) => {
		const info: string[] = [];
		const warnings: string[] = [];
		const result = runImageset({
			patchesDir: patchset.dir,
			type: vscodeType,
			treeDir: tree.dir,
			brandingDir,
			pin: tree.pin,
			dryRun,
			onInfo: (text) => info.push(text),
			onWarn: (text) => warnings.push(text)
		});
		return { info, warnings, ...result };
	};
	const index = () => buildImagesetIndex({ type: vscodeType, treeDir: tree.dir, brandingDir, onReport: () => {} });
	const verify = (treeDir: string = tree.dir) => verifyImageset({ type: vscodeType, treeDir, brandingDir, onReport: () => {} });
	return { tree, patchset, brandingDir, run, index, verify };
}
