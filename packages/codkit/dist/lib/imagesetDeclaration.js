/** @scope spec://codkit/modules/codkit/PROP-007#IMAGESET-MASTERS */
// The product's declaration of its image set (##IMAGESET-DECLARATION):
// imageset.json in the root of the masters directory, next to the masters it
// names and versioned with them in the product repository. It says the two
// things a shipped file cannot: the frame set of a target
// (##IMAGESET-DECLARED-FRAMES) and which master key serves which of its frames
// (##IMAGESET-DECLARED-SOURCES).
//
// Every verb of the namespace reads it here and validates all of it before it
// reads a master or writes a byte: a declaration is applied exactly or refused
// with CK-E-CONFIG, never applied in part and never ignored. What a frame set
// may be is the codec's answer, so this module, like the engine, names no
// container. The scope names the masters directory the file belongs to; the
// facts it implements are cited where they apply.
import { existsSync, readFileSync } from 'node:fs';
import { codecFor } from './imagesetCodec.js';
import { DECLARATION_FILE, hasMasters, inBranding } from './imagesetMasters.js';
import { artworkKey } from './imagesetTargets.js';
import { ckError } from './messages.js';
/** The version of the declaration's form this tool reads. */
const DECLARATION_VERSION = 1;
/** A master key: one segment, or family/artwork, never starting with a dot. */
const KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/u;
/** The declaration of a masters directory, checked in form; null when there is none. */
export function readDeclaration(brandingDir) {
    const file = inBranding(brandingDir, DECLARATION_FILE);
    if (!existsSync(file)) {
        return null;
    }
    const fail = (message, hint) => {
        throw ckError('CONFIG', message, hint, file);
    };
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (error) {
        fail(`is not valid JSON: ${error instanceof Error ? error.message : String(error)}`, 'fix the JSON syntax of the declaration');
    }
    const top = objectOr(raw, () => fail('must be a JSON object', `write {"codkitImageset": ${DECLARATION_VERSION}, "targets": {...}}`));
    onlyMembers(top, ['codkitImageset', 'targets'], '', 'version 1 knows codkitImageset and targets', fail);
    if (top['codkitImageset'] !== DECLARATION_VERSION) {
        const found = 'codkitImageset' in top ? JSON.stringify(top['codkitImageset']) : 'missing';
        fail(`codkitImageset must be ${DECLARATION_VERSION}, and it is ${found}`, `write "codkitImageset": ${DECLARATION_VERSION}`);
    }
    const entries = objectOr(top['targets'], () => fail('targets must be an object from target paths to their entries', 'write "targets": {"<path in the fork tree>": {...}}'));
    const targets = new Map();
    for (const [path, value] of Object.entries(entries)) {
        targets.set(path, entryOf(path, value, fail));
    }
    return { file, targets };
}
function entryOf(path, value, fail) {
    const entry = objectOr(value, () => fail(`${path}: an entry must be an object`, 'write {"frames": [...], "sources": [...]}'));
    onlyMembers(entry, ['frames', 'sources'], `${path}: `, 'an entry knows frames and sources', fail);
    if (!('frames' in entry) && !('sources' in entry)) {
        fail(`${path}: the entry declares neither frames nor sources`, 'declare the frames of the target, the sources of some of its frames, or remove the entry');
    }
    let frames = null;
    if ('frames' in entry) {
        const listed = entry['frames'];
        if (!Array.isArray(listed) || !listed.every((size) => typeof size === 'number')) {
            fail(`${path}: frames must be a list of sizes in pixels`, 'write "frames": [16, 32, 256]');
        }
        frames = listed;
    }
    let sources = [];
    if ('sources' in entry) {
        const rules = entry['sources'];
        if (!Array.isArray(rules)) {
            fail(`${path}: sources must be a list of rules`, 'write "sources": [{"key": "<key>", "maxSize": 64}]');
        }
        sources = rules.map((rule, index) => ruleOf(`${path}: sources[${index}]`, rule, fail));
    }
    return { frames, sources };
}
/**
 * One rule, with the contradictions a rule can carry on its own refused here:
 * two selectors, none, an inverted range, a size listed twice.
 */
function ruleOf(where, value, fail) {
    const rule = objectOr(value, () => fail(`${where}: a rule must be an object`, 'write {"key": "<key>", "maxSize": 64}'));
    onlyMembers(rule, ['key', 'sizes', 'minSize', 'maxSize'], `${where}: `, 'a rule knows key, sizes, minSize and maxSize', fail);
    const key = rule['key'];
    if (key === undefined) {
        fail(`${where}: the rule names no key`, 'add "key": "<key>", the key whose masters serve the frames the rule selects');
    }
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
        fail(`${where}: key must be a master key - one segment, or family/artwork, of letters, digits, '.', '_' and '-' - and ${JSON.stringify(key)} is not`, 'name the key the way its masters are named: taskbar for taskbar.svg and taskbar-16.png');
    }
    const hasList = 'sizes' in rule;
    const hasRange = 'minSize' in rule || 'maxSize' in rule;
    if (hasList && hasRange) {
        fail(`${where}: selects by sizes and by a range at once, and a rule takes one selector`, 'keep either sizes, or minSize and maxSize');
    }
    if (!hasList && !hasRange) {
        fail(`${where}: selects no frame: a rule takes sizes, or minSize and maxSize`, 'add "sizes": [16, 32], or "maxSize": 64');
    }
    if (hasList) {
        const sizes = rule['sizes'];
        if (!Array.isArray(sizes) || sizes.length === 0 || !sizes.every(isSize)) {
            fail(`${where}: sizes must be a non-empty list of whole sizes in pixels`, 'write "sizes": [16, 32]');
        }
        const listed = sizes;
        const twice = listed.find((size, at) => listed.indexOf(size) !== at);
        if (twice !== undefined) {
            fail(`${where}: the size ${twice} is listed twice`, 'list every size once');
        }
        return { key: key, sizes: listed, minSize: null, maxSize: null };
    }
    const minSize = 'minSize' in rule ? rule['minSize'] : null;
    const maxSize = 'maxSize' in rule ? rule['maxSize'] : null;
    if (('minSize' in rule && !isSize(minSize)) || ('maxSize' in rule && !isSize(maxSize))) {
        fail(`${where}: minSize and maxSize must be whole sizes in pixels`, 'write "minSize": 128, or "maxSize": 64');
    }
    if (minSize !== null && maxSize !== null && minSize > maxSize) {
        fail(`${where}: minSize ${String(minSize)} is greater than maxSize ${String(maxSize)}`, 'give the smaller bound as minSize');
    }
    return { key: key, sizes: null, minSize: minSize, maxSize: maxSize };
}
/**
 * The targets as the verbs work on them. Without a declaration every target
 * keeps its shipped frames and its own key; with one, every declared target is
 * checked against the distribution, its container and its masters, and the
 * first problem refuses the whole declaration.
 */
export function resolveTargets(type, discovered, declaration, brandingDir, virtualMasters = new Set()) {
    if (declaration === null) {
        return discovered.map((target) => undeclared(target));
    }
    const fail = (message, hint) => {
        throw ckError('CONFIG', message, hint, declaration.file);
    };
    const known = new Set(discovered.map((target) => target.target));
    for (const path of declaration.targets.keys()) {
        if (!known.has(path)) {
            fail(`${path} is not an image target of this distribution`, 'name a target by its path in the fork tree, exactly as codkit imageset index prints it');
        }
    }
    return discovered.map((target) => {
        const entry = declaration.targets.get(target.target);
        if (entry === undefined) {
            return undeclared(target);
        }
        const frames = entry.frames === null ? target.frames : declaredFramesOf(type, target, entry.frames, fail);
        const frameSources = frameSourcesOf(target, frames, entry.sources, brandingDir, virtualMasters, fail);
        return { ...target, frames, shippedFrames: target.frames, framesDeclared: entry.frames !== null, frameSources };
    });
}
function undeclared(target) {
    const own = artworkKey(target);
    return {
        ...target,
        shippedFrames: target.frames,
        framesDeclared: false,
        frameSources: target.frames.map(() => ({ key: own, declared: false }))
    };
}
/** The declared frame set, as the codec of the target's container answers it (##IMAGESET-DECLARED-FRAMES). */
function declaredFramesOf(type, target, sizes, fail) {
    const answer = codecFor(type, target.kind).declaredFrames;
    if (answer === undefined) {
        fail(`${target.target}: a declared frame set is not supported for a target of the ${target.kind} container`, 'remove frames from this entry: the target keeps the frames its shipped file carries');
    }
    const problem = answer.problem(sizes);
    if (problem !== null) {
        fail(`${target.target}: frames: ${problem}`, 'declare a frame set this container can carry');
    }
    return answer.frames(sizes);
}
/** The key of every frame: a rule's where one selects it, the target's own elsewhere (##IMAGESET-DECLARED-SOURCES). */
function frameSourcesOf(target, frames, rules, brandingDir, virtualMasters, fail) {
    const chosenBy = frames.map(() => null);
    rules.forEach((rule, index) => {
        const where = `${target.target}: sources[${index}]`;
        for (const at of selectedFrames(rule, frames, where, fail)) {
            const earlier = chosenBy[at];
            if (earlier !== null && earlier !== undefined) {
                const frame = frames[at];
                fail(`${where} selects the ${frame?.width ?? 0}x${frame?.height ?? 0} frame, which sources[${earlier}] selects already`, 'give every frame one rule at most');
            }
            chosenBy[at] = index;
        }
        if (!hasMasters(brandingDir, rule.key, virtualMasters)) {
            fail(`${where}: the key ${rule.key} has no master in ${brandingDir}`, `add ${rule.key}.svg, ${rule.key}.png or ${rule.key}-<N>.png to the masters directory, or name a key that has masters`);
        }
    });
    const own = artworkKey(target);
    return frames.map((_, at) => {
        const rule = rules[chosenBy[at] ?? -1];
        return rule === undefined ? { key: own, declared: false } : { key: rule.key, declared: true };
    });
}
/** The positions a rule selects: square frames, by their size; never none. */
function selectedFrames(rule, frames, where, fail) {
    const sizeOf = (frame) => (frame.width === frame.height ? frame.width : null);
    if (rule.sizes !== null) {
        return rule.sizes.flatMap((size) => {
            const matching = frames.flatMap((frame, at) => (sizeOf(frame) === size ? [at] : []));
            if (matching.length === 0) {
                fail(`${where}: the size ${size} is not a frame of the target`, 'list only sizes the target carries - the declared frames, or those of its shipped file');
            }
            return matching;
        });
    }
    const selected = frames.flatMap((frame, at) => {
        const size = sizeOf(frame);
        const inside = size !== null && (rule.minSize === null || size >= rule.minSize) && (rule.maxSize === null || size <= rule.maxSize);
        return inside ? [at] : [];
    });
    if (selected.length === 0) {
        fail(`${where}: ${rangeText(rule)} selects no frame of the target`, 'widen the range to the sizes the target carries, or remove the rule');
    }
    return selected;
}
function rangeText(rule) {
    if (rule.minSize !== null && rule.maxSize !== null) {
        return `the range ${rule.minSize} to ${rule.maxSize} px`;
    }
    return rule.minSize !== null ? `the range from ${rule.minSize} px` : `the range up to ${String(rule.maxSize)} px`;
}
function isSize(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
function objectOr(value, otherwise) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return otherwise();
    }
    return value;
}
function onlyMembers(value, known, where, knows, fail) {
    for (const name of Object.keys(value)) {
        if (!known.includes(name)) {
            fail(`${where}unknown member ${JSON.stringify(name)}: ${knows}`, 'remove the member, or correct its spelling');
        }
    }
}
