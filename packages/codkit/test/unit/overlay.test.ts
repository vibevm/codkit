// config-overlay: schema, variables, operations, dev channel (PROP-005 sec. 5).

import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyOperations, devChannelIgnoreWarning, parseOverlay, resolveVar, writeDevChannel } from '../../src/lib/layers/overlay.ts';
import type { Overlay, OverlayVarContext } from '../../src/lib/layers/overlay.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as vscodeType } from '@codkit/type-vscode';

const ARTIFACT = 'delta/overlays/product.json.overlay.json';

/** The valid sample of PROP-005 ##overlay-valid-sample, transcribed. */
const VALID = {
	codkitOverlay: 2,
	id: 'CK-product-001',
	target: 'product.json',
	type: 'modify',
	category: 'own',
	owner: 'product',
	reason: 'patchset branding: product name fields',
	link: 'none',
	cause: 'none',
	pin: '1.135.0@08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
	contractTests: ['patchset.guard.product-name'],
	operations: [
		{ op: 'set', path: ['nameShort'], value: 'PatchSet', expectUpstream: 'Code - OSS' },
		{ op: 'set', path: ['patchsetUpstreamPin'], value: { $var: 'pin.tag' }, expectUpstream: { $absent: true } }
	]
};

const CONTEXT: OverlayVarContext = {
	pinTag: '1.135.0',
	pinSha: '08d4889f9ec4a1685d257b9b95de036c8e1ce1e5',
	pinDate: '2026-08-25',
	patchSetCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	buildDate: '2026-08-25'
};

function withOperations(operations: unknown): unknown {
	return { ...VALID, operations };
}

function codeOf(run: () => unknown): { code: string; message: string; file?: string } {
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

afterAll(() => {
	cleanupTempRoots();
});

describe('overlay schema', () => {
	it('accepts the sample of the spec', () => {
		const overlay = parseOverlay(VALID, ARTIFACT);
		expect(overlay.id).toBe('CK-product-001');
		expect(overlay.operations.length).toBe(2);
		expect(overlay.artifactPath).toBe(ARTIFACT);
	});

	it('refuses an unknown operation with the wording of the spec', () => {
		const failure = codeOf(() => parseOverlay(withOperations([{ op: 'insert', path: ['nameShort'], value: 'x' }]), ARTIFACT));
		expect(failure.code).toBe('OVERLAY-SCHEMA');
		expect(failure.message).toBe('operations[0].op must be "set" or "remove", got "insert"');
		expect(failure.file).toBe(ARTIFACT);
	});

	it('requires a guard test', () => {
		const failure = codeOf(() => parseOverlay({ ...VALID, contractTests: [] }, ARTIFACT));
		expect(failure.code).toBe('OVERLAY-SCHEMA');
		expect(failure.message).toContain('contractTests');
		expect(failure.message).toContain('guard test is mandatory');
	});

	it('refuses an array index in a path', () => {
		const failure = codeOf(() => parseOverlay(withOperations([{ op: 'set', path: ['a', 0], value: 'x' }]), ARTIFACT));
		expect(failure.code).toBe('OVERLAY-SCHEMA');
		expect(failure.message).toContain('operations[0].path');
	});

	it('refuses an empty path', () => {
		const failure = codeOf(() => parseOverlay(withOperations([{ op: 'remove', path: [] }]), ARTIFACT));
		expect(failure.message).toContain('operations[0].path');
	});

	it('refuses a set without a value', () => {
		const failure = codeOf(() => parseOverlay(withOperations([{ op: 'set', path: ['nameShort'] }]), ARTIFACT));
		expect(failure.message).toBe('operations[0].value is required for op "set", got nothing');
	});

	it('refuses an unknown variable name', () => {
		const failure = codeOf(() => parseOverlay(withOperations([{ op: 'set', path: ['a'], value: { $var: 'pin.branch' } }]), ARTIFACT));
		expect(failure.code).toBe('OVERLAY-SCHEMA');
		expect(failure.message).toContain('operations[0].value.$var');
		expect(failure.message).toContain('pin.tag');
	});

	it('refuses a document of another schema version', () => {
		expect(codeOf(() => parseOverlay({ ...VALID, codkitOverlay: 3 }, ARTIFACT)).message).toContain('codkitOverlay must be exactly 2');
	});

	it.each(['../product.json', '/tmp/product.json', 'dir\\product.json'])('refuses unsafe target %j', (target) => {
		const failure = codeOf(() => parseOverlay({ ...VALID, target }, ARTIFACT));

		expect(failure.code).toBe('OVERLAY-SCHEMA');
		expect(failure.message).toContain('target');
	});
});

describe('variables', () => {
	it('resolves every documented name', () => {
		expect(resolveVar('pin.tag', CONTEXT)).toBe('1.135.0');
		expect(resolveVar('pin.sha', CONTEXT)).toBe(CONTEXT.pinSha);
		expect(resolveVar('pin.date', CONTEXT)).toBe('2026-08-25');
		expect(resolveVar('patchset.commit', CONTEXT)).toBe(CONTEXT.patchSetCommit);
		expect(resolveVar('build.date', CONTEXT)).toBe('2026-08-25');
	});

	it('refuses a name it does not know', () => {
		expect(codeOf(() => resolveVar('pin.branch', CONTEXT)).code).toBe('OVERLAY-SCHEMA');
	});
});

describe('applyOperations', () => {
	it('sets, creating the objects along the path', () => {
		const overlay = parseOverlay(
			withOperations([
				{ op: 'set', path: ['nameShort'], value: 'PatchSet' },
				{ op: 'set', path: ['gallery', 'serviceUrl'], value: 'https://gallery.invalid' }
			]),
			ARTIFACT
		);
		expect(applyOperations({}, overlay.operations, CONTEXT)).toEqual({
			nameShort: 'PatchSet',
			gallery: { serviceUrl: 'https://gallery.invalid' }
		});
	});

	it('substitutes $var at materialization time', () => {
		const overlay = parseOverlay(withOperations([{ op: 'set', path: ['pin'], value: { $var: 'pin.sha' } }]), ARTIFACT);
		expect(applyOperations({}, overlay.operations, CONTEXT)).toEqual({ pin: CONTEXT.pinSha });
	});

	it('removes a key, and removing an absent key is not an error', () => {
		const overlay = parseOverlay(
			withOperations([
				{ op: 'remove', path: ['nameShort'] },
				{ op: 'remove', path: ['neverThere'] },
				{ op: 'remove', path: ['deep', 'gone'] }
			]),
			ARTIFACT
		);
		expect(applyOperations({ nameShort: 'x', keep: 1 }, overlay.operations, CONTEXT)).toEqual({ keep: 1 });
	});

	it('does not mutate the document it was given', () => {
		const overlay = parseOverlay(withOperations([{ op: 'set', path: ['nameShort'], value: 'PatchSet' }]), ARTIFACT);
		const base = { nameShort: 'Code - OSS' };
		applyOperations(base, overlay.operations, CONTEXT);
		expect(base.nameShort).toBe('Code - OSS');
	});
});

describe('the dev channel', () => {
	function devChannel(operations: unknown): { document: Record<string, unknown>; warnings: string[] } {
		const tree = makeTempRoot('overlay-dev');
		const overlay: Overlay = parseOverlay(withOperations(operations), ARTIFACT);
		const warnings: string[] = [];
		// No pin to seed nested keys from here: the temporary tree is not a git
		// repository, which is exactly the "cannot be answered" case the seeding
		// and the ignore check both step around. The e2e load test covers the
		// seeding against a real tree.
		const result = writeDevChannel(vscodeType, tree, [overlay], CONTEXT, '', (text) => {
			warnings.push(text);
		});
		return { document: JSON.parse(readFileSync(result.path, 'utf8')) as Record<string, unknown>, warnings };
	}

	it('flattens to top-level keys and substitutes variables', () => {
		const { document, warnings } = devChannel([
			{ op: 'set', path: ['nameShort'], value: 'PatchSet' },
			{ op: 'set', path: ['extensionsGallery'], value: { serviceUrl: 'https://gallery.invalid', itemUrl: 'https://item.invalid' } },
			{ op: 'set', path: ['patchsetUpstreamPin'], value: { $var: 'pin.tag' } }
		]);
		expect(document).toEqual({
			nameShort: 'PatchSet',
			extensionsGallery: { serviceUrl: 'https://gallery.invalid', itemUrl: 'https://item.invalid' },
			patchsetUpstreamPin: '1.135.0'
		});
		expect(warnings).toEqual([]);
	});

	it('warns that remove cannot be expressed and leaves the key out', () => {
		const { document, warnings } = devChannel([
			{ op: 'set', path: ['nameShort'], value: 'PatchSet' },
			{ op: 'remove', path: ['telemetry'] }
		]);
		expect(document).toEqual({ nameShort: 'PatchSet' });
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain('remove telemetry');
		expect(warnings[0]).toContain('dev channel');
	});

	it('writes a nested set without a warning: the top-level key is seeded from the pin', () => {
		// Without a tree to read the pin from, the seeding finds nothing and the
		// operation still applies; what matters here is that a nested path is a
		// normal thing to write in the dev channel, not a reported degradation.
		const { document, warnings } = devChannel([{ op: 'set', path: ['extensionsGallery', 'serviceUrl'], value: 'https://gallery.invalid' }]);
		expect(warnings).toEqual([]);
		expect(document).toEqual({ extensionsGallery: { serviceUrl: 'https://gallery.invalid' } });
	});

	it('writes two-space JSON with a final newline', () => {
		const tree = makeTempRoot('overlay-bytes');
		const overlay = parseOverlay(withOperations([{ op: 'set', path: ['nameShort'], value: 'PatchSet' }]), ARTIFACT);
		const result = writeDevChannel(vscodeType, tree, [overlay], CONTEXT, '');
		expect(readFileSync(result.path, 'utf8')).toBe('{\n  "nameShort": "PatchSet"\n}\n');
		expect(result.path).toBe(join(tree, 'product.overrides.json'));
		expect(result.overlayIds).toEqual(['CK-product-001']);
	});

	it('writes nothing when no overlay targets product.json', () => {
		const tree = makeTempRoot('overlay-other');
		const other = parseOverlay({ ...VALID, target: 'package.json' }, 'delta/overlays/package.json.overlay.json');

		const result = writeDevChannel(vscodeType, tree, [other], CONTEXT, '');

		expect(result.written).toBe(false);
		expect(result.overlayIds).toEqual([]);
		expect(existsSync(result.path)).toBe(false);
	});

	it('empties an existing file when the last product overlay is gone', () => {
		const tree = makeTempRoot('overlay-emptied');
		writeFileSync(join(tree, 'product.overrides.json'), '{\n  "nameShort": "PatchSet"\n}\n', 'utf8');

		const result = writeDevChannel(vscodeType, tree, [], CONTEXT, '');

		expect(result.written).toBe(true);
		expect(readFileSync(result.path, 'utf8')).toBe('{}\n');
	});

	it('refuses an existing product.overrides.json symlink without overwriting its target', () => {
		const tree = makeTempRoot('overlay-dev-symlink');
		const outside = makeTempRoot('overlay-dev-symlink-outside');
		const victim = join(outside, 'victim.json');
		writeFileSync(victim, '{"outside":true}\n', 'utf8');
		const path = join(tree, 'product.overrides.json');
		rmSync(path, { force: true });
		symlinkSync(victim, path);
		const overlay = parseOverlay(withOperations([{ op: 'set', path: ['nameShort'], value: 'PatchSet' }]), ARTIFACT);

		expect(() => writeDevChannel(vscodeType, tree, [overlay], CONTEXT, '')).toThrow(/symlink/i);
		expect(readFileSync(victim, 'utf8')).toBe('{"outside":true}\n');
	});
});

describe('devChannelIgnoreWarning', () => {
	/** A real repository: the question is one only git can answer. */
	function repo(label: string, gitignore: string | null): string {
		const tree = makeTempRoot(label);
		runGit({ args: ['init', '--quiet', '--initial-branch=main', '.'], cwd: tree });
		if (gitignore !== null) {
			writeFileSync(join(tree, '.gitignore'), gitignore, 'utf8');
		}
		return tree;
	}

	it('warns when the tree does not ignore the dev-channel file', () => {
		const warning = devChannelIgnoreWarning(vscodeType, repo('overlay-ignore-missing', null));
		expect(warning).not.toBeNull();
		expect(warning).toContain('product.overrides.json');
		expect(warning).toContain('.gitignore');
	});

	it('says nothing when the tree ignores it', () => {
		expect(devChannelIgnoreWarning(vscodeType, repo('overlay-ignore-present', 'product.overrides.json\n'))).toBeNull();
	});

	it('says nothing when git cannot answer at all', () => {
		// Not a repository: the load would have failed long before this point,
		// and a warning here would only be noise.
		expect(devChannelIgnoreWarning(vscodeType, makeTempRoot('overlay-ignore-norepo'))).toBeNull();
	});
});
