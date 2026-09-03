/** @scope spec://codkit/modules/codkit/PROP-007#root */
// Command vocabulary shared by main.ts and every command module.
//
// PROP-002 ##DEPENDENCY-RULE-BETWEEN-MODULES: commands are thin functions over
// the libraries; each receives an already-resolved context and returns an exit
// code, so a command can be exercised without a process.
import { requireForkDir, requirePatchesDir } from './paths.js';
/** Value of a `--name <value>` flag, or null when it was not given. */
export function commandFlagValue(flags, name) {
    const value = flags.get(name);
    return typeof value === 'string' ? value : null;
}
/** Values of a repeatable `--name <value>` flag, in the order they were given. */
export function commandFlagList(flags, name) {
    const value = flags.get(name);
    if (Array.isArray(value)) {
        return value;
    }
    return typeof value === 'string' ? [value] : [];
}
/** Whether a boolean command flag was given. */
export function commandFlagGiven(flags, name) {
    return flags.has(name);
}
/** Absolute patch-set root required by commands that read or write patch data. */
export function patchesRoot(ctx) {
    return requirePatchesDir(ctx.locations).path;
}
/** Managed VS Code checkout required by commands that operate on the fork. */
export function forkResolution(ctx) {
    return requireForkDir(ctx.locations);
}
export const EXIT_OK = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_ENVIRONMENT = 2;
export const EXIT_NEEDS_HUMAN = 3;
