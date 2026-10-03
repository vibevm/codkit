#!/usr/bin/env node
// Public format coverage and compatibility metadata (PROP-017).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScanner, ScriptTarget, SyntaxKind } from 'typescript/unstable/ast';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CATALOG = 'vibevm/vibespecs/modules/codkit/public-formats.json';

function sources(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		return entry.isDirectory() ? sources(path) : /\.(ts|mjs)$/.test(entry.name) ? [path] : [];
	});
}

function tokens(text) {
	const scanner = createScanner(ScriptTarget.Latest, true);
	scanner.setText(text);
	const result = [];
	const templates = [];
	while (scanner.getTokenEnd() < text.length) {
		const before = scanner.getTokenEnd();
		let kind = scanner.scan();
		const previous = result.at(-1)?.kind;
		if (
			kind === SyntaxKind.SlashToken &&
			![
				SyntaxKind.Identifier,
				SyntaxKind.NumericLiteral,
				SyntaxKind.CloseParenToken,
				SyntaxKind.CloseBracketToken,
				SyntaxKind.PlusPlusToken,
				SyntaxKind.MinusMinusToken
			].includes(previous)
		)
			kind = scanner.reScanSlashToken();
		if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === 0) {
			kind = scanner.reScanTemplateToken(false);
			if (kind === SyntaxKind.TemplateTail) templates.pop();
		} else if (kind === SyntaxKind.TemplateHead) templates.push(0);
		else if (templates.length && kind === SyntaxKind.OpenBraceToken) templates[templates.length - 1]++;
		else if (templates.length && kind === SyntaxKind.CloseBraceToken) templates[templates.length - 1]--;
		if (kind === SyntaxKind.EndOfFile) break;
		if (scanner.getTokenEnd() <= before) throw new Error(`scanner made no progress at source offset ${before}`);
		result.push({
			kind,
			text:
				kind === SyntaxKind.Identifier || kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NumericLiteral
					? scanner.getTokenValue()
					: scanner.getTokenText()
		});
	}
	return result;
}

function constants(code) {
	const result = new Map();
	for (let i = 0; i < code.length - 3; i++)
		if (
			code[i].kind === SyntaxKind.ConstKeyword &&
			code[i + 2].kind === SyntaxKind.EqualsToken &&
			[SyntaxKind.NumericLiteral, SyntaxKind.StringLiteral].includes(code[i + 3].kind)
		)
			result.set(code[i + 1].text, code[i + 3].kind === SyntaxKind.NumericLiteral ? Number(code[i + 3].text) : code[i + 3].text);
	return result;
}

// Inspect declarations, validators and writers without importing product code.
export function discoverFormats(root = ROOT) {
	const paths = readdirSync(join(root, 'packages'), { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, 'packages', entry.name, 'src')))
		.flatMap((entry) => sources(join(root, 'packages', entry.name, 'src')));
	paths.push(
		...sources(join(root, 'tools')).filter((path) => !path.includes(`${join('tools', 'test')}`) && path !== fileURLToPath(import.meta.url))
	);
	const all = paths.sort().map((path) => {
		const code = tokens(readFileSync(path, 'utf8'));
		return { path, code, values: constants(code) };
	});
	const global = new Map();
	for (const { values } of all)
		for (const [name, value] of values) {
			const versions = global.get(name) ?? new Set();
			versions.add(value);
			global.set(name, versions);
		}
	const found = new Map();
	for (const { path, code, values } of all) {
		for (let i = 0; i < code.length - 2; i++) {
			const name = code[i].text;
			if (
				(code[i].kind === SyntaxKind.Identifier || code[i].kind === SyntaxKind.StringLiteral) &&
				/^codkit[A-Z]/.test(name) &&
				code[i + 1].kind === SyntaxKind.ColonToken
			) {
				let expression = code[i + 2];
				if (expression.text === 'z' && code[i + 3]?.text === '.' && code[i + 4]?.text === 'literal' && code[i + 5]?.text === '(')
					expression = code[i + 6];
				const shared = global.get(expression?.text);
				const version =
					expression?.kind === SyntaxKind.NumericLiteral
						? Number(expression.text)
						: (values.get(expression?.text) ?? (shared?.size === 1 ? [...shared][0] : null));
				const row = found.get(name) ?? { field: name, versions: new Set(), sources: new Set() };
				if (typeof version === 'number') row.versions.add(version);
				// Bounded supported form: z.union([z.literal(N), z.literal(M)]).
				// Do not look past this array or execute a validator expression.
				if (code[i + 2]?.text === 'z' && code[i + 4]?.text === 'union' && code[i + 6]?.text === '[') {
					for (let j = i + 7; j < code.length && code[j].text !== ']'; j++) {
						if (code[j].text !== 'z' || code[j + 1]?.text !== '.' || code[j + 2]?.text !== 'literal' || code[j + 3]?.text !== '(') continue;
						const argument = code[j + 4];
						if (code[j + 5]?.text !== ')') continue;
						const sharedValue = global.get(argument?.text);
						const value =
							argument?.kind === SyntaxKind.NumericLiteral
								? Number(argument.text)
								: (values.get(argument?.text) ?? (sharedValue?.size === 1 ? [...sharedValue][0] : null));
						if (typeof value === 'number') row.versions.add(value);
					}
				}
				row.sources.add(relative(root, path).replaceAll('\\', '/'));
				found.set(name, row);
			}
		}
	}
	return [...found.values()]
		.map((row) => ({ field: row.field, versions: [...row.versions].sort((a, b) => a - b), sources: [...row.sources].sort() }))
		.sort((a, b) => a.field.localeCompare(b.field, 'en'));
}

export function checkCatalog(catalog, discovered, root = ROOT) {
	const problems = [];
	if (!catalog || catalog.codkitPublicFormats !== 1 || !Array.isArray(catalog.formats))
		return ['invalid public format catalog: expected codkitPublicFormats:1 and formats array'];
	const ids = new Set();
	const fields = new Map();
	for (const row of catalog.formats) {
		if (!row || typeof row !== 'object') {
			problems.push('invalid format entry');
			continue;
		}
		if (typeof row.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(row.id) || ids.has(row.id))
			problems.push(`invalid or duplicate format id: ${row.id}`);
		ids.add(row.id);
		for (const key of ['owner', 'trustBoundary', 'compatibility', 'migration', 'fingerprint', 'contract'])
			if (typeof row[key] !== 'string' || row[key].trim() === '') problems.push(`${row.id}: missing ${key}`);
		if (!knownContract(root, row.contract)) problems.push(`${row.id}: contract does not resolve: ${row.contract}`);
		if (!Array.isArray(row.tests) || row.tests.length === 0) problems.push(`${row.id}: missing conformance tests`);
		else for (const path of row.tests) if (!safeFile(root, path)) problems.push(`${row.id}: missing or unsafe conformance test ${path}`);
		if (!safeFile(root, row.source)) problems.push(`${row.id}: missing or unsafe source ${row.source}`);
		if (row.externalVersion !== undefined) {
			if (row.version !== null || typeof row.externalVersion !== 'string' || !row.externalVersion.trim() || typeof row.externalVersionSymbol !== 'string' || !row.externalVersionSymbol)
				problems.push(`${row.id}: external version needs a nonempty string and source symbol, with no numeric Codkit version`);
			if (safeFile(root, row.source)) {
				const value = constants(tokens(readFileSync(join(root, row.source), 'utf8'))).get(row.externalVersionSymbol);
				if (value !== row.externalVersion) problems.push(`${row.id}: external version drift: ${String(value)} differs from ${row.externalVersion}`);
			}
		} else if (row.version === null) {
			if (typeof row.versionGap !== 'string' || !row.versionGap.trim())
				problems.push(`${row.id}: unversioned format needs an explicit versionGap`);
		} else if (!Number.isInteger(row.version) || row.version < 1) problems.push(`${row.id}: missing schema version`);
		if (row.field !== undefined) {
			if (typeof row.field !== 'string' || fields.has(row.field))
				problems.push(`${row.id}: invalid or duplicate version field ${row.field}`);
			fields.set(row.field, row);
			if (!Array.isArray(row.observedVersions) || row.observedVersions.some((value) => !Number.isInteger(value) || value < 1))
				problems.push(`${row.id}: missing observedVersions`);
		}
		if (row.versionSymbol !== undefined && safeFile(root, row.source)) {
			const text = readFileSync(join(root, row.source), 'utf8');
			const value = constants(tokens(text)).get(row.versionSymbol) ?? null;
			if (value !== row.version) problems.push(`${row.id}: ${row.versionSymbol} is ${value}, catalog says ${row.version}`);
		}
	}
	const seen = new Set();
	for (const found of discovered) {
		seen.add(found.field);
		const row = fields.get(found.field);
		if (!row) {
			problems.push(`${found.field}: public format has no version/migration policy (${found.sources.join(', ')})`);
			continue;
		}
		if (JSON.stringify(row.observedVersions) !== JSON.stringify(found.versions))
			problems.push(
				`${row.id}: observed versions ${JSON.stringify(found.versions)} differ from catalog ${JSON.stringify(row.observedVersions)}`
			);
		if (row.version !== null && found.versions.length > 0 && !found.versions.includes(row.version))
			problems.push(`${row.id}: current schema version is absent from sources`);
	}
	for (const [field, row] of fields)
		if (!seen.has(field) && row.versionSymbol === undefined) problems.push(`${row.id}: version field ${field} disappeared from sources`);
	return problems;
}

function safeFile(root, path) {
	return (
		typeof path === 'string' &&
		path !== '' &&
		!path.includes('\\') &&
		!path.split('/').some((part) => part === '..' || part === '') &&
		!/^[A-Za-z]:|^\//.test(path) &&
		existsSync(join(root, path)) &&
		statSync(join(root, path)).isFile()
	);
}

function knownContract(root, uri) {
	if (typeof uri !== 'string') return false;
	const match = /^spec:\/\/codkit\/(common|modules\/[a-z]+)\/(PROP-\d+)#([a-zA-Z0-9-]+)$/.exec(uri);
	if (!match) return false;
	const directory = join(root, 'vibevm', 'vibespecs', match[1]);
	if (!existsSync(directory)) return false;
	const names = readdirSync(directory).filter((name) => name.startsWith(`${match[2]}-`) && name.endsWith('.xml'));
	if (names.length !== 1) return false;
	const text = readFileSync(join(directory, names[0]), 'utf8');
	return match[3] === 'root' ? /<title\s+id="root"/.test(text) : new RegExp(`<${match[3]}(?:\\s|>)`).test(text);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		if (process.argv.length > 2) throw new Error('usage: node tools/check-public-formats.mjs');
		const catalog = JSON.parse(readFileSync(join(ROOT, CATALOG), 'utf8'));
		const problems = checkCatalog(catalog, discoverFormats());
		if (problems.length) {
			process.stderr.write(`${problems.join('\n')}\n`);
			process.exitCode = 1;
		} else {
			for (const row of catalog.formats)
				process.stdout.write(`${row.id}\t${row.externalVersion ?? (row.version === null ? 'unversioned (tracked gap)' : `v${row.version}`)}\t${row.source}\n`);
			process.stdout.write(
				`public formats: ${catalog.formats.length} covered; ${catalog.formats.filter((row) => row.version === null && row.externalVersion === undefined).length} explicit version gaps\n`
			);
		}
	} catch (error) {
		process.stderr.write(`public formats: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
