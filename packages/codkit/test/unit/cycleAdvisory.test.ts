/** @scope spec://codkit/modules/codkit/PROP-009#phases */
// The frame of the upgrade advisory, over real commits and a stub project type
// whose readers are synthetic: what the engine diffs, which files it lists as
// changed, in what order, and the acknowledgement that unblocks the cycle.
//
// No reader of a real upstream appears here on purpose. What a file of a
// distribution means is the type's answer and is proved in the suite of the
// package that gives it (PROP-016 ##TYPE-AREA-ADVISORY, ##TYPE-ENGINE-TESTS);
// what the engine does with two readings is proved here.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AdvisoryReader, ProjectType } from '@codkit/type-api';
import { brokenArtifact } from '@codkit/type-api';
import {
	dependencyAdvisoryAcknowledgement,
	inspectDependencyAdvisory,
	isDependencyAdvisoryAcknowledged,
	shouldStopForDependencyAdvisory
} from '../../src/lib/cycleAdvisory.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { CkError } from '../../src/lib/messages.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { stubReader, stubType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

type Content = string | Uint8Array;
type Snapshot = Readonly<Record<string, Content>>;

/** The files the stub readers below declare, in the order they declare them. */
const PATHS = ['toolchain', 'declared/manifest', 'catalogue'] as const;

const BASE: Snapshot = {
	toolchain: 'one\n',
	'declared/manifest': 'two\n',
	catalogue: 'three\n'
};

/**
 * Two readers whose change is news by itself and one whose file only matters
 * when the reading over it moves: that is the whole rule the frame applies.
 */
const READERS: readonly AdvisoryReader[] = [
	stubReader('toolchain', 'toolchain', { changeIsNews: true }),
	stubReader('manifest', 'declared/manifest', { changeIsNews: true }),
	stubReader('catalogue', 'catalogue', { changeIsNews: false })
];

const TYPE: ProjectType = stubType({ advisory: { readers: READERS } });

type Fixture = {
	readonly cwd: string;
	readonly oldPin: string;
	readonly newPin: string;
};

function replace(snapshot: Snapshot, path: string, content: Content | null): Snapshot {
	const copy: Record<string, Content> = { ...snapshot };
	if (content === null) {
		delete copy[path];
	} else {
		copy[path] = content;
	}
	return copy;
}

function fixture(before: Snapshot = BASE, after: Snapshot = BASE, unmonitoredChange = true): Fixture {
	const cwd = makeTempRoot('cycle-advisory');
	fixtureGit(cwd, ['init', '--quiet', '--initial-branch=main', '.']);
	writeSnapshot(cwd, before);
	write(cwd, 'README.md', 'old\n');
	const oldPin = fixtureCommit(cwd, 'fixture: old advisory inputs', '2026-01-01T03:00:00Z');
	for (const path of PATHS) {
		rmSync(join(cwd, path), { force: true });
	}
	writeSnapshot(cwd, after);
	if (unmonitoredChange) {
		write(cwd, 'README.md', 'new\n');
	}
	const newPin = fixtureCommit(cwd, 'fixture: new advisory inputs', '2026-01-01T03:01:00Z');
	return { cwd, oldPin, newPin };
}

function writeSnapshot(cwd: string, snapshot: Snapshot): void {
	for (const [path, content] of Object.entries(snapshot)) {
		write(cwd, path, content);
	}
}

function write(cwd: string, path: string, content: Content): void {
	const absolute = join(cwd, path);
	mkdirSync(dirname(absolute), { recursive: true });
	writeFileSync(absolute, content);
}

function report(fixtureValue: Fixture, type: ProjectType = TYPE) {
	return inspectDependencyAdvisory({ cwd: fixtureValue.cwd, oldPin: fixtureValue.oldPin, newPin: fixtureValue.newPin, type });
}

function codeOf(run: () => unknown): string {
	try {
		run();
		throw new Error('expected CkError');
	} catch (error) {
		expect(error).toBeInstanceOf(CkError);
		return (error as CkError).code;
	}
}

describe('dependency advisory', () => {
	afterAll(() => {
		cleanupTempRoots();
	});

	it('returns an empty report when the declared values do not change', () => {
		const value = report(fixture());

		expect(value.changedFiles).toEqual([]);
		expect(value.semanticChanges).toEqual([]);
		expect(dependencyAdvisoryAcknowledgement(value)).toBeNull();
		expect(isDependencyAdvisoryAcknowledged(value, null)).toBe(true);
		expect(shouldStopForDependencyAdvisory(value, { ci: false })).toBe(false);
	});

	it('asks no reader whose own files are untouched', () => {
		const asked: string[] = [];
		const watching = (id: string, path: string): AdvisoryReader => ({
			...stubReader(id, path, { changeIsNews: true }),
			read: (files) => {
				asked.push(id);
				return files.get(path)?.trim() ?? null;
			}
		});
		const type = stubType({ advisory: { readers: [watching('toolchain', 'toolchain'), watching('catalogue', 'catalogue')] } });
		report(fixture(BASE, replace(BASE, 'catalogue', 'other\n')), type);

		expect([...new Set(asked)]).toEqual(['catalogue']);
	});

	it('reports the reading that moved, with the sentence its reader gives it', () => {
		const value = report(fixture(BASE, replace(BASE, 'toolchain', 'four\n')));

		expect(value.changedFiles).toEqual([{ path: 'toolchain', change: 'modified' }]);
		expect(value.semanticChanges).toEqual([
			{ kind: 'toolchain', paths: ['toolchain'], before: 'one', after: 'four', meaning: 'toolchain changed' }
		]);
	});

	it('lists every reader and file in the order the type declared them', () => {
		let after = replace(BASE, 'toolchain', 'four\n');
		after = replace(after, 'declared/manifest', 'five\n');
		after = replace(after, 'catalogue', 'six\n');
		const value = report(fixture(BASE, after));

		expect(value.changedFiles.map((change) => change.path)).toEqual([...PATHS]);
		expect(value.semanticChanges.map((change) => change.kind)).toEqual(['toolchain', 'manifest', 'catalogue']);
	});

	it('names a file whose reader calls a change news even when the reading is the same', () => {
		const value = report(fixture(BASE, replace(BASE, 'toolchain', 'one \n')));

		expect(value.changedFiles).toEqual([{ path: 'toolchain', change: 'modified' }]);
		expect(value.semanticChanges).toEqual([]);
		expect(dependencyAdvisoryAcknowledgement(value)).not.toBeNull();
	});

	it('says nothing about a file whose reader does not, when the reading stays equal', () => {
		const value = report(fixture(BASE, replace(BASE, 'catalogue', 'three \n')));

		expect(value).toMatchObject({ changedFiles: [], semanticChanges: [] });
	});

	it('drops a difference the reader gives no meaning to, and the file with it', () => {
		const type = stubType({ advisory: { readers: [stubReader('quiet', 'catalogue', { meaning: null })] } });
		const value = report(fixture(BASE, replace(BASE, 'catalogue', 'six\n')), type);

		expect(value).toMatchObject({ changedFiles: [], semanticChanges: [] });
	});

	it('reports deleted inputs as deleted, with a null reading after', () => {
		const value = report(fixture(BASE, {}));

		expect(value.changedFiles).toEqual(PATHS.map((path) => ({ path, change: 'deleted' })));
		expect(value.semanticChanges.map((change) => [change.kind, change.after])).toEqual([
			['toolchain', null],
			['manifest', null],
			['catalogue', null]
		]);
	});

	it('turns a refusal of a reader into a broken artifact naming the pin', () => {
		const type = stubType({
			advisory: {
				readers: [
					{
						...stubReader('strict', 'toolchain', { changeIsNews: true }),
						read: () => {
							throw brokenArtifact('toolchain is not readable', 'restore the file upstream');
						}
					}
				]
			}
		});
		const value = fixture(BASE, replace(BASE, 'toolchain', 'four\n'));
		let message = '';
		try {
			report(value, type);
		} catch (error) {
			message = error instanceof CkError ? error.message : 'other';
		}
		expect(codeOf(() => report(value, type))).toBe('ARTIFACT-BROKEN');
		expect(message).toContain('toolchain is not readable');
		expect(message.startsWith(value.oldPin)).toBe(true);
	});

	it('refuses binary and non-UTF-8 inputs before a reader ever sees them', () => {
		const binary = fixture(BASE, replace(BASE, 'toolchain', new Uint8Array([0x32, 0x30, 0x00, 0x0a])));
		expect(codeOf(() => report(binary))).toBe('ENCODING');
	});

	it('is deterministic, leaves HEAD and the worktree untouched, and rejects stale acknowledgements', () => {
		const fixtureValue = fixture(BASE, replace(BASE, 'toolchain', 'four\n'));
		const headBefore = runGit({ args: ['rev-parse', 'HEAD'], cwd: fixtureValue.cwd }).stdout;
		const statusBefore = runGit({ args: ['status', '--porcelain'], cwd: fixtureValue.cwd }).stdout;
		const first = report(fixtureValue);
		const second = report(fixtureValue);
		const acknowledgement = dependencyAdvisoryAcknowledgement(first);

		expect(second).toEqual(first);
		expect(acknowledgement).toMatch(/^deps-advisory-v1:[0-9a-f]{40}:[0-9a-f]{64}$/);
		expect(shouldStopForDependencyAdvisory(first, { ci: false })).toBe(true);
		expect(shouldStopForDependencyAdvisory(first, { ci: false, acknowledgement: 'stale' })).toBe(true);
		expect(shouldStopForDependencyAdvisory(first, { ci: false, acknowledgement })).toBe(false);
		expect(shouldStopForDependencyAdvisory(first, { ci: true })).toBe(false);
		expect(isDependencyAdvisoryAcknowledged(first, acknowledgement)).toBe(true);
		expect(runGit({ args: ['rev-parse', 'HEAD'], cwd: fixtureValue.cwd }).stdout).toBe(headBefore);
		expect(runGit({ args: ['status', '--porcelain'], cwd: fixtureValue.cwd }).stdout).toBe(statusBefore);
	});

	it('ignores refs/replace through the default isolated Git runner', () => {
		const fixtureValue = fixture(BASE, replace(BASE, 'toolchain', 'four\n'));
		write(fixtureValue.cwd, 'toolchain', 'ninety-nine\n');
		const replacement = fixtureCommit(fixtureValue.cwd, 'fixture: malicious replacement tree', '2026-01-01T03:02:00Z');
		fixtureGit(fixtureValue.cwd, ['replace', fixtureValue.oldPin, replacement]);

		expect(report(fixtureValue).semanticChanges).toContainEqual({
			kind: 'toolchain',
			paths: ['toolchain'],
			before: 'one',
			after: 'four',
			meaning: 'toolchain changed'
		});
	});

	it('treats an absent declared path as unavailable but a missing blob as a Git/object failure', () => {
		const absent = fixture({}, {}, true);
		expect(report(absent).changedFiles).toEqual([]);

		const damaged = fixture(BASE, replace(BASE, 'toolchain', 'four\n'));
		const blob = fixtureGit(damaged.cwd, ['rev-parse', `${damaged.oldPin}:toolchain`]).stdout.trim();
		const objectPath = join(damaged.cwd, '.git', 'objects', blob.slice(0, 2), blob.slice(2));
		rmSync(objectPath);
		expect(codeOf(() => report(damaged))).toBe('ARTIFACT-BROKEN');
	});

	it('rejects unreachable and unsafe refs before advisory reads', () => {
		const fixtureValue = fixture();
		expect(
			codeOf(() => inspectDependencyAdvisory({ cwd: fixtureValue.cwd, oldPin: 'missing', newPin: fixtureValue.newPin, type: TYPE }))
		).toBe('PIN-UNREACHABLE');
		expect(
			codeOf(() => inspectDependencyAdvisory({ cwd: fixtureValue.cwd, oldPin: '-bad', newPin: fixtureValue.newPin, type: TYPE }))
		).toBe('CONFIG');
	});

	it('asks git for nothing when the type declares no reader at all', () => {
		const value = report(fixture(BASE, replace(BASE, 'toolchain', 'four\n')), stubType());

		expect(value.changedFiles).toEqual([]);
		expect(value.semanticChanges).toEqual([]);
	});
});
