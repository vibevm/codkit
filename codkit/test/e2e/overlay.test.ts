// e2e: `codkit overlay check|apply` through the real launcher, and channel 2 of
// the config-overlay layer inside `sync`.
//
// Contracts under test: PROP-007 sec. 12 (##CMD-OVERLAY), PROP-005 sec. 5
// (##OVERLAY-TWO-CHANNELS, ##OVERLAY-DRIFT-DETECTOR, ##OVERLAY-KNOWN-MATERIALIZATION),
// PROP-008 sec. 3 (the order of the generated commits: patches, then overlay
// targets, then the resource map) and sec. 4 (the drift guard).
//
// One outcome here looks like a failure and is not: a target materialized into
// the work tree is, for an ordinary `sync`, an upstream file that changed without
// being extracted, so that sync refuses to run. `sync --fresh` is the way back:
// it classifies the bytes first and replaces the target only when they are
// exactly the strict composition of the configured overlays (##OVERLAY-KNOWN-
// MATERIALIZATION); any manual byte still stops the run.

import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGit } from '../../src/lib/gitx.ts';
import { OVERLAY_ID } from '../fixtures/makePatchSet.ts';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { makeSyncFixture } from '../support/syncFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

const OVERLAY_ARTIFACT = 'delta/overlays/product.json.overlay.json';

afterAll(() => {
	cleanupTempRoots();
});

describe('codkit overlay check', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('overlay-check');
	});

	it('agrees with the pin the fixture overlay was written against', () => {
		const { run, envelope } = fixture.json(['overlay', 'check', 'product.json']);

		expect(run.status).toBe(0);
		expect(envelope.errors).toEqual([]);
		expect(envelope.data['target']).toBe('product.json');
		expect(envelope.data['overlays']).toEqual([OVERLAY_ID]);
		expect(envelope.data['drift']).toEqual([]);
		// Nothing was materialized: the tree still carries the pin's product.json.
		expect(envelope.data['materialized']).toBe(false);
	});

	it('takes the overlay file as its argument too', () => {
		expect(fixture.run(['overlay', 'check', OVERLAY_ARTIFACT]).status).toBe(0);
		expect(fixture.run(['overlay', 'check', 'product.json.overlay.json']).status).toBe(0);
	});

	it('allows only additions to scripts on a target that has no dev channel', () => {
		// ##OVERLAY-NON-PRODUCT-TARGETS: the tree's package.json is rewritten for
		// real when it is materialized, so the layer may add npm scripts there and
		// nothing else.
		const artifact = fixture.patchesPath('delta/overlays/package.json.overlay.json');
		try {
			writeFileSync(artifact, packageOverlay(['name'], 'patchset'), 'utf8');
			const outcome = fixture.json(['overlay', 'check', 'package.json']);
			expect(outcome.run.status).toBe(1);
			expect(outcome.envelope.errors[0]?.code).toBe('CK-E-OVERLAY-SCHEMA');
			expect(outcome.envelope.errors[0]?.message).toContain('only additions to scripts are allowed');

			writeFileSync(artifact, packageOverlay(['scripts', 'patchset-check'], 'node ./out/check.js'), 'utf8');
			expect(fixture.run(['overlay', 'check', 'package.json']).status).toBe(0);
		} finally {
			rmSync(artifact, { force: true });
		}
	});

	it('is a usage failure when nothing in the delta targets the argument', () => {
		const { run, envelope } = fixture.json(['overlay', 'check', 'settings.json']);

		expect(run.status).toBe(2);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-CONFIG']);
		expect(envelope.errors[0]?.hint).toContain('product.json');
	});

	it('is read-only: it leaves the tree exactly where it was', () => {
		const before = readFileSync(fixture.treePath('product.json'), 'utf8');
		expect(fixture.run(['overlay', 'check', 'product.json']).status).toBe(0);
		expect(readFileSync(fixture.treePath('product.json'), 'utf8')).toBe(before);
	});

	it('is a failed check, not a crash, when the target does not exist at the pin', () => {
		const artifact = 'delta/overlays/nowhere.json.overlay.json';
		const document = JSON.parse(readFileSync(fixture.patchesPath(OVERLAY_ARTIFACT), 'utf8')) as Record<string, unknown>;
		writeFileSync(
			fixture.patchesPath(artifact),
			`${JSON.stringify({ ...document, id: 'CK-product-904', target: 'nowhere.json', operations: [{ op: 'set', path: ['a'], value: 1 }] }, null, 2)}\n`,
			'utf8'
		);
		try {
			const { run, envelope } = fixture.json(['overlay', 'check', 'nowhere.json']);

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-ARTIFACT-BROKEN']);
			expect(envelope.errors[0]?.message).toContain('does not exist at the pin');
		} finally {
			rmSync(fixture.patchesPath(artifact), { force: true });
		}
	});
});

describe('codkit overlay check: upstream drift', () => {
	let fixture: CliFixture;
	let original: string;

	beforeAll(() => {
		fixture = makeCliFixture('overlay-drift');
		original = readFileSync(fixture.patchesPath(OVERLAY_ARTIFACT), 'utf8');
		// The pin did not move; the artifact now claims something else about it,
		// which is the same thing from the checker's point of view.
		const document = JSON.parse(original) as { operations: { expectUpstream?: unknown }[] };
		const first = document.operations[0];
		if (first !== undefined) {
			first.expectUpstream = 'Something Upstream Never Said';
		}
		writeFileSync(fixture.patchesPath(OVERLAY_ARTIFACT), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
	});

	afterAll(() => {
		writeFileSync(fixture.patchesPath(OVERLAY_ARTIFACT), original, 'utf8');
	});

	it('fails the check with CK-E-OVERLAY-DRIFT and names the key', () => {
		const { run, envelope } = fixture.json(['overlay', 'check', 'product.json']);

		expect(run.status).toBe(1);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-OVERLAY-DRIFT']);
		expect(envelope.errors[0]?.message).toContain('product.json:nameShort');
		expect(envelope.errors[0]?.message).toContain('Fixture - OSS');
		expect(envelope.errors[0]?.file).toBe(OVERLAY_ARTIFACT);
		expect(envelope.errors[0]?.hint).toContain('expectUpstream');
	});

	it('fails the check with the same code before apply materializes anything', () => {
		expect(fixture.run(['overlay', 'apply', 'product.json']).status).toBe(1);
		// Nothing was written: the artifact does not describe this pin.
		expect(JSON.parse(readFileSync(fixture.treePath('product.json'), 'utf8'))['nameShort']).toBe('Fixture - OSS');
	});

	it('stops sync too, because every sync checks the expectation', () => {
		const { run, envelope } = fixture.json(['sync']);

		expect(run.status).toBe(1);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-OVERLAY-DRIFT']);
		expect(envelope.data['brokenArtifacts']).toEqual([OVERLAY_ARTIFACT]);
		// The branch was not built: the delta is not applicable as it stands.
		expect(fixture.git(['rev-parse', '--verify', `refs/heads/${fixture.branch}`]).status).not.toBe(0);
	});

	it('passes again once the artifact is restored', () => {
		writeFileSync(fixture.patchesPath(OVERLAY_ARTIFACT), original, 'utf8');

		expect(fixture.run(['overlay', 'check', 'product.json']).status).toBe(0);
		expect(fixture.run(['sync']).status).toBe(0);
	});
});

describe('codkit overlay apply', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('overlay-apply');
		expect(fixture.run(['sync']).status).toBe(0);
	});

	it('rewrites the target from the pin, with tabs and a final line feed', () => {
		const { run, envelope } = fixture.json(['overlay', 'apply', 'product.json']);
		const text = readFileSync(fixture.treePath('product.json'), 'utf8');

		expect(run.status).toBe(0);
		expect(envelope.data['changed']).toBe(true);
		expect(text.startsWith('{\n\t"nameShort": "Fixture PatchSet",\n')).toBe(true);
		expect(text.endsWith('}\n')).toBe(true);
		const document = JSON.parse(text) as Record<string, unknown>;
		expect(document['patchsetUpstreamPin']).toBe('t1');
		// The base was the clean pin, so nothing upstream ships is lost.
		expect(document['applicationName']).toBe('fixture-code');
	});

	it('is idempotent: the second run writes the same bytes', () => {
		const before = readFileSync(fixture.treePath('product.json'));

		const { run, envelope } = fixture.json(['overlay', 'apply', 'product.json']);

		expect(run.status).toBe(0);
		expect(envelope.data['changed']).toBe(false);
		expect(readFileSync(fixture.treePath('product.json')).equals(before)).toBe(true);
	});

	it('lets check see the materialized target and agree with it', () => {
		const { run, envelope } = fixture.json(['overlay', 'check', 'product.json']);

		expect(run.status).toBe(0);
		expect(envelope.data['materialized']).toBe(true);
		expect(envelope.data['matchesOperations']).toBe(true);
	});

	it('makes check fail when the materialized file is edited by hand', () => {
		const path = fixture.treePath('product.json');
		const applied = readFileSync(path, 'utf8');
		writeFileSync(path, applied.replace('"applicationName": "fixture-code"', '"applicationName": "by-hand"'), 'utf8');
		try {
			const { run, envelope } = fixture.json(['overlay', 'check', 'product.json']);

			expect(run.status).toBe(1);
			expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-OVERLAY-DRIFT']);
			expect(envelope.errors[0]?.message).toContain('is not the pin plus the operations');
			expect(envelope.errors[0]?.hint).toContain('overlay apply');
		} finally {
			writeFileSync(path, applied, 'utf8');
		}
	});

	it('is dirt for an ordinary sync, which refuses it and preserves the bytes', () => {
		// The model for a local `sync`: a materialized upstream file is a changed
		// upstream file, and an ordinary sync never overwrites a change it has not
		// seen in patchset - and must not silently exempt it either, because the
		// fast path could then answer "up to date" and leave the packaging bytes
		// standing as if they were dev state.
		const before = readFileSync(fixture.treePath('product.json'), 'utf8');
		const { run, envelope } = fixture.json(['sync']);

		expect(run.status).toBe(1);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(envelope.data['dirtyFiles']).toContain('product.json');
		expect(readFileSync(fixture.treePath('product.json'), 'utf8')).toBe(before);
	});

	it('is returned to dev mode by sync --fresh, with no direct git restore', () => {
		const { run, envelope } = fixture.json(['sync', '--fresh']);

		expect(run.status).toBe(0);
		expect(envelope.data['status']).toBe('applied');
		const document = JSON.parse(readFileSync(fixture.treePath('product.json'), 'utf8')) as Record<string, unknown>;
		// The raw tracked target carries the dev/generated state again...
		expect(document['nameShort']).toBe('Fixture - OSS');
		expect(document['patchsetUpstreamPin']).toBeUndefined();
		// ...and the dev channel is back.
		const overrides = JSON.parse(readFileSync(fixture.treePath('product.overrides.json'), 'utf8')) as Record<string, unknown>;
		expect(overrides['nameShort']).toBe('Fixture PatchSet');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
	});
});

describe('sync --fresh over an exact packaging materialization', () => {
	let fixture: CliFixture;

	beforeAll(() => {
		fixture = makeCliFixture('overlay-fresh');
		expect(fixture.run(['sync']).status).toBe(0);
		expect(fixture.run(['overlay', 'apply', 'product.json']).status).toBe(0);
	});

	it('succeeds, announces the replacement, and restores the dev state', () => {
		const { run, envelope } = fixture.json(['sync', '--fresh']);

		expect(run.status).toBe(0);
		expect(
			envelope.messages.some(
				(message) => message.text.includes('product.json') && message.text.includes('carries the exact overlay materialization')
			)
		).toBe(true);
		const document = JSON.parse(readFileSync(fixture.treePath('product.json'), 'utf8')) as Record<string, unknown>;
		expect(document['nameShort']).toBe('Fixture - OSS');
		expect(document['patchsetUpstreamPin']).toBeUndefined();
		expect(JSON.parse(readFileSync(fixture.treePath('product.overrides.json'), 'utf8'))['nameShort']).toBe('Fixture PatchSet');
		expect(fixture.git(['status', '--porcelain']).stdout).toBe('');
	});

	it('still refuses a hand edit of the materialized target, and preserves it', () => {
		// One byte of manual work on top of the composition is unextracted work
		// again: --fresh replaces a known state, it is not a blanket reset.
		expect(fixture.run(['overlay', 'apply', 'product.json']).status).toBe(0);
		const path = fixture.treePath('product.json');
		const mutated = readFileSync(path, 'utf8').replace('"applicationName": "fixture-code"', '"applicationName": "by-hand"');
		writeFileSync(path, mutated, 'utf8');

		const { run, envelope } = fixture.json(['sync', '--fresh']);

		expect(run.status).toBe(1);
		expect(envelope.errors.map((error) => error.code)).toEqual(['CK-E-DIRTY-TREE']);
		expect(envelope.data['dirtyFiles']).toContain('product.json');
		expect(readFileSync(path, 'utf8')).toBe(mutated);
	});
});

describe('sync --fresh over a target several overlays compose', () => {
	let fixture: CliFixture;
	const SECOND_ARTIFACT = 'delta/overlays/product.json.brand.overlay.json';

	beforeAll(() => {
		fixture = makeCliFixture('overlay-fresh-compose');
		writeFileSync(fixture.patchesPath(SECOND_ARTIFACT), brandOverlay(), 'utf8');
		expect(fixture.run(['sync']).status).toBe(0);
		expect(fixture.run(['overlay', 'apply', 'product.json']).status).toBe(0);
	});

	afterAll(() => {
		rmSync(fixture.patchesPath(SECOND_ARTIFACT), { force: true });
	});

	it('recognizes the composed bytes and returns the tree to dev mode', () => {
		const composed = JSON.parse(readFileSync(fixture.treePath('product.json'), 'utf8')) as Record<string, Record<string, unknown>>;
		expect(composed['nameShort']).toBe('Fixture PatchSet');
		expect(composed['extensionsGallery']?.['serviceUrl']).toBe('https://gallery.patchset.invalid');

		const { run } = fixture.json(['sync', '--fresh']);

		expect(run.status).toBe(0);
		const restored = JSON.parse(readFileSync(fixture.treePath('product.json'), 'utf8')) as Record<string, Record<string, unknown>>;
		expect(restored['nameShort']).toBe('Fixture - OSS');
		expect(restored['extensionsGallery']?.['serviceUrl']).toBe('https://gallery.fixture.invalid/api');
		// The dev channel composes both overlays too.
		const overrides = JSON.parse(readFileSync(fixture.treePath('product.overrides.json'), 'utf8')) as Record<
			string,
			Record<string, unknown>
		>;
		expect(overrides['nameShort']).toBe('Fixture PatchSet');
		expect(overrides['extensionsGallery']?.['serviceUrl']).toBe('https://gallery.patchset.invalid');
	});
});

describe('sync with materializeOverlays: channel 2 on the generated branch', () => {
	it('commits the overlay target between the patches and the resource map', () => {
		const fixture = makeSyncFixture('overlay-materialize');

		const result = fixture.sync({ materializeOverlays: true });

		expect(result.exitCode).toBe(0);
		expect(result.status).toBe('applied');
		// One patch, one overlay target, one resource entry.
		expect(result.artifacts).toBe(3);

		const log = fixture.messages.join('\n');
		expect(log).toContain('applied 3 artifact(s)');

		const subjects = gitOut(fixture.treeDir, ['log', '--format=%s', `${fixture.upstream.t1.sha}..HEAD`]).split('\n');
		// git log is newest first: resource map, overlay target, patch.
		expect(subjects[1]).toBe(`codkit: ${OVERLAY_ID} product.json`);
		expect(subjects[1]?.includes('product.json')).toBe(true);
		expect(gitOut(fixture.treeDir, ['log', '-1', '--format=%B', 'HEAD~1'])).toContain(`Codkit-Artifact: ${OVERLAY_ID}`);
	});

	it('puts the tab-serialized target on HEAD and leaves the tree clean', () => {
		const fixture = makeSyncFixture('overlay-materialize-tree');

		expect(fixture.sync({ materializeOverlays: true }).exitCode).toBe(0);

		const onHead = gitOut(fixture.treeDir, ['show', 'HEAD:product.json']);
		const document = JSON.parse(onHead) as Record<string, unknown>;
		expect(document['nameShort']).toBe('Fixture PatchSet');
		expect(document['patchsetUpstreamPin']).toBe('t1');
		expect(onHead.startsWith('{\n\t"nameShort"')).toBe(true);
		// The work tree carries the same bytes and git sees nothing dirty.
		expect(readFileSync(`${fixture.treeDir}/product.json`, 'utf8')).toBe(`${onHead}\n`);
		expect(gitOut(fixture.treeDir, ['status', '--porcelain'])).toBe('');
		// Channel 1 stays out of the way when channel 2 is in use.
		expect(gitOut(fixture.treeDir, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
	});

	it('leaves the target at the pin when the option is off, as a local sync does', () => {
		const fixture = makeSyncFixture('overlay-materialize-off');

		expect(fixture.sync().exitCode).toBe(0);

		expect(JSON.parse(gitOut(fixture.treeDir, ['show', 'HEAD:product.json']))['nameShort']).toBe('Fixture - OSS');
		expect(JSON.parse(readFileSync(`${fixture.treeDir}/product.overrides.json`, 'utf8'))['nameShort']).toBe('Fixture PatchSet');
	});
});

/** An overlay on the tree's package.json with one operation at `path`. */
function packageOverlay(path: readonly string[], value: string): string {
	return `${JSON.stringify(
		{
			codkitOverlay: 2,
			id: 'CK-product-903',
			target: 'package.json',
			type: 'modify',
			category: 'own',
			owner: 'product',
			reason: 'fixture: the non-product overlay target and its scripts-only rule',
			link: 'none',
			cause: 'none',
			pin: 't1@0000000000000000000000000000000000000000',
			contractTests: ['fixture.guard.product'],
			operations: [{ op: 'set', path: [...path], value }]
		},
		null,
		2
	)}\n`;
}

/**
 * A second overlay on product.json, so one target is composed from two files:
 * the state `overlay apply` writes, and the drift guard of `sync --fresh`
 * classifies, is the composition of every overlay that names the target.
 */
function brandOverlay(): string {
	return `${JSON.stringify(
		{
			codkitOverlay: 2,
			id: 'CK-product-905',
			target: 'product.json',
			type: 'modify',
			category: 'own',
			owner: 'product',
			reason: 'fixture: the second overlay of one target, composed with the first',
			link: 'none',
			cause: 'none',
			pin: 't1@0000000000000000000000000000000000000000',
			contractTests: ['fixture.guard.product'],
			operations: [{ op: 'set', path: ['extensionsGallery', 'serviceUrl'], value: 'https://gallery.patchset.invalid' }]
		},
		null,
		2
	)}\n`;
}

/** git in a tree, for the assertions above. */
function gitOut(treeDir: string, args: readonly string[]): string {
	const result = runGit({ args, cwd: treeDir });
	expect(result.status).toBe(0);
	return result.stdout.trimEnd();
}
