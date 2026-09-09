/** @scope spec://codkit/modules/codkit/PROP-002#root */

import { describe, expect, it } from 'vitest';
import { repoRelativePathProblem } from '../../src/lib/pathSafety.ts';

describe('repoRelativePathProblem portability', () => {
	it('accepts ordinary POSIX paths with spaces and non-ASCII text', () => {
		expect(repoRelativePathProblem('src/vs/обычный файл.ts')).toBeNull();
		expect(repoRelativePathProblem('src/vs/emoji-😀.ts')).toBeNull();
	});

	it.each([
		'CON',
		'src/aux.ts',
		'src/COM1/file.ts',
		'src/a:b.ts',
		'src/question?.ts',
		'src/trailing.',
		'src/trailing ',
		'src/control\u007f.ts',
		'src/replacement\ufffd.ts',
		'src/lone-high\ud800.ts',
		'src/lone-low\udfff.ts'
	])('rejects a path Windows or a strict UTF-8 pipeline cannot represent safely: %j', (path) => {
		expect(repoRelativePathProblem(path)).not.toBeNull();
	});
});
