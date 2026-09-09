// The bounds of the own root and the materialization of an own extension
// (modules/vscode/PROP-002 ##VSCODE-OWN-ROOT-CONSTRAINT, ##OWN-EXTENSION-UNIT).

import { describe, expect, it } from 'vitest';
import { layout, OWN_ROOT_PREFIX, ownRootProblem } from '../src/layout.ts';

describe('the own root of this family', () => {
	it('accepts a directory under the source root of the distribution', () => {
		expect(ownRootProblem('src/vs/patchset')).toBeNull();
		expect(ownRootProblem('src/vs/team/patchset')).toBeNull();
	});

	it.each(['', 'patchset', 'src/patchset', 'srcx/vs/patchset', 'src/vs', 'src/vs/'])('refuses %j and says why', (candidate) => {
		const problem = ownRootProblem(candidate);
		expect(problem).not.toBeNull();
		expect(typeof problem).toBe('string');
	});

	it('refuses a root that could escape the tree or use the wrong separator', () => {
		expect(ownRootProblem('src/vs/../../etc')).not.toBeNull();
		expect(ownRootProblem('src\\vs\\patchset')).not.toBeNull();
		expect(ownRootProblem('/src/vs/patchset')).not.toBeNull();
	});

	it('states the prefix it constrains the root to', () => {
		expect(OWN_ROOT_PREFIX).toBe('src/vs/');
	});
});

describe('the layout answers', () => {
	it('materializes an own extension next to the built-in ones', () => {
		expect(layout.ownExtensionPath('acme-pack')).toBe('extensions/acme-pack');
	});

	it('names the build outputs a fresh pass may remove and the targets a patch may not touch', () => {
		expect(layout.cleanupWhitelist).toContain('node_modules/');
		expect(layout.cleanupWhitelist).toContain('/out*/');
		expect(layout.forbiddenPatchTargets).toEqual(['.config/1espt/**']);
	});
});
