// unit: the rewrite-rule artifact and its match counter (PROP-005 sec. 7).
//
// The engine that turns a rule into a patch is not implemented yet, so what is
// under test is what the milestone does ship: the schema, the marker discipline
// (a rule wraps everything it inserts in a block of its own id), and the counter
// `verify` will compare against expectedMatches.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { countRuleMatches, loadRules, parseRule } from '../../src/lib/layers/rule.ts';
import type { Rule } from '../../src/lib/layers/rule.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { EXAMPLE_PART_PATH, EXAMPLE_TOOLBAR_ANCHOR, makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { RULE_ID, makePatchSet } from '../fixtures/makePatchSet.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const ARTIFACT = 'delta/rules/example.ckrule.json';
const ID = 'CK-shell-903';

const VALID = {
	codkitRule: 2,
	id: ID,
	type: 'hook',
	category: 'follow',
	owner: 'shell-core',
	reason: 'fixture rewrite rule: the rule layer with an expected match count',
	link: 'none',
	cause: 'none',
	pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
	contractTests: ['patchset.guard.rule'],
	target: 'source/app/browser/parts/example/examplePart.ts',
	engine: 'line-ops',
	expectedMatches: 1,
	ops: [
		{
			match: '\tprotected createExampleToolbar(parent: FixtureElement): void {',
			action: 'append-after',
			text: `\t\t// codkit:begin ${ID}`
		},
		{ match: `\t\t// codkit:begin ${ID}`, action: 'append-after', text: `\t\t// codkit:end ${ID}` }
	]
};

function withOps(ops: unknown): unknown {
	return { ...VALID, ops };
}

function failureOf(run: () => unknown): { code: string; message: string; file?: string } {
	try {
		run();
	} catch (error) {
		if (isCkError(error)) {
			return { code: error.code, message: error.message, ...(error.file === undefined ? {} : { file: error.file }) };
		}
		throw error;
	}
	throw new Error('expected the call to fail');
}

let upstream: UpstreamFixture;
let patchesDir: string;

beforeAll(() => {
	upstream = makeUpstream(makeTempRoot('rule-upstream'));
	patchesDir = makeTempRoot('rule-patchset');
	makePatchSet(patchesDir, upstream);
});

afterAll(() => {
	cleanupTempRoots();
});

describe('rule schema', () => {
	it('accepts a rule that carries the metadata dictionary and a closed block', () => {
		const rule = parseRule(VALID, ARTIFACT);

		expect(rule.id).toBe(ID);
		expect(rule.engine).toBe('line-ops');
		expect(rule.expectedMatches).toBe(1);
		expect(rule.ops.length).toBe(2);
		expect(rule.artifactPath).toBe(ARTIFACT);
	});

	it('reads the rule of the patchset fixture from disk', () => {
		const rules = loadRules(patchesDir);

		expect(rules.length).toBe(1);
		expect(rules[0]?.id).toBe(RULE_ID);
		expect(rules[0]?.target).toBe(EXAMPLE_PART_PATH);
		expect(rules[0]?.artifactPath).toBe(ARTIFACT);
	});

	it('has no rules at all when the repository carries no rules directory', () => {
		expect(loadRules(makeTempRoot('rule-empty'))).toEqual([]);
	});

	it('refuses an append-after without the line to insert', () => {
		const failure = failureOf(() =>
			parseRule(
				withOps([
					{ match: 'anything', action: 'append-after' },
					{ match: 'anything', action: 'append-after', text: `// codkit:end ${ID}` }
				]),
				ARTIFACT
			)
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain('ops[0].text is required for action "append-after"');
		expect(failure.file).toBe(ARTIFACT);
	});

	it('refuses a text on comment-out, which inserts nothing', () => {
		const failure = failureOf(() => parseRule(withOps([{ match: 'anything', action: 'comment-out', text: 'x' }]), ARTIFACT));

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain('ops[0].text has no meaning for action "comment-out"');
	});

	it('refuses an engine it does not have', () => {
		expect(failureOf(() => parseRule({ ...VALID, engine: 'ast-ops' }, ARTIFACT)).message).toContain('engine must be "line-ops"');
	});

	it('refuses a negative expectedMatches', () => {
		expect(failureOf(() => parseRule({ ...VALID, expectedMatches: -1 }, ARTIFACT)).message).toContain('expectedMatches');
	});

	it('refuses a document of another schema version', () => {
		expect(failureOf(() => parseRule({ ...VALID, codkitRule: 3 }, ARTIFACT)).message).toContain('codkitRule must be exactly 2');
	});

	it('refuses inserted lines that do not open the marker block of the rule', () => {
		const failure = failureOf(() =>
			parseRule(
				withOps([
					{ match: 'anchor', action: 'append-after', text: '\t\t// a bare comment' },
					{ match: '\t\t// a bare comment', action: 'append-after', text: `\t\t// codkit:end ${ID}` }
				]),
				ARTIFACT
			)
		);

		expect(failure.code).toBe('ARTIFACT-BROKEN');
		expect(failure.message).toContain('does not open the marker block');
		expect(failure.message).toContain(`codkit:begin ${ID}`);
	});

	it('refuses inserted lines that do not close the marker block of the rule', () => {
		const failure = failureOf(() =>
			parseRule(
				withOps([
					{ match: 'anchor', action: 'append-after', text: `\t\t// codkit:begin ${ID}` },
					{ match: `\t\t// codkit:begin ${ID}`, action: 'append-after', text: '\t\t// and nothing closes it' }
				]),
				ARTIFACT
			)
		);

		expect(failure.message).toContain('does not close the marker block');
		expect(failure.message).toContain(`codkit:end ${ID}`);
	});

	it('refuses a rule that only comments out, because it opens no block at all', () => {
		const failure = failureOf(() => parseRule(withOps([{ match: 'anchor', action: 'comment-out' }]), ARTIFACT));

		expect(failure.message).toContain('inserts no lines');
	});
});

describe('countRuleMatches', () => {
	/** The target of the fixture rule, as of the pin, from git objects. */
	function pinBytes(): Uint8Array {
		const shown = runGit({ args: ['show', `${upstream.t1.sha}:${EXAMPLE_PART_PATH}`], cwd: upstream.dir });
		expect(shown.status).toBe(0);
		return encodeUtf8(shown.stdout);
	}

	function rule(document: unknown): Rule {
		return parseRule(document, ARTIFACT);
	}

	it('counts the one line the fixture rule anchors on, and nothing else', () => {
		const fixtureRule = loadRules(patchesDir)[0];
		expect(fixtureRule).toBeDefined();

		const counted = countRuleMatches(fixtureRule as Rule, pinBytes());

		// The anchor is there once; the lines the rule inserts are not in the pin,
		// which is the whole point - they are what the rule adds.
		expect(counted.perOp).toEqual([1, 0, 0]);
		expect(counted.total).toBe(1);
		expect(counted.total).toBe((fixtureRule as Rule).expectedMatches);
	});

	it('counts zero when the anchor line is not in the file at all', () => {
		const counted = countRuleMatches(
			rule(
				withOps([
					{ match: '\tprotected createNothingAtAll(): void {', action: 'append-after', text: `\t\t// codkit:begin ${ID}` },
					{ match: `\t\t// codkit:begin ${ID}`, action: 'append-after', text: `\t\t// codkit:end ${ID}` }
				])
			),
			pinBytes()
		);

		expect(counted.perOp).toEqual([0, 0]);
		expect(counted.total).toBe(0);
	});

	it('counts every occurrence: a line that is there twice matches twice', () => {
		const line = '\t\tconst duplicated = 1;';
		const content = encodeUtf8(['function a(): void {', line, '}', 'function b(): void {', line, '}', ''].join('\n'));

		const counted = countRuleMatches(
			rule(
				withOps([
					{ match: line, action: 'append-after', text: `\t\t// codkit:begin ${ID}` },
					{ match: `\t\t// codkit:begin ${ID}`, action: 'append-after', text: `\t\t// codkit:end ${ID}` }
				])
			),
			content
		);

		expect(counted.perOp).toEqual([2, 0]);
		expect(counted.total).toBe(2);
	});

	it('matches the whole line and nothing less', () => {
		const trimmed = EXAMPLE_TOOLBAR_ANCHOR.trimStart();
		const counted = countRuleMatches(
			rule(
				withOps([
					{ match: trimmed, action: 'append-after', text: `\t\t// codkit:begin ${ID}` },
					{ match: `\t\t// codkit:begin ${ID}`, action: 'append-after', text: `\t\t// codkit:end ${ID}` }
				])
			),
			pinBytes()
		);

		// The same text without its indentation is a different line: an exact
		// byte match is what lets the counter see upstream reformatting.
		expect(counted.total).toBe(0);
	});

	it('does not invent a line after the final line feed', () => {
		const counted = countRuleMatches(
			rule(
				withOps([
					{ match: 'only', action: 'append-after', text: `// codkit:begin ${ID}` },
					{ match: `// codkit:begin ${ID}`, action: 'append-after', text: `// codkit:end ${ID}` }
				])
			),
			encodeUtf8('only\n')
		);

		expect(counted.perOp).toEqual([1, 0]);
	});
});
