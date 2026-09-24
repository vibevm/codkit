/** @scope spec://codkit/modules/codkit/PROP-016#TYPE-INPUT-PLACEMENT */
// Where an input may land (PROP-016 ##TYPE-INPUT-PLACEMENT, PROP-007
// ##INPUTS-PLACEMENT). The engine names no place itself: it asks the answers
// the project type already gives - the directories the delta owns, where an own
// extension materializes, where the type's dependencies are installed, what its
// build and its packaging write - and the pin and the patch set for the paths
// they carry. A `to` that is one of those, inside one or around one is refused
// before anything is written: an input never replaces a byte another source
// owns, and never shares a directory with one.
import { matchesPatternList } from './conventionsFile.js';
import { runGit } from './gitx.js';
import { pathsOverlap } from './inputsDeclaration.js';
import { ckError } from './messages.js';
import { matchesTreePattern } from './packagePaths.js';
/** Refuse the first input whose `to` another source owns; silent when every one is free. */
export function assertInputPlacement(options) {
    if (options.inputs.length === 0)
        return;
    const pin = pinEntries(options.treeDir, options.pinSha);
    for (const input of options.inputs) {
        const problem = placementProblem(input.to, options, pin);
        if (problem !== null) {
            throw ckError('CONFIG', `input ${input.name}: to ${input.to} ${problem}`, 'choose a directory that the pin, the patch set and the project type all leave free');
        }
    }
}
function placementProblem(to, options, pin) {
    for (const owned of options.roots) {
        if (pathsOverlap(to, owned.path))
            return `meets the directory ${owned.path} the delta owns`;
    }
    const extensions = extensionRootOf(options.type);
    if (extensions !== null && pathsOverlap(to, extensions))
        return `meets ${extensions}, where the type materializes own extensions`;
    for (const root of options.type.build.dependencyRoots) {
        if (pathsOverlap(to, root))
            return `meets ${root}, where the type installs its dependencies`;
    }
    if (matchesPatternList(`${to}/`, options.cleanupWhitelist))
        return 'is a place the build of the type writes (its cleanup whitelist names it)';
    const outputs = [
        ...options.type.build.packageOutputs,
        ...(options.type.build.packageTargets ?? []).flatMap((target) => target.outputs ?? [])
    ];
    const output = outputs.find((pattern) => patternMeets(to, pattern));
    if (output !== undefined)
        return `meets ${output}, where the packaging of the type writes`;
    const lower = to.toLowerCase();
    const ancestors = lower.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'));
    if (pin.paths.has(lower) || [...pin.paths].some((path) => path.startsWith(`${lower}/`)))
        return 'meets paths the pin carries';
    if (ancestors.slice(0, -1).some((ancestor) => pin.blobs.has(ancestor)))
        return 'lies under a file the pin carries';
    const spelled = to.split('/').map((_, index, segments) => segments.slice(0, index + 1).join('/'));
    const folded = spelled.slice(0, -1).find((ancestor) => pin.paths.has(ancestor.toLowerCase()) && !pin.exact.has(ancestor));
    if (folded !== undefined)
        return `names ${folded}, which differs only in case from a directory of the pin`;
    const target = options.deliveredTargets.find((path) => pathsOverlap(to, path));
    if (target !== undefined)
        return `meets ${target}, which the patch set delivers`;
    return null;
}
/**
 * A pattern of the packaging meets `to` when it names `to` or a directory above
 * it, or when its leading segments name `to` and it goes on inside it.
 */
function patternMeets(to, pattern) {
    const segments = to.split('/');
    for (let count = 1; count <= segments.length; count += 1) {
        if (matchesTreePattern(segments.slice(0, count).join('/'), pattern.endsWith('/') ? pattern : `${pattern}/`))
            return true;
    }
    const patternSegments = (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).split('/');
    return patternSegments.length > segments.length && matchesTreePattern(to, `${patternSegments.slice(0, segments.length).join('/')}/`);
}
/** The directory the type materializes own extensions in, or null when it has none. */
function extensionRootOf(type) {
    const probe = type.layout.ownExtensionPath('probe');
    if (probe === null)
        return null;
    const cut = probe.lastIndexOf('/');
    return cut === -1 ? null : probe.slice(0, cut);
}
/** Every path of the pin, directories included, lower-cased: a checkout on Windows or macOS folds case. */
function pinEntries(treeDir, pinSha) {
    const listed = runGit({ args: ['ls-tree', '-r', '-t', '-z', '--full-tree', pinSha], cwd: treeDir, maxBuffer: 512 * 1024 * 1024 });
    if (listed.status !== 0) {
        throw ckError('CONFIG', `cannot read the pin to place the inputs: ${listed.stderr.trim().split('\n')[0] ?? ''}`, 'run over a fork tree that holds the pin');
    }
    const paths = new Set();
    const exact = new Set();
    const blobs = new Set();
    for (const record of listed.stdout.split('\0')) {
        const tab = record.indexOf('\t');
        if (tab === -1)
            continue;
        const path = record.slice(tab + 1);
        paths.add(path.toLowerCase());
        exact.add(path);
        if (record.split(' ')[1] !== 'tree')
            blobs.add(path.toLowerCase());
    }
    return { paths, exact, blobs };
}
