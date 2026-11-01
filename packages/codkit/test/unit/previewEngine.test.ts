/** @scope spec://codkit/modules/codkit/PROP-007#CMD-PREVIEW */
// The pure helpers of the preview engine (PROP-007 ##CMD-PREVIEW,
// ##CMD-PREVIEW-HOST, ##CMD-PREVIEW-ISOLATION): the fixed plan, the order of
// the host sources and their resolution, the wrapper rule, the isolation check
// and the choice of the newest artifact. The run itself is proved end to end
// over the real CLI, in e2e/preview.test.ts.

import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PreviewRecipe } from '@codkit/type-api';
import { isCkError } from '../../src/lib/messages.ts';
import { newestArtifact, previewStepPlan, requireMode } from '../../src/lib/previewEngine.ts';
import {
	PREVIEW_HOST_VARIABLE,
	configuredPreviewHost,
	findOnPath,
	hostCandidate,
	looksLikePath,
	resolveHost,
	resolveWrapper
} from '../../src/lib/previewHost.ts';
import { isolationProblem, previewStateDir } from '../../src/lib/previewIsolation.ts';
import { previewArea, stubType } from '../fixtures/stubType.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(() => {
	cleanupTempRoots();
});

/** An executable file for the lookups: executable on POSIX, a file on Windows. */
function executable(directory: string, name: string): string {
	mkdirSync(directory, { recursive: true });
	const path = join(directory, name);
	writeFileSync(path, '', 'utf8');
	chmodSync(path, 0o755);
	return path;
}

function recipe(stateDir: string, overrides: Partial<PreviewRecipe> = {}): PreviewRecipe {
	const userDataDir = join(stateDir, 'user-data');
	const extensionsDir = join(stateDir, 'extensions');
	return {
		prepare: [],
		needsArtifact: false,
		launch: { command: 'host', args: ['--user-data-dir', userDataDir, '--extensions-dir', extensionsDir] },
		isolation: { userDataDir, extensionsDir },
		...overrides
	};
}

describe('the plan of one preview run', () => {
	it('is fixed before the recipe is asked, and ends with the restore only under --wait', () => {
		expect(previewStepPlan(false)).toEqual(['drift guard', 'host', 'overlay apply', 'recipe', 'artifact', 'prepare', 'launch']);
		expect(previewStepPlan(true)).toEqual(['drift guard', 'host', 'overlay apply', 'recipe', 'artifact', 'prepare', 'launch', 'restore']);
	});

	it('keeps the state of a mode under .codkit/preview of the patch set', () => {
		expect(previewStateDir(join('p', 'set'), 'development')).toBe(join('p', 'set', '.codkit', 'preview', 'development'));
	});

	it('takes the mode of the type by default and refuses one it does not answer', () => {
		const type = stubType({});
		expect(requireMode(previewArea, type, null)).toBe('development');
		expect(requireMode(previewArea, type, 'artifact')).toBe('artifact');
		try {
			requireMode(previewArea, type, 'nowhere');
			expect.unreachable('an unknown mode must be refused');
		} catch (error) {
			expect(isCkError(error) && error.code).toBe('CONFIG');
			expect(isCkError(error) ? error.message : '').toContain('development, artifact');
		}
	});
});

describe('the sources of the host, in the fixed order of ##CMD-PREVIEW-HOST', () => {
	const typeConfig = { ownRoot: 'source/own', preview: { host: 'configured-host' } };

	it('takes --host first, the environment second, the configuration third and the default last', () => {
		expect(hostCandidate('flagged', { [PREVIEW_HOST_VARIABLE]: 'exported' }, typeConfig, 'fallback')).toEqual({
			source: 'flag',
			value: 'flagged'
		});
		expect(hostCandidate(null, { [PREVIEW_HOST_VARIABLE]: 'exported' }, typeConfig, 'fallback')).toEqual({
			source: 'environment',
			value: 'exported'
		});
		expect(hostCandidate(null, {}, typeConfig, 'fallback')).toEqual({ source: 'configuration', value: 'configured-host' });
		expect(hostCandidate(null, {}, { ownRoot: 'source/own' }, 'fallback')).toEqual({ source: 'default', value: 'fallback' });
	});

	it('treats an empty value as no value at all', () => {
		expect(hostCandidate('', { [PREVIEW_HOST_VARIABLE]: '' }, { ownRoot: 'source/own' }, 'fallback')).toEqual({
			source: 'default',
			value: 'fallback'
		});
	});

	it('reads typeConfig.preview.host as an opaque string and nothing else of the section', () => {
		expect(configuredPreviewHost(typeConfig)).toBe('configured-host');
		expect(configuredPreviewHost({ preview: { host: 3 } })).toBeNull();
		expect(configuredPreviewHost({ preview: { host: '' } })).toBeNull();
		expect(configuredPreviewHost({ preview: 'host' })).toBeNull();
		expect(configuredPreviewHost({ ownRoot: 'source/own' })).toBeNull();
		expect(configuredPreviewHost(null)).toBeNull();
		expect(configuredPreviewHost('configured-host')).toBeNull();
	});

	it('tells a path from a name by its separators', () => {
		expect(looksLikePath('host')).toBe(false);
		expect(looksLikePath('tools/host')).toBe(true);
		expect(looksLikePath('C:\\tools\\host.exe')).toBe(true);
		expect(looksLikePath('./host')).toBe(true);
	});
});

describe('the resolution of one host', () => {
	it('accepts a path that is an executable file and refuses one that is not, naming what was tried', () => {
		const root = makeTempRoot('preview-host-path');
		const path = executable(root, process.platform === 'win32' ? 'host.exe' : 'host');
		const lookup = { platform: process.platform, env: {}, cwd: root };

		const found = resolveHost({ source: 'flag', value: path }, lookup);
		expect(found).toEqual({ ok: true, path, tried: [`--host: ${path}`] });

		const missing = resolveHost({ source: 'flag', value: join(root, 'absent') }, lookup);
		expect(missing.ok).toBe(false);
		expect(missing.tried).toEqual([`--host: ${join(root, 'absent')}`]);

		const directory = resolveHost({ source: 'environment', value: root }, lookup);
		expect(directory.ok).toBe(false);
		expect(directory.tried[0]).toContain(PREVIEW_HOST_VARIABLE);
	});

	it('finds a name on PATH with the suffixes of the platform, in PATH order', () => {
		const first = makeTempRoot('preview-path-first');
		const second = makeTempRoot('preview-path-second');
		const windowsHost = executable(second, 'tool.CMD');
		const posixHost = executable(first, 'tool');

		// Windows: the suffixes of PATHEXT, compared without case, and the entry's
		// own spelling in the answer.
		expect(findOnPath('tool', [second], ['', '.COM', '.EXE', '.BAT', '.cmd'], 'win32')).toBe(windowsHost);
		expect(findOnPath('TOOL', [second], ['', '.cmd'], 'win32')).toBe(windowsHost);
		expect(findOnPath('tool', [second], ['', '.exe'], 'win32')).toBeNull();
		// POSIX: the bare name, exactly.
		expect(findOnPath('tool', [first, second], [''], 'linux')).toBe(posixHost);
		expect(findOnPath('Tool', [first], [''], 'linux')).toBeNull();
		// A directory of PATH that does not exist is skipped, not an error.
		expect(findOnPath('tool', [join(first, 'absent'), first], [''], 'linux')).toBe(posixHost);
	});

	it('resolves the whole lookup through the environment of the platform', () => {
		const directory = makeTempRoot('preview-path-env');
		const path = executable(directory, 'tool.cmd');
		const resolution = resolveHost(
			{ source: 'default', value: 'tool' },
			{ platform: 'win32', env: { PATH: `${directory};${join(directory, 'absent')}`, PATHEXT: '.EXE;.CMD' }, cwd: directory }
		);
		expect(resolution).toEqual({
			ok: true,
			path,
			tried: ['the default host of the project type: tool on PATH (2 directories, suffixes .EXE .CMD)']
		});

		// The POSIX PATH is colon-separated; a Windows temp path carries one itself,
		// so only the shape of what was tried is asserted here, not its count.
		const none = resolveHost({ source: 'default', value: 'other' }, { platform: 'linux', env: { PATH: directory }, cwd: directory });
		expect(none.ok).toBe(false);
		expect(none.tried).toHaveLength(1);
		expect(none.tried[0]).toMatch(/^the default host of the project type: other on PATH \(\d+ director(?:y|ies)\)$/u);
	});

	it('resolves a bin/<name>.cmd wrapper to the <name>.exe beside its bin directory, on Windows only', () => {
		const application = makeTempRoot('preview-wrapper');
		const wrapper = executable(join(application, 'bin'), 'tool.cmd');
		const exe = executable(application, 'Tool.exe');

		expect(resolveWrapper(wrapper, 'win32')).toBe(exe);
		expect(resolveWrapper(wrapper, 'linux')).toBe(wrapper);
		// No executable beside the bin directory: the wrapper stays.
		const lonely = executable(join(makeTempRoot('preview-wrapper-lonely'), 'bin'), 'other.cmd');
		expect(resolveWrapper(lonely, 'win32')).toBe(lonely);
		// A wrapper that does not sit in a bin directory is not of the shape the rule reads.
		const elsewhere = executable(join(makeTempRoot('preview-wrapper-elsewhere'), 'scripts'), 'tool.cmd');
		executable(join(elsewhere, '..', '..'), 'Tool.exe');
		expect(resolveWrapper(elsewhere, 'win32')).toBe(elsewhere);
	});
});

describe('the isolation rule (##CMD-PREVIEW-ISOLATION)', () => {
	const stateDir = join('p', 'set', '.codkit', 'preview', 'development');

	it('accepts a recipe whose two directories lie under the state directory and are whole launch arguments', () => {
		expect(isolationProblem(recipe(stateDir), stateDir)).toBeNull();
	});

	it('refuses a directory outside the state directory, the state directory itself, and one missing from the arguments', () => {
		const outside = join('p', 'set', 'elsewhere');
		const broken = recipe(stateDir, { isolation: { userDataDir: outside, extensionsDir: join(stateDir, 'extensions') } });
		expect(isolationProblem(broken, stateDir)).toContain('userDataDir');
		expect(isolationProblem(broken, stateDir)).toContain('does not lie under the state directory');

		const itself = recipe(stateDir, { isolation: { userDataDir: join(stateDir, 'user-data'), extensionsDir: stateDir } });
		expect(isolationProblem(itself, stateDir)).toContain('extensionsDir');

		const sibling = join('p', 'set', '.codkit', 'preview', 'development-two', 'user-data');
		const lookalike = recipe(stateDir, { isolation: { userDataDir: sibling, extensionsDir: join(stateDir, 'extensions') } });
		expect(isolationProblem(lookalike, stateDir)).toContain('does not lie under the state directory');

		const unpassed = recipe(stateDir, { launch: { command: 'host', args: ['--user-data-dir', join(stateDir, 'user-data')] } });
		expect(isolationProblem(unpassed, stateDir)).toBe(
			`extensionsDir ${join(stateDir, 'extensions')} is not a whole argument of the launch`
		);

		const joined = recipe(stateDir, {
			launch: {
				command: 'host',
				args: [`--user-data-dir=${join(stateDir, 'user-data')}`, '--extensions-dir', join(stateDir, 'extensions')]
			}
		});
		expect(isolationProblem(joined, stateDir)).toContain('userDataDir');
		expect(isolationProblem(joined, stateDir)).toContain('not a whole argument');

		const empty = recipe(stateDir, { isolation: { userDataDir: '', extensionsDir: join(stateDir, 'extensions') } });
		expect(isolationProblem(empty, stateDir)).toBe('the recipe names no userDataDir');
	});
});

describe('the artifact handed to a mode that needs one', () => {
	it('is the newest existing output, whatever the order of the patterns', () => {
		const tree = makeTempRoot('preview-artifact');
		mkdirSync(join(tree, '.build', 'package'), { recursive: true });
		writeFileSync(join(tree, '.build', 'package', 'app.bin'), 'app\n', 'utf8');
		writeFileSync(join(tree, '.build', 'app-1.tar'), 'tar\n', 'utf8');
		writeFileSync(join(tree, '.build', 'app-2.tar'), 'tar\n', 'utf8');
		const old = new Date('2024-01-01T00:00:00Z');
		const newer = new Date('2024-06-01T00:00:00Z');
		const newest = new Date('2025-01-01T00:00:00Z');
		utimesSync(join(tree, '.build', 'package'), old, old);
		utimesSync(join(tree, '.build', 'app-1.tar'), newest, newest);
		utimesSync(join(tree, '.build', 'app-2.tar'), newer, newer);

		expect(newestArtifact(tree, ['.build/package/', '.build/app-1.tar', '.build/app-2.tar'])).toBe(join(tree, '.build', 'app-1.tar'));
		expect(newestArtifact(tree, ['.build/app-2.tar', '.build/package/'])).toBe(join(tree, '.build', 'app-2.tar'));
		// An output that is gone is skipped; no output at all is no artifact.
		expect(newestArtifact(tree, ['.build/absent.tar', '.build/package/'])).toBe(join(tree, '.build', 'package'));
		expect(newestArtifact(tree, [])).toBeNull();
	});
});
