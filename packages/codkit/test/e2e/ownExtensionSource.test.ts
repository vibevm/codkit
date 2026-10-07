// e2e: recorded artifacts distinguish source-only own-extension edits from tree work.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeCliFixture } from '../support/cliFixture.ts';
import type { CliFixture } from '../support/cliFixture.ts';
import { cleanupTempRoots } from '../support/tmp.ts';

let subject: CliFixture;
const relative = 'acme-pack/package.nls.json';
const sourcePath = () => subject.patchesPath('delta/own-extensions/' + relative);
const treePath = () => subject.treePath('addons/' + relative);
const original = '{"hello":"original"}\n';
const changed = '{"hello":"source"}\n';

beforeEach(() => {
	subject = makeCliFixture('own-extension-source');
	const manifestPath = subject.patchesPath('delta/own/patchset.delta.json');
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
	if (typeof manifest !== 'object' || manifest === null) {
		throw new Error('invalid fixture manifest');
	}
	Reflect.set(manifest, 'extensions', [
		{
			id: 'CK-product-905',
			name: 'acme-pack',
			owner: 'product',
			reason: 'fixture language pack',
			pin: `${subject.upstream.t1.tag}@${subject.upstream.t1.sha}`,
			contractTests: []
		}
	]);
	writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
	const packagePath = subject.patchesPath('delta/own-extensions/acme-pack/package.json');
	mkdirSync(dirname(packagePath), { recursive: true });
	writeFileSync(packagePath, '{"name":"acme-pack"}\n');
	writeFileSync(sourcePath(), original);
	expect(subject.run(['load']).status).toBe(0);
}, 180000);
afterAll(cleanupTempRoots);

function editMark(edit: (mark: object) => void): void {
	const path = resolve(subject.treeDir, subject.git(['rev-parse', '--git-path', 'codkit/applied.json']).stdout.trim());
	const mark: unknown = JSON.parse(readFileSync(path, 'utf8'));
	if (typeof mark !== 'object' || mark === null) {
		throw new Error('invalid fixture mark');
	}
	edit(mark);
	writeFileSync(path, JSON.stringify(mark) + '\n');
}

describe('own-extension source provenance through the real CLI', { timeout: 180000 }, () => {
	it('applies existing source-only content and updates the baseline for a second edit', () => {
		writeFileSync(sourcePath(), changed);
		const first = subject.run(['load']);
		expect(first.status, first.stderr).toBe(0);
		expect(first.stderr).toContain('CK-W-PATCHSET-SIDE-EDIT');
		expect(readFileSync(treePath(), 'utf8')).toBe(changed);
		writeFileSync(sourcePath(), '{"hello":"second"}\n');
		const second = subject.run(['load']);
		expect(second.status, second.stderr).toBe(0);
		expect(readFileSync(treePath(), 'utf8')).toBe('{"hello":"second"}\n');
	});
	it('refuses tree-only work and preserves both files; save establishes the next baseline', () => {
		writeFileSync(treePath(), '{"hello":"tree"}\n');
		expect(subject.run(['load']).status).toBe(1);
		expect(readFileSync(sourcePath(), 'utf8')).toBe(original);
		expect(readFileSync(treePath(), 'utf8')).toBe('{"hello":"tree"}\n');
		const save = subject.run(['save']);
		expect(save.status, save.stderr).toBe(0);
		writeFileSync(sourcePath(), changed);
		const load = subject.run(['load']);
		expect(load.status, load.stderr).toBe(0);
		expect(readFileSync(treePath(), 'utf8')).toBe(changed);
	}, 420000);
	it('refuses both-edited work and preserves its bytes', () => {
		writeFileSync(sourcePath(), changed);
		writeFileSync(treePath(), '{"hello":"tree"}\n');
		const result = subject.run(['load']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('CK-E-BOTH-SIDES-EDITED');
		expect(readFileSync(sourcePath(), 'utf8')).toBe(changed);
		expect(readFileSync(treePath(), 'utf8')).toBe('{"hello":"tree"}\n');
	});
	it('keeps a legacy mark without artifacts strict', () => {
		editMark((mark) => {
			Reflect.deleteProperty(mark, 'artifacts');
		});
		writeFileSync(sourcePath(), changed);
		expect(subject.run(['load']).status).toBe(1);
		expect(readFileSync(treePath(), 'utf8')).toBe(original);
		expect(readFileSync(sourcePath(), 'utf8')).toBe(changed);
	});
	it('refuses a baseline bound to a different pin', () => {
		editMark((mark) => {
			Reflect.set(mark, 'pinSha', 'f'.repeat(40));
		});
		writeFileSync(sourcePath(), changed);
		expect(subject.run(['load']).status).toBe(1);
		expect(readFileSync(treePath(), 'utf8')).toBe(original);
	});
	it('applies a source deletion only when tree still matches the recorded file', () => {
		rmSync(sourcePath());
		const result = subject.run(['load']);
		expect(result.status, result.stderr).toBe(0);
		expect(() => readFileSync(treePath())).toThrow();
	});
	it('does not delete a file edited in tree when source deleted it', () => {
		rmSync(sourcePath());
		writeFileSync(treePath(), '{"hello":"tree"}\n');
		expect(subject.run(['load']).status).toBe(1);
		expect(readFileSync(treePath(), 'utf8')).toBe('{"hello":"tree"}\n');
	});
	it('preserves a staged projection and unrelated staged upstream content', () => {
		const upstream = 'source/app/obsolete/oldThing.ts';
		const upstreamBytes = readFileSync(subject.treePath(upstream), 'utf8') + '\n// staged upstream work\n';
		writeFileSync(subject.treePath(upstream), upstreamBytes);
		expect(subject.git(['add', upstream]).status).toBe(0);
		expect(subject.git(['add', 'addons/' + relative]).status).toBe(0);
		const staged = subject.git(['write-tree']).stdout;
		writeFileSync(sourcePath(), changed);
		expect(subject.run(['load']).status).toBe(1);
		expect(subject.git(['write-tree']).stdout).toBe(staged);
		expect(readFileSync(treePath(), 'utf8')).toBe(original);
		expect(readFileSync(subject.treePath(upstream), 'utf8')).toBe(upstreamBytes);
		expect(readFileSync(sourcePath(), 'utf8')).toBe(changed);
	});
	it('applies a source addition through the structured JSON automation interface', () => {
		const added = 'acme-pack/new-translation.json';
		writeFileSync(subject.patchesPath('delta/own-extensions/' + added), changed);
		const { run, envelope } = subject.json(['load']);
		expect(run.status, run.stdout + run.stderr).toBe(0);
		expect(envelope.ok).toBe(true);
		expect(envelope.errors).toEqual([]);
		expect(readFileSync(subject.treePath('addons/' + added), 'utf8')).toBe(changed);
		// A new path has no divergent tree bytes; the conflict warning belongs to
		// a changed existing path, checked separately through the same JSON API.
	});
	it('reports the existing-source edit warning through the structured JSON automation interface', () => {
		writeFileSync(sourcePath(), changed);
		const { run, envelope } = subject.json(['load']);
		expect(run.status, run.stdout + run.stderr).toBe(0);
		expect(envelope.ok).toBe(true);
		expect(envelope.errors).toEqual([]);
		expect(readFileSync(treePath(), 'utf8')).toBe(changed);
		expect(envelope.messages.some((message) => message.code === 'CK-W-PATCHSET-SIDE-EDIT')).toBe(true);
	});
	it('refuses an invalid artifact SHA through the structured JSON automation interface', () => {
		editMark((mark) => {
			const artifacts: unknown = Reflect.get(mark, 'artifacts');
			if (typeof artifacts !== 'object' || artifacts === null) throw new Error('missing fixture artifacts');
			Reflect.set(artifacts, 'delta/own-extensions/' + relative, 'invalid-sha');
		});
		writeFileSync(sourcePath(), changed);
		const { run, envelope } = subject.json(['load']);
		expect(run.status, run.stdout + run.stderr).toBe(1);
		expect(envelope.ok).toBe(false);
		expect(envelope.errors.length).toBeGreaterThan(0);
		expect(readFileSync(treePath(), 'utf8')).toBe(original);
		expect(readFileSync(sourcePath(), 'utf8')).toBe(changed);
	});
});
