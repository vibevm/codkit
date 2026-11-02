/** @scope spec://codkit/modules/codkit/PROP-008#BUNDLES-LOAD */
// The bundles of a patch set in the tree (PROP-008 ##BUNDLES-LOAD; PROP-007
// ##CMD-LOAD-BUNDLES, ##CMD-STATUS-BUNDLES, ##CMD-PACKAGE-BUNDLES): the units
// the product ships inside its distribution, built elsewhere and delivered as
// archives, provisioned into the cache of the upstream build the type names.
//
// The declaration (PROP-003 ##CFG-BUNDLES) is joined by name with the entries
// of the manifest the overlays compose over the pin - never with the tree's
// file, so that a materialized target and a dev-channel tree answer the same -
// and the entry says what the archive must hash to. A unit built per target has
// one archive and one hash per target, and a run provisions the archive of the
// one target it runs or packages for: the host's for `load`, the selected
// package targets' for `package`. The stamp (PROP-006 ##BUNDLES-STAMP) says
// what was unpacked where and for which target, so nothing is hashed or
// unpacked twice and a withdrawn bundle is removed exactly where it was put.

import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BundleEntry, BundleHost, BundleLayer, PackageTarget, ProjectType } from '@codkit/type-api';
import { resolveBundleFile } from './bundlesDeclaration.ts';
import type { BundleConfig } from './bundlesDeclaration.ts';
import { readBundleStore, writeBundleStore } from './bundlesStore.ts';
import type { StoredBundle } from './bundlesStore.ts';
import type { CodkitConfig } from './configFile.ts';
import type { Output } from './jsonOut.ts';
import { loadOverlays, overlayBaseAtPin, renderOverlayTarget } from './layers/overlay.ts';
import type { JsonLike, OverlayVarContext } from './layers/overlay.ts';
import { ckError } from './messages.ts';
import { repoRelativePathProblem } from './pathSafety.ts';
import { extractZip, hashFile } from './zipArchive.ts';

export type BundleState = 'provisioned' | 'unchanged' | 'missing' | 'mismatch' | 'off' | 'withdrawn';

export type BundleReport = {
	readonly name: string;
	readonly version: string;
	/** The hash the manifest entry declares for the archive this run looked at; empty when it declares none. */
	readonly sha256: string;
	/** The target whose archive this run looked at, for a unit built per target; null for one archive. */
	readonly target: string | null;
	/** The archive the run looked at, resolved; null for a bundle switched off or without an archive here. */
	readonly file: string | null;
	readonly cachePath: string;
	readonly state: BundleState;
	/** One line, as the run printed it. */
	readonly line: string;
};

export type DeclaredBundle = {
	readonly config: BundleConfig;
	/** Switched off on this machine by codkit.local.json. */
	readonly off: boolean;
	/** Built per target: one archive and one hash per target. */
	readonly perTarget: boolean;
	/** The target of this run, for a unit built per target; null for one archive or when the run has none. */
	readonly target: string | null;
	/** The archive of this run on this machine, resolved; null when it is switched off or declares none for the target. */
	readonly file: string | null;
	/** The entry of the composed manifest, or null when the manifest does not carry the unit. */
	readonly unit: BundleEntry | null;
	readonly cachePath: string;
};

const TEMP_SUFFIX = '.codkit-tmp';

/** The bundles layer of the type; a patch set that declares bundles under a type without the layer is refused. */
export function bundleLayerOf(type: ProjectType, config: CodkitConfig): BundleLayer | null {
	const layer = type.layers.bundles;
	const declared = config.bundles?.length ?? 0;
	if (layer === null && declared > 0) {
		throw ckError(
			'TYPE-CAPABILITY',
			`codkit.json declares ${declared} bundle(s), but the project type ${type.id} ships no bundles`,
			'remove the bundles list, or use a project type that answers the bundles layer'
		);
	}
	return layer;
}

/**
 * The target a run provisions for: the host's, or the one target every
 * selected package target ships. A run that would package several targets of
 * a unit built per target is refused - the cache of the build holds one.
 */
export function runTargetOf(
	layer: BundleLayer,
	config: CodkitConfig,
	packageTargets: readonly PackageTarget[] | undefined,
	host: BundleHost
): string | null {
	if (packageTargets === undefined || packageTargets.length === 0) return layer.hostTarget(host);
	const targets = [...new Set(packageTargets.map((target) => layer.packageTarget(target)))];
	const perTarget = (config.bundles ?? []).filter((bundle) => bundle.files !== undefined && bundle.off !== true);
	if (perTarget.length > 0 && targets.length > 1) {
		throw ckError(
			'CONFIG',
			`the bundle ${perTarget[0]?.name ?? ''} is built per target, and this run packages for ${targets.map((target) => target ?? 'no single target').join(' and ')}`,
			'package the targets of each platform in a run of their own: the cache of the upstream build holds the archive of one target'
		);
	}
	return targets[0] ?? null;
}

/** The manifest document the overlays compose for the layer's target over the pin. */
export function composedManifest(
	layer: BundleLayer,
	type: ProjectType,
	config: CodkitConfig,
	patchesDir: string,
	treeDir: string,
	context: OverlayVarContext
): Readonly<Record<string, unknown>> {
	const overlays = loadOverlays(patchesDir, type).filter((overlay) => overlay.target === layer.manifestTarget);
	if (overlays.length === 0) {
		return overlayBaseAtPin(treeDir, config.pin.sha, layer.manifestTarget, 'json') as Readonly<Record<string, JsonLike>>;
	}
	return renderOverlayTarget(overlays, treeDir, config.pin.sha, context).document;
}

/** Every declared bundle with its archive of the run's target on this machine and its entry in the composed manifest. */
export function declaredBundles(
	type: ProjectType,
	config: CodkitConfig,
	patchesDir: string,
	treeDir: string,
	context: OverlayVarContext,
	target: string | null = null
): readonly DeclaredBundle[] {
	const layer = bundleLayerOf(type, config);
	const declared = config.bundles ?? [];
	if (layer === null || declared.length === 0) return [];
	const units = layer.entries(composedManifest(layer, type, config, patchesDir, treeDir, context));
	return declared.map((bundle) => {
		const perTarget = bundle.files !== undefined;
		const declaredFile = perTarget ? (target === null ? undefined : bundle.files?.[target]) : bundle.file;
		return {
			config: bundle,
			off: bundle.off === true,
			perTarget,
			target: perTarget ? target : null,
			file: bundle.off === true || declaredFile === undefined ? null : resolveBundleFile(patchesDir, declaredFile),
			unit: units.find((unit) => unit.name === bundle.name) ?? null,
			cachePath: layer.cachePath(bundle.name)
		};
	});
}

/** The refusal of a bundle the composed manifest does not carry. */
function undeclaredUnit(layer: BundleLayer, name: string): never {
	throw ckError(
		'CONFIG',
		`bundle ${name}: ${layer.manifestTarget} composed over the pin declares no such unit in ${layer.listPath.join('.')}`,
		`run codkit bundles add <archive>... --id <id> to write its record, or codkit bundles update ${name} to refresh it`
	);
}

/** Where the archive of a bundle is taken from: the kit first, by the basename of the declared file, then the declared path. */
export function locateArchive(file: string, kitDir: string | null): { readonly path: string; readonly where: 'kit' | 'declared' } | null {
	if (kitDir !== null) {
		const inKit = join(kitDir, 'bundles', basename(file));
		if (existsSync(inKit) && statSync(inKit).isFile()) return { path: inKit, where: 'kit' };
	}
	if (existsSync(file) && statSync(file).isFile()) return { path: file, where: 'declared' };
	return null;
}

export type ProvisionOptions = {
	readonly type: ProjectType;
	readonly config: CodkitConfig;
	readonly patchesDir: string;
	readonly treeDir: string;
	readonly context: OverlayVarContext;
	readonly out: Output;
	/** `--inputs <dir>` of package: its `bundles/` directory takes precedence over the declared paths. */
	readonly kitDir?: string | null;
	/** `load` tolerates a missing or differing archive and honours the local switch; `package` refuses and ignores the switch. */
	readonly mode: 'load' | 'package';
	/** Report only: nothing is unpacked, removed or stamped (the preflight of package, and status). */
	readonly inspect?: boolean;
	/** Under `--ci`, a bundle package cannot provision is a network refusal. */
	readonly offline?: boolean;
	/** False: the reports are returned and no line is printed; `status` prints its own. */
	readonly print?: boolean;
	/** The package targets of a `package` run; absent, the run provisions for the host. */
	readonly packageTargets?: readonly PackageTarget[];
	/** The host whose target a run without package targets provisions for; this process's by default. */
	readonly host?: BundleHost;
};

function cacheAbsolute(treeDir: string, cachePath: string): string {
	if (repoRelativePathProblem(cachePath) !== null || cachePath.split('/').some((segment) => segment.toLowerCase() === '.git')) {
		throw ckError(
			'INTERNAL',
			`the project type names an unusable bundle cache path: ${cachePath}`,
			'report this to the author of the type'
		);
	}
	return join(treeDir, ...cachePath.split('/'));
}

function removeCache(treeDir: string, cachePath: string): void {
	const absolute = cacheAbsolute(treeDir, cachePath);
	rmSync(absolute, { recursive: true, force: true });
	rmSync(`${absolute}${TEMP_SUFFIX}`, { recursive: true, force: true });
}

function unpackInto(treeDir: string, layer: BundleLayer, archive: string, cachePath: string, expected: string): number {
	const absolute = cacheAbsolute(treeDir, cachePath);
	const temporary = `${absolute}${TEMP_SUFFIX}`;
	rmSync(temporary, { recursive: true, force: true });
	mkdirSync(dirname(absolute), { recursive: true });
	let extracted;
	try {
		extracted = extractZip(archive, { root: layer.archiveRoot, destination: temporary });
	} catch (error) {
		rmSync(temporary, { recursive: true, force: true });
		throw ckError(
			'CONFIG',
			`bundle archive ${archive} cannot be unpacked: ${error instanceof Error ? error.message : String(error)}`,
			`the archive must be a zip with the unit under ${layer.archiveRoot === '' ? 'its root' : layer.archiveRoot}; rebuild it, or point codkit.json at the right file`
		);
	}
	if (extracted.sha256 !== expected) {
		rmSync(temporary, { recursive: true, force: true });
		throw ckError('CONFIG', `bundle archive ${archive} changed while it was read`, 'run the command again');
	}
	if (extracted.files === 0) {
		rmSync(temporary, { recursive: true, force: true });
		throw ckError(
			'CONFIG',
			`bundle archive ${archive} holds no file under ${layer.archiveRoot === '' ? 'its root' : layer.archiveRoot}`,
			'the unit is read from that directory of the archive; rebuild the archive, or point codkit.json at the right file'
		);
	}
	rmSync(absolute, { recursive: true, force: true });
	renameSync(temporary, absolute);
	return extracted.files;
}

/**
 * Provision every declared bundle into the cache of the upstream build, and
 * withdraw what is declared no more; or, under `inspect`, only say what a run
 * would do. Returns one report per bundle the run looked at.
 */
export function provisionBundles(options: ProvisionOptions): readonly BundleReport[] {
	const { type, config, patchesDir, treeDir, out } = options;
	const layer = bundleLayerOf(type, config);
	if (layer === null) return [];
	const runTarget = runTargetOf(layer, config, options.packageTargets, options.host ?? { platform: process.platform, arch: process.arch });
	const declared = declaredBundles(type, config, patchesDir, treeDir, options.context, runTarget);
	const stored = readBundleStore(treeDir, (text) => out.warn(text));
	const inspect = options.inspect === true;
	const kitDir = options.kitDir ?? null;
	const next: StoredBundle[] = [];
	const reports: BundleReport[] = [];
	const short = (hash: string): string => hash.slice(0, 12);
	const refuse = (message: string, hint: string): never => {
		throw ckError(options.offline === true ? 'NET-FORBIDDEN' : 'CONFIG', message, hint);
	};

	for (const bundle of declared) {
		const name = bundle.config.name;
		const unit = bundle.unit ?? undeclaredUnit(layer, name);
		const label = `bundle ${name}@${unit.version}${bundle.perTarget ? ` for ${bundle.target ?? 'this host'}` : ''}`;
		const expected = bundle.perTarget ? (bundle.target === null ? undefined : unit.targets?.[bundle.target]) : unit.sha256;
		const previous = stored.find((entry) => entry.name === name);
		const sameTarget = (entry: StoredBundle): boolean => (entry.target ?? null) === bundle.target;
		const cachePresent = (entry: StoredBundle | undefined): entry is StoredBundle =>
			entry !== undefined && entry.cachePath === bundle.cachePath && existsSync(cacheAbsolute(treeDir, entry.cachePath));
		const current = (entry: StoredBundle | undefined): entry is StoredBundle =>
			cachePresent(entry) && sameTarget(entry) && expected !== undefined && entry.sha256 === expected;
		const report = (state: BundleState, file: string | null, line: string): void => {
			reports.push({
				name,
				version: unit.version,
				sha256: expected ?? '',
				target: bundle.target,
				file,
				cachePath: bundle.cachePath,
				state,
				line
			});
			if (options.print !== false) out.info(line);
		};

		if (bundle.off && options.mode === 'load') {
			if (cachePresent(previous)) {
				if (!inspect) removeCache(treeDir, previous.cachePath);
				report('withdrawn', null, `${label}: switched off in codkit.local.json; withdrawn from ${bundle.cachePath}`);
			} else {
				report('off', null, `${label}: switched off in codkit.local.json`);
			}
			continue;
		}
		if (bundle.perTarget && bundle.target === null) {
			if (options.mode === 'package') {
				refuse(
					`${label}: the project type ${type.id} names no target of the unit for this run`,
					'package on a host and for targets the family builds the unit for'
				);
			}
			report('missing', null, `${label}: not provisioned (the family names no target of the unit for this host)`);
			continue;
		}
		const declaredFile = bundle.perTarget ? bundle.config.files?.[bundle.target ?? ''] : bundle.config.file;
		const file = bundle.file ?? (declaredFile === undefined ? null : resolveBundleFile(patchesDir, declaredFile));
		if (file === null) {
			if (options.mode === 'package') {
				refuse(
					`${label}: codkit.json names no archive of the unit for ${bundle.target ?? 'this run'}`,
					`add the archive of ${bundle.target ?? 'the target'} to the files of the bundle and run codkit bundles update ${name}`
				);
			}
			report('missing', null, `${label}: not provisioned (codkit.json names no archive for ${bundle.target ?? 'this host'})`);
			continue;
		}
		if (expected === undefined) {
			if (options.mode === 'package') {
				refuse(
					`${label}: the record of the unit carries no hash for ${bundle.target ?? 'this run'}`,
					`codkit bundles update ${name} writes the hash of every archive codkit.json names`
				);
			}
			if (!inspect) out.warn(`${label}: the record carries no hash for this target; codkit bundles update ${name} writes it`);
			report('mismatch', file, `${label}: the record carries no hash for this target (codkit bundles update ${name})`);
			continue;
		}
		const located = locateArchive(file, kitDir);
		if (located === null) {
			// A cache that holds the unit with the recorded hash is the unit: the
			// archive is needed only to put it there (##BUNDLES-STAMP).
			if (current(previous)) {
				next.push(previous);
				report('unchanged', file, `${label}: unchanged in ${bundle.cachePath} (sha256 ${short(expected)}; ${file} is not there)`);
				continue;
			}
			if (options.mode === 'package') {
				refuse(
					`${label}: no archive to provision it from (looked for ${file}${kitDir === null ? '' : ` and ${join(kitDir, 'bundles', basename(file))}`})`,
					'put the archive at the declared path, or give --inputs <dir> whose bundles/ directory holds it'
				);
			}
			report('missing', file, `${label}: not provisioned (${file} is not there)`);
			continue;
		}
		const stat = statSync(located.path);
		const unchangedArchive = current(previous) && previous.archiveBytes === stat.size && previous.archiveMtimeMs === stat.mtimeMs;
		const sha256 = unchangedArchive ? previous.sha256 : hashFile(located.path).sha256;
		if (sha256 !== expected) {
			if (options.mode === 'package') {
				refuse(
					`${label}: ${located.path} hashes to ${short(sha256)}, the manifest entry expects ${short(expected)}`,
					`codkit bundles update ${name} rewrites the record from the archive, or put the archive the record names at that path`
				);
			}
			if (!inspect) {
				out.warn(
					`${label}: ${located.path} hashes to ${short(sha256)}, the record expects ${short(expected)}; codkit bundles update ${name} rewrites the record`
				);
			}
			if (current(previous)) next.push(previous);
			report('mismatch', located.path, `${label}: archive differs from the record (sha256 ${short(sha256)} vs ${short(expected)})`);
			continue;
		}
		const stamp: StoredBundle = {
			name,
			version: unit.version,
			sha256,
			cachePath: bundle.cachePath,
			...(bundle.target === null ? {} : { target: bundle.target }),
			archiveBytes: stat.size,
			archiveMtimeMs: stat.mtimeMs
		};
		if (current(previous)) {
			next.push(stamp);
			report('unchanged', located.path, `${label}: unchanged in ${bundle.cachePath} (sha256 ${short(sha256)})`);
			continue;
		}
		if (inspect) {
			report(
				'provisioned',
				located.path,
				`${label}: to provision into ${bundle.cachePath} from ${located.where === 'kit' ? 'the kit' : located.path}`
			);
			continue;
		}
		const files = unpackInto(treeDir, layer, located.path, bundle.cachePath, sha256);
		next.push(stamp);
		report(
			'provisioned',
			located.path,
			`${label}: provisioned from ${located.where === 'kit' ? 'the kit' : located.path} into ${bundle.cachePath} (${files} file(s), sha256 ${short(sha256)})`
		);
	}

	for (const entry of stored) {
		if (declared.some((bundle) => bundle.config.name === entry.name)) continue;
		if (!inspect) removeCache(treeDir, entry.cachePath);
		const line = `bundle ${entry.name}@${entry.version}: declared no more; withdrawn from ${entry.cachePath}`;
		reports.push({
			name: entry.name,
			version: entry.version,
			sha256: entry.sha256,
			target: entry.target ?? null,
			file: null,
			cachePath: entry.cachePath,
			state: 'withdrawn',
			line
		});
		if (options.print !== false) out.info(line);
	}
	if (!inspect && (declared.length > 0 || stored.length > 0)) writeBundleStore(treeDir, next);
	return reports;
}

/** The report of `status`: what `load` would do, without doing it. */
export function inspectBundles(options: Omit<ProvisionOptions, 'inspect' | 'mode'>): readonly BundleReport[] {
	return provisionBundles({ ...options, mode: 'load', inspect: true });
}

/** The line of `status` for one bundle (PROP-007 ##CMD-STATUS-BUNDLES); `declared` says whether codkit.json still names it. */
export function bundleStatusLine(bundle: BundleReport, declared: boolean): string {
	const head = `${bundle.name}@${bundle.version}${bundle.target === null ? '' : ` for ${bundle.target}`} -> ${bundle.cachePath}`;
	switch (bundle.state) {
		case 'unchanged':
			return `${head}: provisioned (sha256 ${bundle.sha256.slice(0, 12)})`;
		case 'provisioned':
			return `${head}: not provisioned (codkit load unpacks ${bundle.file ?? 'the archive'})`;
		case 'missing':
			return bundle.file === null
				? `${head}: not provisioned (no archive for this host)`
				: `${head}: not provisioned (${bundle.file} is not there)`;
		case 'mismatch':
			return `${head}: archive differs from the record (codkit bundles update ${bundle.name})`;
		case 'off':
			return `${head}: switched off in codkit.local.json`;
		case 'withdrawn':
			return declared
				? `${head}: switched off in codkit.local.json (codkit load withdraws it)`
				: `${head}: declared no more (codkit load withdraws it)`;
	}
}
