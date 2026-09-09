/** @scope spec://codkit/modules/codkit/PROP-008#renames */

import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
	applyPatchRenameBatch,
	buildPatchRenameBatch,
	RENAME_COMPLETIONS_DIR,
	RENAME_TRANSACTION_PATH,
	resumePatchRenameTransaction,
	type PatchRenameBatchPlan
} from '../../src/lib/renameApply.ts';
import { serializeCkpatch, type ParsedPatch } from '../../src/lib/patchFormat.ts';
import type { UpstreamRename } from '../../src/lib/renames.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const OLD = 'src/vs/old/remoteClient.ts';
const NEXT = 'src/vs/new/client.ts';
const OLD_ARTIFACT = 'delta/patches/src__vs__old__remoteClient.ts.ckpatch';
const NEXT_ARTIFACT = 'delta/patches/src__vs__new__client.ts.ckpatch';
const OWN = 'delta/own/client.ts';
const EXACT: UpstreamRename = { from: OLD, to: NEXT, similarity: 100, needsReview: false };

function patch(target = OLD): ParsedPatch {
	return {
		header: {
			schema: 2,
			id: 'CK-workbench-001',
			layer: 'patch',
			layerExplicit: false,
			type: 'hook',
			category: 'follow',
			owner: 'workbench-core',
			reason: 'rename fixture',
			link: 'none',
			cause: 'none',
			pin: `1.0.0@${'a'.repeat(40)}`,
			contractTests: [],
			lines: [
				'# codkit-patch: 2',
				'# id: CK-workbench-001',
				'# type: hook',
				'# category: follow',
				'# owner: workbench-core',
				'# reason: rename fixture',
				'# link: none',
				'# cause: none',
				`# pin: 1.0.0@${'a'.repeat(40)}`,
				'# contract-tests: none'
			]
		},
		targetPath: target,
		isAddFile: false,
		hunks: [
			{
				startOld: 1,
				countOld: 1,
				startNew: 1,
				countNew: 1,
				header: '@@ -1 +1 @@',
				headerLine: 13,
				lines: [
					{ kind: '-', text: 'old', bare: false },
					{ kind: '+', text: 'new', bare: false }
				]
			}
		]
	};
}

function write(root: string, path: string, bytes: string | Uint8Array): void {
	const absolute = join(root, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, bytes);
}

function fixture(label: string, withReference = true): { readonly root: string; readonly batch: PatchRenameBatchPlan } {
	const root = makeTempRoot(label);
	const parsed = patch();
	write(root, OLD_ARTIFACT, serializeCkpatch(parsed));
	if (withReference) write(root, OWN, "import { client } from '../../src/vs/old/remoteClient.js';\n");
	const batch = buildPatchRenameBatch({
		patchesDir: root,
		renames: [EXACT],
		artifacts: [{ artifactPath: OLD_ARTIFACT, patch: parsed }],
		ownPaths: withReference ? [OWN] : [],
		explicitReferenceReplacements: withReference
			? [
					{
						renameFrom: OLD,
						area: 'own-import',
						file: OWN,
						from: '../../src/vs/old/remoteClient.js',
						to: '../../src/vs/new/client.js'
					}
				]
			: []
	});
	return { root, batch };
}

describe('rename batch planning and apply', () => {
	afterAll(() => cleanupTempRoots());

	it('rewrites both exact patch headers, applies an explicit relative import, then moves the artifact', () => {
		const { root, batch } = fixture('rename-apply-happy');
		expect(batch.candidates).toEqual([expect.objectContaining({ file: OWN, matched: 'remoteClient', reason: 'module-stem' })]);
		expect(batch.needsReview).toBe(true);
		applyPatchRenameBatch({ patchesDir: root, batch, reviewed: true });

		expect(existsSync(join(root, OLD_ARTIFACT))).toBe(false);
		const moved = readFileSync(join(root, NEXT_ARTIFACT), 'utf8');
		expect(moved).toContain(`--- a/${NEXT}`);
		expect(moved).toContain(`+++ b/${NEXT}`);
		expect(readFileSync(join(root, OWN), 'utf8')).toContain('../../src/vs/new/client.js');
		expect(existsSync(join(root, RENAME_TRANSACTION_PATH))).toBe(false);
	});

	it('carries R<100 as review even when no reference candidate exists', () => {
		const root = makeTempRoot('rename-apply-review');
		const parsed = patch();
		write(root, OLD_ARTIFACT, serializeCkpatch(parsed));
		const rename: UpstreamRename = { from: OLD, to: NEXT, similarity: 87, needsReview: true };
		const batch = buildPatchRenameBatch({
			patchesDir: root,
			renames: [rename],
			artifacts: [{ artifactPath: OLD_ARTIFACT, patch: parsed }]
		});
		expect(batch.needsReview).toBe(true);
		expect(() => applyPatchRenameBatch({ patchesDir: root, batch })).toThrow(/explicit review/);
		expect(readFileSync(join(root, OLD_ARTIFACT))).toEqual(Buffer.from(serializeCkpatch(parsed)));
	});

	it('rejects duplicate sources and an existing destination during read-only planning', () => {
		const duplicateFixture = fixture('rename-apply-duplicate', false);
		expect(() =>
			buildPatchRenameBatch({
				patchesDir: duplicateFixture.root,
				renames: [EXACT, EXACT],
				artifacts: [{ artifactPath: OLD_ARTIFACT, patch: patch() }]
			})
		).toThrow(/duplicate detected rename source/);

		const collision = makeTempRoot('rename-apply-destination');
		write(collision, OLD_ARTIFACT, serializeCkpatch(patch()));
		write(collision, NEXT_ARTIFACT, 'occupied\n');
		expect(() =>
			buildPatchRenameBatch({
				patchesDir: collision,
				renames: [EXACT],
				artifacts: [{ artifactPath: OLD_ARTIFACT, patch: patch() }]
			})
		).toThrow(/destination already exists/);
	});

	it('refuses traversal and symlinks in declared scans and operation paths', () => {
		const traversal = fixture('rename-apply-traversal', false);
		expect(() =>
			buildPatchRenameBatch({
				patchesDir: traversal.root,
				renames: [EXACT],
				artifacts: [{ artifactPath: OLD_ARTIFACT, patch: patch() }],
				ownPaths: ['../outside.ts']
			})
		).toThrow(/unsafe path/);

		const linked = fixture('rename-apply-symlink', false);
		const outside = makeTempRoot('rename-apply-symlink-outside');
		write(outside, 'secret.ts', 'secret\n');
		mkdirSync(join(linked.root, 'delta/own'), { recursive: true });
		symlinkSync(join(outside, 'secret.ts'), join(linked.root, OWN));
		expect(() =>
			buildPatchRenameBatch({
				patchesDir: linked.root,
				renames: [EXACT],
				artifacts: [{ artifactPath: OLD_ARTIFACT, patch: patch() }],
				ownPaths: [OWN]
			})
		).toThrow(/symlink/);
	});

	it('preflights every replacement before making the first change', () => {
		const { root } = fixture('rename-apply-all-or-nothing', false);
		const before = readFileSync(join(root, OLD_ARTIFACT));
		expect(() =>
			buildPatchRenameBatch({
				patchesDir: root,
				renames: [EXACT],
				artifacts: [{ artifactPath: OLD_ARTIFACT, patch: patch() }],
				explicitReferenceReplacements: [{ renameFrom: OLD, area: 'own-import', file: OWN, from: '../old.js', to: '../new.js' }]
			})
		).toThrow(/replacement source does not exist/);
		expect(readFileSync(join(root, OLD_ARTIFACT))).toEqual(before);
		expect(existsSync(join(root, RENAME_TRANSACTION_PATH))).toBe(false);
	});

	it('resumes byte-identically after interruption following every ordered operation', () => {
		const baseline = fixture('rename-apply-baseline');
		applyPatchRenameBatch({ patchesDir: baseline.root, batch: baseline.batch, reviewed: true });
		const expectedPatch = readFileSync(join(baseline.root, NEXT_ARTIFACT));
		const expectedOwn = readFileSync(join(baseline.root, OWN));
		const operationCount = baseline.batch.plans.flatMap((plan) => plan.operations).length;

		for (let stop = 1; stop <= operationCount; stop += 1) {
			const interrupted = fixture(`rename-apply-interrupt-${stop}`);
			expect(() =>
				applyPatchRenameBatch(
					{ patchesDir: interrupted.root, batch: interrupted.batch, reviewed: true },
					{
						afterOperation(completed) {
							if (completed === stop) throw new Error(`interrupt ${stop}`);
						}
					}
				)
			).toThrow(`interrupt ${stop}`);
			expect(existsSync(join(interrupted.root, RENAME_TRANSACTION_PATH))).toBe(true);
			resumePatchRenameTransaction(interrupted.root, interrupted.batch);
			expect(readFileSync(join(interrupted.root, NEXT_ARTIFACT))).toEqual(expectedPatch);
			expect(readFileSync(join(interrupted.root, OWN))).toEqual(expectedOwn);
			expect(existsSync(join(interrupted.root, RENAME_TRANSACTION_PATH))).toBe(false);
		}
	});

	it('recognizes and completes an atomic replacement whose same-directory temp was already written', () => {
		const interrupted = fixture('rename-apply-partial-temp');
		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: interrupted.root, batch: interrupted.batch, reviewed: true },
				{
					afterTemporaryWrite() {
						throw new Error('power loss before replace');
					}
				}
			)
		).toThrow(/remains resumable/);
		resumePatchRenameTransaction(interrupted.root, interrupted.batch);
		expect(readFileSync(join(interrupted.root, NEXT_ARTIFACT), 'utf8')).toContain(`+++ b/${NEXT}`);
		expect(existsSync(join(interrupted.root, RENAME_TRANSACTION_PATH))).toBe(false);
	});

	it('recovers a temp whose bytes were written before its executable mode was applied', () => {
		const root = makeTempRoot('rename-apply-partial-temp-mode');
		const parsed = patch();
		write(root, OLD_ARTIFACT, serializeCkpatch(parsed));
		write(root, OWN, `const target = '${OLD}';\n`);
		chmodSync(join(root, OWN), 0o755);
		const batch = buildPatchRenameBatch({
			patchesDir: root,
			renames: [EXACT],
			artifacts: [{ artifactPath: OLD_ARTIFACT, patch: parsed }],
			ownPaths: [OWN]
		});

		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: root, batch, reviewed: true },
				{
					afterTemporaryBytesWrite(operation) {
						if (operation === 3) throw new Error('power loss before chmod');
					}
				}
			)
		).toThrow(/remains resumable/);
		resumePatchRenameTransaction(root, batch);
		expect(statSync(join(root, OWN)).mode & 0o777).toBe(0o755);
		expect(readFileSync(join(root, OWN), 'utf8')).toContain(NEXT);
	});

	it('binds every replacement to its exact preimage hash and occurrence count, then rejects drift', () => {
		const drifted = fixture('rename-apply-count-drift');
		expect(drifted.batch.bindings).toHaveLength(3);
		for (const binding of drifted.batch.bindings) {
			expect(binding.preimageSha256).toMatch(/^[0-9a-f]{64}$/);
			expect(binding.expectedOccurrences).toBe(1);
		}
		writeFileSync(join(drifted.root, OWN), "import '../../src/vs/old/remoteClient.js';\nimport '../../src/vs/old/remoteClient.js';\n");
		expect(() => applyPatchRenameBatch({ patchesDir: drifted.root, batch: drifted.batch, reviewed: true })).toThrow(
			/hash\/count or portable file mode changed/
		);
		expect(existsSync(join(drifted.root, RENAME_TRANSACTION_PATH))).toBe(false);
	});

	it('never clobbers a destination that appears after preflight', () => {
		const raced = fixture('rename-apply-destination-race');
		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: raced.root, batch: raced.batch, reviewed: true },
				{
					beforeMoveCreate() {
						writeFileSync(join(raced.root, NEXT_ARTIFACT), 'racing owner bytes\n');
					}
				}
			)
		).toThrow(/remains resumable/);
		expect(readFileSync(join(raced.root, NEXT_ARTIFACT), 'utf8')).toBe('racing owner bytes\n');
		expect(existsSync(join(raced.root, OLD_ARTIFACT))).toBe(true);
	});

	it('recognizes the exclusive two-name move state and resumes by removing only the source name', () => {
		const interrupted = fixture('rename-apply-partial-move');
		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: interrupted.root, batch: interrupted.batch, reviewed: true },
				{
					afterMoveCreate() {
						throw new Error('power loss after exclusive create');
					}
				}
			)
		).toThrow(/remains resumable/);
		expect(readFileSync(join(interrupted.root, OLD_ARTIFACT))).toEqual(readFileSync(join(interrupted.root, NEXT_ARTIFACT)));
		resumePatchRenameTransaction(interrupted.root, interrupted.batch);
		expect(existsSync(join(interrupted.root, OLD_ARTIFACT))).toBe(false);
		expect(existsSync(join(interrupted.root, NEXT_ARTIFACT))).toBe(true);
	});

	it('rechecks the bound preimage immediately before replacing the target', () => {
		const raced = fixture('rename-apply-replace-race');
		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: raced.root, batch: raced.batch, reviewed: true },
				{
					afterTemporaryWrite() {
						writeFileSync(join(raced.root, OLD_ARTIFACT), 'concurrent writer bytes\n');
					}
				}
			)
		).toThrow(/hash\/count\/mode changed immediately before atomic replace/);
		expect(readFileSync(join(raced.root, OLD_ARTIFACT), 'utf8')).toBe('concurrent writer bytes\n');
	});

	it('persists a digest-keyed completion receipt, repeats as an exact no-op, and makes final drift loud', () => {
		const completed = fixture('rename-apply-repeat');
		expect(applyPatchRenameBatch({ patchesDir: completed.root, batch: completed.batch, reviewed: true }).repeated).toBe(false);
		const receipts = readdirSync(join(completed.root, RENAME_COMPLETIONS_DIR));
		expect(receipts).toHaveLength(1);
		expect(receipts[0]).toMatch(/^[0-9a-f]{64}\.json$/);
		expect(applyPatchRenameBatch({ patchesDir: completed.root, batch: completed.batch, reviewed: true })).toMatchObject({
			completed: true,
			repeated: true
		});
		writeFileSync(join(completed.root, NEXT_ARTIFACT), 'drift after completion\n');
		expect(() => applyPatchRenameBatch({ patchesDir: completed.root, batch: completed.batch, reviewed: true })).toThrow(
			/final hash mismatch/
		);
	});

	it('preserves an executable own-file mode and makes post-completion chmod drift loud', () => {
		const root = makeTempRoot('rename-apply-executable');
		const parsed = patch();
		write(root, OLD_ARTIFACT, serializeCkpatch(parsed));
		write(root, OWN, `const target = '${OLD}';\n`);
		chmodSync(join(root, OWN), 0o755);
		const batch = buildPatchRenameBatch({
			patchesDir: root,
			renames: [EXACT],
			artifacts: [{ artifactPath: OLD_ARTIFACT, patch: parsed }],
			ownPaths: [OWN]
		});
		expect(batch.modes.find((entry) => entry.path === OWN)?.mode).toBe(0o755);
		applyPatchRenameBatch({ patchesDir: root, batch });
		expect(statSync(join(root, OWN)).mode & 0o777).toBe(0o755);
		chmodSync(join(root, OWN), 0o644);
		expect(() => applyPatchRenameBatch({ patchesDir: root, batch })).toThrow(/final mode mismatch/);
	});

	it('rejects a tampered digest and a plan edit even when the attacker recomputes the digest', () => {
		for (const recompute of [false, true]) {
			const interrupted = fixture(`rename-apply-journal-tamper-${recompute}`);
			expect(() =>
				applyPatchRenameBatch(
					{ patchesDir: interrupted.root, batch: interrupted.batch, reviewed: true },
					{
						afterOperation() {
							throw new Error('interrupt');
						}
					}
				)
			).toThrow('interrupt');
			const path = join(interrupted.root, RENAME_TRANSACTION_PATH);
			const journal = JSON.parse(readFileSync(path, 'utf8')) as {
				planDigest: string;
				plans: Array<{ similarity: number }>;
				bindings: unknown[];
				initial: Array<{ path: string; mode: number | null }>;
				steps?: unknown;
			};
			expect(journal.steps).toBeUndefined();
			if (recompute) {
				const first = journal.plans[0];
				if (first === undefined) throw new Error('missing fixture plan');
				first.similarity = 99;
				const modes = journal.initial.map(({ path: file, mode }) => ({ path: file, mode }));
				journal.planDigest = createHash('sha256')
					.update(JSON.stringify({ plans: journal.plans, bindings: journal.bindings, modes }))
					.digest('hex');
			} else journal.planDigest = '0'.repeat(64);
			writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`);
			expect(() => resumePatchRenameTransaction(interrupted.root, interrupted.batch)).toThrow(/expected rename batch/);
		}
	});

	it('derives the temp name instead of trusting the journal and rejects changed temp bytes', () => {
		const interrupted = fixture('rename-apply-temp-tamper');
		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: interrupted.root, batch: interrupted.batch, reviewed: true },
				{
					afterTemporaryWrite() {
						throw new Error('power loss');
					}
				}
			)
		).toThrow(/remains resumable/);
		const patchDir = join(interrupted.root, 'delta/patches');
		const temp = readdirSync(patchDir).find((name) => name.includes('.rename-'));
		if (temp === undefined) throw new Error('missing derived temp');
		writeFileSync(join(patchDir, temp), 'tampered temp\n');
		expect(() => resumePatchRenameTransaction(interrupted.root, interrupted.batch)).toThrow(/not an exact recognized partial state/);
	});

	it('refuses an unrecognized partial state instead of guessing how to continue', () => {
		const interrupted = fixture('rename-apply-unrecognized');
		expect(() =>
			applyPatchRenameBatch(
				{ patchesDir: interrupted.root, batch: interrupted.batch, reviewed: true },
				{
					afterOperation() {
						throw new Error('interrupt');
					}
				}
			)
		).toThrow('interrupt');
		writeFileSync(join(interrupted.root, OWN), 'unrecognized hand edit\n');
		expect(() => resumePatchRenameTransaction(interrupted.root, interrupted.batch)).toThrow(/not an exact recognized partial state/);
	});
});
