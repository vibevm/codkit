// The message registry is the single definition of codkit's diagnostic codes
// (PROP-012 sec. 2). This test carries an independent copy of the mandatory list
// so that a code cannot be dropped or renamed without the test noticing.

import { describe, expect, it } from 'vitest';
import {
	ckError,
	ERROR_CODES,
	formatError,
	formatWarning,
	isCkError,
	publicErrorPayloadSchema,
	serializeErrorPayload,
	WARNING_CODES
} from '../../src/lib/messages.ts';

/** Codes the specs require, transcribed from PROP-012 sec. 2. */
const REQUIRED_ERROR_CODES = [
	'CONFIG',
	'NOT-A-REPO',
	'NOT-UPSTREAM',
	'PIN-UNREACHABLE',
	'LFS',
	'LOCKED',
	'DIRTY-TREE',
	'TREE-READONLY',
	'CRLF',
	'EOF-NEWLINE',
	'ENCODING',
	'MARKER-MALFORMED',
	'MARKER-NESTED',
	'MARKER-UNBALANCED',
	'MARKER-UNCLOSED',
	'MARKER-DUP-ID',
	'MARKER-BAD-ID',
	'HUNK-OUTSIDE-MARKER',
	'DELETES-UPSTREAM-LINE',
	'DELETES-UPSTREAM-FILE',
	'NEW-FILE-IN-UPSTREAM-ZONE',
	'HEADER-MISSING',
	'FORBIDDEN-TARGET',
	'MARKER-ARTIFACT-MISMATCH',
	'UNTRACKED-INTERVENTION',
	'STALE-ARTIFACT',
	'OWN-UNCOVERED',
	'OWNER-UNKNOWN',
	'GUARD-MISSING',
	'FORBIDDEN-SERVICE',
	'OVERLAY-SCHEMA',
	'OVERLAY-DRIFT',
	'RULE-DRIFT',
	'ARTIFACT-BROKEN',
	'NET-FORBIDDEN',
	'LOG-INCOMPLETE',
	'BOTH-SIDES-EDITED',
	'WORKTREE-REF-SHARED',
	'TREE-HEAD',
	'PATCHSET-MOVED',
	'SYNC-IN-PROGRESS',
	'INTERNAL',
	'DEPS-MISSING',
	'LICENSE-HEADER',
	'LICENSE-THIRD-PARTY',
	'LICENSE-PACKAGE',
	'STANDARDS-DRIFT',
	'RUNTIME-DRIFT',
	'RUNTIME-PACKAGE',
	'DELIVERED-EDIT',
	'OWN-UNDER-CODKIT',
	'HOOK-TOO-LARGE',
	'GEN-EXISTS',
	'GEN-ID',
	'OWN-EXTENSION-MANIFEST',
	'OWN-EXTENSION-DRIFT',
	'TYPE-UNKNOWN',
	'TYPE-CAPABILITY'
];

const REQUIRED_WARNING_CODES = ['MARK-RO', 'PATCHSET-SIDE-EDIT', 'EMPTY-BLOCK'];

describe('error registry', () => {
	it('contains exactly the required codes', () => {
		expect(new Set(ERROR_CODES)).toEqual(new Set(REQUIRED_ERROR_CODES));
	});

	it('contains exactly the required warning codes', () => {
		expect(new Set(WARNING_CODES)).toEqual(new Set(REQUIRED_WARNING_CODES));
	});

	it('has no duplicates', () => {
		expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
		expect(new Set(WARNING_CODES).size).toBe(WARNING_CODES.length);
	});

	it('spells every code in upper kebab case', () => {
		for (const code of [...ERROR_CODES, ...WARNING_CODES]) {
			expect(code, code).toMatch(/^[A-Z]+(-[A-Z]+)*$/);
		}
	});
});

describe('ckError', () => {
	it('produces a throwable payload with no undefined keys', () => {
		const error = ckError('LOCKED', 'the tree is locked');

		expect(isCkError(error)).toBe(true);
		expect(error.toPayload()).toEqual({ code: 'LOCKED', message: 'the tree is locked' });
		expect(Object.keys(error.toPayload())).toEqual(['code', 'message']);
	});

	it('carries hint, file and line when given', () => {
		const error = ckError('CRLF', 'CRLF line ending', 'convert the file to LF', 'source/a.ts', 12);
		expect(error.toPayload()).toEqual({
			code: 'CRLF',
			message: 'CRLF line ending',
			hint: 'convert the file to LF',
			file: 'source/a.ts',
			line: 12
		});
	});
});

describe('public error payload', () => {
	it('adds the CK-E prefix once and conforms to the public schema', () => {
		const internal = ckError('CONFIG', 'broken', 'fix it', 'codkit.json', 4).toPayload();
		const payload = serializeErrorPayload(internal);

		expect(payload).toEqual({
			code: 'CK-E-CONFIG',
			message: 'broken',
			hint: 'fix it',
			file: 'codkit.json',
			line: 4
		});
		expect(publicErrorPayloadSchema.safeParse(payload).success).toBe(true);
		expect(publicErrorPayloadSchema.safeParse({ ...payload, code: 'CONFIG' }).success).toBe(false);
	});
});

describe('formatError', () => {
	it('renders code, message and hint on separate lines', () => {
		const text = formatError(ckError('CONFIG', 'pin.sha is required', 'set it', 'codkit.json').toPayload());
		expect(text).toBe('error CK-E-CONFIG: codkit.json: pin.sha is required\nhint: set it');
	});

	it('renders file:line when a line is known', () => {
		const text = formatError(ckError('MARKER-NESTED', 'nested marker', undefined, 'source/a.ts', 7).toPayload());
		expect(text).toBe('error CK-E-MARKER-NESTED: source/a.ts:7: nested marker');
	});

	it('omits the location when there is no file', () => {
		expect(formatError(ckError('INTERNAL', 'boom').toPayload())).toBe('error CK-E-INTERNAL: boom');
	});
});

describe('formatWarning', () => {
	it('renders a coded warning', () => {
		expect(formatWarning('read-only marker', 'MARK-RO')).toBe('warning CK-W-MARK-RO: read-only marker');
	});

	it('renders an uncoded warning', () => {
		expect(formatWarning('long path')).toBe('warning: long path');
	});
});
