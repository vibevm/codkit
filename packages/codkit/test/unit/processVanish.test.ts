import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const probe = vi.hoisted((): { path: string | null; code: string } => ({ path: null, code: '' }));
vi.mock('node:fs', async (original) => {
	const actual = await original<typeof import('node:fs')>();
	return {
		...actual,
		readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
			if (args[0] === probe.path) throw Object.assign(new Error('proc read failed'), { code: probe.code });
			return actual.readFileSync(...args);
		}
	};
});
import { processArgs } from '../../src/lib/buildWrap.ts';
const roots: string[] = [];
afterEach(() => {
	probe.path = null;
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.each(['ENOENT', 'ESRCH'])('treats %s during cmdline read as a vanished task', (code) => {
	const root = mkdtempSync(join(tmpdir(), 'codkit-proc-vanish-'));
	roots.push(root);
	probe.path = join(root, '4242', 'cmdline');
	probe.code = code;
	expect(processArgs(4242, { platform: 'linux', procRoot: root })).toBeNull();
});
it.each(['EACCES', 'EPERM'])('continues to fail closed for %s', (code) => {
	const root = mkdtempSync(join(tmpdir(), 'codkit-proc-private-'));
	roots.push(root);
	probe.path = join(root, '4242', 'cmdline');
	probe.code = code;
	expect(() => processArgs(4242, { platform: 'linux', procRoot: root })).toThrow(/cannot inspect process 4242/);
});
