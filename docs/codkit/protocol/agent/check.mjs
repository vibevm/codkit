#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const failures = [];
const docs = ['00-index.md', '01-journal-format.md', '02-evals.md', '03-memory-policy.md'];
const agents = ['ck-upstream-scout.md', 'ck-conflict-resolver.md', 'ck-verifier.md', 'ck-upgrade-reviewer.md', 'ck-cause-finder.md'];
const rules = new Map([
	['ck-delta-artifacts.md', 'delta/**'],
	['ck-markers.md', null],
	['ck-codkit-dev.md', 'codkit/**'],
	['ck-cycle.md', 'cycle/**']
]);

for (const name of docs) checkText(join(here, name), true);
for (const name of agents) {
	const source = join(root, 'docs', 'codkit', 'agents', name);
	const target = join(root, '.claude', 'agents', name);
	const text = checkText(source, false);
	if (text !== null) checkAgentFrontmatter(name, text);
	if (!existsSync(target) || readFileSync(target, 'utf8') !== text) failures.push(`agent copy differs: ${name}`);
}

for (const [name, expectedPath] of rules) {
	const text = checkText(join(root, '.claude', 'rules', name), false);
	if (text === null) continue;
	const frontmatter = frontmatterOf(text);
	if (expectedPath === null && frontmatter !== null) failures.push(`markers rule must be unscoped: ${name}`);
	if (expectedPath !== null && !frontmatter?.includes(`- "${expectedPath}"`)) failures.push(`wrong paths scope: ${name}`);
}

const core = checkText(join(root, 'docs', 'codkit', 'agents', 'shared-core.md'), false);
if (core !== null && lineCount(core) > 120) failures.push(`shared core exceeds 120 lines: ${lineCount(core)}`);
for (const name of ['CLAUDE.md', 'AGENTS.md']) {
	const text = checkText(join(root, name), false);
	if (text === null || core === null) continue;
	if (occurrences(text, '<!-- codkit-agent-core:begin -->') !== 1 || occurrences(text, '<!-- codkit-agent-core:end -->') !== 1) {
		failures.push(`managed core markers invalid: ${name}`);
	} else if (!text.includes(core.trimEnd())) {
		failures.push(`managed core differs from source: ${name}`);
	}
}

checkSettings();
for (const path of ['codkit/hooks/pretool.mjs', 'codkit/hooks/pretool.sh', 'codkit/hooks/pretool.ps1']) checkText(join(root, path), false);
checkResolverSkill();

const sync = spawnSync(process.execPath, [join(root, 'tools', 'sync-codkit-agents.mjs'), '--check'], {
	cwd: root,
	encoding: 'utf8'
});
if (sync.status !== 0) failures.push(`sync check failed: ${(sync.stderr || sync.stdout).trim()}`);

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`${failure}\n`);
	process.exit(1);
}
process.stdout.write('agent protocol check: ok\n');

function checkText(path, links) {
	if (!existsSync(path)) {
		failures.push(`missing: ${path.slice(root.length + 1)}`);
		return null;
	}
	const bytes = readFileSync(path);
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		failures.push(`not UTF-8: ${path.slice(root.length + 1)}`);
		return null;
	}
	if (!text.endsWith('\n')) failures.push(`no final LF: ${path.slice(root.length + 1)}`);
	if (text.includes('\r')) failures.push(`CR is forbidden: ${path.slice(root.length + 1)}`);
	if (/\/home\/[^/]+|[A-Za-z]:\\Users\\/u.test(text)) failures.push(`machine path: ${path.slice(root.length + 1)}`);
	if (links) checkLinks(path, text);
	return text;
}

function checkLinks(path, text) {
	for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const target = match[1];
		if (target.startsWith('#') || /^[a-z]+:/i.test(target)) continue;
		const file = decodeURIComponent(target.split('#', 1)[0]);
		if (file !== '' && !existsSync(resolve(dirname(path), file))) {
			failures.push(`broken link: ${path.slice(root.length + 1)} -> ${target}`);
		}
	}
}

function checkAgentFrontmatter(name, text) {
	const frontmatter = frontmatterOf(text);
	if (frontmatter === null) {
		failures.push(`missing frontmatter: ${name}`);
		return;
	}
	const expectedName = name.slice(0, -3);
	for (const field of [`name: ${expectedName}`, 'description:', 'tools:', 'model:', 'effort:', 'permissionMode:']) {
		if (!frontmatter.includes(field)) failures.push(`frontmatter ${field} missing: ${name}`);
	}
	if (!/^tools:.*\bWrite\b/m.test(frontmatter)) failures.push(`agent has no guarded file output tool: ${name}`);
	if (name !== 'ck-conflict-resolver.md' && !text.includes('outputs[]')) failures.push(`report agent does not write exact task outputs: ${name}`);
}

function checkSettings() {
	const path = join(root, '.claude', 'settings.json');
	const text = checkText(path, false);
	if (text === null) return;
	let settings;
	try {
		settings = JSON.parse(text);
	} catch (error) {
		failures.push(`settings JSON: ${error.message}`);
		return;
	}
	if (settings.permissions?.allow !== undefined) failures.push('project settings must not grant permissions');
	if (!Array.isArray(settings.permissions?.deny) || settings.permissions.deny.length === 0) failures.push('settings deny list missing');
	const groups = settings.hooks?.PreToolUse;
	if (!Array.isArray(groups) || groups.length !== 1 || groups[0]?.matcher !== 'Bash|PowerShell|Edit|Write|NotebookEdit') {
		failures.push('PreToolUse matcher invalid');
		return;
	}
	const hook = groups[0]?.hooks?.[0];
	if (
		hook?.type !== 'command' ||
		hook.command !== 'node' ||
		!Array.isArray(hook.args) ||
		hook.args.length !== 1 ||
		hook.args[0] !== '${CLAUDE_PROJECT_DIR}/codkit/hooks/pretool.mjs'
	) {
		failures.push('PreToolUse hook must use portable Node exec form');
	}
}

function checkResolverSkill() {
	const skill = checkText(join(root, '.claude', 'skills', 'ck-resolve', 'SKILL.md'), false);
	const helper = checkText(join(root, '.claude', 'skills', 'ck-resolve', 'scripts', 'append-journal.mjs'), false);
	const openai = checkText(join(root, '.claude', 'skills', 'ck-resolve', 'agents', 'openai.yaml'), false);
	if (skill !== null) {
		const frontmatter = frontmatterOf(skill);
		for (const field of ['name: ck-resolve', 'description:', 'allowed-tools:']) {
			if (!frontmatter?.includes(field)) failures.push(`resolver skill frontmatter missing ${field}`);
		}
		if (skill.includes('TODO') || !skill.includes('.codkit/agent-task-result.json')) failures.push('resolver skill is unfinished or lacks result binding');
	}
	if (helper !== null && (!helper.includes('agent-task-result.json') || !helper.includes('withLock'))) {
		failures.push('resolver journal helper lacks result/lock binding');
	}
	if (openai !== null && (!openai.includes('allow_implicit_invocation: false') || !openai.includes('default_prompt:'))) {
		failures.push('resolver skill must remain explicit-only with a default prompt');
	}
}

function frontmatterOf(text) {
	const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
	return match?.[1] ?? null;
}

function lineCount(text) {
	return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
}

function occurrences(text, needle) {
	return text.split(needle).length - 1;
}
