#!/usr/bin/env node
// A type author's standalone contract check; the operator chooses the package.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { projectTypeProblems, validateTypeManifest } from '../dist/index.js';

const packageSchema = z.object({ name: z.string(), version: z.string(), exports: z.object({ '.': z.object({ import: z.string() }) }) });
const adapterSchema = z.object({ id: z.string(), capabilities: z.instanceof(Set) }).passthrough();
const here = dirname(fileURLToPath(import.meta.url));

async function main() {
	if (process.argv.length !== 3) throw new Error('usage: codkit-type-conform <type-package-directory>');
	const root = realpathSync(resolve(process.argv[2]));
	const pkg = packageSchema.parse(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
	const raw = JSON.parse(readFileSync(join(root, 'type-manifest.json'), 'utf8'));
	const apiVersion = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))).version;
	const id = z.object({ id: z.string() }).parse(raw).id;
	const result = validateTypeManifest(raw, { id, package: pkg.name, version: pkg.version, engineVersion: apiVersion });
	if (!result.ok) throw new Error(result.problem.message);
	const adapter = realpathSync(resolve(root, pkg.exports['.'].import));
	const fromRoot = relative(root, adapter);
	if (isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
		throw new Error('adapter export leaves the selected package');
	const module = await import(pathToFileURL(adapter).href);
	const checked = adapterSchema.safeParse(module.projectType);
	if (!checked.success || checked.data.id !== id) throw new Error('adapter does not export the declared project type');
	// The contract checker executes the functional answers, so malformed areas
	// are reported as a conformance failure by the outer boundary too.
	const problems = [...projectTypeProblems(module.projectType)];
	for (const key of ['capabilities', 'configurableCapabilities']) {
		const actual = module.projectType[key] ?? new Set();
		const declared = result.manifest[key];
		if (declared.length !== actual.size || declared.some((name) => !actual.has(name))) problems.push(`${key} differs from manifest`);
	}
	if (problems.length) throw new Error(problems.join('; '));
	process.stdout.write(
		`${pkg.name}@${pkg.version}: manifest ${result.manifest.typeManifestVersion}, contract ${result.manifest.contractVersion}: conformant\n`
	);
}

main().catch((error) => {
	process.stderr.write(`type conformance: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
