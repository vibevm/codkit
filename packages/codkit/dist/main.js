/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit entry point: argv parsing, command dispatch, exit codes, --json.
//
// Contracts: PROP-007 sec. 1 (global flags, exit codes, hints), PROP-012 sec. 1-2
// (envelope, error registry). Executed by node's type stripping through
// bin/codkit.mjs - nothing here is compiled ahead of time.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDownCommand, buildErrorsCommand, buildStatusCommand, buildUpCommand } from './commands/build.js';
import { checkTreeCommand } from './commands/checkTree.js';
import { ciCommand } from './commands/ci.js';
import { cloneCommand } from './commands/clone.js';
import { configCommand, configMigrateCommand } from './commands/config.js';
import { cycleCommand } from './commands/cycle.js';
import { forecastCommand } from './commands/forecast.js';
import { gcCommand } from './commands/gc.js';
import { genBrandCommand, genCommand, genFeatureCommand, genLicensingCommand } from './commands/gen.js';
import { hooksCommand } from './commands/hooks.js';
import { imagesetCommand, imagesetGenCommand, imagesetIndexCommand, imagesetVerifyCommand } from './commands/imageset.js';
import { inputsCommand, inputsPinCommand } from './commands/inputs.js';
import { inventoryCommand } from './commands/inventory.js';
import { consumerLicenseCheckCommand } from './commands/consumerLicense.js';
import { licenseAnnotateCommand, licenseCheckCommand, licenseCommand, licenseNoticesCommand } from './commands/license.js';
import { loadCommand } from './commands/load.js';
import { markerNewCommand } from './commands/markerNew.js';
import { markerReasonCommand } from './commands/markerReason.js';
import { overlayApplyCommand, overlayCheckCommand, overlayNewCommand } from './commands/overlay.js';
import { packageCommand } from './commands/package.js';
import { previewCommand } from './commands/preview.js';
import { publishCommand } from './commands/publish.js';
import { rebaseOntoPinCommand } from './commands/rebaseOntoPin.js';
import { reresolveCommand } from './commands/reresolve.js';
import { runtimeCheckCommand, runtimeCommand, runtimeLoadCommand } from './commands/runtime.js';
import { saveCommand } from './commands/save.js';
import { standardsCheckCommand, standardsCommand, standardsLicenseCommand, standardsLoadCommand } from './commands/standards.js';
import { statusCommand } from './commands/status.js';
import { syncCommand } from './commands/sync.js';
import { typesCommand } from './commands/types.js';
import { verifyCommand } from './commands/verify.js';
import { whereCommand } from './commands/where.js';
import { workspaceCommands } from './commands/workspace.js';
import { selectWorkspace } from './lib/workspaceSelection.js';
import { workspaceConfig } from './lib/workspaceConfig.js';
import { resolveWorkspaceType } from './lib/workspaceType.js';
import { parseArgv, GLOBAL_FLAG_HELP } from './lib/argv.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from './lib/command.js';
import { loadConfig } from './lib/configFile.js';
import { Output, readCodkitVersion } from './lib/jsonOut.js';
import { ckError, isCkError } from './lib/messages.js';
import { assertDisjointRoots, formatPatchesLine, requirePatchesDir, resolveLocations } from './lib/paths.js';
import { loadSettings } from './lib/settingsFile.js';
import { configureProjectType } from './types/configure.js';
import { resolveProjectType } from './types/registry.js';
import { assertTypeConfig } from './types/typeConfig.js';
/** Longest command name in words; `marker new` and `overlay check` make this 2. */
const MAX_COMMAND_WORDS = 2;
/** Width of the name column in `codkit --help`; the longest name plus two. */
const HELP_NAME_COLUMN = 19;
/** The one command-scoped help flag; a namespace answers it instead of usage. */
const GLOBAL_FLAG_HELP_NAME = '--help';
/** Diagnosed domain verdicts: the command ran, but its requested check failed. */
// STANDARDS-DRIFT joins them: an installed copy that someone edited is a
// verdict about the patch set, not a broken environment - `standards load`
// ran, looked and refused (PROP-014 ##STD-LOAD-STEP-DRIFT-REFUSAL). RUNTIME-DRIFT
// is the same verdict about the runtime library (PROP-015 ##RT-LOAD-STEPS).
const CHECK_ERROR_CODES = new Set(['DIRTY-TREE', 'STANDARDS-DRIFT', 'RUNTIME-DRIFT']);
const COMMANDS = new Map([
    whereCommand,
    ...workspaceCommands,
    typesCommand,
    configCommand,
    configMigrateCommand,
    checkTreeCommand,
    cloneCommand,
    loadCommand,
    statusCommand,
    saveCommand,
    syncCommand,
    gcCommand,
    markerNewCommand,
    markerReasonCommand,
    reresolveCommand,
    inventoryCommand,
    verifyCommand,
    overlayNewCommand,
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
    packageCommand,
    previewCommand,
    publishCommand,
    inputsCommand,
    inputsPinCommand,
    hooksCommand,
    imagesetCommand,
    imagesetGenCommand,
    imagesetIndexCommand,
    imagesetVerifyCommand,
    licenseCommand,
    licenseCheckCommand,
    consumerLicenseCheckCommand,
    licenseAnnotateCommand,
    licenseNoticesCommand,
    standardsCommand,
    standardsLoadCommand,
    standardsCheckCommand,
    standardsLicenseCommand,
    runtimeCommand,
    runtimeLoadCommand,
    runtimeCheckCommand,
    genCommand,
    genFeatureCommand,
    genBrandCommand,
    genLicensingCommand
].map((definition) => [definition.name, definition]));
/** Immutable Codkit install/source root; never discovered from cwd or settings. */
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
    // A namespace carries no work: it answers with the usage of its subcommands
    // and exit 2, exactly as an unknown command does, and it does so before any
    // root is resolved. Only its `--help` reaches the command itself.
    if (matched.definition.namespace === true && !commandFlags.has(GLOBAL_FLAG_HELP_NAME)) {
        const name = matched.definition.name;
        const subcommands = [...COMMANDS.keys()].filter((candidate) => candidate.startsWith(`${name} `));
        const given = matched.args.length === 0 ? 'no subcommand given' : `unknown subcommand: ${matched.args.join(' ')}`;
        // Only a namespace that declares `--help` has one to point at; the licence
        // and standards families answer through the command reference instead
        // (PROP-007 ##LICENSE-NAMESPACE), so offering them a flag they refuse
        // would send a person straight into a usage error.
        const help = (matched.definition.commandFlags ?? []).includes(GLOBAL_FLAG_HELP_NAME) ? `; see codkit ${name} --help` : '';
        return usageFail({
            error: `'${name}' is a namespace and does nothing by itself (${given})`,
            hint: `available: ${subcommands.join(', ')}${help}`
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
    // `--help` answers before any root is required: asking what a command
    // needs must not itself need a configured patchset or fork tree.
    const helpOnly = (matched.definition.commandFlags ?? []).includes(GLOBAL_FLAG_HELP_NAME) && commandFlags.has(GLOBAL_FLAG_HELP_NAME);
    const out = new Output({
        command: matched.definition.name,
        version: readCodkitVersion(toolRoot),
        jsonMode: flags.json
    });
    out.setToolRoot(toolRoot);
    try {
        const resolveRoots = matched.definition.resolveRoots !== false;
        if (matched.definition.name.startsWith('workspace') && flags.workspace !== undefined)
            throw ckError('CONFIG', 'workspace lifecycle management takes its explicit name argument, not --workspace');
        const selection = flags.workspace === undefined ? null : selectWorkspace(flags.workspace, flags);
        if (!resolveRoots && (flags.forkDir !== null || flags.patchesDir !== null))
            throw ckError('CONFIG', 'workspace management takes roots from the registry; external root flags are not accepted');
        const settingsFields = resolveRoots && selection === null ? rootSettingsNeeded(flags, process.env) : { patchesDir: false, forkDir: false };
        const settings = settingsFields.patchesDir || settingsFields.forkDir ? loadSettings(undefined, settingsFields) : { codkitSettings: 1 };
        const locations = selection?.locations ?? (resolveRoots ? resolveLocations(flags, process.env, settings) : { patchesDir: null, forkDir: null });
        out.setRoots(toolRoot, locations);
        assertDisjointRoots(toolRoot, locations);
        const needsPatches = (matched.definition.roots ?? 'patches') === 'patches' && !helpOnly;
        const patches = needsPatches ? requirePatchesDir(locations) : locations.patchesDir;
        const patchRoot = patches?.path ?? '';
        if (needsPatches && patches !== null)
            out.info(formatPatchesLine(patches));
        const declared = matched.definition.configMode === 'none' || helpOnly ? null : loadConfig(patchRoot);
        const config = declared === null || selection === null ? declared : workspaceConfig(declared, selection.record);
        // PROP-016 ##TYPE-REGISTRY: the type is resolved once, here, and handed to
        // the command with everything else it needs. A configuration always names
        // one - schema 2 requires it - so a resolved config means a resolved type,
        // and every engine below asks the type instead of stating its facts.
        const registered = config === null || selection !== null ? null : await resolveProjectType(config.type);
        let type = registered;
        if (config !== null && selection !== null)
            type = await resolveWorkspaceType(selection.record);
        if (config !== null && registered !== null) {
            assertTypeConfig(registered, config);
            // ##TYPE-CONFIGURED: a type whose answers live in `typeConfig` is
            // specialized here, once, and every engine below asks the result.
            type = configureProjectType(registered, config.typeConfig);
        }
        out.setProjectType(type?.id ?? null);
        const exitCode = await matched.definition.run({
            toolRoot,
            locations,
            patchesDir: patchRoot,
            args: matched.args,
            flags,
            commandFlags,
            env: process.env,
            config,
            type,
            out,
            ...(selection === null ? {} : { workspace: selection.record })
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
                hint: namespaceHelpHint(definition, name) ?? `${usable}; see codkit --help for the global flags`
            };
        }
    }
    return null;
}
/**
 * `--help` given to a subcommand of a namespace. The namespace carries one
 * help text for the whole family on purpose, so the reader is sent there
 * rather than shown a flag list they did not ask for.
 */
function namespaceHelpHint(definition, flag) {
    if (flag !== GLOBAL_FLAG_HELP_NAME) {
        return null;
    }
    const parentName = definition.name.slice(0, definition.name.lastIndexOf(' '));
    const parent = parentName === '' ? undefined : COMMANDS.get(parentName);
    if (parent?.namespace !== true || !(parent.commandFlags ?? []).includes(GLOBAL_FLAG_HELP_NAME)) {
        return null;
    }
    return `the help of this family lives on its namespace: run codkit ${parentName} --help`;
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
    const lines = ['codkit - manage a patch set over a fork tree', '', 'usage: codkit <command> [flags]', '', 'commands:'];
    for (const definition of COMMANDS.values()) {
        const own = definition.commandFlags ?? [];
        const suffix = own.length === 0 ? '' : ` (flags: ${own.join(', ')})`;
        // The column has to leave at least two spaces after the longest name, or
        // the reference generator cannot tell the name from the summary.
        lines.push(`  ${definition.name.padEnd(Math.max(HELP_NAME_COLUMN, definition.name.length + 2))}${definition.summary}${suffix}`);
    }
    lines.push('', 'global flags:');
    for (const flag of GLOBAL_FLAG_HELP) {
        lines.push(`  ${flag}`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
}
