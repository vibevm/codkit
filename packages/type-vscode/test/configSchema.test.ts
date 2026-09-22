// `typeConfig` of this type: the own root, required, inside the bounds of the
// family (modules/codkit/PROP-016 ##TYPE-CONFIG-FIELD, modules/vscode/PROP-002
// ##VSCODE-OWN-ROOT-CONSTRAINT).

import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/configSchema.ts';

describe('the typeConfig schema', () => {
	it('accepts the own root and the optional quality channel, and nothing else', () => {
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset' }).success).toBe(true);
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', quality: 'stable' }).success).toBe(true);
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', packageTargets: ['windows-x64', 'linux-x64'] }).success).toBe(true);
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', ownDirName: 'patchset' }).success).toBe(false);
	});

	it('refuses duplicate or foreign package targets', () => {
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', packageTargets: ['windows-x64', 'windows-x64'] }).success).toBe(false);
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', packageTargets: ['freebsd-x64'] }).success).toBe(false);
	});

	it('refuses a quality channel this family does not have', () => {
		// ##VSCODE-QUALITY-IS-A-PRODUCT-ANSWER: a word the upstream build does
		// not know would be stamped as "not the released channel" in silence.
		const parsed = configSchema.safeParse({ ownRoot: 'src/vs/patchset', quality: 'nightly' });
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.path).toEqual(['quality']);
	});

	it('requires the own root: the field has no default', () => {
		const parsed = configSchema.safeParse({});
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.path).toEqual(['ownRoot']);
	});

	it('refuses a root outside the bounds of the family and says which constraint', () => {
		const parsed = configSchema.safeParse({ ownRoot: 'packages/patchset' });
		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toContain('src/vs/');
	});
});
