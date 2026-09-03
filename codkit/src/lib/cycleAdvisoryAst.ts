/** @scope spec://codkit/modules/codkit/PROP-009#phases */
import {
	isArrayLiteralExpression,
	isIdentifier,
	isNoSubstitutionTemplateLiteral,
	isObjectLiteralExpression,
	isPropertyAssignment,
	isStringLiteral,
	isVariableStatement
} from 'typescript/unstable/ast';
import type { Expression, ObjectLiteralExpression, PropertyName, SourceFile } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { ckError } from './messages.ts';

const SCAN_ROOT = '/codkit-dependency-advisory';
const SOURCE_PATH = `${SCAN_ROOT}/build/npm/dirs.ts`;
const RELEVANT_NAMES: ReadonlySet<string> = new Set(['dirs', 'directories', 'npmDirs', 'npmDirectories']);

export function extractNpmDirectories(source: string, pin: string): readonly string[] {
	const api = new API({ cwd: SCAN_ROOT, fs: createVirtualFileSystem({ [SOURCE_PATH]: source }) });
	try {
		const snapshot = api.updateSnapshot({ openFiles: [SOURCE_PATH] });
		try {
			const project = snapshot.getDefaultProjectForFile(SOURCE_PATH);
			const sourceFile = project?.program.getSourceFile(SOURCE_PATH);
			if (project === undefined || sourceFile === undefined) {
				throw broken(pin, 'TypeScript did not return a source file');
			}
			const diagnostics = project.program.getSyntacticDiagnostics(SOURCE_PATH);
			if (diagnostics.length !== 0) {
				throw broken(pin, `TypeScript syntax error: ${diagnostics[0]?.text ?? 'unknown diagnostic'}`);
			}
			return directoriesFromSource(sourceFile, pin);
		} finally {
			snapshot.dispose();
		}
	} finally {
		api.close();
	}
}

function directoriesFromSource(sourceFile: SourceFile, pin: string): readonly string[] {
	const bindings: Expression[] = [];
	const propertyBindings: Expression[] = [];
	for (const statement of sourceFile.statements) {
		if (!isVariableStatement(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			const initializer = declaration.initializer;
			if (initializer === undefined) continue;
			if (isIdentifier(declaration.name) && RELEVANT_NAMES.has(declaration.name.text)) {
				bindings.push(initializer);
			} else if (isObjectLiteralExpression(initializer)) {
				collectRelevantProperties(initializer, propertyBindings);
			}
		}
	}
	const candidates = bindings.length === 0 ? propertyBindings : bindings;
	if (candidates.length !== 1) {
		throw broken(pin, `expected one npm directory initializer, found ${candidates.length}`);
	}
	const initializer = candidates[0];
	if (initializer === undefined) throw broken(pin, 'npm directory initializer disappeared');
	const directories: string[] = [];
	collectStaticDirectories(initializer, directories, pin);
	return directories;
}

function collectRelevantProperties(object: ObjectLiteralExpression, output: Expression[]): void {
	for (const property of object.properties) {
		if (!isPropertyAssignment(property)) continue;
		const name = staticPropertyName(property.name);
		if (name !== null && RELEVANT_NAMES.has(name)) {
			output.push(property.initializer);
		} else if (isObjectLiteralExpression(property.initializer)) {
			collectRelevantProperties(property.initializer, output);
		}
	}
}

function collectStaticDirectories(expression: Expression, output: string[], pin: string): void {
	if (isStringLiteral(expression) || isNoSubstitutionTemplateLiteral(expression)) {
		output.push(expression.text);
		return;
	}
	if (isArrayLiteralExpression(expression)) {
		for (const element of expression.elements) collectStaticDirectories(element, output, pin);
		return;
	}
	if (isObjectLiteralExpression(expression)) {
		for (const property of expression.properties) {
			if (!isPropertyAssignment(property)) throw dynamic(pin, property.getText());
			collectStaticDirectories(property.initializer, output, pin);
		}
		return;
	}
	throw dynamic(pin, expression.getText());
}

function staticPropertyName(name: PropertyName): string | null {
	return isIdentifier(name) || isStringLiteral(name) ? name.text : null;
}

function dynamic(pin: string, text: string): Error {
	return broken(pin, `npm directory initializer is not fully static near ${JSON.stringify(text)}`);
}

function broken(pin: string, problem: string): Error {
	return ckError(
		'ARTIFACT-BROKEN',
		`cannot parse build/npm/dirs.ts at ${pin}: ${problem}`,
		'keep one static dirs/npmDirs/npmDirectories initializer in the upstream source',
		'build/npm/dirs.ts'
	);
}
