/** @scope spec://codkit/modules/codkit/PROP-005#OVERLAY-NON-PRODUCT-TARGETS */

import { ckError } from '../messages.ts';
import type { JsonLike } from './overlay.ts';

const ROOT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const PACKAGE_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

type JsonObject = { [key: string]: JsonLike };

function object(value: JsonLike | undefined, label: string): JsonObject {
	if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
		throw ckError('OVERLAY-SCHEMA', `${label} must be an object in an npm v3 lockfile`);
	}
	return value;
}

function dependencyNames(entry: JsonObject, sections: readonly string[], label: string): readonly string[] {
	const names: string[] = [];
	for (const section of sections) {
		const value = entry[section];
		if (value === undefined) continue;
		const dependencies = object(value, `${label}.${section}`);
		for (const [name, range] of Object.entries(dependencies)) {
			if (typeof range !== 'string') {
				throw ckError('OVERLAY-SCHEMA', `${label}.${section}.${name} must be a version string`);
			}
			names.push(name);
		}
	}
	return names;
}

function resolvedPackage(packages: JsonObject, from: string, name: string): string | null {
	let location = from;
	for (;;) {
		const candidate = location === '' ? `node_modules/${name}` : `${location}/node_modules/${name}`;
		if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
		if (location === '') return null;
		const parent = location.lastIndexOf('/node_modules/');
		location = parent < 0 ? '' : location.slice(0, parent);
	}
}

function reachablePackages(packages: JsonObject): ReadonlySet<string> {
	const reached = new Set<string>(['']);
	const pending = [''];
	while (pending.length > 0) {
		const path = pending.pop();
		if (path === undefined) continue;
		const entry = object(packages[path], `packages[${JSON.stringify(path)}]`);
		if (entry['link'] === true) {
			throw ckError('OVERLAY-SCHEMA', `npm-prune does not support linked package ${path}`);
		}
		const sections = path === '' ? ROOT_SECTIONS : PACKAGE_SECTIONS;
		for (const name of dependencyNames(entry, sections, `packages[${JSON.stringify(path)}]`)) {
			const resolved = resolvedPackage(packages, path, name);
			if (resolved !== null && !reached.has(resolved)) {
				reached.add(resolved);
				pending.push(resolved);
			}
		}
	}
	return reached;
}

/** Remove one direct edge and only the package instances it alone kept alive. */
export function pruneNpmDependency(lock: JsonObject, path: readonly string[]): void {
	if (lock['lockfileVersion'] !== 3) {
		throw ckError('OVERLAY-SCHEMA', 'npm-prune supports npm package-lock v3 only');
	}
	const [packagesKey, rootKey, section, name] = path;
	if (
		path.length !== 4 ||
		packagesKey !== 'packages' ||
		rootKey !== '' ||
		section === undefined ||
		name === undefined ||
		!ROOT_SECTIONS.some((candidate) => candidate === section)
	) {
		throw ckError('OVERLAY-SCHEMA', 'npm-prune path must be ["packages", "", "<dependency section>", "<package name>"]');
	}
	const packages = object(lock['packages'], 'packages');
	const root = object(packages[''], 'packages[""]');
	const dependencies = object(root[section], `packages[""].${section}`);
	if (typeof dependencies[name] !== 'string') {
		throw ckError('OVERLAY-SCHEMA', `npm-prune cannot remove absent direct dependency ${section}.${name}`);
	}
	const before = reachablePackages(packages);
	delete dependencies[name];
	const after = reachablePackages(packages);
	for (const packagePath of before) {
		if (packagePath !== '' && !after.has(packagePath)) delete packages[packagePath];
	}
}
