/** @scope spec://codkit/modules/codkit/PROP-003#root */
// The declaration of the inputs of a patch set (PROP-003 ##CFG-INPUTS): the
// schema of the top-level `inputs` list of codkit.json, the one field
// codkit.local.json may set in an entry, and the rules that span entries. Where
// `to` may land in a tree is inputsPlacement.ts: that needs the project type
// and the pin, which a schema does not have.
//
// Nothing here names a kind of input. An input is a directory another
// repository builds; what is in it is the declaration's business.
import { posix, win32 } from 'node:path';
import { z } from 'zod';
import { repoRelativePathProblem, safeBasenameProblem } from './pathSafety.js';
const SHA40 = /^[0-9a-f]{40}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
/** `host:path` and `user@host:path`, the short forms git reads as a remote. */
const REMOTE_SHORTHAND = /^[^/\\]+:/;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/**
 * ##INPUTS-LOCAL-REPOSITORY: an input's repository is a local git repository,
 * named by an absolute path. A remote address is refused: `load` and `ci` never
 * reach the network, and codkit keeps no cache of fetched repositories.
 */
export function localRepositoryProblem(value) {
    if (value === '')
        return 'must not be empty';
    if (CONTROL.test(value))
        return 'must not contain control characters';
    if (URL_SCHEME.test(value) || (REMOTE_SHORTHAND.test(value) && !DRIVE_ABSOLUTE.test(value))) {
        return 'names a remote repository; clone it and name the clone';
    }
    if (!posix.isAbsolute(value) && !win32.isAbsolute(value))
        return 'must be an absolute path';
    return null;
}
/** A segment git itself refuses to carry in a tree, whatever its case. */
export function hasGitSegment(path) {
    return path.split('/').some((segment) => segment.toLowerCase() === '.git');
}
/** `a` equals `b` or one is a directory of the other, compared ignoring case. */
export function pathsOverlap(a, b) {
    const left = a.toLowerCase();
    const right = b.toLowerCase();
    return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}
const safePath = z.string().refine((value) => repoRelativePathProblem(value) === null);
const inputName = z.string().refine((value) => safeBasenameProblem(value) === null);
const inputRepository = z.string().refine((value) => localRepositoryProblem(value) === null);
const argv = z
    .array(z.string().refine((word) => !word.includes('\0')))
    .min(1)
    .refine((words) => (words[0] ?? '') !== '');
const inputSchema = z.strictObject({
    name: inputName,
    repository: inputRepository,
    ref: z.string().regex(SHA40),
    build: z.array(argv).default([]),
    dependencyRoots: z.array(safePath).default([]),
    env: z
        .record(z.string().regex(ENV_NAME), z.string().refine((value) => !value.includes('\0')))
        .default({}),
    from: safePath,
    to: safePath.refine((value) => !hasGitSegment(value))
});
/**
 * The cross-entry rules: a name is used once, two inputs never share a
 * directory of the tree, a dependency root is named once, and two variables of
 * one input never differ in case alone (Windows would see one variable).
 */
export const inputsSchema = z.array(inputSchema).superRefine((inputs, context) => {
    inputs.forEach((input, index) => {
        for (const other of inputs.slice(0, index)) {
            if (other.name === input.name)
                context.addIssue({ code: 'custom', message: 'duplicate', path: [index, 'name'] });
            if (pathsOverlap(other.to, input.to))
                context.addIssue({ code: 'custom', message: 'overlap', path: [index, 'to'] });
        }
        if (new Set(input.dependencyRoots).size !== input.dependencyRoots.length) {
            context.addIssue({ code: 'custom', message: 'duplicate', path: [index, 'dependencyRoots'] });
        }
        const names = Object.keys(input.env).map((name) => name.toUpperCase());
        if (new Set(names).size !== names.length)
            context.addIssue({ code: 'custom', message: 'case', path: [index, 'env'] });
    });
});
/** codkit.local.json: the location of an input on this machine, and nothing it takes. */
export const localInputsSchema = z
    .array(z.strictObject({ name: inputName, repository: inputRepository }))
    .superRefine((inputs, context) => {
    inputs.forEach((input, index) => {
        if (inputs.slice(0, index).some((other) => other.name === input.name)) {
            context.addIssue({ code: 'custom', message: 'duplicate', path: [index, 'name'] });
        }
    });
});
/** The fields of an entry of codkit.local.json `inputs`: its key and its location. */
const LOCAL_INPUT_FIELDS = ['name', 'repository'];
/**
 * ##LOCAL-CONFIG-RULE: the first field of a local `inputs` entry that says what
 * an input takes rather than where it is, or null. Every such field is reviewed
 * in codkit.json.
 */
export function localInputContentField(inputs) {
    if (!Array.isArray(inputs))
        return null;
    for (const entry of inputs) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            continue;
        const field = Object.keys(entry).find((key) => !LOCAL_INPUT_FIELDS.includes(key));
        if (field !== undefined)
            return field;
    }
    return null;
}
/**
 * ##LOCAL-CONFIG-RULE: the location of an input on this machine replaces the
 * shared one; everything the input takes stays as codkit.json declares it. A
 * local entry for a name codkit.json does not declare changes nothing - `status`
 * names it.
 */
export function locateInputs(inputs, local) {
    if (local === undefined)
        return inputs;
    return inputs.map((input) => {
        const location = local.find((entry) => entry.name === input.name);
        return location === undefined ? input : { ...input, repository: location.repository };
    });
}
const INPUT_SAMPLE = '"inputs": [{ "name": "<name>", "repository": "<absolute path>", "ref": "<40 hex>", "from": "<dir>", "to": "<dir>" }]';
/** Diagnostics of the `inputs` fields, joined into the table of configFile.ts. */
export const INPUT_FIELD_DOCS = {
    inputs: {
        required: 'inputs is optional',
        invalid: 'inputs must be a list of objects whose fields are name, repository, ref, build, dependencyRoots, env, from and to',
        hint: `set ${INPUT_SAMPLE}`
    },
    'inputs.name': {
        required: 'inputs.name is required (the name of the input)',
        invalid: 'inputs.name must be one portable name (letters, digits, dot, underscore or dash) that no other input uses',
        hint: 'set "name": "<name>"'
    },
    'inputs.repository': {
        required: 'inputs.repository is required (the absolute path of the local git repository)',
        invalid: 'inputs.repository must be the absolute path of a local git repository; a remote address is not supported',
        hint: 'clone the repository and name the clone; codkit.local.json may name another location on this machine'
    },
    'inputs.ref': {
        required: 'inputs.ref is required (the full commit id the release takes)',
        invalid: 'inputs.ref must be a full 40-hex commit id',
        hint: 'run: codkit inputs pin <name>   (or git -C <repository> rev-parse HEAD)'
    },
    'inputs.build': {
        required: 'inputs.build is optional',
        invalid: 'inputs.build must be a list of commands, each a non-empty list of words whose first word names the program',
        hint: 'set "build": [["<program>", "<argument>"]]; there is no shell'
    },
    'inputs.dependencyRoots': {
        required: 'inputs.dependencyRoots is optional',
        invalid: 'inputs.dependencyRoots must be a list of distinct safe paths from the root of the input repository',
        hint: 'set "dependencyRoots": ["<dir>"]'
    },
    'inputs.env': {
        required: 'inputs.env is optional',
        invalid: 'inputs.env must map variable names of letters, digits and _ (not starting with a digit, unique ignoring case) to strings',
        hint: 'set "env": { "NAME": "value" }'
    },
    'inputs.from': {
        required: 'inputs.from is required (the directory of the built copy to take)',
        invalid: 'inputs.from must be a safe path from the root of the input repository',
        hint: 'set "from": "<dir>"'
    },
    'inputs.to': {
        required: 'inputs.to is required (where the input lands in the tree)',
        invalid: 'inputs.to must be a safe path from the tree root without a .git segment, and neither equal to, inside nor around the to of another input',
        hint: 'set "to": "<dir>"'
    }
};
/** The same table for codkit.local.json, which may name only the location. */
export const LOCAL_INPUT_FIELD_DOCS = {
    inputs: {
        required: 'inputs is optional',
        invalid: 'inputs of codkit.local.json must be a list of { "name", "repository" } objects, each name once',
        hint: 'set "inputs": [{ "name": "<name>", "repository": "<absolute path>" }]'
    },
    'inputs.name': {
        required: 'inputs.name is required (the name of the input codkit.json declares)',
        invalid: 'inputs.name must be one portable name that no other entry of the file uses',
        hint: 'name an input of codkit.json'
    },
    'inputs.repository': INPUT_FIELD_DOCS['inputs.repository'] ?? {
        required: 'inputs.repository is required',
        invalid: 'inputs.repository is invalid',
        hint: ''
    }
};
