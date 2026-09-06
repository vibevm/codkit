// PROP-014 ##LIC-ANNOTATE and ##LIC-COMMENT-STYLES, FEAT-002 ##S39: the carrier
// a file gets, where it goes, and the idempotence that keeps `git diff` empty.
// ##LIC-NOTICES-FILE and ##S40: the notices body generated from the registry.

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { annotateFile, commentStyleOf, needsSidecar, preludeLength, wrapNotice } from '../../src/lib/licenseAnnotate.ts';
import { renderThirdPartyNotices } from '../../src/lib/licenseNotices.ts';
import { noticeLines } from '../../src/lib/licenseTexts.ts';
import { readReuseRegistry } from '../../src/lib/reuseRegistry.ts';
import { FIXTURE_NOTICES, makeLicensePackage } from '../fixtures/makeLicensePackage.ts';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

afterAll(cleanupTempRoots);

const NOTICE = noticeLines('2026', 'Oleg Chirukhin');

describe('comment styles', () => {
	it('maps an extension, a bare name and a dotfile to its style', () => {
		expect(commentStyleOf('a/b.toml')).toBe('hash');
		expect(commentStyleOf('a/b.ts')).toBe('slash');
		expect(commentStyleOf('a/b.md')).toBe('xml');
		expect(commentStyleOf('a/b.css')).toBe('block');
		expect(commentStyleOf('a/b.sql')).toBe('dash');
		expect(commentStyleOf('Dockerfile')).toBe('hash');
		expect(commentStyleOf('.gitignore')).toBe('hash');
	});

	it('has no style for a format that cannot carry a comment', () => {
		expect(commentStyleOf('a/b.json')).toBeNull();
		expect(commentStyleOf('a/b.png')).toBeNull();
		expect(commentStyleOf('LICENSE')).toBeNull();
	});

	it('wraps the notice in the markers of each style', () => {
		expect(wrapNotice('hash', ['x'])).toBe('# x\n');
		expect(wrapNotice('slash', ['x'])).toBe('// x\n');
		expect(wrapNotice('xml', ['x'])).toBe('<!--\nx\n-->\n');
		expect(wrapNotice('block', ['x'])).toBe('/*\n * x\n */\n');
		expect(wrapNotice('rem', ['x'])).toBe('REM x\n');
	});
});

describe('the prelude a header must follow', () => {
	it('counts a shebang, an XML declaration, an encoding line and a doctype', () => {
		expect(preludeLength('code\n')).toBe(0);
		expect(preludeLength('#!/bin/sh\ncode\n')).toBe(1);
		expect(preludeLength('<?xml version="1.0"?>\n<spec/>\n')).toBe(1);
		expect(preludeLength('#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\ncode\n')).toBe(2);
		expect(preludeLength('<!DOCTYPE html>\n<html>\n')).toBe(1);
	});

	it('counts a YAML front matter block as one prelude', () => {
		expect(preludeLength('---\ntitle: x\n---\ntext\n')).toBe(3);
	});
});

describe('annotateFile', () => {
	function fixture(label: string): string {
		return makeLicensePackage(makeTempRoot(`ann-${label}`));
	}

	it('writes a sidecar for a format with no comments', () => {
		const root = fixture('json');
		writeFileSync(join(root, 'data.json'), '{"a":1}\n', 'utf8');
		const result = annotateFile({ dir: root, relative: 'data.json', notice: NOTICE, alreadyCarried: false, dryRun: false });

		expect(result).toEqual({ path: 'data.json.license', action: 'sidecar' });
		expect(readFileSync(join(root, 'data.json.license'), 'utf8')).toBe(`${NOTICE.join('\n')}\n`);
		// The file itself is untouched: a JSON parser would have dropped a header.
		expect(readFileSync(join(root, 'data.json'), 'utf8')).toBe('{"a":1}\n');
	});

	it('inserts a header after the prelude of an XML file', () => {
		const root = fixture('xml');
		writeFileSync(join(root, 'doc.xml'), '<?xml version="1.0"?>\n<spec/>\n', 'utf8');
		const result = annotateFile({ dir: root, relative: 'doc.xml', notice: NOTICE, alreadyCarried: false, dryRun: false });
		const lines = readFileSync(join(root, 'doc.xml'), 'utf8').split('\n');

		expect(result.action).toBe('header');
		expect(lines[0]).toBe('<?xml version="1.0"?>');
		expect(lines[1]).toBe('<!--');
		expect(lines[6]).toBe('-->');
		expect(lines[7]).toBe('<spec/>');
	});

	it('keeps a shebang first', () => {
		const root = fixture('sh');
		writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho hi\n', 'utf8');
		annotateFile({ dir: root, relative: 'run.sh', notice: NOTICE, alreadyCarried: false, dryRun: false });
		const lines = readFileSync(join(root, 'run.sh'), 'utf8').split('\n');

		expect(lines[0]).toBe('#!/bin/sh');
		expect(lines[1]).toBe(`# ${NOTICE[0]}`);
	});

	it('leaves a file that already has a carrier alone', () => {
		const root = fixture('idempotent');
		const before = readFileSync(join(root, 'README.md'), 'utf8');
		const result = annotateFile({ dir: root, relative: 'README.md', notice: NOTICE, alreadyCarried: true, dryRun: false });

		expect(result.action).toBe('unchanged');
		expect(readFileSync(join(root, 'README.md'), 'utf8')).toBe(before);
	});

	it('writes nothing under --dry-run', () => {
		const root = fixture('dry');
		writeFileSync(join(root, 'data.json'), '{"a":1}\n', 'utf8');
		const result = annotateFile({ dir: root, relative: 'data.json', notice: NOTICE, alreadyCarried: false, dryRun: true });

		expect(result.action).toBe('sidecar');
		expect(() => readFileSync(join(root, 'data.json.license'))).toThrow();
	});

	it('treats a byte with a NUL as binary whatever its extension says', () => {
		expect(needsSidecar(new Uint8Array([0x61, 0x00, 0x62]), 'a.md')).toBe(true);
		expect(needsSidecar(new TextEncoder().encode('text'), 'a.md')).toBe(false);
		expect(needsSidecar(new TextEncoder().encode('{}'), 'a.json')).toBe(true);
	});
});

describe('renderThirdPartyNotices (S40)', () => {
	it('generates exactly the file the fixture package ships', () => {
		const root = makeLicensePackage(makeTempRoot('notices-gen'), { thirdParty: true });
		const registry = readReuseRegistry(root, true);

		expect(renderThirdPartyNotices(registry, ['Oleg Chirukhin'], NOTICE)).toBe(FIXTURE_NOTICES);
	});

	it('generates nothing when no third-party file is declared', () => {
		const root = makeLicensePackage(makeTempRoot('notices-empty'));
		const registry = readReuseRegistry(root, false);

		expect(renderThirdPartyNotices(registry, ['Oleg Chirukhin'], NOTICE)).toBeNull();
	});
});
