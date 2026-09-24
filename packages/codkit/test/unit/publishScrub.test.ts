// unit: the scrub of a clean release (PROP-007 ##PUBLISH-SCRUB,
// ##PUBLISH-EXCLUDE, ##PUBLISH-SCRUB-FAIL-CLOSED).
//
// The text rules run on synthetic files; the release tree runs on a two-commit
// repository in a temporary directory - a pin and a tip - the way `publish`
// runs it on the disposable fork. The marker forms come from the shipped
// conventions.json, not from a copy of it.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { markerFormFor } from '../../src/lib/markers.ts';
import type { MarkerConventions } from '../../src/lib/markers.ts';
import { scrubReleaseTree } from '../../src/lib/publishRelease.ts';
import { commentSyntaxOf, markerFormsOf, scrubText } from '../../src/lib/publishScrub.ts';
import type { ScrubbedText } from '../../src/lib/publishScrub.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** The shipped forms plus one a conventions extension could add. */
function withExtension(): MarkerConventions {
	const shipped = conventions();
	return { ...shipped, markerComment: { ...shipped.markerComment, '.lua': { open: '-- codkit:', close: '' } } };
}

function scrub(path: string, text: string, known: MarkerConventions = conventions()): ScrubbedText {
	return scrubText(text, commentSyntaxOf(path, known), markerFormsOf(known));
}

describe('publish scrub: marker lines', () => {
	it('removes begin and end lines in every form codkit emits, with any indentation', () => {
		const known = withExtension();
		const extensions = Object.keys(known.markerComment).filter((key) => !key.startsWith('_'));
		expect(extensions).toEqual(expect.arrayContaining(['.ts', '.css', '.html', '.md', '.sh', '.yml', '.lua']));
		for (const ext of extensions) {
			const form = markerFormFor(ext, known);
			if (form === null) throw new Error(`no marker form for ${ext}`);
			const text = [
				'first',
				`\t\t${form.open}begin CK-shell-001${form.close}`,
				'\tbody',
				`${form.open}end CK-shell-001${form.close}`,
				'last',
				''
			].join('\n');
			const scrubbed = scrub(`file${ext}`, text, known);
			expect(scrubbed.text, ext).toBe('first\n\tbody\nlast\n');
			expect(scrubbed.markers, ext).toBe(2);
		}
	});

	it('removes the named markers of managed blocks, also in a file whose extension has no form', () => {
		const notice = '# Notice\n<!-- codkit:begin components -->\nstandards 1.0.0\n<!-- codkit:end components -->\n';
		expect(scrub('LICENSE-CODKIT.md', notice).text).toBe('# Notice\nstandards 1.0.0\n');
		const toml = 'a = 1\n# codkit:begin standards\n[requires]\n# codkit:end standards\n';
		expect(commentSyntaxOf('vibe.toml', conventions())).toBeNull();
		expect(scrub('vibe.toml', toml)).toMatchObject({ text: 'a = 1\n[requires]\n', markers: 2 });
	});

	it('keeps a line that only mentions a marker, and a path that names the codkit directory', () => {
		const text = "\t// codkit:begin CK-shell-001 and more\n\tconst runtime = 'src/vs/patchset/codkit/**';\n";
		expect(scrub('build.ts', text)).toMatchObject({ text, markers: 0 });
	});
});

describe('publish scrub: spec references', () => {
	it('takes parentheticals out of comment prose and moves their punctuation up', () => {
		const text = [
			'/**',
			' * The configuration defaults of the product',
			' * (spec://nimbus/FEAT-007-product-chat#CP-AI-DEFAULTS). `product.json` has no',
			' * field for defaults.',
			' */',
			'/*',
			' *  The container of a chat takes the secondary side bar, once',
			' *  (spec://nimbus/FEAT-007-product-chat#CP-PLACEMENT).',
			' *',
			' *  The chats of the product (spec://nimbus/FEAT-007-product-chat#CP-PROVIDERS).',
			' */',
			'/**',
			' * Where Nimbus keeps its user data',
			' * (spec://nimbus/PROP-003-configuration-locations#CONFIG-USER-HOME): `<home>/.config/nimbus` on Windows,',
			' * The two documents (spec://nimbus/FEAT-005#EP-POLICY-DOCUMENT, EP-CHECKSUM-DOCUMENT): the policy',
			' */',
			'export const x = 1;',
			''
		].join('\n');
		const scrubbed = scrub('src/defaults.ts', text);
		expect(scrubbed.text).toBe(
			[
				'/**',
				' * The configuration defaults of the product.',
				' * `product.json` has no',
				' * field for defaults.',
				' */',
				'/*',
				' *  The container of a chat takes the secondary side bar, once.',
				' *',
				' *  The chats of the product.',
				' */',
				'/**',
				' * Where Nimbus keeps its user data:',
				' * `<home>/.config/nimbus` on Windows,',
				' * The two documents: the policy',
				' */',
				'export const x = 1;',
				''
			].join('\n')
		);
		expect(scrubbed).toMatchObject({ specRefs: 5, droppedLines: 1, markers: 0 });
	});

	it('drops tag lines, and keeps the delimiters of a block they open', () => {
		const text = [
			'/** @scope spec://codkit/modules/codkit/PROP-011#root */',
			'// Immutable publish transaction.',
			'/**',
			' * Build the tree.',
			' * @implements spec://codkit/modules/codkit/PROP-007#PUBLISH-SQUASH',
			' * @verifies spec://codkit/a#B spec://codkit/c#D',
			' */',
			'// @scope spec://codkit/x#root',
			'/** @scope spec://codkit/x#y',
			' * more text',
			' */',
			'function f() {}',
			''
		].join('\n');
		const scrubbed = scrub('src/tree.ts', text);
		expect(scrubbed.text).toBe(
			['// Immutable publish transaction.', '/**', ' * Build the tree.', ' */', '/**', ' * more text', ' */', 'function f() {}', ''].join(
				'\n'
			)
		);
		expect(scrubbed).toMatchObject({ specRefs: 6, droppedLines: 4 });
	});

	it('removes bare tokens from comments and never alters code', () => {
		const text = [
			"const address = 'spec://nimbus/FEAT-001#X'; // see spec://nimbus/FEAT-001#Y for the rule",
			'foo(/* (spec://nimbus/FEAT-001#Z) */ 1);',
			'// the rule `spec://nimbus/FEAT-001#W` holds; see also spec://nimbus/FEAT-002#V.',
			'/* (spec://nimbus/FEAT-003#U) */ bar();',
			'const product = 1 *',
			'  (spec://nimbus/FEAT-004#T);',
			''
		].join('\n');
		const scrubbed = scrub('src/code.ts', text);
		const lines = scrubbed.text.split('\n');
		expect(lines[0]).toBe("const address = 'spec://nimbus/FEAT-001#X'; // see spec://nimbus/FEAT-001#Y for the rule");
		expect(lines[1]).toBe('foo(/* (spec://nimbus/FEAT-001#Z) */ 1);');
		expect(lines[2]).toBe('// the rule holds; see also.');
		expect(lines[3]).toBe('/* */ bar();');
		expect(lines[4]).toBe('const product = 1 *');
		expect(lines[5]).toBe('  (spec://nimbus/FEAT-004#T);');
		expect(scrubbed.specRefs).toBe(3);
	});

	it('reads hash and markup comments by their form, and leaves prose and files without a form alone', () => {
		const shell = '#!/bin/sh\n# Build the tree (spec://nimbus/FEAT-001#BUILD).\n# @scope spec://nimbus/FEAT-001#root\necho "spec://kept"\n';
		expect(scrub('build.sh', shell)).toMatchObject({
			text: '#!/bin/sh\n# Build the tree.\necho "spec://kept"\n',
			specRefs: 2,
			droppedLines: 1
		});
		const markdown = [
			'# Title',
			'',
			'Prose names spec://nimbus/FEAT-001#PROSE and stays.',
			'<!-- (spec://nimbus/FEAT-001#DOC) -->',
			'<!--',
			'The owner (spec://nimbus/FEAT-001#OWNER).',
			'-->',
			''
		].join('\n');
		expect(scrub('README.md', markdown).text).toBe(
			['# Title', '', 'Prose names spec://nimbus/FEAT-001#PROSE and stays.', '<!--', 'The owner.', '-->', ''].join('\n')
		);
		const json = '{ "link": "spec://nimbus/FEAT-001#JSON" }\n';
		expect(scrub('product.json', json)).toMatchObject({ text: json, specRefs: 0 });
	});

	it('keeps CRLF line ends and comment lines that were empty before', () => {
		const text = '// a (spec://nimbus/FEAT-001#A)\r\n//\r\n// (spec://nimbus/FEAT-001#B)\r\n// b\r\n';
		expect(scrub('win.ts', text)).toMatchObject({ text: '// a\r\n//\r\n// b\r\n', specRefs: 2, droppedLines: 1 });
	});
});

describe('publish scrub: the release tree', () => {
	it('scrubs delivered files, leaves excluded ones out, and names every leftover', () => {
		const repo = makeTempRoot('publish-scrub-tree');
		fixtureGit(repo, ['init', '--quiet', '--initial-branch=main']);
		write(repo, 'README.md', 'upstream: spec://upstream-owns-this\n');
		write(repo, 'src/a.ts', 'export const a = 1;\n');
		const pin = fixtureCommit(repo, 'pin', '2026-01-01T00:00:00Z');
		write(repo, 'src/a.ts', 'export const a = 1;\n// codkit:begin CK-shell-001\nimport "./own/x.js";\n// codkit:end CK-shell-001\n');
		write(repo, 'src/own/x.ts', "/**\n * The own module (spec://nimbus/FEAT-001#X).\n */\nexport const x = 'spec://in-code';\n");
		write(repo, 'src/own/NOTES.md', 'The specs live in vibevm/vibespecs.\n');
		writeFileSync(join(repo, 'src', 'own', 'logo.bin'), Buffer.from([0x00, ...Buffer.from('VibeVM'), 0x00]));
		const tip = fixtureCommit(repo, 'tip', '2026-01-02T00:00:00Z');

		const { tree, report } = scrubReleaseTree({
			treeDir: repo,
			scratchDir: join(makeTempRoot('publish-scrub-scratch'), 'release'),
			pinSha: pin,
			tip,
			conventions: conventions(),
			exclude: ['src/own/NOTES.md', 'src/missing']
		});

		expect(report.files).toEqual([
			{ path: 'src/a.ts', markers: 2, specRefs: 0, droppedLines: 0 },
			{ path: 'src/own/x.ts', markers: 0, specRefs: 1, droppedLines: 0 }
		]);
		expect(report.excluded).toEqual(['src/own/NOTES.md']);
		expect(report.unmatched).toEqual(['src/missing']);
		// Fail-closed over the whole tree: code, a binary file, and upstream's own bytes.
		expect(report.leftovers.map((leftover) => [leftover.path, leftover.line])).toEqual([
			['README.md', 1],
			['src/own/logo.bin', null],
			['src/own/x.ts', 4]
		]);
		expect(gitOut(repo, ['show', `${tree}:src/a.ts`])).toBe('export const a = 1;\nimport "./own/x.js";\n');
		expect(gitOut(repo, ['show', `${tree}:src/own/x.ts`])).toBe("/**\n * The own module.\n */\nexport const x = 'spec://in-code';\n");
		expect(gitOut(repo, ['ls-tree', '-r', '--name-only', tree]).split('\n')).toEqual([
			'README.md',
			'src/a.ts',
			'src/own/logo.bin',
			'src/own/x.ts'
		]);
	});
});

function write(repo: string, relative: string, text: string): void {
	const path = join(repo, ...relative.split('/'));
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text, 'utf8');
}

function gitOut(repo: string, args: readonly string[]): string {
	const result = runGit({ args, cwd: repo });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.trimEnd() + (args[0] === 'show' ? '\n' : '');
}
