/** @scope spec://codkit/modules/vscode/PROP-008#GEN-FEATURE */
// The generators behind `codkit gen feature` and `codkit gen brand`
// (PROP-015 sec. 5).
//
// Two properties are the whole contract. ##GEN-REFUSES-EXISTING: every target
// is classified before the first byte is written, so a run that would overwrite
// somebody's file writes nothing at all. ##GEN-HEADER-IS-THE-PRODUCTS: the
// files are product code, so their header is the product's or there is none -
// codkit's own notice never reaches a product file.

import { join } from 'node:path';
import type { FeatureSkeleton, ProjectType } from '@codkit/type-api';
import { statIfPresent } from './containedPath.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { ckError } from './messages.ts';
import { headerStyleName, productHeader } from './genTemplates.ts';
import type { HeaderStyleName, ProductHeader } from './genTemplates.ts';

/** ##RT-DESCRIPTOR: two or more dot-separated camelCase segments. */
export const FEATURE_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/u;

/** One file a generator would create. */
export type GeneratedFile = { readonly path: string; readonly text: string };

export type GenOptions = {
	readonly patchesDir: string;
	/** The product's header, or null when no header flag was given. */
	readonly header: ProductHeader | null;
	/** The project type of the patch set: the skeletons are its answer. */
	readonly type: ProjectType;
	/** The own root of the patch set, a path from the tree root. */
	readonly ownRoot: string;
};

export type FeatureOptions = GenOptions & {
	readonly id: string;
	readonly title: string;
	readonly setting: boolean;
	readonly cold: boolean;
};

export type GenOutcome = {
	readonly files: readonly GeneratedFile[];
	readonly headerWritten: boolean;
	/** ##CMD-GEN-FEATURE: which form was written, `null` when none was. */
	readonly headerStyle: HeaderStyleName;
};

export type FeatureOutcome = GenOutcome & {
	/** The directory of the feature: one unit of the own manifest covers it. */
	readonly directory: string;
	/** The line the composition root of the product gains by hand. */
	readonly importLine: string;
	/** What is left to do by hand, the engine's line first. */
	readonly reminders: readonly string[];
};

export type BrandOutcome = GenOutcome & {
	/** The graft the product writes as a patch; printed, never written. */
	readonly hookText: string;
	readonly reminders: readonly string[];
};

/** ##GEN-FEATURE: the id decides the directory, so it is validated first. */
export function featureDirectoryName(id: string): string {
	if (!FEATURE_ID_PATTERN.test(id)) {
		throw ckError(
			'GEN-ID',
			`feature id "${id}" is not two or more dot-separated camelCase segments`,
			'use the product prefix and camelCase segments, for example acme.sample',
			id
		);
	}
	return id.split('.').at(-1) ?? id;
}

/** The files of a feature skeleton, as the project type writes them. */
export function planFeature(options: FeatureOptions): FeatureOutcome {
	const name = featureDirectoryName(options.id);
	const skeleton = options.type.generators.featureSkeleton({
		id: options.id,
		name,
		title: options.title,
		setting: options.setting,
		cold: options.cold,
		ownRoot: options.ownRoot
	});
	assertTestLivesWithTheFeature(options.type, skeleton);
	const files: GeneratedFile[] = skeleton.modules.map((module) => ({ path: module.path, text: module.text }));
	return {
		...withHeader(files, options.header),
		directory: skeleton.directory,
		importLine: skeleton.importLine,
		reminders: [unitReminder(skeleton.directory), ...skeleton.reminders]
	};
}

/**
 * ##GEN-TEST-LIVES-WITH-THE-FEATURE: the rule is the engine's, so the engine
 * checks it rather than trusting the answer. A test outside the feature's
 * directory would need a unit of its own, and the reminder the run prints names
 * exactly one.
 */
function assertTestLivesWithTheFeature(type: ProjectType, skeleton: FeatureSkeleton): void {
	const strays = skeleton.modules.filter((module) => module.role === 'test' && !module.path.startsWith(`${skeleton.directory}/`));
	if (strays.length > 0) {
		throw ckError(
			'ARTIFACT-BROKEN',
			`the project type ${type.id} puts the test of a feature outside its directory: ${strays.map((module) => module.path).join(', ')}`,
			`a feature skeleton keeps its test under ${skeleton.directory}/, so one declared unit covers the code and the test`
		);
	}
}

/** ##GEN-BRAND: the rules table and, when the family answers one, the leftover guard; the graft into the funnel is printed, not written. */
export function planBrand(options: GenOptions): BrandOutcome {
	const graft = options.type.generators.brandGraft;
	if (graft === undefined) {
		throw ckError(
			'TYPE-CAPABILITY',
			`the project type ${options.type.id} has no string funnel to graft a brand table into`,
			'the capability gen-brand is what says a family has one'
		);
	}
	const built = graft(options.ownRoot);
	const modules = built.guard === undefined ? [built.module] : [built.module, built.guard];
	return {
		...withHeader(
			modules.map((module) => ({ path: module.path, text: module.text })),
			options.header
		),
		hookText: built.hookText,
		reminders: built.reminders
	};
}

function withHeader(files: readonly GeneratedFile[], header: ProductHeader | null): GenOutcome {
	if (header === null) return { files, headerWritten: false, headerStyle: null };
	const prefix = productHeader(header);
	return {
		files: files.map((file) => ({ path: file.path, text: `${prefix}\n${file.text}` })),
		headerWritten: true,
		headerStyle: headerStyleName(header)
	};
}

/**
 * ##GEN-HEADER-IS-THE-PRODUCTS: the text of `--header-file`, read from inside
 * the patch set and copied byte for byte. The final newline is a requirement,
 * not a courtesy: the generator puts one blank line between the header and the
 * module, and a file that ends mid-line would run the header into the code.
 */
export function readHeaderText(patchesDir: string, relativePath: string): string {
	const read = readContainedFile(patchesDir, relativePath, { what: `header file ${relativePath}` });
	if (read.state === 'absent') {
		throw ckError(
			'CONFIG',
			'the header file is not in the patch set',
			'pass --header-file as a path relative to the patch-set root',
			relativePath
		);
	}
	const text = Buffer.from(read.bytes).toString('utf8');
	if (!text.endsWith('\n')) {
		throw ckError(
			'CONFIG',
			'the header file does not end with a newline',
			'end the header file with a newline; codkit writes it verbatim and adds one blank line after it',
			relativePath
		);
	}
	return text;
}

/**
 * ##GEN-REFUSES-EXISTING: the whole plan is classified before anything is
 * written, so the refusal leaves the patch set exactly as it was.
 */
export function refuseExisting(patchesDir: string, files: readonly GeneratedFile[]): void {
	const existing = files.map((file) => file.path).filter((path) => statIfPresent(join(patchesDir, ...path.split('/'))) !== null);
	if (existing.length === 0) return;
	throw ckError(
		'GEN-EXISTS',
		`the generator would overwrite ${existing.length} existing file(s): ${existing.join(', ')}`,
		'remove or rename the existing file, or generate under another id; nothing was written',
		existing[0]
	);
}

/** Write the plan. The caller has already refused an existing target. */
export function writeGenerated(patchesDir: string, files: readonly GeneratedFile[]): void {
	for (const file of files) {
		writeContainedFileAtomic(patchesDir, file.path, { what: file.path, bytes: Buffer.from(file.text, 'utf8') });
	}
}

/**
 * ##GEN-TEST-LIVES-WITH-THE-FEATURE: own code needs a unit, and the generator
 * does not write one. The test lives inside the feature, so one unit covers
 * the whole skeleton and the reminder names exactly that one.
 */
export function unitReminder(directory: string): string {
	return `declare a unit for ${directory} in delta/own/patchset.delta.json, or verify reports CK-E-OWN-UNCOVERED`;
}
