// PROP-013 ##UT-STANDARDS-MANIFEST: the managed-block automaton on abstract
// markers, then its two instances.
//
// The law it has to keep is one line: own exactly one delimited block, never
// touch a byte outside it (PROP-014 ##STD-MANIFEST-NO-TOML-PARSER). Every case
// below compares the slices outside the block before and after.

import { describe, expect, it } from 'vitest';
import { applyBlock, refuseCarriageReturn, scanBlock } from '../../src/lib/managedBlock.ts';
import type { BlockMarkers } from '../../src/lib/managedBlock.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { canonicalManifestBlock, manifestMarkers, requireProjectTable } from '../../src/lib/standardsManifest.ts';
import { CANONICAL_SCRAPE_BLOCK, SCRAPE_MARKERS } from '../../src/lib/standardsScrape.ts';

const MARKERS: BlockMarkers = { begin: '# begin', end: '# end', needles: ['NEEDLE'] };
const CANONICAL = '# begin\nvalue = 1\n# end';

function codeOf(run: () => unknown): string | null {
	try {
		run();
		return null;
	} catch (error) {
		return isCkError(error) ? error.code : 'not-a-ck-error';
	}
}

describe('scanBlock', () => {
	it('finds nothing in a file without markers', () => {
		const scan = scanBlock('a = 1\n', MARKERS);

		expect(scan.state).toBe('absent');
		expect(scan.beginLine).toBeNull();
	});

	it('finds a well-formed block and its lines', () => {
		const scan = scanBlock(`head = 1\n\n${CANONICAL}\n`, MARKERS);

		expect(scan.state).toBe('present');
		expect(scan.beginLine).toBe(3);
		expect(scan.endLine).toBe(5);
		expect(scan.text).toBe(CANONICAL);
	});

	it('refuses a lone marker, a repeated one and a reversed pair', () => {
		expect(scanBlock('# begin\n', MARKERS).state).toBe('malformed');
		expect(scanBlock('# begin\n# begin\n# end\n', MARKERS).state).toBe('malformed');
		const reversed = scanBlock('# end\n# begin\n', MARKERS);
		expect(reversed.state).toBe('malformed');
		expect(reversed.reason).toContain('before the begin marker');
	});

	it('sees a needle outside the block but ignores one inside a comment', () => {
		expect(scanBlock('other = "NEEDLE"\n', MARKERS).outsideEntryLine).toBe(1);
		expect(scanBlock('# a note about NEEDLE\n', MARKERS).outsideEntryLine).toBeNull();
		expect(scanBlock(`${CANONICAL.replace('value = 1', 'x = "NEEDLE"')}\n`, MARKERS).outsideEntryLine).toBeNull();
	});

	it('warns about a key written after the block with no table header of its own', () => {
		expect(scanBlock(`${CANONICAL}\nstray = 1\n`, MARKERS).tailWarningLine).toBe(4);
		expect(scanBlock(`${CANONICAL}\n[other]\nstray = 1\n`, MARKERS).tailWarningLine).toBeNull();
		expect(scanBlock(`${CANONICAL}\n# a comment\n`, MARKERS).tailWarningLine).toBeNull();
	});
});

describe('applyBlock', () => {
	it('appends after a blank line and normalises a missing final newline', () => {
		const applied = applyBlock('head = 1', CANONICAL, MARKERS);

		expect(applied.action).toBe('append');
		expect(applied.text).toBe(`head = 1\n\n${CANONICAL}\n`);
	});

	it('leaves an already-canonical file byte-identical', () => {
		const text = `head = 1\n\n${CANONICAL}\n`;
		const applied = applyBlock(text, CANONICAL, MARKERS);

		expect(applied.action).toBe('unchanged');
		expect(applied.text).toBe(text);
	});

	it('replaces only the block, byte for byte outside it', () => {
		const head = 'head = 1\n# a comment of mine\n\n';
		const tail = '\n[later]\nkeep = "mine"\n';
		const stale = '# begin\nvalue = 0\n# end';
		const applied = applyBlock(`${head}${stale}${tail}`, CANONICAL, MARKERS);

		expect(applied.action).toBe('update');
		expect(applied.text.startsWith(head)).toBe(true);
		expect(applied.text.endsWith(tail)).toBe(true);
		expect(applied.text).toBe(`${head}${CANONICAL}${tail}`);
	});

	it('refuses to touch a malformed block at all', () => {
		expect(codeOf(() => applyBlock('# begin\nvalue = 1\n', CANONICAL, MARKERS))).toBe('CONFIG');
	});

	it('refuses a file with CR rather than guessing its line endings', () => {
		expect(codeOf(() => refuseCarriageReturn('a = 1\r\n', 'vibe.toml'))).toBe('CRLF');
		expect(codeOf(() => refuseCarriageReturn('a = 1\n', 'vibe.toml'))).toBeNull();
	});
});

describe('the manifest instance', () => {
	it('renders one table per shipped package inside one block', () => {
		const block = canonicalManifestBlock([
			{ name: 'standards', version: '0.1.0' },
			{ name: 'agent-skills', version: '0.2.0' }
		]);

		expect(block.split('\n')).toEqual([
			'# codkit:begin standards',
			'# Managed by `codkit standards load`; do not edit inside this block.',
			'[requires.packages."org.vibevm.codkit/standards"]',
			'version = "=0.1.0"',
			'link = "static"',
			'[requires.packages."org.vibevm.codkit/agent-skills"]',
			'version = "=0.2.0"',
			'link = "static"',
			'# codkit:end standards'
		]);
	});

	it('sees a dependency entry written outside the block, for either package', () => {
		const markers = manifestMarkers(['standards', 'agent-skills']);
		const standards = `[project]\nname = "x"\n\n[requires.packages]\n"org.vibevm.codkit/standards" = "0.1.0"\n`;
		expect(scanBlock(standards, markers).outsideEntryLine).toBe(5);

		const skills = `[project]\nname = "x"\n\n[requires.packages."org.vibevm.codkit/agent-skills"]\nversion = "=0.1.0"\n`;
		expect(scanBlock(skills, markers).outsideEntryLine).toBe(4);
	});

	it('requires a [project] table before it will write anything', () => {
		expect(codeOf(() => requireProjectTable('[package]\nname = "x"\n'))).toBe('CONFIG');
		expect(codeOf(() => requireProjectTable('[project]\nname = "x"\n'))).toBeNull();
	});
});

describe('the scrape-contract instance', () => {
	it('carries both rows and all three needles', () => {
		expect(CANONICAL_SCRAPE_BLOCK).toContain('[[classify]]');
		expect(CANONICAL_SCRAPE_BLOCK).toContain('[[assert]]');
		expect(CANONICAL_SCRAPE_BLOCK).toContain('kind = "paths-absent-v1"');
		expect(SCRAPE_MARKERS.needles).toEqual(['remove-codkit-licence-notice', 'codkit-licence-notice-absent', 'LICENSE-CODKIT.md']);
	});

	it('appends after the last element of a contract', () => {
		const contract = '[policy]\nmode = "strict"\n\n[[healthcheck]]\nid = "build"\n';
		const applied = applyBlock(contract, CANONICAL_SCRAPE_BLOCK, SCRAPE_MARKERS);

		expect(applied.action).toBe('append');
		expect(applied.text.startsWith(contract)).toBe(true);
		expect(applied.text).toContain('# codkit:begin scrape');
	});

	it('sees a foreign row that names the notice', () => {
		const contract = `[policy]\nmode = "strict"\n\n[[classify]]\npatterns = ["LICENSE-CODKIT.md"]\n`;
		expect(scanBlock(contract, SCRAPE_MARKERS).outsideEntryLine).toBe(5);
	});
});
