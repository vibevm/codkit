/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-REGISTRY */
// The registry of project types the engine will load, and the resolution of a
// patch set's `type` into the `ProjectType` every engine asks.
//
// ##TYPE-REGISTRY: the set of loadable code is fixed by the tool's own release.
// A type is resolved by a dynamic import of a package name from this table, and
// the official types are regular dependencies of the CLI package; nothing is
// ever loaded from a patch set or from a path somebody names, because
// determinism, the air-gapped circuit and the clean room all want it that way.
// Adding a type is publishing its package and adding its name here.
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectTypeProblems } from '@codkit/type-api';
import { ckError } from '../lib/messages.js';
import { testSeamEntry, TYPE_PACKAGE_ENV } from './testSeam.js';
/** Type identifier -> the npm package that implements it (##TYPE-REGISTRY). */
export const TYPE_REGISTRY = new Map([
    ['vscode', '@codkit/type-vscode'],
    ['generic', '@codkit/type-generic'],
    ['theia', '@codkit/type-theia']
]);
/**
 * The table this process resolves against: the shipped one, plus the single
 * type a test build was told to add (##TYPE-TEST-SEAM). A production build gets
 * `TYPE_REGISTRY` itself, so `codkit types` of a real installation never has a
 * row the release does not carry.
 */
export function effectiveRegistry() {
    const seam = testSeamEntry(process.env[TYPE_PACKAGE_ENV], process.execArgv);
    return seam === null ? TYPE_REGISTRY : new Map([...TYPE_REGISTRY, seam]);
}
const loaded = new Map();
/**
 * ##TYPE-UNKNOWN: a `type` the registry does not know, or whose package is not
 * installed, is `CK-E-TYPE-UNKNOWN` naming the identifier and the package the
 * registry expected. No command proceeds without a type.
 */
export async function resolveProjectType(id) {
    const cached = loaded.get(id);
    if (cached !== undefined) {
        return cached;
    }
    const registry = effectiveRegistry();
    const packageName = registry.get(id);
    if (packageName === undefined) {
        throw ckError('TYPE-UNKNOWN', `the project type ${JSON.stringify(id)} is not in the registry of this codkit`, `use one of: ${[...registry.keys()].join(', ')}   (run: codkit types)`, 'codkit.json');
    }
    const type = await importProjectType(id, packageName);
    const problems = projectTypeProblems(type);
    if (problems.length > 0) {
        throw ckError('TYPE-UNKNOWN', `the project type ${id} is installed but does not answer its own contract: ${problems.join('; ')}`, `reinstall ${packageName} at a version built against this codkit`, 'codkit.json');
    }
    loaded.set(id, type);
    return type;
}
/** The rows `codkit types` prints, in registry order (##CMD-TYPES). */
export async function registeredTypes() {
    const rows = [];
    for (const [id, packageName] of effectiveRegistry()) {
        let type = null;
        try {
            type = await resolveProjectType(id);
        }
        catch {
            // An uninstalled or broken package is a row saying so, not a refusal:
            // `codkit types` is the command a person runs to find that out.
            type = null;
        }
        rows.push({
            id,
            package: packageName,
            version: type === null ? null : packageVersion(packageName),
            installed: type !== null,
            capabilities: type === null ? [] : [...type.capabilities].sort(),
            configurableCapabilities: type === null ? [] : [...(type.configurableCapabilities ?? [])].sort()
        });
    }
    return rows;
}
async function importProjectType(id, packageName) {
    let module;
    try {
        // An absolute path is the test seam; everything else is a package name.
        const specifier = isAbsolute(packageName) ? pathToFileURL(packageName).href : packageName;
        module = (await import(__rewriteRelativeImportExtension(specifier)));
    }
    catch (error) {
        throw ckError('TYPE-UNKNOWN', `the project type ${id} is registered as ${packageName}, and that package is not installed: ${messageOf(error)}`, `install ${packageName} next to codkit, or declare a type whose package this installation carries`, 'codkit.json');
    }
    const candidate = module.projectType;
    if (!isProjectType(candidate) || candidate.id !== id) {
        throw ckError('TYPE-UNKNOWN', `${packageName} does not export a project type named ${id}`, `the package must export \`projectType\` with id ${JSON.stringify(id)}; reinstall it at a matching version`, 'codkit.json');
    }
    return candidate;
}
function isProjectType(value) {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const candidate = value;
    return typeof candidate.id === 'string' && candidate.capabilities instanceof Set;
}
/** The installed version of a type package, read from its own manifest. */
function packageVersion(packageName) {
    if (isAbsolute(packageName)) {
        // The test seam names a module, not a package: it has no manifest.
        return null;
    }
    try {
        const manifest = createRequire(import.meta.url)(`${packageName}/package.json`);
        return typeof manifest.version === 'string' ? manifest.version : null;
    }
    catch {
        return null;
    }
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
