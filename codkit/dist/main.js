/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit entry point: argv parsing, command dispatch, exit codes, --json.
//
// Contracts: PROP-007 sec. 1 (global flags, exit codes, hints), PROP-012 sec. 1-2
// (envelope, error registry). Executed by node's type stripping through
// codkit/bin/codkit.mjs - nothing here is compiled ahead of time.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDownCommand, buildErrorsCommand, buildStatusCommand, buildUpCommand } from './commands/build.js';
import { checkTreeCommand } from './commands/checkTree.js';
import { ciCommand } from './commands/ci.js';
import { cloneCommand } from './commands/clone.js';
import { cycleCommand } from './commands/cycle.js';
import { forecastCommand } from './commands/forecast.js';
import { hooksCommand } from './commands/hooks.js';
import { inventoryCommand } from './commands/inventory.js';
import { markerNewCommand } from './commands/markerNew.js';
import { overlayApplyCommand, overlayCheckCommand } from './commands/overlay.js';
import { publishCommand } from './commands/publish.js';
import { rebaseOntoPinCommand } from './commands/rebaseOntoPin.js';
import { reresolveCommand } from './commands/reresolve.js';
import { saveCommand } from './commands/save.js';
import { statusCommand } from './commands/status.js';
import { syncCommand } from './commands/sync.js';
import { verifyCommand } from './commands/verify.js';
import { whereCommand } from './commands/where.js';
import { parseArgv, GLOBAL_FLAG_HELP } from './lib/argv.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './lib/command.js';
import { loadConfig } from './lib/configFile.js';
import { Output, readCodkitVersion } from './lib/jsonOut.js';
import { isCkError } from './lib/messages.js';
import { assertDisjointRoots, formatPatchesLine, requirePatchesDir, resolveLocations } from './lib/paths.js';
import { loadSettings } from './lib/settingsFile.js';
/** Longest command name in words; `marker new` and `overlay check` make this 2. */
const MAX_COMMAND_WORDS = 2;
/** Diagnosed domain verdicts: the command ran, but its requested check failed. */
const CHECK_ERROR_CODES = new Set(['DIRTY-TREE']);
const COMMANDS = new Map([
    whereCommand,
    checkTreeCommand,
    cloneCommand,
    syncCommand,
    statusCommand,
    saveCommand,
    markerNewCommand,
    reresolveCommand,
    inventoryCommand,
    verifyCommand,
    overlayApplyCommand,
    overlayCheckCommand,
    buildUpCommand,
    buildDownCommand,
    buildStatusCommand,
    buildErrorsCommand,
    cycleCommand,
    forecastCommand,
    rebaseOntoPinCommand,
    ciCommand,
    publishCommand,
    hooksCommand
].map((definition) => [definition.name, definition]));
/** Immutable Codkit install/source root; never discovered from cwd or settings. */
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
process.exitCode = await main(process.argv.slice(2));
async function main(argv) {
    const parsed = parseArgv(argv);
    if (!parsed.ok) {
        return usageFail(parsed.problem);
    }
    const { flags, commandFlags, positional } = parsed.value;
    if (positional.length === 0) {
        printHelp();
        return EXIT_OK;
    }
    const matched = matchCommand(positional);
    if (matched === null) {
        return usageFail({
            error: `unknown command: ${positional.join(' ')}`,
            hint: `available commands: ${[...COMMANDS.keys()].join(', ')}`
        });
    }
    if (matched.args.length > matched.definition.maxArgs) {
        const allowed = matched.definition.maxArgs === 0 ? 'takes no arguments' : `takes at most ${matched.definition.maxArgs} argument(s)`;
        return usageFail({
            error: `command '${matched.definition.name}' ${allowed} (got: ${matched.args.join(' ')})`,
            hint: `usage: codkit ${matched.definition.name} [global flags]`
        });
    }
    const misplaced = misplacedFlag(matched.definition, commandFlags);
    if (misplaced !== null) {
        return usageFail(misplaced);
    }
    const out = new Output({
        command: matched.definition.name,
        version: readCodkitVersion(toolRoot),
        jsonMode: flags.json
    });
    out.setToolRoot(toolRoot);
    try {
        const settingsFields = rootSettingsNeeded(flags, process.env);
        const settings = settingsFields.patchesDir || settingsFields.forkDir ? loadSettings(undefined, settingsFields) : { codkitSettings: 1 };
        const locations = resolveLocations(flags, process.env, settings);
        out.setRoots(toolRoot, locations);
        assertDisjointRoots(toolRoot, locations);
        const needsPatches = matched.definition.name !== 'where';
        const patches = needsPatches ? requirePatchesDir(locations) : locations.patchesDir;
        const patchRoot = patches?.path ?? '';
        if (needsPatches && patches !== null)
            out.info(formatPatchesLine(patches));
        const config = matched.definition.configMode === 'none' ? null : loadConfig(patchRoot);
        const exitCode = await matched.definition.run({
            toolRoot,
            locations,
            patchesDir: patchRoot,
            args: matched.args,
            flags,
            commandFlags,
            env: process.env,
            config,
            out
        });
        return out.finish(exitCode);
    }
    catch (error) {
        return out.finish(reportFailure(out, error, flags));
    }
}
function rootSettingsNeeded(flags, env) {
    return {
        patchesDir: flags.patchesDir === null && env['CODKIT_PATCHES_DIR'] === undefined,
        forkDir: flags.forkDir === null && env['CODKIT_FORK_DIR'] === undefined
    };
}
/** A command-specific flag given to a command that does not declare it. */
function misplacedFlag(definition, given) {
    const accepted = [...(definition.commandFlags ?? []), ...(definition.hiddenFlags ?? [])];
    const advertised = definition.commandFlags ?? [];
    for (const name of given.keys()) {
        if (!accepted.includes(name)) {
            const usable = advertised.length === 0 ? 'it takes global flags only' : `it takes: ${advertised.join(', ')}`;
            return {
                error: `flag ${name} is not a flag of command '${definition.name}'`,
                hint: `${usable}; see codkit --help for the global flags`
            };
        }
    }
    return null;
}
/** Longest-first match, so `marker new` wins over a hypothetical `marker`. */
function matchCommand(positional) {
    for (let words = Math.min(MAX_COMMAND_WORDS, positional.length); words >= 1; words -= 1) {
        const name = positional.slice(0, words).join(' ');
        const definition = COMMANDS.get(name);
        if (definition !== undefined) {
            return { definition, args: positional.slice(words) };
        }
    }
    return null;
}
/**
 * Turn any escaped throwable into output. A CkError is a diagnosed condition;
 * anything else is a bug in codkit and is reported as CK-E-INTERNAL.
 */
function reportFailure(out, error, flags) {
    if (isCkError(error)) {
        out.addError(error.toPayload());
        return CHECK_ERROR_CODES.has(error.code) ? EXIT_CHECK_FAILED : EXIT_ENVIRONMENT;
    }
    const message = error instanceof Error ? error.message : String(error);
    out.addError({
        code: 'INTERNAL',
        message,
        hint: 're-run with --verbose and attach the output to a bug report'
    });
    if (flags.verbose && error instanceof Error && error.stack !== undefined) {
        process.stderr.write(`${error.stack}\n`);
    }
    return EXIT_ENVIRONMENT;
}
/**
 * Usage problems are reported plainly: they happen before a command context
 * exists, and the message registry has no code for "you typed it wrong".
 */
function usageFail(problem) {
    process.stderr.write(`error: ${problem.error}\n`);
    process.stderr.write(`hint: ${problem.hint}\n`);
    return EXIT_ENVIRONMENT;
}
function printHelp() {
    const lines = ['codkit - manage a patch set over a VS Code fork tree', '', 'usage: codkit <command> [flags]', '', 'commands:'];
    for (const definition of COMMANDS.values()) {
        const own = definition.commandFlags ?? [];
        const suffix = own.length === 0 ? '' : ` (flags: ${own.join(', ')})`;
        lines.push(`  ${definition.name.padEnd(18)}${definition.summary}${suffix}`);
    }
    lines.push('', 'global flags:');
    for (const flag of GLOBAL_FLAG_HELP) {
        lines.push(`  ${flag}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
}
