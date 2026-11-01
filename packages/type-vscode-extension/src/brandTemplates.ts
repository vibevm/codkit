/** @scope spec://codkit/modules/vscode-extension/PROP-005#VSX-GEN-BRAND */
// The texts `codkit gen brand` produces for this family: the brand table with
// its self-contained transform, the leftover guard, and the hook that is
// printed and never written.
//
// The transform is generated into the own layer rather than delivered as a
// runtime library: it is one pure function, and a library of the type would be
// a package, a managed-copy delivery and a drift check for one file
// (##DECISION-VSX-BRAND-TRANSFORM-SELF-CONTAINED). A rule of the table is
// `{find, replace, locales?, except?}` and the rules apply in order to one
// message (##VSX-BRAND-RULE-SHAPE); the guard proves that nothing of the
// original terms survives in what the product ships outside the licence files
// (##VSX-BRAND-LEFTOVER-GUARD); the hook is the wrap of a translate function,
// a patch of the product at each funnel it has (##VSX-BRAND-HOOK).
//
// None of the texts carries a licence header: the engine adds the product's
// (`spec://codkit/modules/codkit/PROP-015#GEN-HEADER-IS-THE-PRODUCTS`).

/** Where the brand table lives in the patch set; the guard imports it from there. */
export const BRAND_MODULE_PATH = 'delta/own/common/brand.ts';

/** The suite and test words of the product's own-test runner, chosen by `testWordsOf`. */
export type TestWords = { readonly suite: 'suite' | 'describe'; readonly test: 'test' | 'it' };
/** ##VSX-BRAND-LEFTOVER-GUARD: the contract test beside the own tests. */
export const BRAND_GUARD_PATH = 'delta/own/test/brand.leftovers.test.ts';

/** The allow-list of the guard: licence files and third-party notices, by name prefix. */
export const GUARD_ALLOWED_NAME_PREFIXES: readonly string[] = ['LICENSE', 'THIRD_PARTY', 'NOTICE'];
/** The allow-list of the guard: the licences a bundler copies beside the bundle. */
export const GUARD_ALLOWED_DIRECTORIES: readonly string[] = ['dist/licenses'];
/** What the guard scans by content, under the extension root. */
export const GUARD_CONTENT_ROOTS: readonly string[] = ['dist'];
export const GUARD_CONTENT_FILES: readonly string[] = ['package.json', 'README.md', 'CHANGELOG.md'];
/** What the guard scans by content under the content roots, by extension: text a person could read. */
export const GUARD_CONTENT_EXTENSIONS: readonly string[] = [
	'.js',
	'.mjs',
	'.cjs',
	'.json',
	'.html',
	'.css',
	'.md',
	'.txt',
	'.svg',
	'.xml',
	'.yml',
	'.yaml'
];
/** What the guard scans by file name, under the extension root. */
export const GUARD_NAME_ROOTS: readonly string[] = ['assets'];

/**
 * ##VSX-GEN-BRAND: `delta/own/common/brand.ts` - the brand table with one
 * worked example, the self-contained `createBrandTransform(rules)` and the
 * export `brandMessage`.
 */
export function brandModuleText(): string {
	return `${[
		'/**',
		' * The brand table of this product.',
		' *',
		' * Every translated or hard-coded string that passes through a translate',
		' * function of the product reaches `brandMessage` where that function would',
		' * return it, so the English defaults and every locale are branded at render',
		' * time alike, and a new upstream string is branded without a new artifact.',
		' * The strings of the extension manifest pass through no function: they are a',
		' * config-overlay of the manifest and of the locale manifests.',
		' *',
		' * A rule is `{ find, replace, locales?, except? }`. `find` is the original',
		' * term, matched case-sensitively as a whole word or token; `replace` is its',
		' * replacement; `locales`, when present, lists the locale tags the rule applies',
		' * to, and `*` stands for every locale no other rule of the same `find` names -',
		' * so one term carries one replacement for one locale and another for the rest;',
		' * `except`, when present, lists substrings whose presence leaves the message',
		' * untouched - an address, an identifier, a licence line. The rules apply in',
		' * order to one message.',
		' */',
		'export type BrandRule = {',
		'\treadonly find: string;',
		'\treadonly replace: string;',
		'\treadonly locales?: readonly string[];',
		'\treadonly except?: readonly string[];',
		'};',
		'',
		'/** A pure, total transform of one message rendered for one locale; it never throws. */',
		'export type BrandTransform = (message: string, locale: string) => string;',
		'',
		'/**',
		' * The table of this product: a starter list with one worked example - one',
		' * replacement for one locale, another for every other - and an exception that',
		" * keeps the upstream's address intact.",
		' */',
		'export const RULES: readonly BrandRule[] = [',
		"\t{ find: 'Upstream Name', replace: 'Localized Product Name', locales: ['ru'], except: ['https://upstream.example'] },",
		"\t{ find: 'Upstream Name', replace: 'Product Name', locales: ['*'], except: ['https://upstream.example'] }",
		'];',
		'',
		'/** Whether a rule applies to the locale: a rule without locales applies to every one; `*` yields to a rule that names the locale. */',
		'function appliesTo(rule: BrandRule, locale: string, rules: readonly BrandRule[]): boolean {',
		'\tif (rule.locales === undefined || rule.locales.includes(locale)) {',
		'\t\treturn true;',
		'\t}',
		"\tif (!rule.locales.includes('*')) {",
		'\t\treturn false;',
		'\t}',
		'\treturn !rules.some((other) => other !== rule && other.find === rule.find && other.locales !== undefined && other.locales.includes(locale));',
		'}',
		'',
		'/**',
		' * The term as a whole word or token: no Latin letter, digit or underscore',
		' * touches it on either side. The boundary is Latin on purpose: a locale',
		' * written without spaces glues the term to its particles, and those are',
		' * still the term, while `TermKit` is an identifier and is not.',
		' */',
		'function wholeWord(term: string): RegExp {',
		"\tconst escaped = term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
		"\treturn new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gu');",
		'}',
		'',
		'/**',
		' * Builds the transform from the table. A rule whose term is empty or equal to',
		' * its replacement is inert; a message that no rule touches comes back as the',
		' * same string.',
		' */',
		'export function createBrandTransform(rules: readonly BrandRule[]): BrandTransform {',
		"\tconst active = rules.filter((rule) => rule.find !== '' && rule.find !== rule.replace);",
		'\tconst compiled = active.map((rule) => ({ rule, pattern: wholeWord(rule.find) }));',
		'\treturn (message, locale) => {',
		'\t\tlet result = message;',
		'\t\tfor (const { rule, pattern } of compiled) {',
		'\t\t\tif (!appliesTo(rule, locale, active)) {',
		'\t\t\t\tcontinue;',
		'\t\t\t}',
		'\t\t\tif (rule.except !== undefined && rule.except.some((exception) => result.includes(exception))) {',
		'\t\t\t\tcontinue;',
		'\t\t\t}',
		'\t\t\tresult = result.replace(pattern, () => rule.replace);',
		'\t\t}',
		'\t\treturn result;',
		'\t};',
		'}',
		'',
		'export const brandMessage: BrandTransform = createBrandTransform(RULES);'
	].join('\n')}\n`;
}

/**
 * ##VSX-BRAND-LEFTOVER-GUARD: `delta/own/test/brand.leftovers.test.ts` - the
 * contract test over the built bundle, the materialized manifest, the locale
 * manifests, the documents and the asset names, failing on the first
 * occurrence of a `find` term outside the allow-list.
 */
// REVIEW: the guard reads `<extensionRoot>/dist/**` and the files of the
// extension root, and not the newest `.vsix` of the package outputs as a zip:
// the bundle, the manifest and the assets the archive carries are the same
// files, and reading a zip in generated code would need an archive reader the
// product may not have. The specification names the archive as a third source.
export function brandGuardText(extensionRoot: string, words: TestWords): string {
	return `${[
		"import * as assert from 'node:assert';",
		"import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';",
		"import { basename, extname, join, relative } from 'node:path';",
		"import { RULES } from '../common/brand';",
		'',
		'// The leftover guard of the rebrand: nothing of the original terms survives in',
		'// what the product ships, outside the licence files and the third-party',
		'// notices. It reads the built bundle, the materialized manifest, the locale',
		'// manifests, the README and the CHANGELOG by content, and the names of the',
		'// files under the assets directory. It runs from the tree root, after the',
		'// build wrote dist/.',
		'',
		'/** Where the runner runs: the tree root, or the extension root of a product whose runner has to run there. */',
		'const TREE = process.cwd();',
		'/** The extension root, from the tree root. */',
		`const EXTENSION_ROOT = ${JSON.stringify(extensionRoot)};`,
		'/** Directories under the extension root scanned by content. */',
		`const CONTENT_ROOTS = ${JSON.stringify(GUARD_CONTENT_ROOTS)};`,
		'/** The files scanned by content, by extension: text a person could read; fonts, images, archives and source maps are not. */',
		`const CONTENT_EXTENSIONS = ${JSON.stringify(GUARD_CONTENT_EXTENSIONS)};`,
		"/** Bundles are large: the scan is given more than a runner's default. */",
		'const GUARD_TIMEOUT_MS = 120000;',
		'/** Files of the extension root scanned by content; package.nls*.json join them by prefix. */',
		`const CONTENT_FILES = ${JSON.stringify(GUARD_CONTENT_FILES)};`,
		"const LOCALE_MANIFEST_PREFIX = 'package.nls';",
		'/** Directories under the extension root whose file names are scanned. */',
		`const NAME_ROOTS = ${JSON.stringify(GUARD_NAME_ROOTS)};`,
		'/** The allow-list: licence files and third-party notices by name prefix, and the bundled licences. */',
		`const ALLOWED_NAME_PREFIXES = ${JSON.stringify(GUARD_ALLOWED_NAME_PREFIXES)};`,
		`const ALLOWED_DIRECTORIES = ${JSON.stringify(GUARD_ALLOWED_DIRECTORIES)};`,
		'/** The terms of the table, each as the whole word or token the transform matches. */',
		'const TERMS = [...new Set(RULES.map((rule) => rule.find))].map((term) => ({ term, pattern: wholeWord(term) }));',
		'/**',
		' * Readable lines that may keep a term, by a substring each, with the reason',
		' * beside it: an address the product has no replacement for yet, a name the',
		" * licence of a component requires. The list is the product's and starts empty.",
		' */',
		'const ALLOWED_TEXT: readonly string[] = [];',
		'',
		`${words.suite}('brand-leftovers', () => {`,
		`\t${words.test}('no original term survives outside the licence files and the third-party notices', () => {`,
		'\t\tconst extensionRoot = extensionRootOf();',
		"\t\tconst dist = join(extensionRoot, 'dist');",
		'\t\tassert.ok(existsSync(dist), `${relative(TREE, dist)} is absent: build the extension before the guard runs`);',
		'\t\tfor (const file of contentFiles(extensionRoot)) {',
		'\t\t\tfor (const line of readableLines(file)) {',
		'\t\t\t\tif (ALLOWED_TEXT.some((allowed) => line.includes(allowed))) {',
		'\t\t\t\t\tcontinue;',
		'\t\t\t\t}',
		'\t\t\t\tfor (const { term, pattern } of TERMS) {',
		'\t\t\t\t\tassert.ok(!pattern.test(line), `${relative(TREE, file)} still carries ${JSON.stringify(term)} in ${JSON.stringify(line.slice(0, 120))}`);',
		'\t\t\t\t}',
		'\t\t\t}',
		'\t\t}',
		'\t\tfor (const file of namedFiles(extensionRoot)) {',
		'\t\t\tfor (const { term, pattern } of TERMS) {',
		'\t\t\t\tassert.ok(!pattern.test(basename(file)), `${relative(TREE, file)} is named after ${JSON.stringify(term)}`);',
		'\t\t\t}',
		'\t\t}',
		'\t}, GUARD_TIMEOUT_MS);',
		'});',
		'',
		'/** The extension root: under the working directory, or the working directory itself when the runner runs in the extension root. */',
		'function extensionRootOf(): string {',
		"\tconst candidates = [join(TREE, ...EXTENSION_ROOT.split('/').filter((segment) => segment !== '.')), TREE];",
		"\tconst found = candidates.find((directory) => existsSync(join(directory, 'package.json')));",
		"\tassert.ok(found !== undefined, `no extension manifest under ${candidates.join(' or ')}`);",
		'\treturn found;',
		'}',
		'',
		'function contentFiles(extensionRoot: string): string[] {',
		'\tconst files = CONTENT_ROOTS.flatMap((root) => walk(join(extensionRoot, root))).filter((file) => CONTENT_EXTENSIONS.includes(extname(file).toLowerCase()));',
		'\tfor (const name of readdirSync(extensionRoot)) {',
		"\t\tif (CONTENT_FILES.includes(name) || (name.startsWith(LOCALE_MANIFEST_PREFIX) && name.endsWith('.json'))) {",
		'\t\t\tfiles.push(join(extensionRoot, name));',
		'\t\t}',
		'\t}',
		'\treturn files.filter((file) => !allowed(extensionRoot, file));',
		'}',
		'',
		'function namedFiles(extensionRoot: string): string[] {',
		'\treturn NAME_ROOTS.flatMap((root) => walk(join(extensionRoot, root))).filter((file) => !allowed(extensionRoot, file));',
		'}',
		'',
		'function allowed(extensionRoot: string, file: string): boolean {',
		"\tconst path = relative(extensionRoot, file).split('\\\\').join('/');",
		'\tconst name = basename(file).toUpperCase();',
		'\treturn ALLOWED_NAME_PREFIXES.some((prefix) => name.startsWith(prefix)) || ALLOWED_DIRECTORIES.some((directory) => path.startsWith(`${directory}/`));',
		'}',
		'',
		'function walk(directory: string): string[] {',
		'\tif (!existsSync(directory)) {',
		'\t\treturn [];',
		'\t}',
		'\treturn readdirSync(directory).flatMap((name) => {',
		'\t\tconst path = join(directory, name);',
		'\t\treturn statSync(path).isDirectory() ? walk(path) : [path];',
		'\t});',
		'}',
		'',
		'/** The term as the transform matches it: no Latin letter, digit or underscore on either side. */',
		'function wholeWord(term: string): RegExp {',
		"\tconst escaped = term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');",
		"\treturn new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'u');",
		'}',
		'',
		"/** What a person can read in a file, one line each: a script's string and template literals, every other file whole. */",
		'function readableLines(file: string): readonly string[] {',
		"\tconst text = readFileSync(file, 'utf8');",
		"\treturn (/\\.[cm]?js$/u.test(file) ? readableTextOfScript(text) : text).split('\\n');",
		'}',
		'',
		'/** What a person can read in a script: the contents of its string and template literals, joined by newlines; code, identifiers, regular expressions and comments are not. */',
		'function readableTextOfScript(text: string): string {',
		'\tconst found: string[] = [];',
		'\tconst length = text.length;',
		'\tlet index = 0;',
		'\t/** The last character of code before `index` that is not whitespace, to tell a regular expression from a division. */',
		"\tlet previous = '';",
		"\tconst regexMayStart = (): boolean => previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous);",
		'\tconst readString = (quote: string): void => {',
		'\t\tindex += 1;',
		'\t\tconst start = index;',
		'\t\twhile (index < length && text[index] !== quote) {',
		"\t\t\tif (text[index] === '\\\\') {",
		'\t\t\t\tindex += 1;',
		'\t\t\t}',
		'\t\t\tindex += 1;',
		'\t\t}',
		'\t\tfound.push(text.slice(start, index));',
		'\t\tindex += 1;',
		'\t\tprevious = quote;',
		'\t};',
		'\tconst readTemplate = (): void => {',
		'\t\tindex += 1;',
		'\t\tlet start = index;',
		"\t\twhile (index < length && text[index] !== '`') {",
		"\t\t\tif (text[index] === '\\\\') {",
		'\t\t\t\tindex += 2;',
		"\t\t\t} else if (text[index] === '$' && text[index + 1] === '{') {",
		'\t\t\t\tfound.push(text.slice(start, index));',
		'\t\t\t\tindex += 2;',
		"\t\t\t\treadCode('}');",
		'\t\t\t\tstart = index;',
		'\t\t\t} else {',
		'\t\t\t\tindex += 1;',
		'\t\t\t}',
		'\t\t}',
		'\t\tfound.push(text.slice(start, index));',
		'\t\tindex += 1;',
		"\t\tprevious = '`';",
		'\t};',
		'\tconst readRegex = (): void => {',
		'\t\tindex += 1;',
		'\t\tlet inClass = false;',
		"\t\twhile (index < length && (inClass || text[index] !== '/') && text[index] !== '\\n') {",
		"\t\t\tif (text[index] === '\\\\') {",
		'\t\t\t\tindex += 1;',
		"\t\t\t} else if (text[index] === '[') {",
		'\t\t\t\tinClass = true;',
		"\t\t\t} else if (text[index] === ']') {",
		'\t\t\t\tinClass = false;',
		'\t\t\t}',
		'\t\t\tindex += 1;',
		'\t\t}',
		'\t\tindex += 1;',
		"\t\tprevious = '/';",
		'\t};',
		'\t/** A comment or a regular expression at `index`, skipped; false when there is none. */',
		'\tconst skipUnreadable = (char: string, next: string): boolean => {',
		"\t\tif (char === '/' && next === '/') {",
		"\t\t\tconst end = text.indexOf('\\n', index);",
		'\t\t\tindex = end === -1 ? length : end;',
		'\t\t\treturn true;',
		'\t\t}',
		"\t\tif (char === '/' && next === '*') {",
		"\t\t\tconst close = text.indexOf('*/', index + 2);",
		'\t\t\tindex = close === -1 ? length : close + 2;',
		'\t\t\treturn true;',
		'\t\t}',
		"\t\tif (char === '/' && regexMayStart()) {",
		'\t\t\treadRegex();',
		'\t\t\treturn true;',
		'\t\t}',
		'\t\treturn false;',
		'\t};',
		'\t/** A literal at `index`, read into `found`; false when there is none. */',
		'\tconst readLiteral = (char: string): boolean => {',
		'\t\tif (char === \'"\' || char === "\'") {',
		'\t\t\treadString(char);',
		'\t\t\treturn true;',
		'\t\t}',
		"\t\tif (char === '`') {",
		'\t\t\treadTemplate();',
		'\t\t\treturn true;',
		'\t\t}',
		'\t\treturn false;',
		'\t};',
		'\t/** Code until the closing brace that ends a template expression, or the end of the text when none is given. */',
		'\tconst readCode = (until: string | null): void => {',
		'\t\tlet depth = 0;',
		'\t\twhile (index < length) {',
		"\t\t\tconst char = text[index] ?? '';",
		"\t\t\tif (readLiteral(char) || skipUnreadable(char, text[index + 1] ?? '')) {",
		'\t\t\t\tcontinue;',
		'\t\t\t}',
		'\t\t\tif (until !== null && char === until && depth === 0) {',
		'\t\t\t\tindex += 1;',
		'\t\t\t\treturn;',
		'\t\t\t}',
		"\t\t\tif (char === '{') {",
		'\t\t\t\tdepth += 1;',
		"\t\t\t} else if (char === '}') {",
		'\t\t\t\tdepth -= 1;',
		'\t\t\t}',
		'\t\t\tif (!/\\s/u.test(char)) {',
		'\t\t\t\tprevious = char;',
		'\t\t\t}',
		'\t\t\tindex += 1;',
		'\t\t}',
		'\t};',
		'\treadCode(null);',
		"\treturn found.join('\\n');",
		'}'
	].join('\n')}\n`;
}

/**
 * ##VSX-BRAND-HOOK: the wrap of a translate function - printed, never written.
 * Each funnel of the product is upstream code, so the seam is a patch of the
 * product; the type names the shape of the wrap and nothing of any funnel.
 */
export function brandHookText(ownRoot: string): string {
	return `${[
		'// in each translate function of the product - one funnel per surface, and the',
		'// display-name constant - inside a codkit marker block at the top of the module:',
		'// codkit:begin <ID>',
		`import { brandMessage } from '<path from the funnel to ${ownRoot}>/common/brand';`,
		'// codkit:end <ID>',
		'',
		'// and where the function would return its string, inside a second block with the same id:',
		'// codkit:begin <ID>',
		'return brandMessage(result, locale);',
		'// codkit:end <ID>',
		'',
		'// A product whose strings do not all pass a translate function - hard-coded',
		'// literals, JSX text, strings handed to the host API - has its bundler as the',
		'// funnel instead: an own module beside the table reads a source file through',
		'// brandMessage line by line, under the locale the path of a dictionary module',
		'// names and the default locale for every other file, and a patch of the',
		'// bundler script (type modify: its seams exceed the hook budget) makes every',
		'// read of a source go through that module. The table then applies once, at',
		'// build time, and the translate wraps above are not written.'
	].join('\n')}\n`;
}

/** ##VSX-GEN-BRAND: what a person has to know before writing that patch. */
export function brandReminders(manifestPath: string, extensionRoot: string): readonly string[] {
	return [
		'the hook is a patch of the product with `type = hook` in its header, one per funnel - a translate function per surface, and the display-name constant - ' +
			'with at most three lines of code between the markers, one of them naming own code (PROP-005 hook budget)',
		`the strings of the extension manifest pass through no funnel: brand them with the config-overlay of ${manifestPath}, ` +
			'and of the locale manifests the patch set names in typeConfig.localeManifests',
		`declare the leftover guard brand-leftovers (${BRAND_GUARD_PATH}) in the contractTests of the brand unit: it scans ${extensionRoot}/dist/**, the materialized manifest, ` +
			`the locale manifests, README.md, CHANGELOG.md and the file names under ${extensionRoot}/assets/** for every find term of the table, ` +
			`outside ${GUARD_ALLOWED_NAME_PREFIXES.map((prefix) => `${prefix}*`).join(', ')} and ${GUARD_ALLOWED_DIRECTORIES.map((directory) => `${directory}/**`).join(', ')}`,
		'hand brandMessage the locale tag the surface rendered the string for, so that a rule for one locale reaches the strings of that locale and `*` the rest'
	];
}
