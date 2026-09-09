// The shape of the type: it answers every area its capabilities promise, and
// promises every area it answers (modules/codkit/PROP-016 ##TYPE-CONTRACT-IS-CLOSED,
// modules/vscode/PROP-001 ##VSCODE-CAPABILITIES).

import { CAPABILITIES as CONTRACT_CAPABILITIES, projectTypeProblems } from '@codkit/type-api';
import { describe, expect, it } from 'vitest';
import { CAPABILITIES, projectType, TYPE_ID } from '../src/index.ts';

describe('the vscode project type', () => {
	it('is well formed against the contract it implements', () => {
		expect(projectTypeProblems(projectType)).toEqual([]);
	});

	it('is named by the identifier a patch set declares', () => {
		expect(projectType.id).toBe('vscode');
		expect(TYPE_ID).toBe('vscode');
	});

	it('declares every optional capability of the contract, so no verb refuses over it', () => {
		expect([...CAPABILITIES].sort()).toEqual([...CONTRACT_CAPABILITIES].sort());
		expect([...projectType.capabilities].sort()).toEqual([...CONTRACT_CAPABILITIES].sort());
	});

	it('answers the areas that are optional in the interface', () => {
		expect(projectType.brandImages).toBeDefined();
		expect(projectType.runtime).toBeDefined();
	});
});
