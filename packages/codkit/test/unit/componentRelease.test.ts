import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import {
	parseComponentRelease,
	readComponentRelease,
	sealComponentRelease,
	serializeComponentRelease,
	writeComponentRelease
} from '../../src/lib/componentRelease.ts';
import type { ComponentRelease, ComponentReleaseResult } from '../../src/lib/componentRelease.ts';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root() {
	const path = mkdtempSync(join(tmpdir(), 'codkit-component-release-'));
	roots.push(path);
	return path;
}
function unwrap<T>(result: ComponentReleaseResult<T>): T {
	if (!result.ok) throw new Error(result.problem.message);
	return result.value;
}
function body() {
	return {
		codkitComponentRelease: 1,
		componentId: 'fixture:desktop',
		operation: 'package',
		upstream: { revision: 'a'.repeat(40), label: null, commitDate: '2026-01-01' },
		patchset: { commit: 'b'.repeat(40), configSha256: 'c'.repeat(64) },
		type: { id: 'generic', package: '@codkit/type-generic', version: '1.0.0', contractVersion: 1, manifestSha256: 'd'.repeat(64) },
		discipline: 'minimal-intervention@1',
		generated: { tip: 'e'.repeat(40), tree: 'f'.repeat(40) },
		artifacts: [
			{ kind: 'file', path: 'out/z.zip', sha256: '1'.repeat(64), bytes: 12 },
			{ kind: 'file', path: 'out/a.zip', sha256: '2'.repeat(64), bytes: 34 }
		],
		buildRecipeSha256: '3'.repeat(64),
		licensePolicies: [{ scope: 'codkit-supply', id: 'codkit-supply', version: 1, sha256: '4'.repeat(64) }],
		distribution: {
			requirements: ['sbom', 'notice'],
			evidence: [{ requirement: 'notice', reference: 'NOTICE', sha256: '5'.repeat(64) }],
			missing: ['sbom'],
			status: 'incomplete'
		}
	};
}

describe('component release receipt', () => {
	it('seals deterministically and keeps commit/tree and digest meanings distinct', () => {
		const raw = body();
		const sealed = unwrap(sealComponentRelease(raw));
		const reordered = {
			...raw,
			artifacts: [...raw.artifacts].reverse(),
			distribution: { ...raw.distribution, requirements: [...raw.distribution.requirements].reverse() }
		};
		expect(unwrap(sealComponentRelease(reordered))).toEqual(sealed);
		const bytes = unwrap(serializeComponentRelease(sealed));
		expect(unwrap(parseComponentRelease(bytes))).toEqual(sealed);
		expectTypeOf<ComponentRelease['generated']['tip']>().not.toEqualTypeOf<ComponentRelease['generated']['tree']>();
		expectTypeOf<ComponentRelease['descriptorSha256']>().not.toEqualTypeOf<ComponentRelease['buildRecipeSha256']>();
	});
	it('detects a changed artifact receipt rather than accepting the old content digest', () => {
		const sealed = unwrap(sealComponentRelease(body()));
		const changed = structuredClone(sealed);
		const entry = changed.artifacts.find((value) => value.kind === 'file');
		if (entry === undefined || entry.kind !== 'file') throw new Error('fixture artifact missing');
		entry.bytes += 1;
		expect(serializeComponentRelease(changed)).toMatchObject({ ok: false, problem: { kind: 'integrity' } });
		const { descriptorSha256, ...changedBody } = changed;
		expect(descriptorSha256).toBe(sealed.descriptorSha256);
		expect(unwrap(sealComponentRelease(changedBody)).descriptorSha256).not.toBe(sealed.descriptorSha256);
	});
	it('refuses false evidence completeness, foreign fields, duplicate artifacts and escaping paths', () => {
		const raw = body();
		for (const candidate of [
			{ ...raw, distribution: { ...raw.distribution, status: 'complete', missing: [] } },
			{ ...raw, distribution: { requirements: [], evidence: [], missing: [], status: 'complete' } },
			{ ...raw, execute: 'adapter.js' },
			{ ...raw, artifacts: [...raw.artifacts, raw.artifacts[0]] },
			{ ...raw, artifacts: [{ kind: 'file', path: '../foreign.zip', sha256: '1'.repeat(64), bytes: 0 }] }
		])
			expect(sealComponentRelease(candidate).ok).toBe(false);
	});
	it('refuses future schemas and noncanonical byte encodings', () => {
		const sealed = unwrap(sealComponentRelease(body()));
		const text = Buffer.from(unwrap(serializeComponentRelease(sealed))).toString('utf8');
		const future = text.replace('"codkitComponentRelease": 1', '"codkitComponentRelease": 2');
		expect(parseComponentRelease(encodeUtf8(future))).toMatchObject({ ok: false, problem: { kind: 'version' } });
		for (const candidate of [text.trimEnd(), `${text}\n`, text.replaceAll('\n', '\r\n'), JSON.stringify(sealed) + '\n'])
			expect(parseComponentRelease(encodeUtf8(candidate)).ok).toBe(false);
	});
	it('publishes atomically, retries idempotently and refuses an existing conflicting file without changing it', () => {
		const dir = root();
		const sealed = unwrap(sealComponentRelease(body()));
		const first = unwrap(writeComponentRelease(dir, sealed));
		expect(first.created).toBe(true);
		expect(unwrap(writeComponentRelease(dir, sealed)).created).toBe(false);
		expect(unwrap(readComponentRelease(dir, sealed.descriptorSha256))).toEqual(sealed);
		const path = join(dir, first.path);
		writeFileSync(path, 'foreign bytes\n');
		expect(writeComponentRelease(dir, sealed)).toMatchObject({ ok: false, problem: { kind: 'storage' } });
		expect(readFileSync(path, 'utf8')).toBe('foreign bytes\n');
		expect(readComponentRelease(dir, '../outside')).toMatchObject({ ok: false, problem: { kind: 'shape' } });
	});
	it('refuses a substituted parent directory and preserves the outside root', () => {
		const dir = root();
		const outside = root();
		mkdirSync(join(dir, '.codkit'));
		symlinkSync(outside, join(dir, '.codkit/releases'), 'junction');
		const sentinel = join(outside, 'sentinel');
		writeFileSync(sentinel, 'preserve');
		expect(writeComponentRelease(dir, unwrap(sealComponentRelease(body())))).toMatchObject({ ok: false, problem: { kind: 'storage' } });
		expect(readFileSync(sentinel, 'utf8')).toBe('preserve');
	});
	it('binds the filename to its receipt even when a valid foreign descriptor is stored there', () => {
		const dir = root();
		const sealed = unwrap(sealComponentRelease(body()));
		const other = unwrap(sealComponentRelease({ ...body(), componentId: 'fixture:other' }));
		const path = join(dir, `.codkit/releases/${sealed.descriptorSha256}.json`);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, unwrap(serializeComponentRelease(other)));
		expect(readComponentRelease(dir, sealed.descriptorSha256)).toMatchObject({ ok: false, problem: { kind: 'integrity' } });
	});
});
