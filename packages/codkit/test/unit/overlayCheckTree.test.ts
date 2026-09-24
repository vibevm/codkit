// unit: what `overlay check` calls a materialized target (PROP-007
// ##CMD-OVERLAY-CHECK-TREE).
//
// The target is materialized when its content differs from the pin's blob, and
// the content is what git stores for the file - not its raw bytes. A Windows
// checkout of a `text=auto` file writes CRLF over the pin's LF blob, and git
// calls that file unchanged; so must the check, or it compares the pin's file
// with the operations and reports a drift nobody made. A real edit, on the
// other hand, is still a materialization that has to match.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { applyOverlayToTree, checkOverlayTarget, parseOverlay } from '../../src/lib/layers/overlay.ts';
import type { Overlay, OverlayVarContext } from '../../src/lib/layers/overlay.ts';
import { makeUpstream } from '../fixtures/makeUpstream.ts';
import type { UpstreamFixture } from '../fixtures/makeUpstream.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const TARGET = 'manifest.json';

const CONTEXT: OverlayVarContext = {
	pinTag: 't1',
	pinSha: '0000000000000000000000000000000000000000',
	pinDate: '2026-01-01',
	patchSetCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	buildDate: '2026-01-01'
};

const SAMPLE: Overlay = parseOverlay(
	{
		codkitOverlay: 2,
		id: 'CK-product-901',
		target: TARGET,
		type: 'modify',
		category: 'own',
		owner: 'product',
		reason: 'fixture product identity',
		link: 'none',
		cause: 'none',
		pin: 'ignored@0000000000000000000000000000000000000000',
		contractTests: ['fixture.guard.product'],
		operations: [{ op: 'set', path: ['displayName'], value: 'Fixture PatchSet', expectUpstream: 'Fixture Upstream' }]
	},
	'delta/overlays/manifest.json.overlay.json'
);

afterAll(() => {
	cleanupTempRoots();
});

/**
 * A pseudo-upstream whose files are `text=auto`, as upstream VS Code declares
 * them, with the target checked out the way git on Windows writes it: CRLF over
 * the pin's LF blob. `core.eol=crlf` on the command line is what `native` means
 * there, and it makes the checkout the same on every OS.
 */
function convertedTree(label: string): UpstreamFixture {
	const fixture = makeUpstream(makeTempRoot(label));
	writeFileSync(join(fixture.dir, '.git', 'info', 'attributes'), '* text=auto\n', 'utf8');
	rmSync(join(fixture.dir, TARGET));
	const checkout = runGit({ args: ['-c', 'core.eol=crlf', 'checkout', 'HEAD', '--', TARGET], cwd: fixture.dir });
	expect(checkout.status).toBe(0);
	return fixture;
}

function targetText(fixture: UpstreamFixture): string {
	return readFileSync(join(fixture.dir, TARGET), 'utf8');
}

function check(fixture: UpstreamFixture): ReturnType<typeof checkOverlayTarget> {
	return checkOverlayTarget([SAMPLE], { type: stubProjectType, treeDir: fixture.dir, pinSha: fixture.t1.sha, context: CONTEXT });
}

describe('checkOverlayTarget: the pin file as a checkout converted it', () => {
	it('is the pin, not a materialization, when git itself calls it unchanged', () => {
		const fixture = convertedTree('overlay-tree-crlf');
		// The precondition: raw bytes other than the blob's, and no change for git.
		expect(targetText(fixture)).toContain('\r\n');
		expect(runGit({ args: ['status', '--porcelain', '--', TARGET], cwd: fixture.dir }).stdout).toBe('');

		const report = check(fixture);

		expect(report.materialization).toEqual({ present: true, differsFromPin: false, matches: null });
		expect(report.drift).toEqual([]);
	});

	it('is still a materialization that must match once somebody edits it', () => {
		const fixture = convertedTree('overlay-tree-crlf-edited');
		writeFileSync(
			join(fixture.dir, TARGET),
			targetText(fixture).replace('"applicationName": "fixture-app"', '"applicationName": "by-hand"'),
			'utf8'
		);

		const report = check(fixture);

		expect(report.materialization).toEqual({ present: true, differsFromPin: true, matches: false });
	});

	it('agrees with the materialization written over it', () => {
		const fixture = convertedTree('overlay-tree-crlf-applied');
		applyOverlayToTree(SAMPLE, fixture.dir, fixture.t1.sha, CONTEXT);

		const report = check(fixture);

		expect(report.materialization).toEqual({ present: true, differsFromPin: true, matches: true });
	});

	it('is no materialization either when the tree has no such file', () => {
		const fixture = convertedTree('overlay-tree-absent');
		rmSync(join(fixture.dir, TARGET));

		const report = check(fixture);

		expect(report.materialization).toEqual({ present: false, differsFromPin: false, matches: null });
	});
});
