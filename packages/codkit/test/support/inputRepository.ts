// A tiny repository an input is taken from, for the tests of inputs (PROP-007
// ##INPUTS): pages under `pages/`, a Node build that copies them into
// `out/site` with a generated index and a line from a helper it finds in its
// ignored `deps/` directory - the dependency root the declaration carries in -
// and that appends one line per run to the file `INPUT_BUILD_LOG` names, so a
// test can count the builds. `INPUT_BUILD_FAIL=1` makes it fail with output.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { InputConfig } from '../../src/lib/configFile.ts';
import { fixtureCommit, fixtureGit } from '../fixtures/makeUpstream.ts';
import { makeTempRoot } from './tmp.ts';

export type InputRepository = {
	readonly dir: string;
	/** Where the build appends one line per run. */
	readonly buildLog: string;
	readonly write: (relative: string, content: string) => void;
	readonly commit: (message: string) => string;
	readonly head: () => string;
	/** How many times the build ran. */
	readonly builds: () => number;
	/** The declaration of this repository as an input of a patch set. */
	readonly declaration: (overrides?: Partial<InputConfig>) => InputConfig;
};

const BUILD_SCRIPT = `import { appendFileSync, cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { helperLine } from './deps/helper/index.mjs';
if (process.env.INPUT_BUILD_LOG) appendFileSync(process.env.INPUT_BUILD_LOG, 'build\\n');
if (process.env.INPUT_BUILD_FAIL === '1') {
	console.log('building the pages');
	console.error('the build failed on purpose');
	process.exit(3);
}
mkdirSync('out/site', { recursive: true });
cpSync('pages', 'out/site', { recursive: true });
writeFileSync('out/site/index.txt', 'pages: ' + readdirSync('pages').sort().join(', ') + '\\n' + helperLine() + '\\n');
`;

export function makeInputRepository(label: string): InputRepository {
	const dir = makeTempRoot(`${label}-input-repo`);
	const buildLog = join(makeTempRoot(`${label}-input-log`), 'builds.log');
	writeFileSync(buildLog, '', 'utf8');
	fixtureGit(dir, ['init', '--quiet']);
	const write = (relative: string, content: string): void => {
		const path = join(dir, ...relative.split('/'));
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf8');
	};
	write('.gitignore', 'out/\ndeps/\n');
	write('build.mjs', BUILD_SCRIPT);
	write('pages/guide.md', '# Guide\n\nThe first page.\n');
	write('pages/topics/setup.md', '# Setup\n\nInstall it.\n');
	// The dependency root: ignored, present in the working tree only.
	write('deps/helper/index.mjs', "export function helperLine() { return 'helper: carried in'; }\n");
	let date = 0;
	const commit = (message: string): string => {
		date += 1;
		return fixtureCommit(dir, message, `2026-03-0${Math.min(date, 9)}T00:00:00Z`);
	};
	commit('pages: the first two');
	const head = (): string => fixtureGit(dir, ['rev-parse', 'HEAD']).stdout.trim();
	return {
		dir,
		buildLog,
		write,
		commit,
		head,
		builds: () =>
			readFileSync(buildLog, 'utf8')
				.split('\n')
				.filter((line) => line !== '').length,
		declaration: (overrides = {}) => ({
			name: 'pages',
			repository: dir,
			ref: head(),
			build: [['node', 'build.mjs']],
			dependencyRoots: ['deps'],
			env: { INPUT_BUILD_LOG: buildLog },
			from: 'out/site',
			to: 'handbook',
			...overrides
		})
	};
}
