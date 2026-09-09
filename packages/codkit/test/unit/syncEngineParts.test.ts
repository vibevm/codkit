// The parts of the sync engine that are pure enough to test on their own: the
// cleanup whitelist matcher (PROP-011 sec. 4) and the managed block of
// .git/info/exclude (PROP-005 ##OWN-EXCLUDED-LOCALLY).

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConventions, matchesPatternList } from '../../src/lib/conventionsFile.ts';
import { bothSidesError, EXCLUDE_BEGIN, EXCLUDE_END, matchesCleanupWhitelist, toPosix, writeExclude } from '../../src/lib/syncEngine.ts';
import { isCkError } from '../../src/lib/messages.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';
import { projectType as stubProjectType } from '../fixtures/stubType.ts';
import { oneOwnedRoot, ownedRoot } from '../support/ownedRoots.ts';

/**
 * The shipped list (PROP-011 ##CLEANUP-WHITELIST-CONTENT), read as gitignore
 * patterns. It is transcribed here rather than loaded, so that a change to the
 * shipped file has to be a deliberate change to this test as well; the case
 * below checks that the two still agree.
 */
const WHITELIST = ['node_modules/', '.build/', '/out*/', 'addons/*/out/', 'addons/*/dist/', '.eslintcache', '*.tsbuildinfo'];

afterAll(() => {
	cleanupTempRoots();
});

describe('matchesCleanupWhitelist', () => {
	it('is the list conventions.json ships', () => {
		expect(loadConventions(stubProjectType).cleanupWhitelist).toEqual(WHITELIST);
	});

	it('keeps node_modules at any level', () => {
		expect(matchesCleanupWhitelist('node_modules/pkg/index.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('addons/sample/node_modules/pkg/index.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('build/lib/node_modules/x', WHITELIST)).toBe(true);
	});

	it('keeps the build caches', () => {
		expect(matchesCleanupWhitelist('.build/stamp', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('out/vs/main.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('out-build/vs/main.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('.eslintcache', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('src/tsconfig.tsbuildinfo', WHITELIST)).toBe(true);
	});

	it('anchors a pattern that carries a slash', () => {
		expect(matchesCleanupWhitelist('addons/sample/dist/main.js', WHITELIST)).toBe(true);
		// The same shape one level deeper is not what the anchored pattern names.
		expect(matchesCleanupWhitelist('vendor/addons/sample/dist/main.js', WHITELIST)).toBe(false);
	});

	it('does not let a star cross a slash', () => {
		expect(matchesCleanupWhitelist('addons/a/b/dist/main.js', WHITELIST)).toBe(false);
	});

	it('anchors a pattern that starts with a slash at the tree root', () => {
		// The build output of the tree root is protected, and only there: the
		// unanchored form would have kept every "out..." directory anywhere in
		// the tree, which is what the anchor is for. At the top level the star
		// still spans the whole name, gitignore-style.
		expect(matchesCleanupWhitelist('out/vs/main.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('out-build/vs/main.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('src/out/file.js', WHITELIST)).toBe(false);
		expect(matchesCleanupWhitelist('deep/nested/out-build/file.js', WHITELIST)).toBe(false);
		// `addons/*/out/` is not redundant any more: it is the only pattern
		// that protects a built extension.
		expect(matchesCleanupWhitelist('addons/sample/out/main.js', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('addons/a/b/out/main.js', WHITELIST)).toBe(false);
	});

	it('does not protect anything inside .git, which git never lists anyway', () => {
		expect(matchesCleanupWhitelist('.git/codkit/applied.json', WHITELIST)).toBe(false);
	});

	it('removes everything the list does not name', () => {
		expect(matchesCleanupWhitelist('litter.txt', WHITELIST)).toBe(false);
		expect(matchesCleanupWhitelist('scratch/deep/note.md', WHITELIST)).toBe(false);
		expect(matchesCleanupWhitelist('outfile.js', WHITELIST)).toBe(false);
		expect(matchesCleanupWhitelist('source/app/new.ts', WHITELIST)).toBe(false);
	});

	it('understands a directory entry the same way as a file inside it', () => {
		expect(matchesCleanupWhitelist('node_modules/', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('out/', WHITELIST)).toBe(true);
		expect(matchesCleanupWhitelist('scratch/', WHITELIST)).toBe(false);
	});
});

describe('conventions ownership', () => {
	function configuredRoot(label: string, extension: unknown): string {
		const root = makeTempRoot(label);
		writeFileSync(
			join(root, 'codkit.json'),
			`${JSON.stringify({
				codkitConfig: 2,
				pin: { tag: '1.0.0', sha: '1'.repeat(40), date: '2026-01-01' },
				upstreamAnchorCommit: '0'.repeat(40),
				type: 'stub',
				typeConfig: { ownRoot: 'source/own' },
				generatedBranchPrefix: 'codkit/applied/',
				cycleBranchPrefix: 'codkit/cycle/',
				releaseRefPrefix: 'codkit/release/',
				publishRemoteUrl: null,
				buildWatchFile: null,
				conventionsExtensionFile: 'config/conventions-extension.json'
			})}\n`
		);
		mkdirSync(join(root, 'config'), { recursive: true });
		writeFileSync(join(root, 'config', 'conventions-extension.json'), `${JSON.stringify(extension)}\n`);
		return root;
	}

	it('ignores an undeclared patch-set copy of the tool safety policy', () => {
		const root = makeTempRoot('conventions-hidden-copy');
		mkdirSync(join(root, 'codkit', 'config'), { recursive: true });
		writeFileSync(join(root, 'codkit', 'config', 'conventions.json'), '{"codkitConventions":999}\n');
		expect(loadConventions(stubProjectType, root)).toBe(loadConventions(stubProjectType));
	});

	it('merges an explicit extension additively', () => {
		const root = configuredRoot('conventions-extension', {
			codkitConventionsExtension: 1,
			subsystems: ['vendor'],
			forbiddenPatchTargets: ['private/**'],
			forbiddenServiceIds: ['IVendorRootService'],
			markerComment: { '.foo': { open: '# codkit:', close: '' } }
		});
		const conventions = loadConventions(stubProjectType, root);
		expect(new RegExp(conventions.idPattern).test('CK-vendor-001')).toBe(true);
		expect(conventions.forbiddenPatchTargets).toContain('private/**');
		expect(conventions.forbiddenServiceIds).toContain('IVendorRootService');
		expect(conventions.markerComment['.foo']).toEqual({ open: '# codkit:', close: '' });
		expect(conventions.cleanupWhitelist).toEqual(WHITELIST);
	});

	it('does not let an extension replace a shipped marker form', () => {
		const root = configuredRoot('conventions-marker-replace', {
			codkitConventionsExtension: 1,
			markerComment: { '.ts': { open: '// unsafe:', close: '' } }
		});
		expect(() => loadConventions(stubProjectType, root)).toThrow(/cannot replace a shipped marker form/);
	});
});

describe('matchesPatternList: forbiddenPatchTargets', () => {
	it('matches the shipped forbidden target by its ** suffix', () => {
		// The type's own forbidden targets, plus the targets of its configuration
		// overlay: an overlay owns those files as data, and a patch over the same
		// bytes would be a second, silent owner (PROP-003 ##CONV-FORBIDDEN-TARGETS).
		const forbidden = loadConventions(stubProjectType).forbiddenPatchTargets;
		expect(forbidden).toEqual(['.config/generated/**', 'manifest.json', 'package.json']);
		expect(matchesPatternList('.config/generated/PipelineAutobaseliningConfig.yml', forbidden)).toBe(true);
		expect(matchesPatternList('.config/generated/deep/nested.yml', forbidden)).toBe(true);
		expect(matchesPatternList('.config/other.yml', forbidden)).toBe(false);
		expect(matchesPatternList('source/app/a.ts', forbidden)).toBe(false);
	});
});

describe('writeExclude', () => {
	function excludeFile(tree: string): string {
		return readFileSync(join(tree, '.git', 'info', 'exclude'), 'utf8');
	}

	function makeTree(label: string, existing: string | null): string {
		const tree = makeTempRoot(label);
		mkdirSync(join(tree, '.git', 'info'), { recursive: true });
		if (existing !== null) {
			writeFileSync(join(tree, '.git', 'info', 'exclude'), existing, 'utf8');
		}
		return tree;
	}

	it('writes exactly the three managed lines', () => {
		const tree = makeTree('exclude-new', null);
		writeExclude(tree, oneOwnedRoot('source/own'));
		expect(excludeFile(tree)).toBe(`${EXCLUDE_BEGIN}\n/source/own/\n${EXCLUDE_END}\n`);
	});

	it('creates an absent block after one blank line without normalizing host bytes', () => {
		const tree = makeTree('exclude-separated', '# user\r\n*.local');
		writeExclude(tree, oneOwnedRoot('source/own'));
		expect(excludeFile(tree)).toBe(`# user\r\n*.local\r\n\r\n${EXCLUDE_BEGIN}\r\n/source/own/\r\n${EXCLUDE_END}\r\n`);
	});

	it('is idempotent', () => {
		const tree = makeTree('exclude-idempotent', '# left by the user\n*.local\n');
		writeExclude(tree, oneOwnedRoot('source/own'));
		const once = excludeFile(tree);
		writeExclude(tree, oneOwnedRoot('source/own'));
		expect(excludeFile(tree)).toBe(once);
		expect(once.startsWith('# left by the user\n*.local\n')).toBe(true);
	});

	it('replaces a stale managed block without touching other lines', () => {
		const tree = makeTree('exclude-stale', `# mine\n${EXCLUDE_BEGIN}\n/source/oldname/\n${EXCLUDE_END}\n# also mine\n`);
		writeExclude(tree, oneOwnedRoot('source/own'));
		expect(excludeFile(tree)).toBe(`# mine\n${EXCLUDE_BEGIN}\n/source/own/\n${EXCLUDE_END}\n# also mine\n`);
	});

	it('hard-stops on an unclosed block and preserves the entire file', () => {
		const existing = `# mine\n${EXCLUDE_BEGIN}\n/source/oldname/\n# user tail\n`;
		const tree = makeTree('exclude-unclosed', existing);
		let failure: unknown;
		try {
			writeExclude(tree, oneOwnedRoot('source/own'));
		} catch (error) {
			failure = error;
		}
		expect(isCkError(failure)).toBe(true);
		expect(excludeFile(tree)).toBe(existing);
	});

	it('hard-stops on duplicate markers', () => {
		const existing = `${EXCLUDE_BEGIN}\nold\n${EXCLUDE_END}\n${EXCLUDE_BEGIN}\nother\n${EXCLUDE_END}\n`;
		const tree = makeTree('exclude-duplicate', existing);
		expect(() => writeExclude(tree, oneOwnedRoot('source/own'))).toThrow(/expected zero markers or one ordered pair/);
		expect(excludeFile(tree)).toBe(existing);
	});

	it('does not rewrite a byte-identical managed block', () => {
		const existing = `# mine\r\n${EXCLUDE_BEGIN}\r\n/source/own/\r\n${EXCLUDE_END}\r\n# tail`;
		const tree = makeTree('exclude-noop', existing);
		const path = join(tree, '.git', 'info', 'exclude');
		const before = statSync(path).mtimeMs;
		writeExclude(tree, oneOwnedRoot('source/own'));
		expect(excludeFile(tree)).toBe(existing);
		expect(statSync(path).mtimeMs).toBe(before);
	});
});

describe('toPosix', () => {
	it('gives git forward slashes on every platform', () => {
		expect(toPosix('source\\app\\a.ts')).toBe('source/app/a.ts');
		expect(toPosix('source/app/a.ts')).toBe('source/app/a.ts');
	});
});

describe('the paths of an own-code diagnostic', () => {
	// ##OWN-ROOTS-IN-THE-DELTA: the own root is `delta/own/`, every other owned
	// directory is `delta/own-roots/<role>/`. A message that spelled the first
	// one for all of them named a file that is not there.
	it('addresses the own root as delta/own', () => {
		const error = bothSidesError({ owned: ownedRoot('source/own'), relative: 'browser/hello.ts' });
		expect(error.toPayload().file).toBe('delta/own/browser/hello.ts');
	});

	it('addresses another owned directory by its role', () => {
		const error = bothSidesError({ owned: ownedRoot('applications/product', 'application'), relative: 'esbuild.mjs' });
		expect(error.toPayload().file).toBe('delta/own-roots/application/esbuild.mjs');
	});
});
