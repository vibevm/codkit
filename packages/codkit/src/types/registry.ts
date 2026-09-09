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

import { createRequire } from 'node:module';
import type { Capability, ProjectType } from '@codkit/type-api';
import { projectTypeProblems } from '@codkit/type-api';
import { ckError } from '../lib/messages.ts';

/** Type identifier -> the npm package that implements it (##TYPE-REGISTRY). */
export const TYPE_REGISTRY: ReadonlyMap<string, string> = new Map([
	['vscode', '@codkit/type-vscode'],
	['generic', '@codkit/type-generic'],
	['theia', '@codkit/type-theia']
]);

/** One row of `codkit types` (##CMD-TYPES). */
export type RegisteredType = {
	readonly id: string;
	readonly package: string;
	/** The version of the installed package, or null when it is not installed. */
	readonly version: string | null;
	readonly installed: boolean;
	readonly capabilities: readonly Capability[];
	/**
	 * The abilities this type declares only when a patch set's `typeConfig` asks
	 * for them (##TYPE-CONFIGURED). Empty for a type that answers the same thing
	 * for every patch set.
	 */
	readonly configurableCapabilities: readonly Capability[];
};

const loaded = new Map<string, ProjectType>();

/**
 * ##TYPE-UNKNOWN: a `type` the registry does not know, or whose package is not
 * installed, is `CK-E-TYPE-UNKNOWN` naming the identifier and the package the
 * registry expected. No command proceeds without a type.
 */
export async function resolveProjectType(id: string): Promise<ProjectType> {
	const cached = loaded.get(id);
	if (cached !== undefined) {
		return cached;
	}
	const packageName = TYPE_REGISTRY.get(id);
	if (packageName === undefined) {
		throw ckError(
			'TYPE-UNKNOWN',
			`the project type ${JSON.stringify(id)} is not in the registry of this codkit`,
			`use one of: ${[...TYPE_REGISTRY.keys()].join(', ')}   (run: codkit types)`,
			'codkit.json'
		);
	}
	const type = await importProjectType(id, packageName);
	const problems = projectTypeProblems(type);
	if (problems.length > 0) {
		throw ckError(
			'TYPE-UNKNOWN',
			`the project type ${id} is installed but does not answer its own contract: ${problems.join('; ')}`,
			`reinstall ${packageName} at a version built against this codkit`,
			'codkit.json'
		);
	}
	loaded.set(id, type);
	return type;
}

/** The rows `codkit types` prints, in registry order (##CMD-TYPES). */
export async function registeredTypes(): Promise<readonly RegisteredType[]> {
	const rows: RegisteredType[] = [];
	for (const [id, packageName] of TYPE_REGISTRY) {
		let type: ProjectType | null = null;
		try {
			type = await resolveProjectType(id);
		} catch {
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

async function importProjectType(id: string, packageName: string): Promise<ProjectType> {
	let module: { readonly projectType?: unknown };
	try {
		module = (await import(packageName)) as { readonly projectType?: unknown };
	} catch (error) {
		throw ckError(
			'TYPE-UNKNOWN',
			`the project type ${id} is registered as ${packageName}, and that package is not installed: ${messageOf(error)}`,
			`install ${packageName} next to codkit, or declare a type whose package this installation carries`,
			'codkit.json'
		);
	}
	const candidate = module.projectType;
	if (!isProjectType(candidate) || candidate.id !== id) {
		throw ckError(
			'TYPE-UNKNOWN',
			`${packageName} does not export a project type named ${id}`,
			`the package must export \`projectType\` with id ${JSON.stringify(id)}; reinstall it at a matching version`,
			'codkit.json'
		);
	}
	return candidate;
}

function isProjectType(value: unknown): value is ProjectType {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as { id?: unknown; capabilities?: unknown };
	return typeof candidate.id === 'string' && candidate.capabilities instanceof Set;
}

/** The installed version of a type package, read from its own manifest. */
function packageVersion(packageName: string): string | null {
	try {
		const manifest = createRequire(import.meta.url)(`${packageName}/package.json`) as { readonly version?: unknown };
		return typeof manifest.version === 'string' ? manifest.version : null;
	} catch {
		return null;
	}
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
