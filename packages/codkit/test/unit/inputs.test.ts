// unit: the inputs of a patch set (PROP-007 ##INPUTS, PROP-008 ##INPUTS-LOAD,
// PROP-016 ##TYPE-INPUT-PLACEMENT) - the portable resolution of a build program,
// the source and its content stamp, the build and its output, the delivery
// into a tree and the edits found there, the commits of a generated branch,
// and where an input may land. A real repository and a real Node build in
// temporary directories; the tree is a plain git repository.

import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { InputConfig } from '../../src/lib/configFile.ts';
import { runGit } from '../../src/lib/gitx.ts';
import { buildEnvironment, collectOutput, produceInput, resolveProgram } from '../../src/lib/inputsBuild.ts';
import { assertInputPlacement } from '../../src/lib/inputsPlacement.ts';
import { inputRepositoryState } from '../../src/lib/inputsRepository.ts';
import { inspectSource } from '../../src/lib/inputsSource.ts';
import { readInputStore } from '../../src/lib/inputsStore.ts';
import { appendInputCommits, deliverInputs, inputSaveRefusal, produceInputs, warnInputEdits } from '../../src/lib/inputsTree.ts';
import { Output } from '../../src/lib/jsonOut.ts';
import { isCkError } from '../../src/lib/messages.ts';
import type { OwnedRoot } from '../../src/lib/ownedRoots.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { projectType as stubType } from '../fixtures/stubType.ts';
import { makeInputRepository } from '../support/inputRepository.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

type Captured = { readonly out: Output; readonly lines: () => readonly string[] };

function captured(): Captured {
	const texts: string[] = [];
	const out = new Output({
		command: 'load',
		version: 'test',
		jsonMode: false,
		streams: {
			writeOut(text: string) {
				texts.push(text);
			},
			writeErr(text: string) {
				texts.push(text);
			}
		}
	});
	return { out, lines: () => texts.join('').split('\n') };
}

function refusal(action: () => unknown): string {
	try {
		action();
	} catch (error) {
		if (isCkError(error)) return error.message;
		throw error;
	}
	throw new Error('expected a refusal');
}

function makeTree(label: string): string {
	const tree = makeTempRoot(`${label}-tree`);
	fixtureGit(tree, ['init', '--quiet']);
	return tree;
}

describe('the program of a build command', () => {
	const files = new Set(['C:\\tools\\node.exe', 'C:\\tools\\gen.cmd', 'C:\\work\\copy\\scripts\\run.bat']);
	const windows = {
		platform: 'win32' as const,
		env: { Path: 'C:\\empty;C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\cmd.exe' },
		cwd: 'C:\\work\\copy',
		isFile: (path: string) => files.has(path)
	};

	it('is the word itself elsewhere than Windows', () => {
		expect(resolveProgram(['node', 'build.mjs'], { ...windows, platform: 'linux' })).toEqual({
			command: 'node',
			args: ['build.mjs'],
			verbatim: false
		});
	});

	it('is searched along PATH with PATHEXT on Windows, and a batch launcher runs through cmd.exe', () => {
		expect(resolveProgram(['node', 'build.mjs'], windows)).toEqual({
			command: 'C:\\tools\\node.exe',
			args: ['build.mjs'],
			verbatim: false
		});
		expect(resolveProgram(['gen', 'docs', 'a b'], windows)).toEqual({
			command: 'C:\\Windows\\cmd.exe',
			args: ['/d', '/s', '/c', '"C:\\tools\\gen.cmd docs "a b""'],
			verbatim: true
		});
		expect(resolveProgram(['scripts/run'], windows).args).toEqual(['/d', '/s', '/c', '"C:\\work\\copy\\scripts\\run.bat"']);
		// Not found: the word is left to the operating system, which says so.
		expect(resolveProgram(['absent', 'x'], windows)).toEqual({ command: 'absent', args: ['x'], verbatim: false });
	});

	it('refuses an argument cmd.exe would interpret for a batch launcher', () => {
		for (const argument of ['a&b', '100%', 'x|y', 'say "hi"', 'a^b', '<in']) {
			expect(
				refusal(() => resolveProgram(['gen', argument], windows)),
				argument
			).toContain('carries a character cmd.exe interprets');
		}
		// An executable takes the same argument as it is.
		expect(resolveProgram(['node', 'a&b'], windows).args).toEqual(['a&b']);
	});

	it('lays the declared variables over the environment, one variable per name on Windows', () => {
		expect(buildEnvironment({ Path: 'a', HOME: 'h' }, { PATH: 'b' }, 'win32')).toEqual({ HOME: 'h', PATH: 'b' });
		expect(buildEnvironment({ Path: 'a' }, { PATH: 'b' }, 'linux')).toEqual({ Path: 'a', PATH: 'b' });
	});
});

describe('the source of an input', () => {
	it('takes tracked and untracked files of the working tree, ignored ones aside, and stamps them by content', () => {
		const repo = makeInputRepository('source-working');
		const input = repo.declaration();
		const clean = inspectSource(input, 'working');
		expect(clean.files).toEqual(['.gitignore', 'build.mjs', 'pages/guide.md', 'pages/topics/setup.md']);
		expect(inspectSource(input, 'working').stamp).toBe(clean.stamp);

		repo.write('pages/draft.md', '# Draft\n');
		repo.write('pages/guide.md', '# Guide\n\nAn edit nobody committed.\n');
		const dirty = inspectSource(input, 'working');
		expect(dirty.files).toContain('pages/draft.md');
		expect(dirty.stamp).not.toBe(clean.stamp);
		// The declaration is part of the stamp; the location and `to` are not.
		expect(inspectSource({ ...input, from: 'out' }, 'working').stamp).not.toBe(dirty.stamp);
		expect(inspectSource({ ...input, to: 'elsewhere' }, 'working').stamp).toBe(dirty.stamp);
		// The pinned commit does not see the working tree.
		expect(inspectSource(input, 'pinned').stamp).toBe(inspectSource(input, 'pinned').stamp);
		expect(inspectSource(input, 'pinned').commit).toBe(repo.head());
	});

	it('refuses a ref the repository does not have, and a repository that is not there', () => {
		const repo = makeInputRepository('source-refusals');
		expect(refusal(() => inspectSource(repo.declaration({ ref: 'f'.repeat(40) }), 'pinned'))).toContain('is not a commit of');
		expect(refusal(() => inspectSource(repo.declaration({ repository: join(repo.dir, 'absent') }), 'pinned'))).toContain('does not exist');
	});
});

describe('building an input', () => {
	it('builds in a disposable copy with the dependency roots carried in, and reuses the output of the same stamp', () => {
		const repo = makeInputRepository('build');
		const tree = makeTree('build');
		const { out } = captured();
		repo.write('pages/guide.md', '# Guide\n\nThe working-tree edit.\n');
		const first = produceInput({ input: repo.declaration(), mode: 'working', treeDir: tree, recorded: null, out, verbose: false });
		expect(first.built).toBe(true);
		expect(first.files.map((file) => file.path)).toEqual(['guide.md', 'index.txt', 'topics/setup.md']);
		const index = runGit({ args: ['cat-file', 'blob', first.files[1]?.blob ?? ''], cwd: tree }).stdout;
		expect(index).toBe('pages: guide.md, topics\nhelper: carried in\n');
		expect(runGit({ args: ['cat-file', 'blob', first.files[0]?.blob ?? ''], cwd: tree }).stdout).toContain('The working-tree edit.');
		expect(repo.builds()).toBe(1);

		const recorded = {
			name: 'pages',
			to: 'handbook',
			mode: 'working' as const,
			commit: null,
			stamp: first.stamp,
			files: Object.fromEntries(first.files.map((file) => [file.path, file.blob]))
		};
		const again = produceInput({ input: repo.declaration(), mode: 'working', treeDir: tree, recorded, out, verbose: false });
		expect(again.built).toBe(false);
		expect(again.files).toEqual(first.files);
		expect(repo.builds()).toBe(1);

		const pinned = produceInput({ input: repo.declaration(), mode: 'pinned', treeDir: tree, recorded, out, verbose: false });
		expect(pinned.built).toBe(true);
		expect(runGit({ args: ['cat-file', 'blob', pinned.files[0]?.blob ?? ''], cwd: tree }).stdout).toBe('# Guide\n\nThe first page.\n');
		expect(repo.builds()).toBe(2);
		// The repository is read, never written: the build left nothing in it.
		expect(runGit({ args: ['status', '--porcelain', '--ignored'], cwd: repo.dir }).stdout).not.toContain('out/');
	});

	it('refuses a failing build with its output, and removes the copy', () => {
		const repo = makeInputRepository('build-fails');
		const tree = makeTree('build-fails');
		const { out, lines } = captured();
		const input = repo.declaration({ env: { INPUT_BUILD_LOG: repo.buildLog, INPUT_BUILD_FAIL: '1' } });
		const message = refusal(() => produceInput({ input, mode: 'working', treeDir: tree, recorded: null, out, verbose: false }));
		expect(message).toContain('input pages: build command 1 exited 3');
		expect(message).toContain('the build failed on purpose');
		expect(lines().join('\n')).toContain('[input pages build 1/1] building the pages');
	});

	it('takes regular files and directories only, and refuses what a tree cannot carry', () => {
		const copy = makeTempRoot('output');
		const input = { name: 'pages', from: 'out/site' } as InputConfig;
		expect(refusal(() => collectOutput(input, copy))).toContain('the build left no out/site');
		mkdirSync(join(copy, 'out', 'site'), { recursive: true });
		expect(refusal(() => collectOutput(input, copy))).toContain('holds no file');
		writeFileSync(join(copy, 'out', 'site', 'page.md'), 'text\n');
		expect(collectOutput(input, copy).map((entry) => entry.path)).toEqual(['page.md']);

		writeFileSync(join(copy, 'out', 'site', 'image.png'), 'version https://git-lfs.github.com/spec/v1\noid sha256:00\nsize 1\n');
		expect(refusal(() => collectOutput(input, copy))).toContain('is a git-lfs pointer');
		rmSync(join(copy, 'out', 'site', 'image.png'));

		mkdirSync(join(copy, 'out', 'site', '.git'));
		expect(refusal(() => collectOutput(input, copy))).toContain('has a name git cannot carry');
		rmSync(join(copy, 'out', 'site', '.git'), { recursive: true });

		const target = makeTempRoot('output-link-target');
		symlinkSync(target, join(copy, 'out', 'site', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
		expect(refusal(() => collectOutput(input, copy))).toContain('out/site/linked is a link');
	});
});

describe('an input in a tree', () => {
	it('is mirrored by content, named when edited, and withdrawn with what codkit wrote', () => {
		const repo = makeInputRepository('deliver');
		const tree = makeTree('deliver');
		const input = repo.declaration();
		const { out, lines } = captured();
		const produced = produceInputs({ treeDir: tree, inputs: [input], mode: 'working', rebuild: false, out, verbose: false });
		const [first] = deliverInputs({ treeDir: tree, produced, out });
		expect(first).toMatchObject({ name: 'pages', to: 'handbook', files: 3, written: 3, removed: 0, built: true });
		expect(readFileSync(join(tree, 'handbook', 'topics', 'setup.md'), 'utf8')).toBe('# Setup\n\nInstall it.\n');
		expect(readInputStore(tree, () => {})[0]?.mode).toBe('working');

		// Unchanged source: no build and no write.
		const [second] = deliverInputs({
			treeDir: tree,
			produced: produceInputs({ treeDir: tree, inputs: [input], mode: 'working', rebuild: false, out, verbose: false }),
			out
		});
		expect(second).toMatchObject({ written: 0, removed: 0, built: false });
		expect(repo.builds()).toBe(1);

		// An edit in the tree is named, refused by save, and replaced by the next delivery.
		writeFileSync(join(tree, 'handbook', 'guide.md'), 'edited in the tree\n');
		writeFileSync(join(tree, 'handbook', 'stray.md'), 'added in the tree\n');
		expect(inputSaveRefusal(tree, [input], [], () => {})?.lines).toEqual([
			'edited   handbook/guide.md (input pages)',
			'added    handbook/stray.md (input pages)'
		]);
		expect(inputSaveRefusal(tree, [input], ['handbook/guide.md'], () => {})?.message).toContain('handbook (input pages)');
		warnInputEdits(tree, [input], out);
		expect(lines().join('\n')).toContain(
			`input pages: handbook/guide.md was edited in the fork tree; the load puts back the bytes of ${repo.dir}`
		);
		const [third] = deliverInputs({
			treeDir: tree,
			produced: produceInputs({ treeDir: tree, inputs: [input], mode: 'working', rebuild: false, out, verbose: false }),
			out
		});
		expect(third).toMatchObject({ written: 1, removed: 1, built: false });
		expect(inputSaveRefusal(tree, [input], [], () => {})).toBeNull();

		// Moved elsewhere: the old directory goes with exactly what codkit wrote.
		writeFileSync(join(tree, 'handbook', 'mine.md'), 'somebody else\n');
		const moved = { ...input, to: 'manual' };
		deliverInputs({
			treeDir: tree,
			produced: produceInputs({ treeDir: tree, inputs: [moved], mode: 'working', rebuild: false, out, verbose: false }),
			out
		});
		expect(readFileSync(join(tree, 'manual', 'guide.md'), 'utf8')).toBe('# Guide\n\nThe first page.\n');
		expect(readFileSync(join(tree, 'handbook', 'mine.md'), 'utf8')).toBe('somebody else\n');
		expect(runGit({ args: ['ls-files', '--others', '--', 'handbook'], cwd: tree }).stdout.trim()).toBe('handbook/mine.md');
	});

	it('becomes one commit per input on a generated branch, with its name and commit in the trailers', () => {
		const repo = makeInputRepository('commit');
		const tree = makeTree('commit');
		writeFileSync(join(tree, 'README.md'), 'upstream\n');
		const pin = fixtureCommit(tree, 'upstream: the pin', '2026-01-01T00:00:00Z');
		const input = repo.declaration();
		const { out } = captured();
		const produced = produceInputs({ treeDir: tree, inputs: [input], mode: 'pinned', rebuild: false, out, verbose: false });
		const indexEnv = { GIT_INDEX_FILE: join(makeTempRoot('commit-index'), 'index') };
		runGit({ args: ['read-tree', pin], cwd: tree, env: indexEnv });
		const identity = { GIT_AUTHOR_NAME: 'codkit', GIT_AUTHOR_EMAIL: 'codkit@patchset.invalid', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' };
		const commitEnv = {
			...indexEnv,
			...identity,
			GIT_COMMITTER_NAME: 'codkit',
			GIT_COMMITTER_EMAIL: 'codkit@patchset.invalid',
			GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
		};
		const options = {
			treeDir: tree,
			indexEnv,
			commitEnv,
			parent: pin,
			produced,
			patchSetCommit: 'a'.repeat(40),
			pinTag: 't1',
			pinSha: pin
		};
		const tip = appendInputCommits(options);
		expect(
			runGit({ args: ['ls-tree', '-r', '--name-only', tip], cwd: tree })
				.stdout.trim()
				.split('\n')
		).toEqual(['README.md', 'handbook/guide.md', 'handbook/index.txt', 'handbook/topics/setup.md']);
		expect(runGit({ args: ['ls-tree', '-r', tip, '--', 'handbook/guide.md'], cwd: tree }).stdout).toMatch(/^100644 blob /);
		expect(runGit({ args: ['log', '-1', '--format=%B', tip], cwd: tree }).stdout.trim()).toBe(
			[
				`codkit: input pages handbook`,
				'',
				`Codkit-Input: pages@${repo.head()}`,
				`Codkit-Patchset-Commit: ${'a'.repeat(40)}`,
				`Codkit-Upstream-Pin: t1@${pin}`
			].join('\n')
		);
		// The same pin, the same content, the same identity and date: the same commit.
		runGit({ args: ['read-tree', pin], cwd: tree, env: indexEnv });
		expect(appendInputCommits(options)).toBe(tip);
	});
});

describe('where an input may land', () => {
	it('refuses a place the pin, the patch set or the type owns, whatever the case', () => {
		const tree = makeTree('placement');
		writeFileSync(join(tree, 'README.md'), 'upstream\n');
		mkdirSync(join(tree, 'docs'));
		writeFileSync(join(tree, 'docs', 'intro.md'), 'upstream docs\n');
		const pin = fixtureCommit(tree, 'upstream: the pin', '2026-01-01T00:00:00Z');
		const roots: readonly OwnedRoot[] = [
			{ path: 'source/own', role: 'own', buildOutputs: [], deltaDir: 'delta/own', upstreamPaths: new Set() }
		];
		const place = (to: string): string | null => {
			try {
				assertInputPlacement({
					inputs: [{ name: 'pages', to } as InputConfig],
					treeDir: tree,
					pinSha: pin,
					type: stubType,
					roots,
					cleanupWhitelist: stubType.layout.cleanupWhitelist,
					deliveredTargets: ['generated/notes.txt']
				});
				return null;
			} catch (error) {
				if (isCkError(error)) return error.message;
				throw error;
			}
		};
		expect(place('handbook')).toBeNull();
		expect(place('source/own/pages')).toContain('meets the directory source/own the delta owns');
		expect(place('source')).toContain('meets the directory source/own the delta owns');
		expect(place('addons/pages')).toContain('where the type materializes own extensions');
		expect(place('vendor/node_modules/x')).toContain('where the type installs its dependencies');
		expect(place('out-pages')).toContain('its cleanup whitelist names it');
		expect(place('docs')).toContain('meets paths the pin carries');
		expect(place('DOCS')).toContain('meets paths the pin carries');
		expect(place('docs/pages')).toBeNull();
		expect(place('DOCS/pages')).toContain('names DOCS, which differs only in case from a directory of the pin');
		expect(place('README.md/pages')).toContain('lies under a file the pin carries');
		expect(place('generated')).toContain('meets generated/notes.txt, which the patch set delivers');
	});
});

describe('the repository of an input against its pin', () => {
	it('says when the pin is behind HEAD and what the working tree has of its own', () => {
		const repo = makeInputRepository('repository-state');
		const input = repo.declaration();
		expect(inputRepositoryState(input)).toMatchObject({ present: true, pin: 'at-head', behind: 0, uncommitted: [] });
		repo.write('pages/new.md', '# New\n');
		expect(inputRepositoryState(input).uncommitted).toEqual(['pages/new.md']);
		repo.commit('pages: a new one');
		expect(inputRepositoryState(input)).toMatchObject({ pin: 'behind', behind: 1, head: repo.head(), uncommitted: [] });
		expect(inputRepositoryState({ ...input, repository: join(repo.dir, 'absent') }).present).toBe(false);
	});
});
