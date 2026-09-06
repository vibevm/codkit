/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-TARGET-DISCOVERY */
// Target discovery (IMAGESET-TARGET-DISCOVERY): which icon files of the fork
// tree belong to the product's icon set, and what structure each one carries.
//
// The file set is codkit's built-in knowledge of the distribution - the icon
// locations every VS Code fork rebrands - expressed as fixed paths and globs.
// The STRUCTURE is never assumed: each existing file is parsed, and the frame
// list, element types and exact per-frame dimensions come from the bytes the
// distribution ships. Upstream adding a frame, an installer size or a whole
// new file under the globs is therefore followed automatically.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseBmp } from './imagesetBmp.ts';
import { parseIcns } from './imagesetIcns.ts';
import { parseIco } from './imagesetIco.ts';
import { ckError } from './messages.ts';
import { pngSize } from './imagesetPng.ts';
import { parseXpm } from './imagesetXpm.ts';

export type TargetKind = 'ico' | 'icns' | 'png' | 'bmp' | 'xpm';

export type TargetFrame = {
	readonly width: number;
	readonly height: number;
	/** ICNS element type; null for the other containers. */
	readonly type: string | null;
	/** ICNS: the element is one of the eight PNG-capable types. */
	readonly pngCapable: boolean;
};

export type DiscoveredTarget = {
	/** Master family the target draws from, e.g. 'icon' or 'installer-big'. */
	readonly family: string;
	/** Where a person sees this image; codkit's knowledge of the distribution. */
	readonly role: string;
	/** Path relative to the fork-tree root, forward slashes. */
	readonly target: string;
	readonly kind: TargetKind;
	readonly frames: readonly TargetFrame[];
	/** ICNS only: legacy element types found and not reproduced. */
	readonly legacyTypes: readonly string[];
	/** File stem; the XPM encoder names its C array after it. */
	readonly stem: string;
};

type TargetPattern = {
	readonly family: string;
	readonly path: string;
	readonly glob: boolean;
	readonly kind: TargetKind;
	/** Where a person sees the image. Never names a downstream product. */
	readonly role: string;
};

/**
 * The built-in icon set of the distribution, as path patterns and roles.
 * The role is what `imageset index` hands to whoever draws the artwork, so
 * it names the place a human sees the image, not the file's own name.
 */
const TARGET_PATTERNS: readonly TargetPattern[] = [
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
	}
];

/**
 * Discover the icon set of a fork tree. Missing fixed paths are reported per
 * file (they are the distribution's own layout, so their absence is news),
 * while a glob that matches nothing simply contributes no targets.
 */
export function discoverTargets(treeDir: string, onReport: (text: string) => void): readonly DiscoveredTarget[] {
	const targets: DiscoveredTarget[] = [];
	for (const pattern of TARGET_PATTERNS) {
		const files = pattern.glob ? globFiles(treeDir, pattern.path) : existsSync(joinTree(treeDir, pattern.path)) ? [pattern.path] : [];
		if (!pattern.glob && files.length === 0) {
			onReport(`target absent in the tree: ${pattern.path}`);
			continue;
		}
		for (const file of files) {
			const discovered = discoverOne(treeDir, file, pattern);
			if (discovered !== null) {
				targets.push(discovered);
			}
		}
	}
	targets.sort((left, right) => compareBytes(left.target, right.target));
	return targets;
}

function discoverOne(treeDir: string, file: string, pattern: TargetPattern): DiscoveredTarget | null {
	const bytes = readFileSync(joinTree(treeDir, file));
	const stem = basename(file, extname(file));
	const { family, kind, role } = pattern;
	const common = { family, role, target: file, kind, stem };
	if (kind === 'ico') {
		const structure = parseIco(bytes);
		return { ...common, frames: structure.frames.map((frame) => toFrame(frame)), legacyTypes: [] };
	}
	if (kind === 'icns') {
		const structure = parseIcns(bytes);
		return {
			...common,
			frames: structure.elements
				.filter((element) => element.pngCapable)
				.map((element) => toFrame({ width: element.width, height: element.height }, element.type, true)),
			legacyTypes: structure.legacyTypes
		};
	}
	if (kind === 'png') {
		const size = pngSize(bytes);
		if (size === null) {
			throw unreadable(file, 'not a PNG');
		}
		return { ...common, frames: [toFrame(size)], legacyTypes: [] };
	}
	if (kind === 'bmp') {
		const structure = parseBmp(bytes);
		return { ...common, frames: [toFrame(structure)], legacyTypes: [] };
	}
	const structure = parseXpm(bytes.toString('utf8'));
	return { ...common, frames: [toFrame(structure)], legacyTypes: [] };
}

function toFrame(size: { width: number; height: number }, type: string | null = null, pngCapable = false): TargetFrame {
	return { width: size.width, height: size.height, type, pngCapable };
}

function globFiles(treeDir: string, pattern: string): string[] {
	const separator = pattern.lastIndexOf('/');
	const directory = separator === -1 ? '' : pattern.slice(0, separator);
	const namePattern = pattern.slice(separator + 1);
	const star = namePattern.indexOf('*');
	if (star === -1) {
		return [];
	}
	const prefix = namePattern.slice(0, star);
	const suffix = namePattern.slice(star + 1).replace(/\*/g, '');
	const absolute = joinTree(treeDir, directory);
	if (!existsSync(absolute)) {
		return [];
	}
	return readdirSync(absolute)
		.filter((name) => name.startsWith(prefix) && name.endsWith(suffix) && name.length >= prefix.length + suffix.length)
		.sort((left, right) => compareBytes(left, right))
		.map((name) => (directory === '' ? name : `${directory}/${name}`));
}

function joinTree(treeDir: string, relative: string): string {
	return join(treeDir, ...relative.split('/'));
}

function compareBytes(left: string, right: string): number {
	return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function unreadable(file: string, reason: string): Error {
	return ckError('ARTIFACT-BROKEN', `${file}: ${reason}`, 'the fork tree target must be an intact file of its declared kind');
}
