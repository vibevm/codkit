// PROP-013 ##UT-RUNTIME-PACKAGE: locating the shipped runtime library
// (PROP-015 ##RT-SHIPPED-LOCATION, ##RT-VERSION-LITERAL).
//
// `shippedRuntime.test.ts` proves the real library; this file proves the
// finder, on made-up directories: what it accepts, and that every damaged
// installation is one code (`CK-E-RUNTIME-PACKAGE`) rather than a guess.

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCkError } from '../../src/lib/messages.ts';
import { RUNTIME_VERSION_FILE, readVersionLiteral, shippedRuntime } from '../../src/lib/runtimePackage.ts';
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

function versionFile(version: string, verified: readonly string[] = ['1.135.0']): string {
	return [
		`export const CODKIT_RUNTIME_VERSION = '${version}';`,
		`export const CODKIT_RUNTIME_VERIFIED_UPSTREAM: readonly string[] = [${verified.map((tag) => `'${tag}'`).join(', ')}];`,
		''
	].join('\n');
}

/** A stand-in library: one version directory carrying the literal. */
function makeSource(label: string, version = '0.1.0', literal = version): { readonly parent: string; readonly dir: string } {
	const parent = makeTempRoot(`rt-${label}`);
	const dir = join(parent, `v${version}`);
	mkdirSync(join(dir, 'common'), { recursive: true });
	writeFileSync(join(dir, ...RUNTIME_VERSION_FILE.split('/')), versionFile(literal), 'utf8');
	return { parent, dir };
}

describe('shippedRuntime', () => {
	it('takes the version from the directory and proves it against the literal', () => {
		const source = makeSource('good');
		const found = shippedRuntime('unused', source.parent);

		expect(found.version).toBe('0.1.0');
		expect(found.directory).toBe(source.dir);
		expect(found.verifiedUpstream).toEqual(['1.135.0']);
	});

	it('refuses a parent with no version directory', () => {
		const empty = makeTempRoot('rt-none');
		expect(codeOf(() => shippedRuntime('unused', join(empty, 'missing')))).toBe('RUNTIME-PACKAGE');
		expect(codeOf(() => shippedRuntime('unused', empty))).toBe('RUNTIME-PACKAGE');
	});

	it('refuses two version directories rather than choosing one', () => {
		const two = makeSource('two');
		mkdirSync(join(two.parent, 'v0.2.0'));
		expect(codeOf(() => shippedRuntime('unused', two.parent))).toBe('RUNTIME-PACKAGE');
	});

	it('refuses a literal that disagrees with the directory name', () => {
		const mismatched = makeSource('mismatch', '0.1.0', '9.9.9');
		expect(codeOf(() => shippedRuntime('unused', mismatched.parent))).toBe('RUNTIME-PACKAGE');
	});

	it('refuses a version file that states no literal, and one that is not there', () => {
		const broken = makeSource('broken');
		writeFileSync(join(broken.dir, ...RUNTIME_VERSION_FILE.split('/')), 'export const OTHER = 1;\n', 'utf8');
		expect(codeOf(() => shippedRuntime('unused', broken.parent))).toBe('RUNTIME-PACKAGE');

		const gone = makeSource('gone');
		rmSync(join(gone.dir, ...RUNTIME_VERSION_FILE.split('/')));
		expect(codeOf(() => shippedRuntime('unused', gone.parent))).toBe('RUNTIME-PACKAGE');
	});
});

describe('readVersionLiteral', () => {
	it('reads both literals without executing the module', () => {
		const source = makeSource('literals', '0.3.1');
		const read = readVersionLiteral(source.dir);

		expect(read.version).toBe('0.3.1');
		expect(read.verifiedUpstream).toEqual(['1.135.0']);
	});

	it('reports an empty verified list rather than failing over it', () => {
		const source = makeSource('no-tags');
		writeFileSync(join(source.dir, ...RUNTIME_VERSION_FILE.split('/')), versionFile('0.1.0', []), 'utf8');
		expect(readVersionLiteral(source.dir).verifiedUpstream).toEqual([]);
	});
});
