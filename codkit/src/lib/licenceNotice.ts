/** @scope spec://codkit/modules/codkit/PROP-014#STD-NOTICE-COMPONENTS-BLOCK */
// The licence notice as it is written into a product repository (PROP-014 sec. 4a).
//
// ##STD-NOTICE-SCOPE-BY-PATHS: the notice states what is codkit's by path, not
// by naming components in prose; ##STD-NOTICE-COMPONENTS-BLOCK: a managed block
// lists what is actually installed, computed from the repository every time a
// delivering command runs, so the file is true for a product with one
// component as much as for one with three. ##STD-NOTICE-TARGETS: two copies,
// the repository root and `delta/own/codkit/`; ##STD-NOTICE-LEGACY-COPY: the
// edition-2 copy at `delta/own/` is removed once the new one exists.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { removeContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { statIfPresent } from './containedPath.ts';
import { ckError } from './messages.ts';
import { readVersionLiteral } from './runtimePackage.ts';

/** The notice template codkit ships, relative to toolRoot; its components block is empty. */
export const NOTICE_SOURCE = 'codkit/config/LICENSE-CODKIT.md';
export const NOTICE_NAME = 'LICENSE-CODKIT.md';

/** Where the copies go, relative to the product repository. */
export const NOTICE_ROOT_PATH = 'LICENSE-CODKIT.md';
export const NOTICE_OWN_PATH = 'delta/own/codkit/LICENSE-CODKIT.md';
export const NOTICE_TARGET_PATHS = [NOTICE_ROOT_PATH, NOTICE_OWN_PATH] as const;
/** Edition 2 put the own copy here; a delivering command moves it. */
export const NOTICE_LEGACY_PATH = 'delta/own/LICENSE-CODKIT.md';

export const COMPONENTS_BEGIN = '<!-- codkit:begin components -->';
export const COMPONENTS_END = '<!-- codkit:end components -->';

/** The prefix under which packages codkit delivers live in the product. */
export const PACKAGES_PREFIX = 'vibevm/vibepacks/org.vibevm.codkit';
/** The prefix under which the runtime library lives in the product. */
export const RUNTIME_PREFIX = 'delta/own/codkit';

/** The four paths the notice's scope names, for the REUSE annotation. */
export const SCOPE_PATHS = [
	NOTICE_ROOT_PATH,
	`${PACKAGES_PREFIX}/**`,
	'vibevm/vibedeps/org.vibevm.codkit.*/**',
	`${RUNTIME_PREFIX}/**`
] as const;

export type NoticeComponent = {
	readonly name: string;
	readonly version: string;
	/** Relative to the product repository, with a trailing slash. */
	readonly path: string;
};

export type NoticeCopyState = 'absent' | 'identical' | 'stale' | 'drift';
export type NoticeCopy = { readonly path: string; readonly state: NoticeCopyState };

/** ##STD-NOTICE-COMPONENTS-BLOCK: what is installed, by name then version. */
export function discoverComponents(patchesDir: string): readonly NoticeComponent[] {
	const components: NoticeComponent[] = [];
	const packages = join(patchesDir, ...PACKAGES_PREFIX.split('/'));
	if (statIfPresent(packages)?.isDirectory()) {
		for (const entry of readdirSync(packages, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const versions = readdirSync(join(packages, entry.name), { withFileTypes: true });
			for (const version of versions) {
				if (!version.isDirectory() || !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(version.name)) continue;
				components.push({ name: entry.name, version: version.name.slice(1), path: `${PACKAGES_PREFIX}/${entry.name}/${version.name}/` });
			}
		}
	}
	const runtime = join(patchesDir, ...RUNTIME_PREFIX.split('/'));
	if (statIfPresent(join(runtime, 'common', 'version.ts')) !== null) {
		try {
			components.push({ name: 'runtime', version: readVersionLiteral(runtime).version, path: `${RUNTIME_PREFIX}/` });
		} catch {
			// A runtime directory without a readable literal is drift, reported by
			// `runtime check`; the notice simply does not list it.
		}
	}
	return components.sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
}

export function renderComponentsBlock(components: readonly NoticeComponent[]): readonly string[] {
	return components.map((component) => `${component.name}  ${component.version}  ${component.path}`);
}

/** The template with the block between the markers replaced. Throws when the template lacks the markers. */
export function renderNotice(template: string, components: readonly NoticeComponent[]): string {
	const lines = template.split('\n');
	const begin = lines.indexOf(COMPONENTS_BEGIN);
	const end = lines.indexOf(COMPONENTS_END);
	if (begin === -1 || end === -1 || end < begin) {
		throw ckError(
			'INTERNAL',
			'the licence notice template carries no components block',
			'restore the codkit installation from the approved supply',
			NOTICE_SOURCE
		);
	}
	return [...lines.slice(0, begin + 1), ...renderComponentsBlock(components), ...lines.slice(end)].join('\n');
}

/** The text with the block content removed: two copies that differ only there are `stale`, not `drift`. */
function withoutBlock(text: string): string {
	const lines = text.split('\n');
	const begin = lines.indexOf(COMPONENTS_BEGIN);
	const end = lines.indexOf(COMPONENTS_END);
	if (begin === -1 || end === -1 || end < begin) return text;
	return [...lines.slice(0, begin + 1), ...lines.slice(end)].join('\n');
}

/** The shipped template, verbatim. */
export function noticeTemplate(toolRoot: string): string {
	const path = join(toolRoot, ...NOTICE_SOURCE.split('/'));
	try {
		return readFileSync(path, 'utf8');
	} catch (error) {
		throw ckError(
			'INTERNAL',
			`cannot read the shipped licence notice: ${error instanceof Error ? error.message : String(error)}`,
			'restore the codkit installation from the approved supply',
			NOTICE_SOURCE
		);
	}
}

/** The notice as it must read in this product right now. */
export function renderedNotice(toolRoot: string, patchesDir: string): string {
	return renderNotice(noticeTemplate(toolRoot), discoverComponents(patchesDir));
}

export function noticeCopyState(rendered: string, target: string): NoticeCopyState {
	if (statIfPresent(target) === null) return 'absent';
	const existing = readFileSync(target, 'utf8');
	if (existing === rendered) return 'identical';
	return withoutBlock(existing) === withoutBlock(rendered) ? 'stale' : 'drift';
}

export type NoticeSurvey = {
	readonly rendered: string;
	readonly copies: readonly NoticeCopy[];
	/** ##STD-NOTICE-LEGACY-COPY */
	readonly legacy: boolean;
};

export function surveyNotice(toolRoot: string, patchesDir: string): NoticeSurvey {
	const rendered = renderedNotice(toolRoot, patchesDir);
	return {
		rendered,
		copies: NOTICE_TARGET_PATHS.map((path) => ({ path, state: noticeCopyState(rendered, join(patchesDir, ...path.split('/'))) })),
		legacy: statIfPresent(join(patchesDir, ...NOTICE_LEGACY_PATH.split('/'))) !== null
	};
}

export type NoticeWriteOutcome = {
	readonly written: readonly { readonly path: string; readonly action: 'created' | 'updated' }[];
	readonly legacyRemoved: boolean;
};

/**
 * ##STD-LOAD-STEP-WRITE-NOTICE: writes the rendered notice where a copy is
 * absent or stale, leaves an identical copy alone and never touches a drifted
 * one (the caller refused before calling), then removes the legacy copy.
 */
export function writeNoticeCopies(toolRoot: string, patchesDir: string, dryRun: boolean): NoticeWriteOutcome {
	const survey = surveyNotice(toolRoot, patchesDir);
	const written: { path: string; action: 'created' | 'updated' }[] = [];
	for (const copy of survey.copies) {
		if (copy.state === 'identical' || copy.state === 'drift') continue;
		written.push({ path: copy.path, action: copy.state === 'absent' ? 'created' : 'updated' });
		if (dryRun) continue;
		writeContainedFileAtomic(patchesDir, copy.path, { what: copy.path, bytes: Buffer.from(survey.rendered, 'utf8') });
	}
	if (survey.legacy && !dryRun) {
		removeContainedFile(patchesDir, NOTICE_LEGACY_PATH, { what: NOTICE_LEGACY_PATH });
	}
	return { written, legacyRemoved: survey.legacy };
}

/** ##STD-LICENSE-PRINTS-REUSE-ROWS: the annotation a product may add to its own REUSE.toml. */
export function reuseAnnotationRows(holder: string, year: string): string {
	return [
		'[[annotations]]',
		`path = [${SCOPE_PATHS.map((path) => `"${path}"`).join(', ')}]`,
		'precedence = "aggregate"',
		`SPDX-FileCopyrightText = "${year} ${holder}"`,
		'SPDX-License-Identifier = "UPL-1.0"',
		'SPDX-FileComment = "third-party; delivered by Codkit, see LICENSE-CODKIT.md"'
	].join('\n');
}
