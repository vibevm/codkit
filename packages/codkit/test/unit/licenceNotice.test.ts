// PROP-014 ##STD-NOTICE-COMPONENTS-BLOCK, ##STD-NOTICE-TARGETS,
// ##STD-NOTICE-LEGACY-COPY: the notice rendered for a repository, the states of
// its copies and what a delivering command writes.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
	COMPONENTS_BEGIN,
	COMPONENTS_END,
	NOTICE_LEGACY_PATH,
	NOTICE_OWN_PATH,
	NOTICE_ROOT_PATH,
	discoverComponents,
	noticeCopyState,
	noticeTemplate,
	renderNotice,
	reuseAnnotationRows,
	surveyNotice,
	writeNoticeCopies
} from '../../src/lib/licenceNotice.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function product(label: string): string {
	const root = makeTempRoot(`notice-${label}`);
	mkdirSync(root, { recursive: true });
	return root;
}

function installStandards(root: string, version: string): void {
	mkdirSync(join(root, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', `v${version}`), { recursive: true });
}

function installRuntime(root: string, version: string): void {
	mkdirSync(join(root, 'delta', 'own', 'codkit', 'common'), { recursive: true });
	writeFileSync(
		join(root, 'delta', 'own', 'codkit', 'common', 'version.ts'),
		`export const CODKIT_RUNTIME_VERSION = '${version}';\nexport const CODKIT_RUNTIME_VERIFIED_UPSTREAM: readonly string[] = ['1.0.0'];\n`,
		'utf8'
	);
}

describe('the licence notice', () => {
	it('ships as a template with an empty components block that renders to itself', () => {
		const template = noticeTemplate(toolRoot);
		const lines = template.split('\n');
		expect(lines.indexOf(COMPONENTS_END)).toBe(lines.indexOf(COMPONENTS_BEGIN) + 1);
		expect(renderNotice(template, [])).toBe(template);
		expect(template).toContain('vibevm/vibepacks/org.vibevm.codkit/**');
		expect(template).toContain('delta/own/codkit/**');
		expect(template).toContain('vibevm/vibedeps/org.vibevm.codkit.*/**');
		expect(template).toContain('generated configuration, not licensed material');
		expect(template).toContain('copies and derivative works of the packages');
	});

	it('discovers every installed package version and the runtime, sorted by name', () => {
		const root = product('discover');
		installStandards(root, '1.0.0');
		installStandards(root, '0.1.0');
		installRuntime(root, '0.1.0');
		mkdirSync(join(root, 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'standards', 'notes'), { recursive: true });

		expect(discoverComponents(root)).toEqual([
			{ name: 'runtime', version: '0.1.0', path: 'delta/own/codkit/' },
			{ name: 'standards', version: '0.1.0', path: 'vibevm/vibepacks/org.vibevm.codkit/standards/v0.1.0/' },
			{ name: 'standards', version: '1.0.0', path: 'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/' }
		]);
	});

	it('renders the block as one line per component, between the markers', () => {
		const rendered = renderNotice(noticeTemplate(toolRoot), [
			{ name: 'standards', version: '1.0.0', path: 'vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/' }
		]);
		const lines = rendered.split('\n');
		const begin = lines.indexOf(COMPONENTS_BEGIN);
		expect(lines[begin + 1]).toBe('standards  1.0.0  vibevm/vibepacks/org.vibevm.codkit/standards/v1.0.0/');
		expect(lines[begin + 2]).toBe(COMPONENTS_END);
	});

	it('refuses a template without the block', () => {
		expect(() => renderNotice('no markers here\n', [])).toThrow(/components block/u);
	});

	it('tells an identical copy from a stale one and from a drifted one', () => {
		const root = product('states');
		installStandards(root, '0.1.0');
		const rendered = renderNotice(noticeTemplate(toolRoot), discoverComponents(root));
		const target = join(root, 'LICENSE-CODKIT.md');
		expect(noticeCopyState(rendered, target)).toBe('absent');
		writeFileSync(target, rendered, 'utf8');
		expect(noticeCopyState(rendered, target)).toBe('identical');
		writeFileSync(target, renderNotice(noticeTemplate(toolRoot), []), 'utf8');
		expect(noticeCopyState(rendered, target)).toBe('stale');
		writeFileSync(target, rendered.replace('Codkit', 'Somebody'), 'utf8');
		expect(noticeCopyState(rendered, target)).toBe('drift');
	});

	it('writes both copies, updates a stale one, leaves an identical one and moves the legacy copy', () => {
		const root = product('write');
		installStandards(root, '0.1.0');
		mkdirSync(join(root, 'delta', 'own'), { recursive: true });
		writeFileSync(join(root, NOTICE_LEGACY_PATH), 'old copy\n', 'utf8');

		const first = writeNoticeCopies(toolRoot, root, false);
		expect(first.written).toEqual([
			{ path: NOTICE_ROOT_PATH, action: 'created' },
			{ path: NOTICE_OWN_PATH, action: 'created' }
		]);
		expect(first.legacyRemoved).toBe(true);
		const rendered = renderNotice(noticeTemplate(toolRoot), discoverComponents(root));
		expect(readFileSync(join(root, NOTICE_ROOT_PATH), 'utf8')).toBe(rendered);
		expect(readFileSync(join(root, NOTICE_OWN_PATH), 'utf8')).toBe(rendered);
		expect(surveyNotice(toolRoot, root).legacy).toBe(false);

		// A new component arrives: the copies are stale and get updated, nothing else changes.
		installRuntime(root, '0.1.0');
		expect(surveyNotice(toolRoot, root).copies.map((copy) => copy.state)).toEqual(['stale', 'stale']);
		const second = writeNoticeCopies(toolRoot, root, false);
		expect(second.written.map((entry) => entry.action)).toEqual(['updated', 'updated']);
		expect(readFileSync(join(root, NOTICE_ROOT_PATH), 'utf8')).toContain('runtime  0.1.0  delta/own/codkit/');

		const third = writeNoticeCopies(toolRoot, root, false);
		expect(third.written).toEqual([]);
	});

	it('writes nothing on a dry run but reports what it would do', () => {
		const root = product('dry');
		installStandards(root, '0.1.0');
		const outcome = writeNoticeCopies(toolRoot, root, true);
		expect(outcome.written.map((entry) => entry.action)).toEqual(['created', 'created']);
		expect(surveyNotice(toolRoot, root).copies.map((copy) => copy.state)).toEqual(['absent', 'absent']);
	});

	it('prints a REUSE annotation naming the four scope paths', () => {
		const rows = reuseAnnotationRows('Acme Holder', '2026');
		expect(rows.split('\n')[0]).toBe('[[annotations]]');
		expect(rows).toContain(
			'"LICENSE-CODKIT.md", "vibevm/vibepacks/org.vibevm.codkit/**", "vibevm/vibedeps/org.vibevm.codkit.*/**", "delta/own/codkit/**"'
		);
		expect(rows).toContain('SPDX-FileCopyrightText = "2026 Acme Holder"');
		expect(rows).toContain('SPDX-License-Identifier = "UPL-1.0"');
		expect(rows).toContain('precedence = "aggregate"');
	});
});
