/** @scope spec://codkit/modules/codkit/PROP-007#root */
// codkit hooks install|check - the git hooks of the patchset repository.
// Contract: PROP-007 sec. 19 (##CMD-HOOKS).
//
// `install` writes them, `check` says whether what is on disk is what codkit
// would write. A third mode, `commit-msg`, is what the installed commit-msg hook
// calls back into; it is not part of what a person is offered, so it is not
// advertised - but it is an ordinary run of this command, which means it is
// testable and produces the same diagnostics as everything else.
//
// The hooks live in `.git/`, so they are local, uncommitted, and lost by a fresh
// clone. That is why `check` exists and why CI validates the trailers of a cycle
// on its own: a hook is a convenience, never the only place a rule is enforced.
import { readFileSync, writeFileSync } from 'node:fs';
import { EXIT_CHECK_FAILED, EXIT_OK, forkResolution } from '../lib/command.js';
import { HOOK_NAMES, hooksDir, inspectHooks, installHooks, runCommitMsg } from '../lib/hooksPatchSet.js';
import { ckError } from '../lib/messages.js';
const MODES = ['install', 'check', 'commit-msg'];
async function run(ctx) {
    const mode = readMode(ctx.args[0]);
    if (mode === 'commit-msg') {
        return commitMsg(ctx);
    }
    if (mode === 'install') {
        return install(ctx);
    }
    return check(ctx);
}
function install(ctx) {
    const reports = installHooks({ patchesDir: ctx.patchesDir, forkDir: forkResolution(ctx).path });
    ctx.out.info(`git hooks in ${hooksDir(ctx.patchesDir)}`);
    for (const report of reports) {
        ctx.out.info(`  ${report.name.padEnd(12)} ${describeInstall(report)}`);
    }
    ctx.out.setData(dataOf('install', reports));
    const refused = reports.filter((report) => report.action === 'refused');
    const first = refused[0];
    if (first === undefined) {
        return EXIT_OK;
    }
    for (const report of refused) {
        ctx.out.addError({
            code: 'CONFIG',
            message: `${report.name} already exists and was not written by codkit, so it was left untouched`,
            hint: `read ${report.path}, merge what it does into the codkit hook or move it aside, then run codkit hooks install again`,
            file: report.path
        });
    }
    return EXIT_CHECK_FAILED;
}
function check(ctx) {
    const reports = inspectHooks({ patchesDir: ctx.patchesDir, forkDir: forkResolution(ctx).path });
    ctx.out.info(`git hooks in ${hooksDir(ctx.patchesDir)}`);
    for (const report of reports) {
        ctx.out.info(`  ${report.name.padEnd(12)} ${report.state}`);
    }
    ctx.out.setData(dataOf('check', reports));
    const wrong = reports.filter((report) => report.state !== 'ok');
    if (wrong.length === 0) {
        return EXIT_OK;
    }
    for (const report of wrong) {
        ctx.out.addError({
            code: 'CONFIG',
            message: `the ${report.name} hook is ${describeState(report)}`,
            hint: report.state === 'foreign' ? `read ${report.path} and move it aside if you want codkit's hook instead` : 'run codkit hooks install',
            file: report.path
        });
    }
    return EXIT_CHECK_FAILED;
}
/**
 * The callback of the installed commit-msg hook: rewrite the message file in
 * place when there is a trailer to stamp, and refuse the commit when the
 * `Cause:` trailer is not a sha.
 */
function commitMsg(ctx) {
    const path = ctx.args[1];
    if (path === undefined || path === '') {
        throw ckError('CONFIG', 'hooks commit-msg needs the path of the message file', 'this mode is called by the installed commit-msg hook; run codkit hooks install to set it up');
    }
    let message;
    try {
        message = readFileSync(path, 'utf8');
    }
    catch (error) {
        throw ckError('CONFIG', `cannot read the commit message file: ${error instanceof Error ? error.message : String(error)}`, 'the commit-msg hook is given the path of the message file by git', path);
    }
    const outcome = runCommitMsg(ctx.patchesDir, message);
    for (const line of outcome.messages) {
        ctx.out.info(line);
    }
    if (outcome.rewritten !== null) {
        writeFileSync(path, outcome.rewritten, 'utf8');
    }
    ctx.out.setData({ mode: 'commit-msg', file: path, stamped: outcome.rewritten !== null, ok: outcome.exitCode === 0 });
    return outcome.exitCode === 0 ? EXIT_OK : EXIT_CHECK_FAILED;
}
function describeInstall(report) {
    switch (report.action) {
        case 'written':
            return 'installed';
        case 'unchanged':
            return 'already up to date';
        default:
            return 'left untouched: not a codkit hook';
    }
}
function describeState(report) {
    switch (report.state) {
        case 'missing':
            return 'not installed';
        case 'stale':
            return "out of date: it is codkit's, but not what this codkit would write";
        case 'foreign':
            return "not codkit's";
        default:
            return 'up to date';
    }
}
function dataOf(mode, reports) {
    return {
        mode,
        hooks: reports.map((report) => ({
            name: report.name,
            path: report.path,
            state: report.state,
            action: 'action' in report ? String(report.action) : null
        }))
    };
}
function readMode(given) {
    const mode = MODES.find((candidate) => candidate === given);
    if (mode === undefined) {
        throw ckError('CONFIG', given === undefined || given === '' ? 'hooks needs a mode' : `hooks has no mode "${given}"`, 'usage: codkit hooks install | codkit hooks check');
    }
    return mode;
}
export const hooksCommand = {
    name: 'hooks',
    summary: `install or check the patchset git hooks (${HOOK_NAMES.join(', ')})`,
    // The hooks are about the patchset repository, and `check` must work in a
    // checkout that has no codkit.json yet.
    configMode: 'none',
    maxArgs: 2,
    run
};
