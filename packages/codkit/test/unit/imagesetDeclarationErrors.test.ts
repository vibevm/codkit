// PROP-016 ##TYPE-ENGINE-TESTS: part of the `vscode` brand polygon - the
// targets and masters below are that family's.
// A declaration that cannot be applied exactly is refused, whole, before a
// master is read or a byte is written (PROP-007 ##IMAGESET-DECLARATION,
// ##IMAGESET-DECLARED-FRAMES, ##IMAGESET-DECLARED-SOURCES): every problem is
// CK-E-CONFIG naming the declaration, the target and the rule, and none of
// them is ignored, applied in part or replaced by a fallback.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { isCkError } from '../../src/lib/messages.ts';
import { CODE_ICO, declaredPolygon } from '../support/imagesetDeclared.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const LETTERPRESS = 'src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg';

type Case = {
	readonly name: string;
	/** The declaration: a string as it is, anything else as JSON. */
	readonly declaration: unknown;
	/** The message; `{BRANDING}` stands for the masters directory. */
	readonly message: string;
	readonly extended?: boolean;
	/** The message starts with this text rather than being it. */
	readonly prefix?: boolean;
};

const on = (entry: unknown, target = CODE_ICO) => ({ codkitImageset: 1, targets: { [target]: entry } });
const rule = (value: unknown) => on({ sources: [value] });

const CASES: readonly Case[] = [
	{ name: 'a file that is not JSON', declaration: '{"codkitImageset": 1,', message: 'is not valid JSON: ', prefix: true },
	{ name: 'a file that is not an object', declaration: [], message: 'must be a JSON object' },
	{
		name: 'an unknown member of the declaration',
		declaration: { codkitImageset: 1, targets: {}, extra: true },
		message: 'unknown member "extra": version 1 knows codkitImageset and targets'
	},
	{ name: 'another version', declaration: { codkitImageset: 2, targets: {} }, message: 'codkitImageset must be 1, and it is 2' },
	{ name: 'no version', declaration: { targets: {} }, message: 'codkitImageset must be 1, and it is missing' },
	{
		name: 'targets that are not an object',
		declaration: { codkitImageset: 1, targets: [] },
		message: 'targets must be an object from target paths to their entries'
	},
	{
		name: 'an unknown target path',
		declaration: on({ frames: [16] }, 'resources/win32/codee.ico'),
		message: 'resources/win32/codee.ico is not an image target of this distribution'
	},
	{ name: 'an entry that is not an object', declaration: on([16]), message: `${CODE_ICO}: an entry must be an object` },
	{
		name: 'an unknown member of an entry',
		declaration: on({ frames: [16], size: 1 }),
		message: `${CODE_ICO}: unknown member "size": an entry knows frames and sources`
	},
	{ name: 'an entry that declares nothing', declaration: on({}), message: `${CODE_ICO}: the entry declares neither frames nor sources` },
	{
		name: 'frames that are not sizes',
		declaration: on({ frames: ['16'] }),
		message: `${CODE_ICO}: frames must be a list of sizes in pixels`
	},
	{
		name: 'an ICO frame of size 0',
		declaration: on({ frames: [16, 0] }),
		message: `${CODE_ICO}: frames: an ICO frame is square, 1 to 256 pixels a side, and 0 is not`
	},
	{
		name: 'an ICO frame larger than 256',
		declaration: on({ frames: [16, 257] }),
		message: `${CODE_ICO}: frames: an ICO frame is square, 1 to 256 pixels a side, and 257 is not`
	},
	{
		name: 'an ICO frame of a fractional size',
		declaration: on({ frames: [16, 20.5] }),
		message: `${CODE_ICO}: frames: an ICO frame is square, 1 to 256 pixels a side, and 20.5 is not`
	},
	{
		name: 'an ICO size listed twice',
		declaration: on({ frames: [16, 32, 16] }),
		message: `${CODE_ICO}: frames: the size 16 is listed twice, and an ICO carries one frame of a size`
	},
	{
		name: 'an ICO with no frame',
		declaration: on({ frames: [] }),
		message: `${CODE_ICO}: frames: an ICO carries at least one frame, and the list is empty`
	},
	...[
		['icns', 'resources/darwin/code.icns'],
		['png', 'resources/linux/code.png'],
		['bmp', 'resources/win32/inno-big-100.bmp'],
		['xpm', 'resources/linux/rpm/code.xpm'],
		['svg', LETTERPRESS]
	].map(([kind, target]) => ({
		name: `a frame set declared for a ${kind ?? ''} target`,
		declaration: on({ frames: [16] }, target),
		message: `${target ?? ''}: a declared frame set is not supported for a target of the ${kind ?? ''} container`,
		extended: kind === 'svg'
	})),
	{
		name: 'sources that are not a list',
		declaration: on({ sources: { key: 'taskbar' } }),
		message: `${CODE_ICO}: sources must be a list of rules`
	},
	{ name: 'a rule that is not an object', declaration: rule('taskbar'), message: `${CODE_ICO}: sources[0]: a rule must be an object` },
	{
		name: 'an unknown member of a rule',
		declaration: rule({ key: 'taskbar', maxsize: 64 }),
		message: `${CODE_ICO}: sources[0]: unknown member "maxsize": a rule knows key, sizes, minSize and maxSize`
	},
	{ name: 'a rule without a key', declaration: rule({ maxSize: 64 }), message: `${CODE_ICO}: sources[0]: the rule names no key` },
	{
		name: 'a key that is not a master key',
		declaration: rule({ key: '../taskbar', maxSize: 64 }),
		message: `${CODE_ICO}: sources[0]: key must be a master key - one segment, or family/artwork, of letters, digits, '.', '_' and '-' - and "../taskbar" is not`
	},
	{
		name: 'a rule with two selectors',
		declaration: rule({ key: 'taskbar', sizes: [16], maxSize: 64 }),
		message: `${CODE_ICO}: sources[0]: selects by sizes and by a range at once, and a rule takes one selector`
	},
	{
		name: 'a rule with no selector',
		declaration: rule({ key: 'taskbar' }),
		message: `${CODE_ICO}: sources[0]: selects no frame: a rule takes sizes, or minSize and maxSize`
	},
	{
		name: 'an empty list of sizes',
		declaration: rule({ key: 'taskbar', sizes: [] }),
		message: `${CODE_ICO}: sources[0]: sizes must be a non-empty list of whole sizes in pixels`
	},
	{
		name: 'a range whose bounds contradict each other',
		declaration: rule({ key: 'taskbar', minSize: 64, maxSize: 16 }),
		message: `${CODE_ICO}: sources[0]: minSize 64 is greater than maxSize 16`
	},
	{
		name: 'a size listed twice in a rule',
		declaration: rule({ key: 'taskbar', sizes: [16, 16] }),
		message: `${CODE_ICO}: sources[0]: the size 16 is listed twice`
	},
	{
		name: 'a bound that is not a size',
		declaration: rule({ key: 'taskbar', maxSize: 0 }),
		message: `${CODE_ICO}: sources[0]: minSize and maxSize must be whole sizes in pixels`
	},
	{
		name: 'a listed size that is not a frame of the target',
		declaration: rule({ key: 'taskbar', sizes: [20] }),
		message: `${CODE_ICO}: sources[0]: the size 20 is not a frame of the target`
	},
	{
		name: 'a range that selects no frame',
		declaration: rule({ key: 'taskbar', minSize: 300 }),
		message: `${CODE_ICO}: sources[0]: the range from 300 px selects no frame of the target`
	},
	{
		name: 'a key with no masters',
		declaration: rule({ key: 'tray', maxSize: 64 }),
		message: `${CODE_ICO}: sources[0]: the key tray has no master in {BRANDING}`
	},
	{
		name: 'rules that overlap',
		declaration: on({
			sources: [
				{ key: 'taskbar', maxSize: 64 },
				{ key: 'icon', sizes: [32] }
			]
		}),
		message: `${CODE_ICO}: sources[1] selects the 32x32 frame, which sources[0] selects already`
	}
];

function refusalOf(call: () => unknown): { code: string; message: string; file: string | null } | null {
	try {
		call();
	} catch (error) {
		if (!isCkError(error)) throw error;
		return { code: error.code, message: error.message, file: error.file ?? null };
	}
	return null;
}

describe('a declaration that cannot be applied exactly', () => {
	for (const each of CASES) {
		it(`is refused: ${each.name}`, () => {
			const { patchset, brandingDir, run } = declaredPolygon(`refuse-${CASES.indexOf(each)}`, {
				declaration: each.declaration,
				extended: each.extended === true
			});
			const refusal = refusalOf(() => run(true));
			expect(refusal?.code).toBe('CONFIG');
			expect(refusal?.file).toBe(join(brandingDir, 'imageset.json'));
			const message = each.message.replace('{BRANDING}', brandingDir);
			if (each.prefix === true) {
				expect(refusal?.message.startsWith(message)).toBe(true);
			} else {
				expect(refusal?.message).toBe(message);
			}
			expect(existsSync(join(patchset.dir, 'delta', 'resources'))).toBe(false);
		});
	}

	it('is refused the same way by gen, its dry run, the index and the verification', () => {
		const { patchset, run, index, verify } = declaredPolygon('refuse-every-verb', {
			declaration: rule({ key: 'taskbar', minSize: 300 })
		});
		const expected = refusalOf(() => run(true));
		expect(expected?.code).toBe('CONFIG');
		expect(refusalOf(() => run(false))).toEqual(expected);
		expect(refusalOf(index)).toEqual(expected);
		expect(refusalOf(() => verify())).toEqual(expected);
		expect(existsSync(join(patchset.dir, 'delta', 'resources'))).toBe(false);
	});
});
