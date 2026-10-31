// unit: the bare references of a clean release (PROP-007 ##PUBLISH-SCRUB-VOCABULARY,
// ##PUBLISH-SCRUB-ID-SHAPE, ##PUBLISH-SCRUB-GROUPS, ##PUBLISH-SCRUB-FAIL-CLOSED).
//
// The vocabulary is learned the way `publish` learns it - from spec documents,
// intervention ids, marker lines and `spec://` references - never written down
// here as a naming pattern. The sample lines follow the shapes a consumer's
// spec tree carries. The release tree runs on a two-commit repository, a pin and a tip.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { scrubReleaseTree } from '../../src/lib/publishRelease.ts';
import { isMarkdownProse, scrubReferences } from '../../src/lib/publishReferences.ts';
import type { ReferenceScrub } from '../../src/lib/publishReferences.ts';
import { commentSyntaxOf } from '../../src/lib/publishScrub.ts';
import {
	EMPTY_SETTINGS,
	findTokens,
	isIdShaped,
	learnVocabulary,
	readSpecDocument,
	vocabularySources
} from '../../src/lib/publishVocabulary.ts';
import type { ScrubSettings, Vocabulary, VocabularySources } from '../../src/lib/publishVocabulary.ts';
import { fixtureCommit, fixtureGit, makeUpstream } from '../fixtures/makeUpstream.ts';
import { makePatchSet } from '../fixtures/makePatchSet.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

/** A spec document in the vibevm dialect: facts are elements marked `fact="true"`. */
function specDocument(title: string, facts: readonly string[]): string {
	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!-- a licence header may name <NOT-A-FACT fact="true"> in passing -->',
		'<spec xmlns="https://vibevm.org/spec/1">',
		`  <title id="root">${title}</title>`,
		'  <section id="intro-part" title="1. Intro">',
		...facts.map((fact) => `    <p><${fact} fact="true" status="spec/done">text</${fact}></p>`),
		"    <p><config-valid-sample fact='true'>a lower-case fact</config-valid-sample></p>",
		'  </section>',
		'</spec>',
		''
	].join('\n');
}

const FACTS_004 = ['CS-REQUIREMENT', 'CS-SESSIONS-GUARD', 'CS-MECH-WEBVIEW', 'CS-D14'];
const FACTS_005 = ['EP-SETTING', 'EP-AGENTS-WINDOW', 'EP-D5', 'EP-POLICY-PAYLOAD'];
const FACTS_007 = ['CP-PROVIDERS', 'CP-PLACEMENT', 'CP-D2', 'CP-BUTTON', 'CP-COPILOT-IN-PACKAGE'];
const FACTS_P004 = ['BU-D2', 'BU-D8', 'BU-D9', 'BU-TEXT-HOMEPAGE'];

function sources(settings: Partial<ScrubSettings> = {}): VocabularySources {
	return {
		interventionIds: ['CK-build-002', 'CK-build-006', 'CK-workbench-008', 'CK-brand-resources-darwin-bat.icns', 'standards'],
		specDocuments: [
			{
				path: 'vibevm/vibespecs/modules/nimbus/FEAT-004-center-surfaces.xml',
				text: specDocument('nimbus FEAT-004: The center', FACTS_004)
			},
			{
				path: 'vibevm/vibespecs/modules/nimbus/FEAT-005-enterprise-policy.xml',
				text: specDocument('nimbus FEAT-005: The policy', FACTS_005)
			},
			{
				path: 'vibevm/vibespecs/modules/nimbus/FEAT-006-first-run.xml',
				text: specDocument('nimbus FEAT-006: First run', ['FR-TRIGGER', 'FR-GUARDS'])
			},
			{ path: 'vibevm/vibespecs/modules/nimbus/FEAT-007-product-chat.xml', text: specDocument('nimbus FEAT-007: Chat', FACTS_007) },
			{
				path: 'vibevm/vibespecs/modules/nimbus/FEAT-010-no-agents-window.xml',
				text: specDocument('nimbus FEAT-010: No Agents', ['AW-OWN-UNIT', 'AW-LOG'])
			},
			{ path: 'vibevm/vibespecs/common/PROP-004-brand-update.xml', text: specDocument('nimbus PROP-004: Brand', FACTS_P004) },
			{ path: 'vibevm/vibespecs/WAL.xml', text: specDocument('WAL - the final checkpoint', []) }
		],
		settings: { ...EMPTY_SETTINGS, ...settings }
	};
}

function vocabulary(settings: Partial<ScrubSettings> = {}, delivered: readonly string[] = []): Vocabulary {
	return learnVocabulary(sources(settings), delivered);
}

function scrub(path: string, text: string, known: Vocabulary = vocabulary()): ReferenceScrub {
	return scrubReferences(text, commentSyntaxOf(path, conventions()), isMarkdownProse(path), known);
}

describe('publish scrub: the vocabulary', () => {
	it('takes a word as an id only in the shape of one', () => {
		for (const id of [
			'AP-D1',
			'FEAT-004',
			'CK-build-002',
			'PROP-001-seam-map-1.135.0',
			'CK-brand-resources-darwin-bat.icns',
			'RU-OWN-MERGE'
		]) {
			expect(isIdShaped(id), id).toBe(true);
		}
		// root: every title's id; WAL: a stem; standards: a managed block; the rest: a
		// lower-case fact, a section anchor, too short, not opening or closing with a character of a word.
		for (const word of ['root', 'WAL', 'standards', 'config-valid-sample', 'intro-part', 'D1', 'A-1', '-AB1', 'AB1.', 'CK build']) {
			expect(isIdShaped(word), word).toBe(false);
		}
	});

	it('reads a spec document: its stem, its id from the title, its module and its facts', () => {
		const learned = readSpecDocument({
			path: 'vibevm/vibespecs/modules/nimbus/FEAT-004-center-surfaces.xml',
			text: specDocument('nimbus FEAT-004: The center', FACTS_004)
		});
		expect(learned).toEqual({
			stem: 'FEAT-004-center-surfaces',
			documentId: 'FEAT-004',
			module: 'nimbus',
			facts: ['root', 'intro-part', ...FACTS_004, 'config-valid-sample']
		});
		const bare = readSpecDocument({ path: 'specs/ADR-0042-use-queues.xml', text: '<spec><title>ADR-0042 - use queues</title></spec>' });
		expect(bare).toMatchObject({ stem: 'ADR-0042-use-queues', documentId: 'ADR-0042', module: null, facts: [] });
		const untitled = readSpecDocument({ path: 'specs/notes-2.xml', text: '<spec><title>Notes</title></spec>' });
		expect(untitled).toMatchObject({ stem: 'notes-2', documentId: null, module: null });
	});

	it('learns ids from the inventory, the marker lines, the spec documents and the spec references, and keeps generic words out', () => {
		const delivered = [
			'// codkit:begin CK-platform-001\n// codkit:end CK-platform-001\n# codkit:begin standards\n',
			' * (spec://nimbus/FEAT-009-report-issue#RI-TARGET, spec://codkit/modules/codkit/PROP-007#IMAGESET-DECLARATION.)\n/** @scope spec://nimbus/FEAT-009-report-issue#root */\n'
		];
		const learned = vocabulary({}, delivered);
		const kinds = Object.fromEntries(learned.tokens);
		expect(kinds).toMatchObject({
			'CK-build-002': 'intervention',
			'CK-platform-001': 'intervention',
			'FEAT-004': 'spec',
			'FEAT-004-center-surfaces': 'spec',
			'CS-REQUIREMENT': 'spec',
			'FEAT-009-report-issue': 'spec',
			'RI-TARGET': 'spec',
			'PROP-007': 'spec',
			'IMAGESET-DECLARATION': 'spec'
		});
		for (const generic of ['root', 'WAL', 'standards', 'intro-part', 'config-valid-sample', 'NOT-A-FACT', 'nimbus', 'codkit']) {
			expect(learned.tokens.has(generic), generic).toBe(false);
		}
		expect([...learned.modules].sort()).toEqual(['codkit', 'nimbus']);
		expect(learned.counts).toEqual({ interventions: 5, documents: 6, stems: 8, facts: 23, modules: 2, configured: 0, allowed: 0 });
	});

	it('adds the configured tokens and patterns, and keeps the tokens the owner allows in the vocabulary', () => {
		const learned = vocabulary({ vocabulary: ['RISK-018', { regex: 'VC-R-[0-9]+' }], allow: ['BU-D2'] });
		expect(learned.tokens.get('RISK-018')).toBe('configured');
		expect(learned.tokens.get('BU-D2')).toBe('spec');
		expect([...learned.allowed]).toEqual(['BU-D2']);
		expect(learned.counts).toMatchObject({ configured: 2, allowed: 1 });
		const text = 'risk VC-R-018 of the register, VC-R-0189x, RISK-018, BU-D2 and BU-D8';
		expect(findTokens(learned, text).map((match) => [match.token, match.kind])).toEqual([
			['VC-R-018', 'configured'],
			['RISK-018', 'configured'],
			['BU-D2', 'spec'],
			['BU-D8', 'spec']
		]);
	});

	it('finds a token only between characters that are not a word, the longest first', () => {
		const learned = vocabulary();
		const found = (text: string): string[] => findTokens(learned, text).map((match) => match.token);
		expect(found('FEAT-004-center-surfaces and FEAT-004.')).toEqual(['FEAT-004-center-surfaces', 'FEAT-004']);
		expect(found('XFEAT-004 FEAT-0041 FEAT-004_x CK-build-0021')).toEqual([]);
		expect(found('`CS-D14`, FEAT-004-draft, (CK-build-002), "EP-D5"')).toEqual(['CS-D14', 'FEAT-004', 'CK-build-002', 'EP-D5']);
	});

	it('reads the spec documents of the published commit under the spec roots, and names a root it lacks', () => {
		const snapshot = makeTempRoot('publish-vocabulary-snapshot');
		makePatchSet(snapshot, makeUpstream(makeTempRoot('publish-vocabulary-upstream')));
		write(snapshot, 'vibevm/vibespecs/modules/fixture/FEAT-001-greeting.xml', specDocument('fixture FEAT-001: Greeting', ['GR-HELLO']));
		write(snapshot, 'vibevm/vibespecs/boot/INDEX.md', '# not a spec document\n');
		const learned = vocabularySources({
			snapshotDir: snapshot,
			type: stubProjectType,
			config: loadConfig(snapshot) ?? fail('the fixture carries codkit.json'),
			patchSetSha: '0'.repeat(40),
			settings: { ...EMPTY_SETTINGS, specRoots: ['vibevm/vibespecs', 'docs/specs'] }
		});
		expect(learned.missing).toEqual(['docs/specs']);
		expect(learned.sources.specDocuments.map((document) => document.path)).toEqual([
			'vibevm/vibespecs/modules/fixture/FEAT-001-greeting.xml'
		]);
		expect(learned.sources.interventionIds).toEqual(expect.arrayContaining(['CK-shell-901', 'CK-shell-902', 'CK-product-901']));
	});
});

describe('publish scrub: reference groups', () => {
	it('removes a parenthetical that holds only a group, with its leading blank, also across lines', () => {
		const text = [
			'// Nimbus ships no built-in Copilot (FEAT-007 CP-COPILOT-IN-PACKAGE): the task stays.',
			'/*',
			' *  Nimbus guard: the product has no Agents window (nimbus FEAT-010 AW-OWN-UNIT,',
			' *  AW-LOG). The answer is always no.',
			' *',
			' *  The value lives in the overlay and is not repeated here (PROP-004',
			' *  BU-D2). The service that opens it is guarded elsewhere.',
			' *  The runtime is a path of the build, `src/vs/patchset/codkit/**`',
			' *  (intervention `CK-build-002`). Wearing the header would be wrong,',
			' *  and so is a setting (FEAT-004, decision D-C6), (decision CS-D14)',
			' *  and (PROP-004 BU-D2, BU-D8; BU-D9 and `BU-TEXT-HOMEPAGE`).',
			' */',
			''
		].join('\n');
		const scrubbed = scrub('src/guard.ts', text);
		expect(scrubbed.text).toBe(
			[
				'// Nimbus ships no built-in Copilot: the task stays.',
				'/*',
				' *  Nimbus guard: the product has no Agents window.',
				' *  The answer is always no.',
				' *',
				' *  The value lives in the overlay and is not repeated here.',
				' *  The service that opens it is guarded elsewhere.',
				' *  The runtime is a path of the build, `src/vs/patchset/codkit/**`.',
				' *  Wearing the header would be wrong,',
				' *  and so is a setting,',
				' *  and.',
				' */',
				''
			].join('\n')
		);
		expect(scrubbed.groups).toEqual({ parenthetical: 7, lead: 0, sentence: 0, preposition: 0 });
		expect(scrubbed.droppedLines).toBe(0);
	});

	it('carries the punctuation of a parenthetical that opens a line up, and drops the emptied line', () => {
		const text = [
			'/**',
			' * The Copy button text is rewritten the same way',
			' * (FEAT-008 AB-COPY).',
			' */',
			'// holds the place of the first-run window',
			'// (FEAT-006).',
			'//',
			'// (CK-workbench-008), and the entry stays.',
			''
		].join('\n');
		const known = vocabulary({ vocabulary: ['FEAT-008', 'AB-COPY'] });
		expect(scrub('src/about.ts', text, known)).toMatchObject({
			text: [
				'/**',
				' * The Copy button text is rewritten the same way.',
				' */',
				'// holds the place of the first-run window.',
				'//',
				'// and the entry stays.',
				''
			].join('\n'),
			groups: { parenthetical: 3, lead: 0, sentence: 0, preposition: 0 },
			droppedLines: 2
		});
	});

	it('removes a group that opens a comment with its colon', () => {
		const text = [
			'\t\t// FEAT-007 CP-PROVIDERS: a new chat of the product is a new entry, and it is seen in review.',
			'\t\t// PROP-004 BU-D8: nine layers.',
			'\t\t// FEAT-007 CP-PROVIDERS:',
			'\t\t// the next line stays.',
			''
		].join('\n');
		expect(scrub('test/chatProviders.test.ts', text)).toMatchObject({
			text: [
				'\t\t// a new chat of the product is a new entry, and it is seen in review.',
				'\t\t// nine layers.',
				'\t\t// the next line stays.',
				''
			].join('\n'),
			groups: { parenthetical: 0, lead: 3, sentence: 0, preposition: 0 },
			droppedLines: 1
		});
	});

	it('removes a sentence that is only a group, or See and a group, also across lines', () => {
		const text = [
			'/**',
			' * the boundary. See FEAT-005 `EP-SETTING`.',
			' *  order a runner happens to load files in. FEAT-006 `FR-TRIGGER`, `FR-GUARDS`.',
			' *  whatever the user does stays. FEAT-007 `CP-PLACEMENT`, decision `CP-D2`.',
			' */',
			'// Nothing of the center comes with it. FEAT-005',
			'// `EP-AGENTS-WINDOW`.',
			'\t// PROP-004 BU-TEXT-HOMEPAGE.',
			'\tconst address = 1;',
			''
		].join('\n');
		expect(scrub('src/policy.ts', text)).toMatchObject({
			text: [
				'/**',
				' * the boundary.',
				' *  order a runner happens to load files in.',
				' *  whatever the user does stays.',
				' */',
				'// Nothing of the center comes with it.',
				'\tconst address = 1;',
				''
			].join('\n'),
			groups: { parenthetical: 0, lead: 0, sentence: 5, preposition: 0 },
			droppedLines: 2
		});
	});

	it('removes a group after of, in, by, per or from together with the preposition, also across lines', () => {
		const text = [
			'/*',
			' * direction rule of FEAT-004 section 5b.',
			' *  registry. Every rule of FEAT-004 section 5a that is about which surface is',
			' *  active. So each rule of',
			' *  FEAT-004 section 7 - the publisher prefix - is one test,',
			' *  as named in FEAT-005 and nowhere else, written by `CK-build-006` alone,',
			' *  checked per PROP-004 always and read from FEAT-007 CP-BUTTON. Two rules',
			' *  of FEAT-004 (FEAT-005), (FEAT-006) and more.',
			' */',
			''
		].join('\n');
		expect(scrub('src/center.ts', text)).toMatchObject({
			text: [
				'/*',
				' * direction rule.',
				' *  registry. Every rule that is about which surface is',
				' *  active. So each rule',
				' *  - the publisher prefix - is one test,',
				' *  as named and nowhere else, written alone,',
				' *  checked always and read. Two rules,',
				' *  and more.',
				' */',
				''
			].join('\n'),
			groups: { parenthetical: 2, lead: 0, sentence: 0, preposition: 8 }
		});
	});

	it('leaves every other place alone, and tidies only where it removed something', () => {
		const text = [
			'/*',
			' *  (`chatProviders.ts`, FEAT-007 CP-BUTTON), and a  double blank stays;',
			' *  a replacement (FEAT-004, D-C7). The owning specification is FEAT-004.',
			' *  the build graft CK-build-006 writes the resource. Before EP-SETTING an',
			' *  intervention FEAT-004 is no qualifier (intervention FEAT-004), nor is nimbus alone (nimbus).',
			' *  a  b (FEAT-004 CS-REQUIREMENT) .',
			' *  the rule (FEAT-004), (FEAT-005), and more.',
			' */',
			''
		].join('\n');
		const scrubbed = scrub('src/left.ts', text);
		const lines = text.split('\n');
		lines[5] = ' *  a  b.';
		lines[6] = ' *  the rule, and more.';
		expect(scrubbed.text).toBe(lines.join('\n'));
		expect(scrubbed.groups).toEqual({ parenthetical: 3, lead: 0, sentence: 0, preposition: 0 });
	});

	it('never alters code, strings or data: a trailing comment after code is code', () => {
		const code = [
			"const id = 'FEAT-004'; // (FEAT-004 CS-REQUIREMENT)",
			"assert.ok(entry, 'workbench.desktop.main imports the gallery (CK-workbench-008)');",
			'foo(/* (FEAT-004) */ 1);',
			''
		].join('\n');
		expect(scrub('src/code.ts', code)).toMatchObject({ text: code, groups: { parenthetical: 0 } });
		const json = '{\n\t"description": "Russian translations (nimbus FEAT-003 RU-OWN-TRANSLATIONS-FILE)."\n}\n';
		expect(scrub('translations/nimbus.i18n.json', json).text).toBe(json);
	});

	it('reads Markdown prose and comments, and leaves fenced code alone', () => {
		const text = [
			'# The pack',
			'',
			'The bootstrap adds its modules to the core',
			'translations (FEAT-004 `CS-REQUIREMENT`, `CS-SESSIONS-GUARD`). A new own',
			'string needs its translation here (spec://nimbus/FEAT-004-center-surfaces#CS-REQUIREMENT).',
			'',
			'Prose names spec://nimbus/FEAT-004#X and stays, as does FEAT-004 here.',
			'',
			'```sh',
			'echo "(FEAT-004 CS-REQUIREMENT)"',
			'```',
			'<!--',
			'The owner (FEAT-004).',
			'-->',
			''
		].join('\n');
		const scrubbed = scrub('extensions/pack/README.md', text);
		expect(scrubbed.text).toBe(
			[
				'# The pack',
				'',
				'The bootstrap adds its modules to the core',
				'translations. A new own',
				'string needs its translation here.',
				'',
				'Prose names spec://nimbus/FEAT-004#X and stays, as does FEAT-004 here.',
				'',
				'```sh',
				'echo "(FEAT-004 CS-REQUIREMENT)"',
				'```',
				'<!--',
				'The owner.',
				'-->',
				''
			].join('\n')
		);
		expect(scrubbed.groups).toEqual({ parenthetical: 3, lead: 0, sentence: 0, preposition: 0 });
	});

	it('keeps CRLF line ends', () => {
		const text = '// a rule (FEAT-004)\r\n//\r\n// (CK-build-002).\r\n// b\r\n';
		expect(scrub('win.ts', text)).toMatchObject({ text: '// a rule\r\n//\r\n// b\r\n', droppedLines: 1 });
	});
});

describe('publish scrub: references in the release tree', () => {
	it('scrubs the groups of delivered files and stops on every token left, in any delivered file', () => {
		const repo = makeTempRoot('publish-references-tree');
		fixtureGit(repo, ['init', '--quiet', '--initial-branch=main']);
		write(repo, 'src/upstream.ts', '// upstream names FEAT-004 by chance\n');
		write(repo, 'src/patched.ts', 'export const a = 1;\n');
		const pin = fixtureCommit(repo, 'pin', '2026-01-01T00:00:00Z');
		write(repo, 'src/patched.ts', 'export const a = 1;\n// the graft (intervention `CK-build-002`) imports the unit\n');
		write(
			repo,
			'src/own/chat.ts',
			[
				'/**',
				' * The chats of the product (spec://nimbus/FEAT-007-product-chat#CP-PROVIDERS).',
				' * The container of the one provider (FEAT-007 CP-PROVIDERS).',
				' */',
				"export const log = 'refused (CK-workbench-008)';",
				'// the build graft CK-build-006 writes it',
				''
			].join('\n')
		);
		write(repo, 'src/own/nimbus.i18n.json', '{ "description": "own modules (nimbus FEAT-007 CP-BUTTON)" }\n');
		write(repo, 'src/own/NOTES.md', 'Every rule of FEAT-007 lives here.\n');
		writeFileSync(join(repo, 'src', 'own', 'logo.bin'), Buffer.from([0x00, ...Buffer.from(' CP-D2 '), 0x00]));
		const tip = fixtureCommit(repo, 'tip', '2026-01-02T00:00:00Z');

		const { tree, report } = scrubReleaseTree({
			treeDir: repo,
			scratchDir: join(makeTempRoot('publish-references-scratch'), 'release'),
			pinSha: pin,
			tip,
			conventions: conventions(),
			exclude: ['src/own/NOTES.md'],
			references: sources()
		});

		expect(report.files).toEqual([
			{
				path: 'src/own/chat.ts',
				markers: 0,
				specRefs: 1,
				droppedLines: 0,
				groups: { parenthetical: 1, lead: 0, sentence: 0, preposition: 0 }
			},
			{
				path: 'src/patched.ts',
				markers: 0,
				specRefs: 0,
				droppedLines: 0,
				groups: { parenthetical: 1, lead: 0, sentence: 0, preposition: 0 }
			}
		]);
		expect(gitOut(repo, ['show', `${tree}:src/own/chat.ts`])).toBe(
			[
				'/**',
				' * The chats of the product.',
				' * The container of the one provider.',
				' */',
				"export const log = 'refused (CK-workbench-008)';",
				'// the build graft CK-build-006 writes it',
				''
			].join('\n')
		);
		expect(gitOut(repo, ['show', `${tree}:src/patched.ts`])).toBe('export const a = 1;\n// the graft imports the unit\n');
		// Code, a comment the rules do not cover, data and a binary file stop the
		// publish; upstream's own bytes and an excluded file are not searched.
		expect(report.leftovers.map((leftover) => [leftover.path, leftover.line, leftover.tokens])).toEqual([
			['src/own/chat.ts', 5, ['CK-workbench-008']],
			['src/own/chat.ts', 6, ['CK-build-006']],
			['src/own/logo.bin', null, ['CP-D2']],
			['src/own/nimbus.i18n.json', 1, ['FEAT-007', 'CP-BUTTON']]
		]);
		expect(report.vocabulary).toMatchObject({ interventions: 4, documents: 6 });

		// An allowed token is still scrubbed wherever a group goes; only the search lets it through.
		const allowed = scrubReleaseTree({
			treeDir: repo,
			scratchDir: join(makeTempRoot('publish-references-allowed'), 'release'),
			pinSha: pin,
			tip,
			conventions: conventions(),
			exclude: ['src/own/NOTES.md'],
			references: sources({ allow: ['CK-build-006', 'CP-BUTTON', 'CP-PROVIDERS'] })
		});
		expect(allowed.tree).toBe(tree);
		expect(allowed.report.leftovers.map((leftover) => [leftover.path, leftover.line, leftover.tokens])).toEqual([
			['src/own/chat.ts', 5, ['CK-workbench-008']],
			['src/own/logo.bin', null, ['CP-D2']],
			['src/own/nimbus.i18n.json', 1, ['FEAT-007']]
		]);
		expect(allowed.report.vocabulary).toMatchObject({ allowed: 3 });
	});
});

function fail(message: string): never {
	throw new Error(message);
}

function write(root: string, relative: string, text: string): void {
	const path = join(root, ...relative.split('/'));
	mkdirSync(join(path, '..'), { recursive: true });
	writeFileSync(path, text, 'utf8');
}

function gitOut(repo: string, args: readonly string[]): string {
	const result = runGit({ args, cwd: repo });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}
