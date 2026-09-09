// The --json envelope (PROP-012 sec. 1) and the split of channels: in json mode
// stdout carries exactly one JSON document and every human line goes to stderr.

import { describe, expect, it } from 'vitest';
import { ENVELOPE_SCHEMA_VERSION, Output } from '../../src/lib/jsonOut.ts';
import type { OutputStreams } from '../../src/lib/jsonOut.ts';
import { ckError } from '../../src/lib/messages.ts';

type Capture = { streams: OutputStreams; stdout: () => string; stderr: () => string };

function capture(): Capture {
	const out: string[] = [];
	const err: string[] = [];
	return {
		streams: {
			writeOut: (chunk) => {
				out.push(chunk);
			},
			writeErr: (chunk) => {
				err.push(chunk);
			}
		},
		stdout: () => out.join(''),
		stderr: () => err.join('')
	};
}

function makeOutput(jsonMode: boolean, sink: Capture): Output {
	return new Output({ command: 'where', version: '9.9.9', jsonMode, streams: sink.streams });
}

describe('json mode', () => {
	it('writes exactly one JSON document to stdout', () => {
		const sink = capture();
		const out = makeOutput(true, sink);

		out.info('fork tree: /abs (source: env)');
		out.warn('long path', 'MARK-RO');
		out.setRoots('/tool', { patchesDir: null, forkDir: { path: '/abs', source: 'env', exists: true, warning: null } });
		out.setData({ path: '/abs', source: 'env', exists: true });
		out.finish(0);

		const stdout = sink.stdout();
		expect(stdout.endsWith('\n')).toBe(true);
		// Parsing the whole stream proves there is exactly one document: two
		// concatenated objects would not parse.
		expect(() => JSON.parse(stdout)).not.toThrow();
		expect(stdout.trim().startsWith('{')).toBe(true);
		expect(stdout.trim().endsWith('}')).toBe(true);
	});

	it('matches the envelope shape', () => {
		const sink = capture();
		const out = makeOutput(true, sink);
		out.info('fork tree: /abs (source: env)');
		out.setRoots('/tool', { patchesDir: null, forkDir: { path: '/abs', source: 'env', exists: true, warning: null } });
		out.setData({ path: '/abs', source: 'env', exists: true });
		out.finish(0);

		const envelope: unknown = JSON.parse(sink.stdout());
		expect(envelope).toEqual({
			codkit: { schema: ENVELOPE_SCHEMA_VERSION, command: 'where', version: '9.9.9' },
			ok: true,
			exitCode: 0,
			roots: {
				tool: { path: '/tool', source: 'install', exists: true },
				patches: null,
				fork: { path: '/abs', source: 'env', exists: true }
			},
			data: { path: '/abs', source: 'env', exists: true },
			messages: [{ level: 'info', text: 'fork tree: /abs (source: env)' }],
			errors: []
		});
	});

	it('sends every human-readable line to stderr', () => {
		const sink = capture();
		const out = makeOutput(true, sink);
		out.info('fork tree: /abs (source: env)');
		out.warn('long path', 'MARK-RO');
		out.addError(ckError('CONFIG', 'pin.sha is required', 'set it', 'codkit.json').toPayload());
		out.finish(2);

		const stderr = sink.stderr();
		expect(stderr).toContain('fork tree: /abs (source: env)');
		expect(stderr).toContain('warning CK-W-MARK-RO: long path');
		expect(stderr).toContain('error CK-E-CONFIG: codkit.json: pin.sha is required');
		expect(stderr).toContain('hint: set it');
		// stdout stays machine-only.
		expect(sink.stdout()).not.toContain('warning CK-W-MARK-RO');
	});

	it('reports failure through ok/exitCode/errors', () => {
		const sink = capture();
		const out = makeOutput(true, sink);
		out.addError(ckError('CONFIG', 'broken', 'fix it', 'codkit.json').toPayload());
		out.finish(2);

		const envelope: unknown = JSON.parse(sink.stdout());
		expect(envelope).toMatchObject({
			ok: false,
			exitCode: 2,
			errors: [{ code: 'CK-E-CONFIG', message: 'broken', hint: 'fix it', file: 'codkit.json' }]
		});
	});

	it('prints nothing more on a second finish', () => {
		const sink = capture();
		const out = makeOutput(true, sink);
		out.finish(0);
		const once = sink.stdout();
		out.finish(0);
		expect(sink.stdout()).toBe(once);
	});
});

describe('human mode', () => {
	it('puts info on stdout and errors on stderr', () => {
		const sink = capture();
		const out = makeOutput(false, sink);
		out.info('fork tree: /abs (source: env)');
		out.info('exists: yes');
		out.addError(ckError('CONFIG', 'broken', 'fix it', 'codkit.json').toPayload());
		out.finish(2);

		expect(sink.stdout()).toBe('fork tree: /abs (source: env)\nexists: yes\n');
		expect(sink.stderr()).toBe('error CK-E-CONFIG: codkit.json: broken\nhint: fix it\n');
	});

	it('prints no JSON at all', () => {
		const sink = capture();
		const out = makeOutput(false, sink);
		out.setData({ path: '/abs' });
		out.finish(0);
		expect(sink.stdout()).not.toContain('{');
	});
});
