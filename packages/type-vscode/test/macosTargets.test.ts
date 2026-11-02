// The macOS targets of this family: the archive and the disk image of each
// architecture (modules/vscode PROP-004 ##VSCODE-MACOS-TARGETS). Nothing here
// runs gulp or codesign: the recipe is read as data, the way a person reads it.

import type { PackageTarget } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import { build } from '../src/build.ts';
import { configSchema } from '../src/configSchema.ts';

const MACOS_TARGETS = ['macos-x64-archive', 'macos-x64-dmg', 'macos-arm64-archive', 'macos-arm64-dmg'];

function targetOf(id: string): PackageTarget {
	const found = build.packageTargets?.find((target) => target.id === id);
	if (found === undefined) {
		throw new Error(`no package target ${id}`);
	}
	return found;
}

/** The script of a bash step, or the argv of any other, as the lines a person reads. */
function linesOf(id: string): readonly string[] {
	return targetOf(id).build.flatMap((command) =>
		command.command === 'bash'
			? [`${command.label}:`, ...(command.args[1] ?? '').split('\n')]
			: [`${command.label}: ${[command.command, ...command.args].join(' ')}`]
	);
}

describe('the macOS targets', () => {
	it('are four, macOS-hosted, without a container route, each naming its artifacts inside the tree', () => {
		for (const id of MACOS_TARGETS) {
			const target = targetOf(id);
			expect(target.platform, id).toBe('macos');
			expect(target.supportedHosts, id).toEqual(['darwin']);
			expect(target.container, id).toBeUndefined();
		}
		expect(targetOf('macos-x64-archive').outputs).toEqual(['.build/darwin-x64/archive/*.tar.gz']);
		expect(targetOf('macos-arm64-dmg').outputs).toEqual(['.build/darwin-arm64/dmg/*.dmg']);
		expect(targetOf('macos-arm64-archive').arch).toBe('arm64');
	});

	it('build the bundle, sign a staged copy ad hoc and leave the bundle beside the tree as the task wrote it', () => {
		const lines = linesOf('macos-arm64-archive');
		expect(lines[0]).toBe('bundle macos-arm64: npm run gulp -- vscode-darwin-arm64');
		expect(lines).toContain(`APP="$(node -p "require('./product.json').nameLong").app"`);
		expect(lines).toContain('/usr/bin/ditto "../VSCode-darwin-arm64/$APP" "$STAGE/$APP"');
		expect(lines).toContain('/usr/bin/codesign --force --deep --sign - "$STAGE/$APP"');
		expect(lines).toContain('/usr/bin/codesign --verify --deep --strict "$STAGE/$APP"');
		expect(lines.some((line) => line.includes('codesign') && line.includes('../VSCode-darwin'))).toBe(false);
	});

	it('archive with the bsdtar of macOS, root:wheel and no AppleDouble files, and check the gzip', () => {
		const lines = linesOf('macos-x64-archive');
		expect(lines).toContain(
			'COPYFILE_DISABLE=1 /usr/bin/tar --uid 0 --gid 0 --uname root --gname wheel -czf "$ARCHIVE" -C ".build/darwin-x64/stage/VSCode-darwin-x64" "$APP"'
		);
		expect(lines).toContain('ARCHIVE=".build/darwin-x64/archive/VSCode-darwin-x64.tar.gz"');
		expect(lines).toContain('/usr/bin/gzip -t "$ARCHIVE"');
		expect(lines.at(-1)).toBe('rm -rf ".build/darwin-x64/stage"');
	});

	it('make the disk image with the upstream script over the stage', () => {
		const lines = linesOf('macos-x64-dmg');
		expect(lines).toContain('VSCODE_ARCH=x64 node build/darwin/create-dmg.ts ".build/darwin-x64/stage" ".build/darwin-x64/dmg"');
		expect(lines.at(-1)).toBe('rm -rf ".build/darwin-x64/stage"');
	});

	it('are targets a patch set may select', () => {
		for (const id of MACOS_TARGETS) {
			expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', packageTargets: [id] }).success, id).toBe(true);
		}
	});
});
