// `typeConfig` of this type: the own root, required, inside the bounds of the
// family (modules/codkit/PROP-016 ##TYPE-CONFIG-FIELD, modules/vscode/PROP-002
// ##VSCODE-OWN-ROOT-CONSTRAINT).

import { describe, expect, it } from 'vitest';
import { configSchema } from '../src/configSchema.ts';

describe('the typeConfig schema', () => {
	it('accepts the own root and nothing else', () => {
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset' }).success).toBe(true);
		expect(configSchema.safeParse({ ownRoot: 'src/vs/patchset', ownDirName: 'patchset' }).success).toBe(false);
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
