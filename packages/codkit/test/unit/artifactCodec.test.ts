import { afterAll, expect, expectTypeOf, it } from 'vitest';
import { artifactCodec, TEXT_PATCH_CODEC_ID } from '../../src/lib/artifactCodec.ts';
import type { ArtifactCodec, ArtifactPlan } from '../../src/lib/artifactCodec.ts';
import type { CodecResult } from '../../src/lib/artifactCodec.ts';
import { encodeUtf8 } from '../../src/lib/bytes.ts';
import { parseCkpatch, serializeCkpatch, encodePatchName } from '../../src/lib/patchFormat.ts';
import { applyUnified } from '../../src/lib/applyUnified.ts';
import { conventions } from '../support/conventions.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);
const header =
	'# codkit-patch: 2\n# id: CK-shell-001\n# type: modify\n# category: follow\n# owner: shell-core\n# reason: codec example\n# link: none\n# cause: none\n# pin: v1@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n# contract-tests: none\n';
const file = 'delta/patches/source__file.ts.ckpatch';
const bytes = encodeUtf8(`${header}--- a/source/file.ts\n+++ b/source/file.ts\n@@ -1 +1 @@\n-before\n+after\n`);
function codec(): ArtifactCodec {
	const result = artifactCodec(TEXT_PATCH_CODEC_ID);
	if (!result.ok) throw new Error(result.problem.message);
	return result.value;
}
function plan(): ArtifactPlan {
	const c = codec();
	const decoded = c.decode(bytes, conventions(), file);
	if (!decoded.ok) throw new Error(decoded.problem.message);
	const result = c.plan(decoded.value, { targetPath: 'source/file.ts', exists: true, bytes: encodeUtf8('before\n') });
	if (!result.ok) throw new Error(result.problem.message);
	return result.value;
}
it('uses the existing wire/parser/apply behavior and returns deterministic metadata/fingerprint', () => {
	const c = codec();
	expectTypeOf(c).toEqualTypeOf<ArtifactCodec>();
	const decoded = c.decode(bytes, conventions(), file);
	if (!decoded.ok) throw new Error(decoded.problem.message);
	expect(serializeCkpatch(decoded.value)).toEqual(bytes);
	expect(decoded.value).toEqual(parseCkpatch(bytes, conventions(), file));
	expect(c.identifyTargets(decoded.value)).toEqual(['source/file.ts']);
	expect(c.inventory(decoded.value)).toMatchObject({ codecId: TEXT_PATCH_CODEC_ID, operations: ['modify'], hunks: 1 });
	expect(c.fingerprint(decoded.value)).toMatch(/^[0-9a-f]{64}$/);
	expect(c.fingerprint(decoded.value)).toBe(c.fingerprint(parseCkpatch(bytes, conventions(), file)));
	const applied = c.apply(plan(), { targetPath: 'source/file.ts', exists: true, bytes: encodeUtf8('before\n') });
	expect(applied).toEqual({ ok: true, value: applyUnified(encodeUtf8('before\n'), decoded.value) });
});
it('refuses unsupported codecs/profiles and stale target/base/output before materialization', () => {
	const c = codec();
	expect(artifactCodec('binary-replace-v1')).toMatchObject({ ok: false, problem: { kind: 'unsupported' } });
	expect(c.compatible('minimal-intervention@1')).toBe(true);
	expect(c.compatible('patch-heavy@1')).toBe(false);
	for (const current of [
		{ targetPath: 'other.ts', exists: true, bytes: encodeUtf8('before\n') },
		{ targetPath: 'source/file.ts', exists: false, bytes: new Uint8Array() },
		{ targetPath: 'source/file.ts', exists: true, bytes: encodeUtf8('edited\n') }
	])
		expect(c.apply(plan(), current)).toMatchObject({ ok: false, problem: { kind: 'stale' } });
	const altered = plan();
	altered.result[0] = 0;
	expect(c.apply(altered, { targetPath: 'source/file.ts', exists: true, bytes: encodeUtf8('before\n') })).toMatchObject({
		ok: false,
		problem: { kind: 'stale' }
	});
});
it('retains normalized extract bytes and refuses invalid/future input without changing existing representation', () => {
	const c = codec();
	expect(c.decode(encodeUtf8('not a patch'), conventions(), file)).toMatchObject({ ok: false });
	expect(
		c.decode(encodeUtf8(Buffer.from(bytes).toString('utf8').replace('codkit-patch: 2', 'codkit-patch: 3')), conventions(), file)
	).toMatchObject({ ok: false });
	const options = {
		targetPath: 'source/file.ts',
		pinBytes: encodeUtf8('before\n'),
		curBytes: encodeUtf8('after\n'),
		header,
		existingBytes: bytes,
		tmpDir: makeTempRoot('codec-extract')
	};
	expect(c.extract(options)).toEqual({ ok: true, value: { unchanged: true, empty: false } });
});
it('keeps explicit add-file existence and legacy ambiguous path refusal', () => {
	const c = codec();
	const wire = encodeUtf8(`${header}--- /dev/null\n+++ b/source/file.ts\n@@ -0,0 +1 @@\n+created\n`);
	const decoded = c.decode(wire, conventions(), file);
	if (!decoded.ok) throw new Error(decoded.problem.message);
	const absent = { targetPath: 'source/file.ts', exists: false, bytes: new Uint8Array() };
	const add = c.plan(decoded.value, absent);
	expect(add).toMatchObject({ ok: true, value: { operation: 'add' } });
	if (add.ok) expect(c.apply(add.value, absent)).toEqual({ ok: true, value: encodeUtf8('created\n') });
	expect(c.plan(decoded.value, { ...absent, exists: true })).toMatchObject({ ok: false });
	expect(() => encodePatchName('source/path__part.ts')).toThrow(/cannot encode/);
	expect(c.operations).toEqual(['add', 'modify']);
});
it('keeps the contract representation-neutral without registering another codec', () => {
	type FutureRepresentation = { readonly explicitTarget: string; readonly payload: Uint8Array };
	type FutureCodec = ArtifactCodec<FutureRepresentation, { readonly target: string }, Uint8Array>;
	expectTypeOf<ReturnType<FutureCodec['decode']>>().toEqualTypeOf<CodecResult<FutureRepresentation>>();
	expectTypeOf<Parameters<FutureCodec['plan']>[0]>().toEqualTypeOf<FutureRepresentation>();
	expectTypeOf<ReturnType<FutureCodec['extract']>>().toEqualTypeOf<CodecResult<Uint8Array>>();
	expect(artifactCodec('unregistered-future')).toMatchObject({ ok: false, problem: { kind: 'unsupported' } });
});
