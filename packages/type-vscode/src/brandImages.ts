/** @scope spec://codkit/modules/vscode/PROP-006#IMAGESET-TARGET-DISCOVERY */
// Area 6: the brand image set of the distribution (capability `brand-images`).
//
// The file set is this type's knowledge of the distribution - the image
// locations every fork of this family rebrands - expressed as fixed paths and
// globs. The structure of a file is never assumed: the engine parses each one
// and takes the frame list, the element types and the exact sizes from the
// bytes the distribution ships, so a frame or a whole new file added upstream
// is followed automatically.
//
// A target names two things (##IMAGESET-ARTWORK): the FAMILY is the guard group
// and the masters folder, the ARTWORK is which drawing inside that family the
// target wants.
//
// The codecs below carry their data half only; the container behaviour still
// lives in the engine's `imageset*.ts` and moves in phase P2-3 (`deferred.ts`).

import type { BrandImagesArea, ImageCodec, ImageTargetPattern } from '@codkit/type-api';
import { notAnsweredHereYet } from './deferred.ts';

const ENGINE_MODULE = 'lib/imageset*.ts';

/**
 * ##DECISION-IMAGESET-ROLE-TABLE: the role of every target - where a person
 * sees this image - is the type's knowledge and is worded without the name of
 * any downstream product.
 */
export const targets: readonly ImageTargetPattern[] = [
	{
		family: 'icon',
		path: 'resources/win32/code.ico',
		glob: false,
		kind: 'ico',
		role: 'Windows: the executable icon, and with it the taskbar button, the window icon, the shortcut and the file-association icon'
	},
	{
		family: 'icon',
		path: 'resources/darwin/code.icns',
		glob: false,
		kind: 'icns',
		role: 'macOS: the application bundle icon, shown in the Dock, in Finder, in Launchpad and in the app switcher'
	},
	{
		family: 'icon',
		path: 'resources/linux/code.png',
		glob: false,
		kind: 'png',
		role: 'Linux: the icon of the desktop entry - the application menu, the dock and the window decoration'
	},
	{
		family: 'icon',
		path: 'resources/win32/code_*.png',
		glob: true,
		kind: 'png',
		role: 'Windows: the Start-menu and Store tile logos referenced by the appx manifest'
	},
	{
		family: 'icon',
		path: 'resources/linux/rpm/*.xpm',
		glob: true,
		kind: 'xpm',
		role: 'Linux, RPM packaging: the package icon the menus of RPM distributions read'
	},
	{
		family: 'icon',
		path: 'resources/server/favicon.ico',
		glob: false,
		kind: 'ico',
		role: 'Browser: the favicon of the served web client, shown in the tab, the bookmark bar and the history'
	},
	{
		family: 'icon',
		path: 'resources/server/code-*.png',
		glob: true,
		kind: 'png',
		role: 'Browser: the installable web-app icon named by the web manifest, used when the client is added to a home screen'
	},
	{
		family: 'installer-big',
		path: 'resources/win32/inno-big-*.bmp',
		glob: true,
		kind: 'bmp',
		role: 'Windows installer: the large image on the welcome and finish pages of the wizard'
	},
	{
		family: 'installer-small',
		path: 'resources/win32/inno-small-*.bmp',
		glob: true,
		kind: 'bmp',
		role: 'Windows installer: the small header image shown on every page of the wizard'
	},
	{
		family: 'filetype',
		path: 'resources/win32/*.ico',
		glob: true,
		kind: 'ico',
		role: 'Windows: the icon Explorer and the desktop show on files this distribution registers itself for',
		artworkFromStem: { strip: '' },
		exclude: ['code.ico']
	},
	{
		family: 'filetype',
		path: 'resources/darwin/*.icns',
		glob: true,
		kind: 'icns',
		role: 'macOS: the icon Finder and Quick Look show on files this distribution registers itself for',
		artworkFromStem: { strip: '' },
		exclude: ['code.icns']
	},
	{
		family: 'letterpress',
		path: 'src/vs/workbench/browser/parts/editor/media/letterpress-*.svg',
		glob: true,
		kind: 'svg',
		role: 'In the application: the watermark drawn behind the editor area when no file is open, one drawing per theme',
		artworkFromStem: { strip: 'letterpress-' }
	},
	{
		family: 'letterpress',
		path: 'src/vs/sessions/contrib/chat/browser/media/letterpress-*.svg',
		glob: true,
		kind: 'svg',
		role: 'In the application: the watermark drawn behind an empty chat session, one drawing per theme',
		artworkFromStem: { strip: 'letterpress-' }
	}
];

/**
 * The containers this family stores its brand images in. `layered` is the one
 * question the engine already asks a codec: such a container holds several
 * drawings of one image at several sizes, so a guard compares it frame by frame
 * rather than as one picture.
 */
function dataOnlyCodec(kind: string, extension: string, layered: boolean): ImageCodec {
	const what = `the ${kind} codec`;
	return {
		kind,
		extension,
		layered,
		parse: () => notAnsweredHereYet(what, ENGINE_MODULE),
		legacyTypes: () => notAnsweredHereYet(what, ENGINE_MODULE),
		extract: () => notAnsweredHereYet(what, ENGINE_MODULE),
		encode: () => notAnsweredHereYet(what, ENGINE_MODULE)
	};
}

export const codecs: readonly ImageCodec[] = [
	dataOnlyCodec('ico', '.ico', true),
	dataOnlyCodec('icns', '.icns', true),
	dataOnlyCodec('png', '.png', false),
	dataOnlyCodec('bmp', '.bmp', false),
	dataOnlyCodec('xpm', '.xpm', false),
	dataOnlyCodec('svg', '.svg', false)
];

/** ##IMAGESET-ARTWORK: one line per family, for the help of the `imageset` verbs. */
export const familyNotes: readonly string[] = [
	'icon: the application icon in .ico, .icns, .png and .xpm, the Start tiles and the web client icons',
	'installer-big and installer-small: the Windows installer bitmaps',
	'filetype: one drawing per file type the distribution registers itself for',
	'letterpress: the empty-editor watermark, one drawing per theme'
];

export const brandImages: BrandImagesArea = { targets, codecs, familyNotes };
