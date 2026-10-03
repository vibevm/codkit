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

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Capability, ProjectType } from '@codkit/type-api';
import { projectTypeProblems } from '@codkit/type-api';
import { ckError } from '../lib/messages.ts';
import { testSeamEntry, TYPE_PACKAGE_ENV } from './testSeam.ts';
import { readTypeManifest } from './manifest.ts';
import type { RegisteredManifest } from './manifest.ts';

/** Type identifier -> the npm package that implements it (##TYPE-REGISTRY). */
export const TYPE_REGISTRY: ReadonlyMap<string, string> = new Map([
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
export function effectiveRegistry(): ReadonlyMap<string, string> {
	const seam = testSeamEntry(process.env[TYPE_PACKAGE_ENV], process.execArgv);
	return seam === null ? TYPE_REGISTRY : new Map([...TYPE_REGISTRY, seam]);
}

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
	readonly manifestVersion: number | null;
	readonly contractVersion: number | null;
	readonly manifestSha256: string | null;
	readonly source: 'installation' | 'test-seam';
	readonly problem: string | null;
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
	const registry = effectiveRegistry();
	const packageName = registry.get(id);
	if (packageName === undefined) {
		throw ckError(
			'TYPE-UNKNOWN',
			`the project type ${JSON.stringify(id)} is not in the registry of this codkit`,
			`use one of: ${[...registry.keys()].join(', ')}   (run: codkit types)`,
			'codkit.json'
		);
	}
	const registration = readTypeManifest(id, packageName);
	const type = await importProjectType(id, packageName);
	const problems = [...projectTypeProblems(type)];
	for (const [key, actual] of [
		['capabilities', type.capabilities],
		['configurableCapabilities', type.configurableCapabilities ?? new Set<Capability>()]
	] as const) {
		const declared = registration.manifest[key];
		if (declared.length !== actual.size || declared.some((capability) => !actual.has(capability)))
			problems.push(`${key} differs from the declarative manifest`);
	}
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
	for (const [id, packageName] of effectiveRegistry()) {
		let registration: RegisteredManifest | null = null;
		let problem: string | null = null;
		try {
			registration = readTypeManifest(id, packageName);
		} catch (error) {
			problem = error instanceof Error ? error.message : String(error);
		}
		rows.push({
			id,
			package: packageName,
			version: registration?.manifest.version ?? null,
			installed: registration !== null,
			capabilities: [...(registration?.manifest.capabilities ?? [])].sort(),
			configurableCapabilities: [...(registration?.manifest.configurableCapabilities ?? [])].sort(),
			manifestVersion: registration?.manifest.typeManifestVersion ?? null,
			contractVersion: registration?.manifest.contractVersion ?? null,
			manifestSha256: registration?.sha256 ?? null,
			source: isAbsolute(packageName) ? 'test-seam' : 'installation',
			problem
		});
	}
	return rows;
}

async function importProjectType(id: string, packageName: string): Promise<ProjectType> {
	let module: { readonly projectType?: unknown };
	try {
		// An absolute path is the test seam; everything else is a package name.
		const specifier = isAbsolute(packageName) ? pathToFileURL(packageName).href : packageName;
		module = (await import(specifier)) as { readonly projectType?: unknown };
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

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
