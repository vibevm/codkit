/** @scope spec://codkit/modules/codkit/PROP-007#CMD-LICENSE-CHECK */
// codkit license - the namespace of the licence markup, with `check` under it.
// Contract: PROP-007 sec. 23, algorithm PROP-014 sec. 3.
//
// `check` reads a directory and says whether every file in it states who owns
// it and under which licence. It needs no patch set and no fork tree
// (##COMP-ROOTS-NONE): a package is a directory, and the question is about the
// directory, not about anyone's project.
//
// `annotate --own` is the one form of the family that is about a project: it
// gives the own files of the patch set their carriers from the selected
// licensing profile (PROP-019 ##ANNOTATE-OWN), so it resolves the patch-set
// root, the configuration and the type itself, for that flag only.
//
// The root is a namespace and never checks anything by itself: a bare
// `codkit license` that quietly picked a directory would be the kind of guess
// this command exists to remove.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative as relativeTo, resolve } from 'node:path';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK, commandFlagGiven, commandFlagValue } from '../lib/command.js';
import { loadConfig } from '../lib/configFile.js';
import { checkLicenseCarriers } from '../lib/licenseCheck.js';
import { annotateFile } from '../lib/licenseAnnotate.js';
import { annotateOwn } from '../lib/licenceAnnotateOwn.js';
import { NOTICES_FILE_NAME, renderThirdPartyNotices } from '../lib/licenseNotices.js';
import { REUSE_REGISTRY_NAME, emptyRegistryText, readReuseRegistry, renderAnnotation } from '../lib/reuseRegistry.js';
import { noticeLines } from '../lib/licenseTexts.js';
import { loadLicensePolicy } from '../lib/licensePolicy.js';
import { readLicensingProfile } from '../lib/licensingProfile.js';
import { ckError } from '../lib/messages.js';
import { formatPatchesLine } from '../lib/paths.js';
import { RELEASE_LICENSING_FILE } from '../lib/releaseLicensing.js';
import { expressionIds, loadSpdxLicenseIds, spdxIdHint, unknownIds } from '../lib/spdxIds.js';
import { shippedStandardsPackage } from '../lib/standardsPackage.js';
import { statIfPresent } from '../lib/containedPath.js';
import { resolveWorkspaceType } from '../lib/workspaceType.js';
import { configureProjectType } from '../types/configure.js';
import { resolveProjectType } from '../types/registry.js';
import { assertTypeConfig } from '../types/typeConfig.js';
/**
 * main.ts answers a bare namespace, and an unknown subcommand under it, with
 * the usage of its subcommands and exit 2 before any root is resolved
 * (PROP-007 ##LICENSE-NAMESPACE). This namespace declares no `--help`, which is
 * the only flag that reaches a namespace's own body, so this function exists to
 * satisfy the definition and is never called.
 */
async function runNamespace() {
    return EXIT_ENVIRONMENT;
}
/**
 * The directory to check: the argument when there is one, else the standards
 * package shipped with this codkit (##STD-PACKAGE-LOCATION). A missing shipped
 * package is a broken installation, not a user error.
 */
function targetDirectory(ctx) {
    const given = ctx.args[0];
    if (given === undefined)
        return shippedStandardsPackage(ctx.toolRoot).directory;
    const absolute = isAbsolute(given) ? given : resolve(process.cwd(), given);
    const shape = statIfPresent(absolute);
    if (shape === null) {
        throw ckError('CONFIG', `${given}: no such directory`, 'give the path of a package directory', given);
    }
    if (!shape.isDirectory()) {
        throw ckError('CONFIG', `${given}: not a directory`, 'give the path of a package directory', given);
    }
    return absolute;
}
async function runCheck(ctx) {
    const directory = targetDirectory(ctx);
    const policy = loadLicensePolicy();
    const result = checkLicenseCarriers(directory, policy, loadSpdxLicenseIds());
    report(ctx, result, policy.holders, policy.ownLicense, policy.allowedThirdParty);
    return result.problems.length === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
/** ##LIC-CHECK-REPORT: one line per problem, then the tally. */
function report(ctx, result, holders, ownLicense, allowedThirdParty) {
    for (const file of result.checked) {
        ctx.out.diag(`  checked  ${file.path}  (${file.carrier})`);
    }
    for (const problem of result.problems) {
        // formatError renders `error CK-E-<CODE>: <file>: <message>`; the path comes
        // from `file`, so the message itself is the reason alone (##LIC-CHECK-REPORT).
        ctx.out.addError({ code: problem.code, message: problem.message, hint: hintFor(problem), file: problem.file });
    }
    ctx.out.info(`${result.checked.length} files checked, ${result.problems.length} problems`);
    ctx.out.setData({
        dir: result.dir,
        files: result.files,
        checked: result.checked.map((file) => ({ path: file.path, carrier: file.carrier, kind: file.kind, license: file.license })),
        problems: result.problems.map((problem) => ({ code: `CK-E-${problem.code}`, file: problem.file, message: problem.message })),
        licences: { own: [...result.licences.own], thirdParty: [...result.licences.thirdParty], notices: result.licences.notices },
        policy: { holders: [...holders], ownLicense, allowedThirdParty: [...allowedThirdParty] }
    });
}
function hintFor(problem) {
    switch (problem.code) {
        case 'LICENSE-HEADER':
            return 'give the file a licence header or a .license sidecar (codkit license annotate)';
        case 'LICENSE-THIRD-PARTY':
            return 'declare the file in REUSE.toml and keep THIRD-PARTY-NOTICES.md generated';
        default:
            return 'fix the package: the manifest, LICENSE and LICENSES/ must agree';
    }
}
const DIR = '--dir';
const YEAR = '--year';
const HOLDER = '--holder';
const LICENSE = '--license';
const SOURCE = '--source';
const THIRD_PARTY = '--third-party';
const DRY_RUN = '--dry-run';
const OWN = '--own';
const REPLACE_RETIRED = '--replace-retired';
/** The flags of the package form, which say what `--own` takes from the profile and the patch set instead. */
const PACKAGE_FORM_FLAGS = [DIR, THIRD_PARTY, HOLDER, LICENSE, SOURCE];
/** Width of the action column of `annotate --own`; `foreign-holder` is the longest action. */
const OWN_ACTION_COLUMN = 14;
/** The package root a subcommand works in: `--dir`, defaulting to the cwd. */
function packageRoot(ctx) {
    const given = commandFlagValue(ctx.commandFlags, DIR) ?? '.';
    const absolute = isAbsolute(given) ? given : resolve(process.cwd(), given);
    const shape = statIfPresent(absolute);
    if (shape === null || !shape.isDirectory()) {
        throw ckError('CONFIG', `${given}: not a directory`, 'point --dir at the package root', given);
    }
    return absolute;
}
/** A path inside the package root, POSIX-separated; anything else is refused. */
function containedRelative(root, given) {
    const absolute = isAbsolute(given) ? given : resolve(process.cwd(), given);
    const inside = relativeTo(root, absolute);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        throw ckError('CONFIG', `${given} is outside ${root}`, 'annotate only files inside --dir', given);
    }
    return inside.split(/[\\/]/u).join('/');
}
/** ##LIC-ANNOTATE: place a carrier, or report the file already had one. */
async function runAnnotate(ctx) {
    if (commandFlagGiven(ctx.commandFlags, OWN))
        return runAnnotateOwn(ctx);
    const root = packageRoot(ctx);
    const policy = loadLicensePolicy();
    const spdx = loadSpdxLicenseIds();
    const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
    const thirdParty = commandFlagGiven(ctx.commandFlags, THIRD_PARTY);
    const holder = commandFlagValue(ctx.commandFlags, HOLDER) ?? policy.holders[0] ?? '';
    const year = commandFlagValue(ctx.commandFlags, YEAR) ?? String(new Date().getUTCFullYear());
    const license = commandFlagValue(ctx.commandFlags, LICENSE);
    const source = commandFlagValue(ctx.commandFlags, SOURCE) ?? '';
    if (thirdParty && (commandFlagValue(ctx.commandFlags, HOLDER) === null || license === null)) {
        throw ckError('CONFIG', '--third-party needs --holder and --license', 'name the other party and the licence of the file', root);
    }
    if (!thirdParty && !policy.holders.includes(holder)) {
        throw ckError('CONFIG', `${holder} is not a holder in the licence policy`, 'use a policy holder, or annotate the file with --third-party', root);
    }
    if (license !== null) {
        const unknown = unknownIds(license, spdx);
        if (unknown.length > 0) {
            throw ckError('CONFIG', `not an SPDX identifier: ${unknown.join(', ')}${spdxIdHint(unknown)}`, 'use an SPDX identifier', root);
        }
        const outside = expressionIds(license).filter((id) => !policy.allowedThirdParty.includes(id) && !policy.allowedExceptions.includes(id));
        if (outside.length > 0) {
            throw ckError('CONFIG', `licence ${outside.join(', ')} is outside the allowlist`, 'widen the policy deliberately, or drop the file', root);
        }
    }
    // A file whose carrier the check already resolves is left untouched: running
    // the command twice must leave `git diff` empty.
    const carried = new Set(checkLicenseCarriers(root, policy, spdx).checked.map((file) => file.path));
    const notice = thirdParty && license !== null ? [`Copyright (c) ${year} ${holder}`, `SPDX-License-Identifier: ${license}`] : noticeLines(year, holder);
    const results = ctx.args.map((given) => {
        const inside = containedRelative(root, given);
        return annotateFile({ dir: root, relative: inside, notice, alreadyCarried: carried.has(inside), dryRun });
    });
    let appended = false;
    if (thirdParty && license !== null && !dryRun) {
        const registryPath = join(root, REUSE_REGISTRY_NAME);
        const head = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : emptyRegistryText('package', policy.holders[0] ?? '');
        const rows = ctx.args
            .map((given) => renderAnnotation({ path: containedRelative(root, given), copyright: `${year} ${holder}`, license, source }))
            .join('');
        writeFileSync(registryPath, head + rows, 'utf8');
        appended = true;
    }
    for (const result of results)
        ctx.out.info(`  ${result.action.padEnd(9)} ${result.path}`);
    ctx.out.setData({
        dir: root,
        files: results.map((result) => ({ path: result.path, action: result.action })),
        registry: { path: REUSE_REGISTRY_NAME, appended }
    });
    return EXIT_OK;
}
/**
 * ##ANNOTATE-OWN, ##CMD-LICENSE-ANNOTATE: the own files of the patch set, from
 * the selected profile. The package form's flags name what the profile and the
 * patch set now supply, so they do not combine with `--own`; `--year` may be
 * given, and must then be the profile's (##HEADER-FROM-PROFILE), or the header
 * would say a year nobody declared.
 */
async function runAnnotateOwn(ctx) {
    for (const flag of PACKAGE_FORM_FLAGS) {
        if (ctx.commandFlags.has(flag)) {
            throw ckError('CONFIG', `${flag} does not combine with --own`, "with --own the directory is the patch set and the holder and the licence are the selected profile's");
        }
    }
    const patches = ctx.locations.patchesDir;
    if (patches === null) {
        throw ckError('CONFIG', '--own annotates the own files of a patch set, and no patch set is configured', 'pass --patches-dir, set CODKIT_PATCHES_DIR, or set patchesDir in ~/.codkit/settings.json');
    }
    ctx.out.info(formatPatchesLine(patches));
    const type = await resolveOwnType(ctx, patches.path);
    ctx.out.setProjectType(type.id);
    const profile = readLicensingProfile(patches.path);
    if (profile === null) {
        throw ckError('CONFIG', `the patch set carries no ${RELEASE_LICENSING_FILE}, so there is no profile to annotate from`, 'write the declaration that selects the profile (PROP-019 LICENSING-DECLARATION-V2), or annotate by path without --own', RELEASE_LICENSING_FILE);
    }
    const year = commandFlagValue(ctx.commandFlags, YEAR);
    if (year !== null && year !== profile.product.year) {
        throw ckError('CONFIG', `--year ${year} disagrees with the year ${profile.product.year} of the profile`, "the year of an own header is the product block's: drop --year, or change the declaration");
    }
    const replaceRetired = commandFlagGiven(ctx.commandFlags, REPLACE_RETIRED);
    if (replaceRetired && profile.product.retiredNotices.length === 0) {
        ctx.out.info('the product block declares no retired notices, so --replace-retired replaces nothing');
    }
    const result = annotateOwn({
        patchesDir: patches.path,
        type,
        profile,
        paths: ctx.args,
        replaceRetired,
        dryRun: commandFlagGiven(ctx.commandFlags, DRY_RUN)
    });
    for (const file of result.files)
        ctx.out.info(`  ${file.action.padEnd(OWN_ACTION_COLUMN)}  ${file.path}`);
    const foreign = result.files.filter((file) => file.action === 'foreign-holder');
    for (const file of foreign) {
        ctx.out.addError({
            code: 'LICENSE-HEADER',
            message: 'the carrier names a holder outside the policy',
            hint: "declare the file third-party in a REUSE.toml of the own layer, or pass --replace-retired when the header is the product's retired posture",
            file: file.path
        });
    }
    ctx.out.setData({
        scope: 'own',
        dir: patches.path,
        files: result.files.map((file) => ({ path: file.path, action: file.action }))
    });
    return foreign.length === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
/**
 * The configuration and the type `--own` needs, resolved the way main.ts
 * resolves them for a command with `configMode: 'load'`. The command keeps
 * `configMode: 'none'`, because without `--own` it must not read codkit.json at
 * all: a package directory is not a patch set, and main.ts reads the
 * configuration of whatever root it resolved - the cwd when nothing names one -
 * so the loading mode would have changed the package form for every run that
 * happens to start inside a patch set. The flag pays for its own resolution.
 */
async function resolveOwnType(ctx, patchesDir) {
    const declared = loadConfig(patchesDir);
    if (declared === null) {
        throw ckError('CONFIG', 'codkit.json was not found in the patch set, so there is no project type to ask', 'run the command from a patch-set checkout that carries codkit.json');
    }
    // A workspace run takes its type from the registry's custody check, as main.ts does.
    if (ctx.workspace !== undefined)
        return resolveWorkspaceType(ctx.workspace);
    const registered = await resolveProjectType(declared.type);
    assertTypeConfig(registered, declared);
    return configureProjectType(registered, declared.typeConfig);
}
/** ##LIC-NOTICES: regenerate the notices file from the registry. */
async function runNotices(ctx) {
    const root = packageRoot(ctx);
    const policy = loadLicensePolicy();
    const dryRun = commandFlagGiven(ctx.commandFlags, DRY_RUN);
    const registryPath = join(root, REUSE_REGISTRY_NAME);
    const registry = readReuseRegistry(root, existsSync(registryPath));
    if (registry.problems.length > 0) {
        for (const problem of registry.problems) {
            ctx.out.addError({ code: problem.code, message: problem.message, hint: 'fix REUSE.toml', file: problem.file });
        }
        return EXIT_CHECK_FAILED;
    }
    const licensePath = join(root, 'LICENSE');
    const statedYear = existsSync(licensePath)
        ? (/(\d{4})/u.exec(readFileSync(licensePath, 'utf8').split('\n')[0] ?? '')?.[1] ?? null)
        : null;
    const year = statedYear ?? String(new Date().getUTCFullYear());
    const body = renderThirdPartyNotices(registry, policy.holders, noticeLines(year, policy.holders[0] ?? ''));
    const target = join(root, NOTICES_FILE_NAME);
    const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
    let action;
    if (body === null) {
        action = current === null ? 'absent' : 'removed';
        if (!dryRun && current !== null)
            rmSync(target);
    }
    else if (current === body) {
        action = 'unchanged';
    }
    else {
        action = 'written';
        if (!dryRun)
            writeFileSync(target, body, 'utf8');
    }
    if (dryRun) {
        // ##LIC-NOTICES: `--dry-run` prints the result instead of writing it, so
        // stdout carries the generated bytes and nothing else - that is what makes
        // `codkit license notices --dry-run | diff - THIRD-PARTY-NOTICES.md` a
        // check anyone can run. `info` re-adds the trailing newline.
        if (body !== null)
            ctx.out.info(body.replace(/\n$/u, ''));
        ctx.out.diag(`${NOTICES_FILE_NAME}: ${action}`);
    }
    else {
        ctx.out.info(`${NOTICES_FILE_NAME}: ${action}`);
    }
    ctx.out.setData({
        dir: root,
        path: NOTICES_FILE_NAME,
        action,
        rows: body === null ? 0 : body.split('\n').filter((line) => line.startsWith('| `')).length
    });
    return EXIT_OK;
}
export const licenseCommand = {
    name: 'license',
    summary: 'namespace of the licence markup; run license check, annotate or notices',
    configMode: 'none',
    namespace: true,
    roots: 'none',
    maxArgs: 0,
    run: runNamespace
};
export const licenseCheckCommand = {
    name: 'license check',
    summary: 'check that every file of a package states its copyright and licence',
    configMode: 'none',
    roots: 'none',
    maxArgs: 1,
    run: runCheck
};
export const licenseAnnotateCommand = {
    name: 'license annotate',
    summary: 'give files a licence header or a .license sidecar, idempotently',
    configMode: 'none',
    roots: 'none',
    // One per file the operator names; there is no upper bound worth inventing.
    maxArgs: Number.MAX_SAFE_INTEGER,
    commandFlags: [DIR, YEAR, HOLDER, LICENSE, SOURCE, THIRD_PARTY, DRY_RUN, OWN, REPLACE_RETIRED],
    run: runAnnotate
};
export const licenseNoticesCommand = {
    name: 'license notices',
    summary: 'generate THIRD-PARTY-NOTICES.md from the REUSE.toml registry',
    configMode: 'none',
    roots: 'none',
    maxArgs: 0,
    commandFlags: [DIR, DRY_RUN],
    run: runNotices
};
