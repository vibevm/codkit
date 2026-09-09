/** @scope spec://codkit/modules/vscode/PROP-005#VSCODE-ADVISORY-READERS */
// The npm directory list of this distribution, read out of `build/npm/dirs.ts`.
//
// It is a TypeScript source, not data, so it is parsed rather than matched: the
// one static `dirs`/`npmDirs`/`npmDirectories` initializer is the answer, and a
// dynamic one is refused instead of half-read. Which file this is, and that it
// means anything at all, is this type's knowledge; the cycle only compares what
// comes back at the two pins.
import { isArrayLiteralExpression, isIdentifier, isNoSubstitutionTemplateLiteral, isObjectLiteralExpression, isPropertyAssignment, isStringLiteral, isVariableStatement } from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { brokenArtifact } from '@codkit/type-api';
const SCAN_ROOT = '/codkit-dependency-advisory';
const SOURCE_PATH = `${SCAN_ROOT}/build/npm/dirs.ts`;
const RELEVANT_NAMES = new Set(['dirs', 'directories', 'npmDirs', 'npmDirectories']);
export function extractNpmDirectories(source) {
    const api = new API({ cwd: SCAN_ROOT, fs: createVirtualFileSystem({ [SOURCE_PATH]: source }) });
    try {
        const snapshot = api.updateSnapshot({ openFiles: [SOURCE_PATH] });
        try {
            const project = snapshot.getDefaultProjectForFile(SOURCE_PATH);
            const sourceFile = project?.program.getSourceFile(SOURCE_PATH);
            if (project === undefined || sourceFile === undefined) {
                throw broken('TypeScript did not return a source file');
            }
            const diagnostics = project.program.getSyntacticDiagnostics(SOURCE_PATH);
            if (diagnostics.length !== 0) {
                throw broken(`TypeScript syntax error: ${diagnostics[0]?.text ?? 'unknown diagnostic'}`);
            }
            return directoriesFromSource(sourceFile);
        }
        finally {
            snapshot.dispose();
        }
    }
    finally {
        api.close();
    }
}
function directoriesFromSource(sourceFile) {
    const bindings = [];
    const propertyBindings = [];
    for (const statement of sourceFile.statements) {
        if (!isVariableStatement(statement))
            continue;
        for (const declaration of statement.declarationList.declarations) {
            const initializer = declaration.initializer;
            if (initializer === undefined)
                continue;
            if (isIdentifier(declaration.name) && RELEVANT_NAMES.has(declaration.name.text)) {
                bindings.push(initializer);
            }
            else if (isObjectLiteralExpression(initializer)) {
                collectRelevantProperties(initializer, propertyBindings);
            }
        }
    }
    const candidates = bindings.length === 0 ? propertyBindings : bindings;
    if (candidates.length !== 1) {
        throw broken(`expected one npm directory initializer, found ${candidates.length}`);
    }
    const initializer = candidates[0];
    if (initializer === undefined)
        throw broken('npm directory initializer disappeared');
    const directories = [];
    collectStaticDirectories(initializer, directories);
    return directories;
}
function collectRelevantProperties(object, output) {
    for (const property of object.properties) {
        if (!isPropertyAssignment(property))
            continue;
        const name = staticPropertyName(property.name);
        if (name !== null && RELEVANT_NAMES.has(name)) {
            output.push(property.initializer);
        }
        else if (isObjectLiteralExpression(property.initializer)) {
            collectRelevantProperties(property.initializer, output);
        }
    }
}
function collectStaticDirectories(expression, output) {
    if (isStringLiteral(expression) || isNoSubstitutionTemplateLiteral(expression)) {
        output.push(expression.text);
        return;
    }
    if (isArrayLiteralExpression(expression)) {
        for (const element of expression.elements)
            collectStaticDirectories(element, output);
        return;
    }
    if (isObjectLiteralExpression(expression)) {
        for (const property of expression.properties) {
            if (!isPropertyAssignment(property))
                throw dynamic(property.getText());
            collectStaticDirectories(property.initializer, output);
        }
        return;
    }
    throw dynamic(expression.getText());
}
function staticPropertyName(name) {
    return isIdentifier(name) || isStringLiteral(name) ? name.text : null;
}
function dynamic(text) {
    return broken(`npm directory initializer is not fully static near ${JSON.stringify(text)}`);
}
function broken(problem) {
    return brokenArtifact(`cannot parse build/npm/dirs.ts: ${problem}`, 'keep one static dirs/npmDirs/npmDirectories initializer in the upstream source');
}
