/** @scope spec://codkit/modules/theia/PROP-003#THEIA-OVERLAY-TARGET */
// Area 3: the layers whose shape this family decides.
//
// Two of the four are absent here, and the absences are the interesting part.
// There is no `entry-module`: own code enters an application by one line in the
// application's `dependencies`, and the generator emits the container load for
// it, so no upstream file is patched to include own code at all
// (##THEIA-OWN-IS-INCLUDED-BY-DEPENDENCY, ##THEIA-NO-ENTRY-MODULE). There are no
// `own-extensions`: a Theia extension **is** own code - a workspace package -
// and a VS Code-style plugin is the other mechanism entirely
// (##THEIA-EXTENSIONS-ARE-OWN-CODE).
//
// What is present is the overlay of the application manifest, which carries the
// whole product model of this family, and the service override, which is an
// inversify `rebind` plus the dependency edge that puts the own package after
// the package it overrides.

import type { LayersArea, OverlayTarget, ServiceOverrideContext, ServiceOverrideProblem, ServiceOverrideVerifier } from '@codkit/type-api';
import { ROOT_MANIFEST_PATH } from './identity.ts';

/** The manifest of the own package inside the own layer (##THEIA-OWN-PACKAGE-SHAPE). */
export const OWN_PACKAGE_MANIFEST = 'package.json';

/**
 * ##THEIA-OVERLAY-TARGET: the application's `package.json` - the `theia`
 * section with the application name, the preference defaults and the Electron
 * window options, `productName`, `main`, `theiaPlugins` and the dependency
 * inventory of extensions. There is no `product.json` and no development
 * channel: the running application reads the values that were frozen into
 * `src-gen/` at build time, so there is no sidecar to read instead.
 *
 * The root manifest is a target too, restricted to `scripts`: the watch
 * channels of this family are npm scripts of the tree root (##THEIA-BUILD-CHANNELS),
 * and the workspace globs, which are a graft of the constant set
 * (##THEIA-FORBIDDEN-TARGETS), stay out of an overlay's reach.
 */
export function overlayTargetsOf(applicationRoot: string): readonly OverlayTarget[] {
	return [
		{ path: `${applicationRoot}/package.json`, devChannel: null, stampedKeys: [], allowedKeys: null },
		{ path: ROOT_MANIFEST_PATH, devChannel: null, stampedKeys: [], allowedKeys: ['scripts'] }
	];
}

/**
 * ##THEIA-OVERRIDE-IS-REBIND, ##THEIA-OVERRIDE-VERIFIER: an override is
 * `rebind(Id)` in the own package's container module, and it wins because the
 * collector pushes a package after every package it depends on. The call alone
 * proves nothing: without the dependency edge the own module may be loaded
 * first and be overridden itself, so the edge is verified too.
 */
export const serviceOverride: ServiceOverrideVerifier = {
	registrationCall: 'rebind',
	registrationModule: null,
	forbiddenReason: 'the conventions of this patch set name it as a service own code may not rebind, with the failure that proved it',
	forbiddenHint:
		'bind a service of your own and contribute it, or override a service that is bound in the root container of the application',
	overrideProblems
};

export function makeLayers(applicationRoot: string): LayersArea {
	return {
		overlayTargets: overlayTargetsOf(applicationRoot),
		ownExtensions: null,
		serviceOverride,
		entryModule: null
	};
}

/**
 * ##THEIA-OVERRIDE-VERIFIER: the two things beyond the `rebind` call.
 *
 * The module has to be a root-container module - a default-exported
 * `ContainerModule`, which is what the application's generator loads - because a
 * `rebind` in a child container is a different mechanism whose reach this type
 * does not claim to know (##THEIA-OVERRIDE-CHILD-CONTAINERS). And the own
 * package has to depend on the package the service identifier comes from, since
 * that dependency is the whole reason the own module is loaded later than the
 * module it overrides.
 */
export function overrideProblems(context: ServiceOverrideContext): readonly ServiceOverrideProblem[] {
	const problems: ServiceOverrideProblem[] = [];
	if (!/export\s+default\s+new\s+ContainerModule\s*\(/u.test(context.moduleText)) {
		problems.push({
			detail: `${context.modulePath} does not default-export a ContainerModule, and the application loads only the module a theiaExtensions entry names`,
			hint: 'write the override as `export default new ContainerModule(({ rebind }) => { rebind(Id).to(Impl); });`; a rebind in a child container is a different mechanism and this type does not verify it'
		});
	}
	const owner = importedPackageOf(context.moduleText, context.serviceId);
	if (owner === null) {
		problems.push({
			detail: `${context.modulePath} does not import ${context.serviceId} from another package, so the package that binds the service cannot be named`,
			hint: `import ${context.serviceId} from the @theia package that binds it, and depend on that package: the load order of the collector is what makes the rebind win`
		});
		return problems;
	}
	if (owner === LOCAL) {
		// A service the own package binds itself needs no edge: there is no
		// other module in the load order to come after.
		return problems;
	}
	const manifest = ownManifest(context);
	if (manifest === null) {
		problems.push({
			detail: `the own package has no readable ${OWN_PACKAGE_MANIFEST}, so the dependency on ${owner} cannot be proved`,
			hint: `carry the manifest of the own package in the own layer as ${OWN_PACKAGE_MANIFEST}: it is what declares theiaExtensions and the dependencies of the package`
		});
		return problems;
	}
	if (!dependsOn(manifest, owner)) {
		problems.push({
			detail: `the own package does not depend on ${owner}, which binds ${context.serviceId}: without that edge the collector may load the own module first and the rebind is overridden itself`,
			hint: `add ${owner} to the dependencies of ${OWN_PACKAGE_MANIFEST} at the version of the monorepo`
		});
	}
	return problems;
}

/** The specifier of a service identifier imported from the own package itself. */
const LOCAL = '.';

/**
 * The package a named import comes from, `.` when it is a relative module of
 * the own package, or null when the module does not import the name at all.
 * `@theia/core/shared/inversify` and `@theia/editor/lib/browser` both name their
 * package in the first one or two segments.
 */
export function importedPackageOf(moduleText: string, name: string): string | null {
	const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gu;
	for (const match of moduleText.matchAll(pattern)) {
		const names = (match[1] ?? '').split(',').map((entry) => (entry.split(/\s+as\s+/u)[0] ?? '').trim());
		if (!names.includes(name)) {
			continue;
		}
		const specifier = match[2] ?? '';
		if (specifier.startsWith('.')) {
			return LOCAL;
		}
		return packageNameOf(specifier);
	}
	return null;
}

/** The package name of a module specifier: two segments when it is scoped, one otherwise. */
export function packageNameOf(specifier: string): string {
	const segments = specifier.split('/');
	if (specifier.startsWith('@')) {
		return segments.slice(0, 2).join('/');
	}
	return segments[0] ?? specifier;
}

function ownManifest(context: ServiceOverrideContext): { readonly [key: string]: unknown } | null {
	const text = context.read(OWN_PACKAGE_MANIFEST);
	if (text === null) {
		return null;
	}
	try {
		const parsed = JSON.parse(text) as unknown;
		return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as { readonly [key: string]: unknown }) : null;
	} catch {
		return null;
	}
}

/**
 * The collector walks `dependencies` and `peerDependencies` alike, so an edge
 * declared either way puts the own package after the package it names.
 */
function dependsOn(manifest: { readonly [key: string]: unknown }, packageName: string): boolean {
	for (const field of ['dependencies', 'peerDependencies']) {
		const declared = manifest[field];
		if (typeof declared === 'object' && declared !== null && !Array.isArray(declared) && packageName in declared) {
			return true;
		}
	}
	return false;
}
