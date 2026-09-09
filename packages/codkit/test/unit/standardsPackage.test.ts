// PROP-013 ##UT-STANDARDS-PACKAGE: locating the packages codkit ships,
// comparing an installed copy with one, and the scratch-then-rename write.

import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCkError } from '../../src/lib/messages.ts';
import {
	SCRATCH_PREFIX,
	SHIPPED_PACKAGES_PARENT,
	compareTrees,
	fileIsIdentical,
	listScratchDirs,
	shippedPackages,
	shippedStandardsPackage,
	writeTreeViaScratch
} from '../../src/lib/standardsPackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not-a-ck-error';
	}
}

/** A stand-in package: one version directory with a manifest and a file. */
function makeSource(label: string, version = '0.1.0'): { readonly parent: string; readonly dir: string } {
	const parent = makeTempRoot(`pkg-${label}`);
	const dir = join(parent, `v${version}`);
	mkdirSync(join(dir, 'nested'), { recursive: true });
	writeFileSync(join(dir, 'vibe.toml'), `[package]\nname = "standards"\nversion = "${version}"\n`, 'utf8');
	writeFileSync(join(dir, 'nested', 'a.txt'), 'a\n', 'utf8');
	return { parent, dir };
}

/** A stand-in tool root carrying a set of packages under the group directory. */
function makeToolRoot(label: string, packages: readonly { name: string; version: string; skills?: boolean }[]): string {
	const root = makeTempRoot(`tool-${label}`);
	for (const entry of packages) {
		const dir = join(root, ...SHIPPED_PACKAGES_PARENT.split('/'), entry.name, `v${entry.version}`);
		mkdirSync(dir, { recursive: true });
		const skills = entry.skills === true ? '\n[[skill]]\nname = "ck-orient"\npath = "vibevm/vibespecs/skills/ck-orient"\n' : '';
		writeFileSync(join(dir, 'vibe.toml'), `[package]\nname = "${entry.name}"\nversion = "${entry.version}"\n${skills}`, 'utf8');
	}
	return root;
}

describe('shippedStandardsPackage', () => {
	it('reads the version from the manifest and checks it against the directory', () => {
		const source = makeSource('good');
		const found = shippedStandardsPackage('unused', source.parent);

		expect(found.version).toBe('0.1.0');
		expect(found.directory).toBe(source.dir);
	});

	it('refuses a damaged installation rather than guessing', () => {
		const none = makeTempRoot('pkg-none');
		expect(codeOf(() => shippedStandardsPackage('unused', join(none, 'missing')))).toBe('INTERNAL');

		const two = makeSource('two');
		mkdirSync(join(two.parent, 'v0.2.0'));
		expect(codeOf(() => shippedStandardsPackage('unused', two.parent))).toBe('INTERNAL');

		const mismatched = makeSource('mismatch');
		writeFileSync(join(mismatched.dir, 'vibe.toml'), '[package]\nversion = "9.9.9"\n', 'utf8');
		expect(codeOf(() => shippedStandardsPackage('unused', mismatched.parent))).toBe('INTERNAL');
	});
});

describe('shippedPackages', () => {
	it('lists the universal set and the packages the type names, standards first', () => {
		const root = makeToolRoot('set', [
			{ name: 'standards', version: '0.2.0' },
			{ name: 'agent-skills', version: '0.1.0', skills: true },
			{ name: 'zeta', version: '1.0.0' }
		]);

		const found = shippedPackages(root, ['zeta']);

		expect(found.map((entry) => entry.name)).toEqual(['standards', 'agent-skills', 'zeta']);
		expect(found.map((entry) => entry.version)).toEqual(['0.2.0', '0.1.0', '1.0.0']);
		expect(found.map((entry) => entry.kind)).toEqual(['standards', 'agent-skills', 'type']);
		// ##STD-SKILLS-DECLARATION: only a manifest with `[[skill]]` needs projecting.
		expect(found.map((entry) => entry.declaresSkills)).toEqual([false, true, false]);
	});

	// ##STD-PACKAGES-OF-THE-TYPE: a package no type names reaches nobody, and a
	// name the installation cannot answer is a damaged installation.
	it('delivers a package of another type to nobody', () => {
		const root = makeToolRoot('set-other-type', [
			{ name: 'standards', version: '0.2.0' },
			{ name: 'agent-skills', version: '0.1.0', skills: true },
			{ name: 'zeta', version: '1.0.0' }
		]);

		expect(shippedPackages(root, []).map((entry) => entry.name)).toEqual(['standards', 'agent-skills']);
		expect(codeOf(() => shippedPackages(root, ['omega']))).toBe('INTERNAL');
	});

	it('refuses a damaged installation rather than guessing', () => {
		expect(codeOf(() => shippedPackages(makeTempRoot('set-none'), []))).toBe('INTERNAL');

		const two = makeToolRoot('set-two', [{ name: 'standards', version: '0.2.0' }]);
		mkdirSync(join(two, ...SHIPPED_PACKAGES_PARENT.split('/'), 'standards', 'v0.3.0'));
		expect(codeOf(() => shippedPackages(two, []))).toBe('INTERNAL');
	});

	it('relocates the standards package alone through the test seam', () => {
		const root = makeToolRoot('set-seam', [
			{ name: 'standards', version: '0.2.0' },
			{ name: 'agent-skills', version: '0.1.0', skills: true }
		]);
		const elsewhere = makeSource('set-seam-source');

		const found = shippedPackages(root, [], elsewhere.parent);

		expect(found[0]?.name).toBe('standards');
		expect(found[0]?.directory).toBe(elsewhere.dir);
		expect(found[1]?.directory).toBe(join(root, ...SHIPPED_PACKAGES_PARENT.split('/'), 'agent-skills', 'v0.1.0'));
	});
});

describe('compareTrees', () => {
	it('calls an absent target absent and an exact copy identical', () => {
		const source = makeSource('cmp').dir;
		const target = makeTempRoot('cmp-target');

		expect(compareTrees(source, join(target, 'nothing')).state).toBe('absent');
		cpSync(source, join(target, 'copy'), { recursive: true });
		expect(compareTrees(source, join(target, 'copy')).state).toBe('identical');
	});

	it('names what differs, on each of the three axes', () => {
		const source = makeSource('drift').dir;
		const target = join(makeTempRoot('drift-target'), 'copy');
		cpSync(source, target, { recursive: true });
		writeFileSync(join(target, 'nested', 'a.txt'), 'changed\n', 'utf8');
		writeFileSync(join(target, 'extra.txt'), 'x\n', 'utf8');
		rmSync(join(target, 'vibe.toml'));

		const comparison = compareTrees(source, target);
		expect(comparison.state).toBe('drift');
		if (comparison.state !== 'drift') return;
		expect(comparison.modified).toEqual(['nested/a.txt']);
		expect(comparison.extra).toEqual(['extra.txt']);
		expect(comparison.missing).toEqual(['vibe.toml']);
	});

	it('treats a symlink in the target as drift', () => {
		const source = makeSource('link').dir;
		const target = join(makeTempRoot('link-target'), 'copy');
		cpSync(source, target, { recursive: true });
		symlinkSync('vibe.toml', join(target, 'link.toml'));

		const comparison = compareTrees(source, target);
		expect(comparison.state).toBe('drift');
		if (comparison.state !== 'drift') return;
		expect(comparison.extra).toContain('link.toml');
	});

	it('compares two files byte for byte', () => {
		const source = makeSource('file').dir;
		const other = join(makeTempRoot('file-other'), 'x.txt');
		writeFileSync(other, 'a\n', 'utf8');

		expect(fileIsIdentical(join(source, 'nested', 'a.txt'), other)).toBe(true);
		writeFileSync(other, 'b\n', 'utf8');
		expect(fileIsIdentical(join(source, 'nested', 'a.txt'), other)).toBe(false);
		expect(fileIsIdentical(join(source, 'nested', 'a.txt'), join(source, 'absent'))).toBe(false);
	});
});

describe('writeTreeViaScratch', () => {
	it('creates the parents, writes through a scratch name and renames it', () => {
		const source = makeSource('write').dir;
		const root = makeTempRoot('write-root');
		const scratch = writeTreeViaScratch(source, root, ['a', 'b'], 'v0.1.0', { what: 'a/b' });

		expect(scratch.startsWith(SCRATCH_PREFIX)).toBe(true);
		expect(compareTrees(source, join(root, 'a', 'b', 'v0.1.0')).state).toBe('identical');
		// Nothing of the scratch name survives the rename.
		expect(readdirSync(join(root, 'a', 'b'))).toEqual(['v0.1.0']);
	});

	it('refuses when the target appeared while it was writing, and cleans up', () => {
		const source = makeSource('race').dir;
		const root = makeTempRoot('race-root');
		mkdirSync(join(root, 'v0.1.0'), { recursive: true });

		expect(codeOf(() => writeTreeViaScratch(source, root, [], 'v0.1.0', { what: '.' }))).toBe('STANDARDS-DRIFT');
		expect(listScratchDirs(root)).toEqual([]);
	});

	it('lists the scratch directories an interrupted run left behind', () => {
		const root = makeTempRoot('scratch-root');
		mkdirSync(join(root, `${SCRATCH_PREFIX}123-abcd`));
		mkdirSync(join(root, 'v0.1.0'));

		expect(listScratchDirs(root)).toEqual([`${SCRATCH_PREFIX}123-abcd`]);
		expect(listScratchDirs(join(root, 'nowhere'))).toEqual([]);
	});
});
