import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanupTempRoots, makeTempRoot } from '../support/tmp.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const guardPath = join(repoRoot, 'codkit', 'hooks', 'pretool.mjs');
const guardUrl = pathToFileURL(guardPath).href;
const evalScript = `
import { evaluatePreTool } from ${JSON.stringify(guardUrl)};
const input = JSON.parse(process.argv[1]);
const result = evaluatePreTool(input, { toolRoot: process.argv[2], patchesRoot: process.argv[3], treeRoot: process.argv[4] });
process.stdout.write(JSON.stringify(result));
`;

afterAll(cleanupTempRoots);

describe('agent protocol structural sources', () => {
	it('keeps source agents, Claude copies, and both generated cores in sync', () => {
		const run = spawnSync(process.execPath, [join(repoRoot, 'tools', 'sync-codkit-agents.mjs'), '--check'], {
			cwd: repoRoot,
			encoding: 'utf8'
		});
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toContain('agent protocol sync check: ok');
	});

	it('passes the protocol links, scopes, settings, and portable-path check', () => {
		const run = spawnSync(process.execPath, [join(repoRoot, 'docs', 'codkit', 'protocol', 'agent', 'check.mjs')], {
			cwd: repoRoot,
			encoding: 'utf8'
		});
		expect(run.status, run.stderr).toBe(0);
		expect(run.stdout).toContain('agent protocol check: ok');
	});

	it('ships the deny-only agent settings template with the tool-root hook and keeps the tool repository free of it', () => {
		const settings = JSON.parse(readFileSync(join(repoRoot, 'codkit', 'claude', 'settings.json'), 'utf8')) as {
			permissions: { allow?: unknown; deny: string[] };
			hooks: { PreToolUse: { matcher: string; hooks: { command: string; args: string[] }[] }[] };
		};
		expect(settings.permissions.allow).toBeUndefined();
		expect(settings.permissions.deny).toContain('Bash(git commit *)');
		expect(settings.hooks.PreToolUse[0]?.matcher).toBe('Bash|PowerShell|Edit|Write|NotebookEdit');
		expect(settings.hooks.PreToolUse[0]?.hooks[0]).toMatchObject({
			command: 'node',
			args: ['<codkit-tool-root>/codkit/hooks/pretool.mjs']
		});
		expect(existsSync(join(repoRoot, '.claude', 'settings.json'))).toBe(false);
		expect(existsSync(join(repoRoot, '.claude', 'agents'))).toBe(false);
		expect(existsSync(join(repoRoot, '.claude', 'skills'))).toBe(false);
		expect(readdirSync(join(repoRoot, '.claude', 'rules'))).toEqual(['ck-codkit-dev.md']);
	});
});

describe('PreToolUse policy', () => {
	it('denies every no-task edit in patchset, the tree, and outside roots', () => {
		const roots = fixtureRoots('no-task');
		mkdirSync(join(roots.outside, 'linked-dir'), { recursive: true });
		symlinkSync(join(roots.outside, 'linked-dir'), join(roots.project, 'linked'), 'dir');
		for (const path of [
			join(roots.project, 'README.md'),
			join(roots.tree, 'src', 'target.ts'),
			join(roots.outside, 'secret.ts'),
			join(roots.project, 'linked', 'secret.ts')
		]) {
			expect(reason(decision(edit(path), roots))).toContain('no-task writes fail closed');
		}
	});

	it('enforces blockers paths and reserves only the two runtime output files', () => {
		const roots = fixtureRoots('active-task');
		writeTask(roots.project, ['src/target.ts']);
		expect(decision(edit(join(roots.tree, 'src', 'target.ts')), roots)).toBeNull();
		expect(reason(decision(edit(join(roots.tree, 'src', 'other.ts')), roots))).toContain('outside blockers');
		expect(decision(edit(join(roots.project, '.codkit', 'agent-task-result.json')), roots)).toBeNull();
		expect(decision(edit(join(roots.project, '.codkit', 'agent-journal-entry.json')), roots)).toBeNull();
		expect(reason(decision(edit(join(roots.project, 'delta', 'patch.ckpatch')), roots))).toContain('outside outputs');
	});

	it.each([
		['scout', 'cycle/reports/1.136.0-scout-CK-workbench-901.md'],
		['verify', 'cycle/reports/1.136.0-verify-1.md'],
		['review', 'cycle/reports/1.136.0-review.md'],
		['cause', '.codkit/agent-cause-CK-workbench-901.json']
	] as const)('allows only the exact %s report output and no tree edit', (kind, output) => {
		const roots = fixtureRoots(`report-${kind}`);
		writeReportTask(roots.project, kind, output);
		expect(decision(edit(join(roots.project, ...output.split('/'))), roots)).toBeNull();
		expect(reason(decision(edit(join(roots.project, 'cycle', 'reports', 'other.md')), roots))).toContain('outside outputs');
		expect(reason(decision(edit(join(roots.tree, 'src', 'target.ts')), roots))).toContain('Only a resolve task');
	});

	it('fails closed on malformed task and symlink escape', () => {
		const malformed = fixtureRoots('malformed-task');
		mkdirSync(join(malformed.project, '.codkit'), { recursive: true });
		writeFileSync(join(malformed.project, '.codkit', 'agent-task.json'), '{"codkitAgentTask":1}\n');
		expect(reason(decision(edit(join(malformed.project, 'README.md')), malformed))).toContain('does not match');

		const escaped = fixtureRoots('symlink-escape');
		mkdirSync(join(escaped.outside, 'dir'), { recursive: true });
		symlinkSync(join(escaped.outside, 'dir'), join(escaped.tree, 'linked'), 'dir');
		writeTask(escaped.project, ['linked/secret.ts']);
		expect(reason(decision(edit(join(escaped.tree, 'linked', 'secret.ts')), escaped))).toContain('outside outputs');

		const outputEscape = fixtureRoots('output-symlink-escape');
		writeTask(outputEscape.project, ['src/target.ts']);
		const outsideResult = join(outputEscape.outside, 'result.json');
		writeFileSync(outsideResult, '{}\n');
		symlinkSync(outsideResult, join(outputEscape.project, '.codkit', 'agent-task-result.json'));
		expect(reason(decision(edit(join(outputEscape.project, '.codkit', 'agent-task-result.json')), outputEscape))).toContain(
			'regular non-symlink'
		);
	});

	it.each([
		['git commit -m change', 'read-only allowlist'],
		['git -C ../tree reset --hard HEAD', 'read-only allowlist'],
		['git status --short', 'read-only allowlist'],
		['git diff HEAD~1 -- output.ts', 'read-only allowlist'],
		['git diff --output=/tmp/x --no-ext-diff HEAD', 'read-only allowlist'],
		['git -c diff.external=touch diff --no-ext-diff HEAD', 'read-only allowlist'],
		['npm run compile', 'not in the agent allowlist'],
		['./node_modules/.bin/tsc -p .', 'not in the agent allowlist'],
		['curl https://example.invalid', 'not in the agent allowlist'],
		['/tmp/git log -1', 'read-only allowlist'],
		['rg --pre sh pattern src', 'static read-only allowlist'],
		['bin/codkit where', 'agent read-only allowlist'],
		['bin/codkit --json --fork-dir /tmp/tree where', 'agent read-only allowlist'],
		['bin/codkit --json --patches-dir /tmp/other inventory', 'agent read-only allowlist'],
		['printf x > /tmp/agent-bypass', 'redirection'],
		['sh -c "printf x"', 'not in the agent allowlist'],
		['cmd=git; $cmd commit -m x', 'operators'],
		['$(printf git) commit -m x', 'variables'],
		['echo `git status`', 'operators'],
		[
			'node -e "process.exit()" codkit/claude/skills/ck-resolve/scripts/append-journal.mjs --entry .codkit/agent-journal-entry.json',
			'installed ck-resolve'
		]
	] as const)('denies shell policy: %s', (command, expected) => {
		const roots = fixtureRoots('shell-deny');
		expect(reason(decision(shell(command), roots))).toContain(expected);
	});

	it('rejects patch-set-local launcher and installed-copy helper lookalikes', () => {
		const roots = fixtureRoots('shell-spoof');
		const launcher = join(roots.project, 'bin', 'codkit');
		const helper = join(roots.project, '.claude', 'skills', 'ck-resolve', 'scripts', 'append-journal.mjs');
		mkdirSync(dirname(launcher), { recursive: true });
		mkdirSync(dirname(helper), { recursive: true });
		writeFileSync(launcher, '#!/bin/sh\n');
		writeFileSync(helper, '// lookalike\n');
		chmodSync(launcher, 0o755);
		expect(reason(decision(shell('bin/codkit --json where', roots.project), roots))).toContain('agent read-only allowlist');
		expect(
			reason(
				decision(
					shell(
						'node --experimental-strip-types .claude/skills/ck-resolve/scripts/append-journal.mjs --entry .codkit/agent-journal-entry.json',
						roots.project
					),
					roots
				)
			)
		).toContain('installed ck-resolve');
	});

	it('allows only static read-only shell inspection and approved Codkit commands', () => {
		const roots = fixtureRoots('shell-allow');
		expect(decision(shell('git log -1 --oneline'), roots)).toBeNull();
		expect(decision(shell('git diff --no-ext-diff HEAD~1 -- src'), roots)).toBeNull();
		expect(decision(shell('git diff --check -- src/file.ts'), roots)).toBeNull();
		expect(decision(shell('rg --line-number marker src'), roots)).toBeNull();
		expect(decision(shell('bin/codkit --json cycle status'), roots)).toBeNull();
		expect(decision(shell('bin/codkit build errors --json'), roots)).toBeNull();
		expect(
			decision(
				shell(
					'node --experimental-strip-types --disable-warning=ExperimentalWarning codkit/claude/skills/ck-resolve/scripts/append-journal.mjs --entry .codkit/agent-journal-entry.json'
				),
				roots
			)
		).toBeNull();
	});
});

describe('hook process boundary', () => {
	it('the Bash wrapper consumes hook JSON and returns a structured deny', () => {
		const wrapper = join(repoRoot, 'codkit', 'hooks', 'pretool.sh');
		chmodSync(wrapper, 0o755);
		const roots = fixtureRoots('hook-wrapper');
		const env = { ...process.env, CODKIT_PATCHES_DIR: roots.project, CODKIT_FORK_DIR: roots.tree };
		const run = spawnSync(wrapper, [], { cwd: repoRoot, env, input: '{}', encoding: 'utf8' });
		expect(run.status).toBe(0);
		expect(reason(JSON.parse(run.stdout) as unknown)).toContain('malformed hook input');

		const allowed = spawnSync(wrapper, [], {
			cwd: repoRoot,
			env,
			input: JSON.stringify(shell('git log -1 --oneline')),
			encoding: 'utf8'
		});
		expect(allowed.status).toBe(0);
		expect(allowed.stdout).toBe('');
	});

	it('fails closed when codkit where cannot run', () => {
		const project = makeTempRoot('agent-guard-no-codkit');
		const copied = join(project, 'codkit', 'hooks', 'pretool.mjs');
		mkdirSync(dirname(copied), { recursive: true });
		copyFileSync(guardPath, copied);
		const run = spawnSync(process.execPath, [copied], {
			cwd: project,
			input: JSON.stringify(shell('git status')),
			encoding: 'utf8'
		});
		expect(run.status).toBe(0);
		expect(reason(JSON.parse(run.stdout) as unknown)).toContain('failed closed');
	});
});

type Roots = { project: string; tree: string; outside: string };

function fixtureRoots(label: string): Roots {
	const project = makeTempRoot(`${label}-patchset`);
	const tree = makeTempRoot(`${label}-tree`);
	const outside = makeTempRoot(`${label}-outside`);
	for (const path of [join(project, 'delta'), join(tree, 'src')]) mkdirSync(path, { recursive: true });
	return { project, tree, outside };
}

function writeTask(project: string, paths: string[]): void {
	mkdirSync(join(project, '.codkit'), { recursive: true });
	writeFileSync(
		join(project, '.codkit', 'agent-task.json'),
		`${JSON.stringify({
			codkitAgentTask: 1,
			kind: 'resolve',
			targetTag: '1.136.0',
			actor: 'agent:ck-conflict-resolver',
			blockers: [{ artifact: 'delta/patches/example.ckpatch', outcome: 'conflict', paths }]
		})}\n`
	);
}

function writeReportTask(project: string, kind: 'scout' | 'verify' | 'review' | 'cause', output: string): void {
	mkdirSync(join(project, '.codkit'), { recursive: true });
	writeFileSync(
		join(project, '.codkit', 'agent-task.json'),
		`${JSON.stringify({
			codkitAgentTask: 1,
			kind,
			targetTag: '1.136.0',
			actor: `agent:ck-${kind}`,
			outputs: [output]
		})}\n`
	);
}

function decision(input: Record<string, unknown>, roots: Roots): unknown {
	const run = spawnSync(
		process.execPath,
		['--input-type=module', '--eval', evalScript, JSON.stringify(input), repoRoot, roots.project, roots.tree],
		{
			encoding: 'utf8'
		}
	);
	expect(run.status, run.stderr).toBe(0);
	return JSON.parse(run.stdout) as unknown;
}

function edit(filePath: string): Record<string, unknown> {
	return { hook_event_name: 'PreToolUse', tool_name: 'Edit', cwd: dirname(filePath), tool_input: { file_path: filePath } };
}

function shell(command: string, cwd: string = repoRoot): Record<string, unknown> {
	return { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd, tool_input: { command } };
}

function reason(value: unknown): string {
	if (typeof value !== 'object' || value === null || !('hookSpecificOutput' in value)) return '';
	const output = value.hookSpecificOutput;
	if (typeof output !== 'object' || output === null || !('permissionDecisionReason' in output)) return '';
	return typeof output.permissionDecisionReason === 'string' ? output.permissionDecisionReason : '';
}
