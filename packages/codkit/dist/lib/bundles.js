/** @scope spec://codkit/modules/codkit/PROP-008#BUNDLES-LOAD */
// The bundles of a patch set in the tree (PROP-008 ##BUNDLES-LOAD; PROP-007
// ##CMD-LOAD-BUNDLES, ##CMD-STATUS-BUNDLES, ##CMD-PACKAGE-BUNDLES): the units
// the product ships inside its distribution, built elsewhere and delivered as
// archives, provisioned into the cache of the upstream build the type names.
//
// The declaration (PROP-003 ##CFG-BUNDLES) is joined by name with the entries
// of the manifest the overlays compose over the pin - never with the tree's
// file, so that a materialized target and a dev-channel tree answer the same -
// and the entry says what the archive must hash to. The stamp (PROP-006
// ##BUNDLES-STAMP) says what was unpacked where, so nothing is hashed or
// unpacked twice and a withdrawn bundle is removed exactly where it was put.
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { resolveBundleFile } from './bundlesDeclaration.js';
import { readBundleStore, writeBundleStore } from './bundlesStore.js';
import { loadOverlays, overlayBaseAtPin, renderOverlayTarget } from './layers/overlay.js';
import { ckError } from './messages.js';
import { repoRelativePathProblem } from './pathSafety.js';
import { extractZip, hashFile } from './zipArchive.js';
const TEMP_SUFFIX = '.codkit-tmp';
/** The bundles layer of the type; a patch set that declares bundles under a type without the layer is refused. */
export function bundleLayerOf(type, config) {
    const layer = type.layers.bundles;
    const declared = config.bundles?.length ?? 0;
    if (layer === null && declared > 0) {
        throw ckError('TYPE-CAPABILITY', `codkit.json declares ${declared} bundle(s), but the project type ${type.id} ships no bundles`, 'remove the bundles list, or use a project type that answers the bundles layer');
    }
    return layer;
}
/** The manifest document the overlays compose for the layer's target over the pin. */
export function composedManifest(layer, type, config, patchesDir, treeDir, context) {
    const overlays = loadOverlays(patchesDir, type).filter((overlay) => overlay.target === layer.manifestTarget);
    if (overlays.length === 0) {
        return overlayBaseAtPin(treeDir, config.pin.sha, layer.manifestTarget, 'json');
    }
    return renderOverlayTarget(overlays, treeDir, config.pin.sha, context).document;
}
/** Every declared bundle with its archive on this machine and its entry in the composed manifest. */
export function declaredBundles(type, config, patchesDir, treeDir, context) {
    const layer = bundleLayerOf(type, config);
    const declared = config.bundles ?? [];
    if (layer === null || declared.length === 0)
        return [];
    const units = layer.entries(composedManifest(layer, type, config, patchesDir, treeDir, context));
    return declared.map((bundle) => ({
        config: bundle,
        file: bundle.off === true ? null : resolveBundleFile(patchesDir, bundle.file),
        unit: units.find((unit) => unit.name === bundle.name) ?? null,
        cachePath: layer.cachePath(bundle.name)
    }));
}
/** The refusal of a bundle the composed manifest does not carry. */
function undeclaredUnit(layer, name) {
    throw ckError('CONFIG', `bundle ${name}: ${layer.manifestTarget} composed over the pin declares no such unit in ${layer.listPath.join('.')}`, `run codkit bundles add <archive> --id <id> to write its record, or codkit bundles update ${name} to refresh it`);
}
/** Where the archive of a bundle is taken from: the kit first, by the basename of the declared file, then the declared path. */
export function locateArchive(file, kitDir) {
    if (kitDir !== null) {
        const inKit = join(kitDir, 'bundles', basename(file));
        if (existsSync(inKit) && statSync(inKit).isFile())
            return { path: inKit, where: 'kit' };
    }
    if (existsSync(file) && statSync(file).isFile())
        return { path: file, where: 'declared' };
    return null;
}
function cacheAbsolute(treeDir, cachePath) {
    if (repoRelativePathProblem(cachePath) !== null || cachePath.split('/').some((segment) => segment.toLowerCase() === '.git')) {
        throw ckError('INTERNAL', `the project type names an unusable bundle cache path: ${cachePath}`, 'report this to the author of the type');
    }
    return join(treeDir, ...cachePath.split('/'));
}
function removeCache(treeDir, cachePath) {
    const absolute = cacheAbsolute(treeDir, cachePath);
    rmSync(absolute, { recursive: true, force: true });
    rmSync(`${absolute}${TEMP_SUFFIX}`, { recursive: true, force: true });
}
function unpackInto(treeDir, layer, archive, cachePath, expected) {
    const absolute = cacheAbsolute(treeDir, cachePath);
    const temporary = `${absolute}${TEMP_SUFFIX}`;
    rmSync(temporary, { recursive: true, force: true });
    mkdirSync(dirname(absolute), { recursive: true });
    let extracted;
    try {
        extracted = extractZip(archive, { root: layer.archiveRoot, destination: temporary });
    }
    catch (error) {
        rmSync(temporary, { recursive: true, force: true });
        throw ckError('CONFIG', `bundle archive ${archive} cannot be unpacked: ${error instanceof Error ? error.message : String(error)}`, `the archive must be a zip with the unit under ${layer.archiveRoot === '' ? 'its root' : layer.archiveRoot}; rebuild it, or point codkit.json at the right file`);
    }
    if (extracted.sha256 !== expected) {
        rmSync(temporary, { recursive: true, force: true });
        throw ckError('CONFIG', `bundle archive ${archive} changed while it was read`, 'run the command again');
    }
    if (extracted.files === 0) {
        rmSync(temporary, { recursive: true, force: true });
        throw ckError('CONFIG', `bundle archive ${archive} holds no file under ${layer.archiveRoot === '' ? 'its root' : layer.archiveRoot}`, 'the unit is read from that directory of the archive; rebuild the archive, or point codkit.json at the right file');
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
export function provisionBundles(options) {
    const { type, config, patchesDir, treeDir, out } = options;
    const layer = bundleLayerOf(type, config);
    if (layer === null)
        return [];
    const declared = declaredBundles(type, config, patchesDir, treeDir, options.context);
    const stored = readBundleStore(treeDir, (text) => out.warn(text));
    const inspect = options.inspect === true;
    const kitDir = options.kitDir ?? null;
    const next = [];
    const reports = [];
    const short = (hash) => hash.slice(0, 12);
    const refuse = (message, hint) => {
        throw ckError(options.offline === true ? 'NET-FORBIDDEN' : 'CONFIG', message, hint);
    };
    for (const bundle of declared) {
        const name = bundle.config.name;
        const unit = bundle.unit ?? undeclaredUnit(layer, name);
        const previous = stored.find((entry) => entry.name === name);
        const cachePresent = (entry) => entry !== undefined && entry.cachePath === bundle.cachePath && existsSync(cacheAbsolute(treeDir, entry.cachePath));
        const report = (state, file, line) => {
            reports.push({ name, version: unit.version, sha256: unit.sha256, file, cachePath: bundle.cachePath, state, line });
            if (options.print !== false)
                out.info(line);
        };
        if (bundle.file === null && options.mode === 'load') {
            if (cachePresent(previous)) {
                if (!inspect)
                    removeCache(treeDir, previous.cachePath);
                report('withdrawn', null, `bundle ${name}@${unit.version}: switched off in codkit.local.json; withdrawn from ${bundle.cachePath}`);
            }
            else {
                report('off', null, `bundle ${name}@${unit.version}: switched off in codkit.local.json`);
            }
            continue;
        }
        const file = bundle.file ?? resolveBundleFile(patchesDir, bundle.config.file);
        const located = locateArchive(file, kitDir);
        if (located === null) {
            // A cache that holds the unit with the recorded hash is the unit: the
            // archive is needed only to put it there (##BUNDLES-STAMP).
            if (cachePresent(previous) && previous.sha256 === unit.sha256) {
                next.push(previous);
                report('unchanged', file, `bundle ${name}@${unit.version}: unchanged in ${bundle.cachePath} (sha256 ${short(unit.sha256)}; ${file} is not there)`);
                continue;
            }
            if (options.mode === 'package') {
                refuse(`bundle ${name}@${unit.version}: no archive to provision it from (looked for ${file}${kitDir === null ? '' : ` and ${join(kitDir, 'bundles', basename(file))}`})`, 'put the archive at the declared path, or give --inputs <dir> whose bundles/ directory holds it');
            }
            report('missing', file, `bundle ${name}@${unit.version}: not provisioned (${file} is not there)`);
            continue;
        }
        const stat = statSync(located.path);
        const unchangedArchive = cachePresent(previous) &&
            previous.sha256 === unit.sha256 &&
            previous.archiveBytes === stat.size &&
            previous.archiveMtimeMs === stat.mtimeMs;
        const sha256 = unchangedArchive ? previous.sha256 : hashFile(located.path).sha256;
        if (sha256 !== unit.sha256) {
            if (options.mode === 'package') {
                refuse(`bundle ${name}@${unit.version}: ${located.path} hashes to ${short(sha256)}, the manifest entry expects ${short(unit.sha256)}`, `codkit bundles update ${name} rewrites the record from the archive, or put the archive the record names at that path`);
            }
            if (!inspect) {
                out.warn(`bundle ${name}@${unit.version}: ${located.path} hashes to ${short(sha256)}, the record expects ${short(unit.sha256)}; codkit bundles update ${name} rewrites the record`);
            }
            if (cachePresent(previous) && previous.sha256 === unit.sha256)
                next.push(previous);
            report('mismatch', located.path, `bundle ${name}@${unit.version}: archive differs from the record (sha256 ${short(sha256)} vs ${short(unit.sha256)})`);
            continue;
        }
        const stamp = {
            name,
            version: unit.version,
            sha256,
            cachePath: bundle.cachePath,
            archiveBytes: stat.size,
            archiveMtimeMs: stat.mtimeMs
        };
        if (cachePresent(previous) && previous.sha256 === sha256) {
            next.push(stamp);
            report('unchanged', located.path, `bundle ${name}@${unit.version}: unchanged in ${bundle.cachePath} (sha256 ${short(sha256)})`);
            continue;
        }
        if (inspect) {
            report('provisioned', located.path, `bundle ${name}@${unit.version}: to provision into ${bundle.cachePath} from ${located.where === 'kit' ? 'the kit' : located.path}`);
            continue;
        }
        const files = unpackInto(treeDir, layer, located.path, bundle.cachePath, sha256);
        next.push(stamp);
        report('provisioned', located.path, `bundle ${name}@${unit.version}: provisioned from ${located.where === 'kit' ? 'the kit' : located.path} into ${bundle.cachePath} (${files} file(s), sha256 ${short(sha256)})`);
    }
    for (const entry of stored) {
        if (declared.some((bundle) => bundle.config.name === entry.name))
            continue;
        if (!inspect)
            removeCache(treeDir, entry.cachePath);
        const line = `bundle ${entry.name}@${entry.version}: declared no more; withdrawn from ${entry.cachePath}`;
        reports.push({
            name: entry.name,
            version: entry.version,
            sha256: entry.sha256,
            file: null,
            cachePath: entry.cachePath,
            state: 'withdrawn',
            line
        });
        if (options.print !== false)
            out.info(line);
    }
    if (!inspect && (declared.length > 0 || stored.length > 0))
        writeBundleStore(treeDir, next);
    return reports;
}
/** The report of `status`: what `load` would do, without doing it. */
export function inspectBundles(options) {
    return provisionBundles({ ...options, mode: 'load', inspect: true });
}
/** The line of `status` for one bundle (PROP-007 ##CMD-STATUS-BUNDLES); `declared` says whether codkit.json still names it. */
export function bundleStatusLine(bundle, declared) {
    const head = `${bundle.name}@${bundle.version} -> ${bundle.cachePath}`;
    switch (bundle.state) {
        case 'unchanged':
            return `${head}: provisioned (sha256 ${bundle.sha256.slice(0, 12)})`;
        case 'provisioned':
            return `${head}: not provisioned (codkit load unpacks ${bundle.file ?? 'the archive'})`;
        case 'missing':
            return `${head}: not provisioned (${bundle.file ?? 'the archive'} is not there)`;
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
