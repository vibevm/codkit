/** @scope spec://codkit/modules/codkit/PROP-015#GEN-FEATURE */
// The generators behind `codkit gen feature` and `codkit gen brand`
// (PROP-015 sec. 5).
//
// Two properties are the whole contract. ##GEN-REFUSES-EXISTING: every target
// is classified before the first byte is written, so a run that would overwrite
// somebody's file writes nothing at all. ##GEN-HEADER-IS-THE-PRODUCTS: the
// files are product code, so their header is the product's or there is none -
// codkit's own notice never reaches a product file.

import { join } from 'node:path';
import { statIfPresent } from './containedPath.ts';
import { readContainedFile, writeContainedFileAtomic } from './containedFile.ts';
import { ckError } from './messages.ts';
import {
	brandHookText,
	brandModule,
	brandReminders,
	commonModule,
	contributionModule,
	headerStyleName,
	productHeader,
	settingId,
	testModule
} from './genTemplates.ts';
import type { FeatureTemplateOptions, HeaderStyleName, ProductHeader } from './genTemplates.ts';

/** ##RT-DESCRIPTOR: two or more dot-separated camelCase segments. */
export const FEATURE_ID_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/u;

/** Where the brand table goes, relative to the patch set. */
export const BRAND_FILE_PATH = 'delta/own/common/brand.ts';

/** One file a generator would create. */
export type GeneratedFile = { readonly path: string; readonly text: string };

export type GenOptions = {
	readonly patchesDir: string;
	/** The product's header, or null when no header flag was given. */
	readonly header: ProductHeader | null;
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

/** The three files a feature skeleton consists of, already rendered. */
export function planFeature(options: FeatureOptions): GenOutcome {
	const name = featureDirectoryName(options.id);
	const template: FeatureTemplateOptions = {
		id: options.id,
		name,
		title: options.title,
		setting: options.setting,
		cold: options.cold
	};
	const files: GeneratedFile[] = [
		{ path: `delta/own/contrib/${name}/common/${name}.ts`, text: commonModule(template) },
		{ path: `delta/own/contrib/${name}/browser/${name}.contribution.ts`, text: contributionModule(template) },
		{ path: `delta/own/contrib/${name}/test/browser/${name}.test.ts`, text: testModule(template) }
	];
	return withHeader(files, options.header);
}

/** ##GEN-BRAND: the rules table; the graft into `nls.ts` is printed, not written. */
export function planBrand(options: GenOptions): GenOutcome {
	return withHeader([{ path: BRAND_FILE_PATH, text: brandModule() }], options.header);
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

/** ##GEN-FEATURE: the line the product's composition root gains. */
export function featureImportLine(name: string): string {
	return `import '../contrib/${name}/browser/${name}.contribution.js';`;
}

/**
 * ##GEN-TEST-LIVES-WITH-THE-FEATURE: own code needs a unit, and the generator
 * does not write one. The test lives inside the feature, so one unit covers
 * the whole skeleton and the reminder names exactly that one.
 */
export function unitReminder(name: string): string {
	return `declare a unit for delta/own/contrib/${name} in delta/own/patchset.delta.json, or verify reports CK-E-OWN-UNCOVERED`;
}

export { brandHookText, brandReminders, settingId };
