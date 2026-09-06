/** @scope spec://codkit/modules/codkit/PROP-007#CMD-LICENSE-CHECK */
// codkit license - the namespace of the licence markup, with `check` under it.
// Contract: PROP-007 sec. 23, algorithm PROP-014 sec. 3.
//
// `check` reads a directory and says whether every file in it states who owns
// it and under which licence. It needs no patch set and no fork tree
// (##COMP-ROOTS-NONE): a package is a directory, and the question is about the
// directory, not about anyone's project.
//
// The root is a namespace and never checks anything by itself: a bare
// `codkit license` that quietly picked a directory would be the kind of guess
// this command exists to remove.
import { isAbsolute, resolve } from 'node:path';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_OK } from '../lib/command.js';
import { checkLicenseCarriers } from '../lib/licenseCheck.js';
import { loadLicensePolicy } from '../lib/licensePolicy.js';
import { ckError } from '../lib/messages.js';
import { loadSpdxLicenseIds } from '../lib/spdxIds.js';
import { shippedStandardsPackage } from '../lib/standardsPackage.js';
import { statIfPresent } from '../lib/containedPath.js';
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
export const licenseCommand = {
    name: 'license',
    summary: 'namespace of the licence markup; run license check',
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
