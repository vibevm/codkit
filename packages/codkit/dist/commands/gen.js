/** @scope spec://codkit/modules/codkit/PROP-015#gen */
// codkit gen - the skeletons a product starts a feature and a brand table from.
// Contract: PROP-007 sec. 26, algorithm PROP-015 sec. 5.
//
// The command needs the patch-set root and nothing else (##GEN-NAMESPACE): a
// skeleton is written into the delta, and the fork tree receives it on the next
// `codkit load` like any other own file.
import { requireCapability } from '../types/capability.js';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, commandFlagValue, patchesRoot, requireProjectType } from '../lib/command.js';
import { featureDirectoryName, planBrand, planFeature, readHeaderText, refuseExisting, writeGenerated } from '../lib/genFeature.js';
import { ckError, isCkError } from '../lib/messages.js';
const TITLE = '--title';
const SETTING = '--setting';
const COLD = '--cold';
const HOLDER = '--holder';
const LICENSE = '--license';
const YEAR = '--year';
const HEADER_STYLE = '--header-style';
const HEADER_FILE = '--header-file';
/** The two shapes codkit can lay a header out in from fields (##GEN-HEADER-IS-THE-PRODUCTS). */
const HEADER_STYLES = ['line', 'block'];
/** ##GEN-HEADER-IS-THE-PRODUCTS: a header is written only when the product supplies one. */
const NO_HEADER_WARNING = 'no header written; pass --holder and --license, or --header-file';
/** The flags of the header, shared by both subcommands (##GEN-NAMESPACE). */
const HEADER_FLAGS = [HOLDER, LICENSE, YEAR, HEADER_STYLE, HEADER_FILE];
/** main.ts answers a bare namespace before this runs (##GEN-NAMESPACE). */
async function runNamespace() {
    return EXIT_ENVIRONMENT;
}
/**
 * ##GEN-HEADER-IS-THE-PRODUCTS: the header the run will write, or null when the
 * product asked for none. The two forms do not mix - either codkit lays the
 * product's fields out, or the product hands over the finished text - so the
 * combination is settled here, before a single target is planned.
 */
function headerOf(ctx, patchesDir) {
    const file = commandFlagValue(ctx.commandFlags, HEADER_FILE);
    const holder = commandFlagValue(ctx.commandFlags, HOLDER);
    const license = commandFlagValue(ctx.commandFlags, LICENSE);
    const year = commandFlagValue(ctx.commandFlags, YEAR);
    const style = commandFlagValue(ctx.commandFlags, HEADER_STYLE);
    if (file !== null) {
        const also = [HOLDER, LICENSE, YEAR, HEADER_STYLE].filter((flag) => ctx.commandFlags.has(flag));
        if (also.length > 0) {
            throw ckError('CONFIG', `${HEADER_FILE} writes the header verbatim and cannot be combined with ${also.join(', ')}`, `drop ${also.join(', ')}, or drop ${HEADER_FILE} and let codkit lay the fields out; nothing was written`);
        }
        return { form: 'text', text: readHeaderText(patchesDir, file) };
    }
    if (holder === null || license === null) {
        // A style with nothing to lay out is a typo, not a request for no header.
        if (style !== null) {
            throw ckError('CONFIG', `${HEADER_STYLE} has no header to shape`, `pass ${HOLDER} and ${LICENSE} as well; nothing was written`);
        }
        return null;
    }
    return { form: 'fields', holder, license, year: year ?? new Date().getUTCFullYear().toString(), style: headerStyleOf(style) };
}
/** ##GEN-HEADER-IS-THE-PRODUCTS: `line` is the default, and there is no third shape. */
function headerStyleOf(style) {
    if (style === null)
        return 'line';
    const known = HEADER_STYLES.find((candidate) => candidate === style);
    if (known === undefined) {
        throw ckError('CONFIG', `${HEADER_STYLE} ${JSON.stringify(style)} is not a header style`, `use ${HEADER_STYLES.join(' or ')}`);
    }
    return known;
}
/**
 * The own root shapes what a generator of this family writes and what a person
 * is asked to write by hand. It comes from the configuration, which is why
 * these two verbs read one (##GEN-NAMESPACE is about the namespace, not about
 * the answers the type needs to give).
 */
function ownRoot(ctx) {
    return ctx.config?.typeConfig.ownRoot ?? '';
}
/**
 * ##GEN-REFUSES-EXISTING: exit 1 with nothing written. It is a verdict about
 * the patch set, not a broken environment, so it is answered here rather than
 * thrown out of the command.
 */
function refuse(ctx, patchesDir, outcome) {
    try {
        refuseExisting(patchesDir, outcome.files);
        return null;
    }
    catch (error) {
        if (!isCkError(error) || error.code !== 'GEN-EXISTS')
            throw error;
        ctx.out.addError(error.toPayload());
        ctx.out.setData({ files: outcome.files.map((file) => file.path), written: false });
        return EXIT_CHECK_FAILED;
    }
}
async function runFeature(ctx) {
    const patchesDir = patchesRoot(ctx);
    const id = ctx.args[0];
    if (id === undefined) {
        throw ckError('CONFIG', 'gen feature needs a feature id', 'usage: codkit gen feature <id> --title <text>');
    }
    const title = commandFlagValue(ctx.commandFlags, TITLE);
    if (title === null || title === '') {
        throw ckError('CONFIG', 'gen feature needs --title <text>', 'usage: codkit gen feature <id> --title <text>');
    }
    // The id is validated before anything else: it decides the directory, and a
    // refusal here has nothing to undo (##GEN-FEATURE).
    featureDirectoryName(id);
    const header = headerOf(ctx, patchesDir);
    const outcome = planFeature({
        patchesDir,
        header,
        type: requireProjectType(ctx),
        ownRoot: ownRoot(ctx),
        id,
        title,
        setting: commandFlagGiven(ctx.commandFlags, SETTING),
        cold: commandFlagGiven(ctx.commandFlags, COLD)
    });
    const refusal = refuse(ctx, patchesDir, outcome);
    if (refusal !== null)
        return refusal;
    writeGenerated(patchesDir, outcome.files);
    for (const file of outcome.files)
        ctx.out.info(`created ${file.path}`);
    if (!outcome.headerWritten)
        ctx.out.warn(NO_HEADER_WARNING);
    ctx.out.info(`next: add to the composition root of the product: ${outcome.importLine}`);
    for (const reminder of outcome.reminders)
        ctx.out.info(`next: ${reminder}`);
    ctx.out.setData({
        id,
        files: outcome.files.map((file) => file.path),
        importLine: outcome.importLine,
        headerWritten: outcome.headerWritten,
        headerStyle: outcome.headerStyle,
        reminders: [...outcome.reminders]
    });
    return EXIT_OK;
}
async function runBrand(ctx) {
    requireCapability(ctx.type, 'gen-brand', 'gen brand');
    const patchesDir = patchesRoot(ctx);
    const outcome = planBrand({ patchesDir, header: headerOf(ctx, patchesDir), type: requireProjectType(ctx), ownRoot: ownRoot(ctx) });
    const refusal = refuse(ctx, patchesDir, outcome);
    if (refusal !== null)
        return refusal;
    writeGenerated(patchesDir, outcome.files);
    for (const file of outcome.files)
        ctx.out.info(`created ${file.path}`);
    if (!outcome.headerWritten)
        ctx.out.warn(NO_HEADER_WARNING);
    ctx.out.info('----- the graft into the string funnel of the distribution (write it as a patch of the product) -----');
    ctx.out.info(outcome.hookText.replace(/\n$/u, ''));
    ctx.out.info('----- end of the graft -----');
    for (const reminder of outcome.reminders)
        ctx.out.info(`reminder: ${reminder}`);
    ctx.out.setData({
        file: outcome.files[0]?.path ?? '',
        files: outcome.files.map((file) => file.path),
        hookText: outcome.hookText,
        reminders: [...outcome.reminders],
        headerWritten: outcome.headerWritten
    });
    return EXIT_OK;
}
export const genCommand = {
    name: 'gen',
    summary: 'namespace of the product skeletons; run gen feature or gen brand',
    configMode: 'none',
    namespace: true,
    roots: 'none',
    maxArgs: 0,
    run: runNamespace
};
export const genFeatureCommand = {
    name: 'gen feature',
    summary: 'write the skeleton of a flag-gated product feature into delta/own/',
    configMode: 'load',
    roots: 'patches',
    maxArgs: 1,
    commandFlags: [TITLE, SETTING, COLD, ...HEADER_FLAGS],
    run: runFeature
};
export const genBrandCommand = {
    name: 'gen brand',
    summary: "write the brand rules table and print the graft for the distribution's string funnel",
    configMode: 'load',
    roots: 'patches',
    maxArgs: 0,
    commandFlags: [...HEADER_FLAGS],
    run: runBrand
};
