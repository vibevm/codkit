#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..', '..');
const profileRoot = join(root, 'packages', 'codkit', 'claude');
const failures = [];
const docs = ['00-index.md', '01-journal-format.md', '02-evals.md', '03-memory-policy.md'];
const agents = ['ck-upstream-scout.md', 'ck-conflict-resolver.md', 'ck-verifier.md', 'ck-upgrade-reviewer.md', 'ck-cause-finder.md'];
const profileRules = new Map([
	['ck-delta-artifacts.md', 'delta/**'],
	['ck-markers.md', null],
	['ck-cycle.md', 'cycle/**']
]);
const toolRules = new Map([['ck-codkit-dev.md', 'packages/**']]);

for (const name of docs) checkText(join(here, name), true);
for (const name of agents) {
	const source = join(root, 'docs', 'codkit', 'agents', name);
	const target = join(profileRoot, 'agents', name);
	const text = checkText(source, false);
	if (text !== null) checkAgentFrontmatter(name, text);
	if (!existsSync(target) || readFileSync(target, 'utf8') !== text) failures.push(`agent copy differs: ${name}`);
}

checkRules(join(profileRoot, 'rules'), profileRules, 'profile');
checkRules(join(root, '.claude', 'rules'), toolRules, 'tool');

const core = checkText(join(root, 'docs', 'codkit', 'agents', 'shared-core.md'), false);
if (core !== null && lineCount(core) > 120) failures.push(`shared core exceeds 120 lines: ${lineCount(core)}`);
for (const name of ['CLAUDE.md', 'AGENTS.md']) {
	const text = checkText(join(profileRoot, name), false);
	if (text === null || core === null) continue;
	if (occurrences(text, '<!-- codkit-agent-core:begin -->') !== 1 || occurrences(text, '<!-- codkit-agent-core:end -->') !== 1) {
		failures.push(`managed core markers invalid: packages/codkit/claude/${name}`);
	} else if (!text.includes(core.trimEnd())) {
		failures.push(`managed core differs from source: packages/codkit/claude/${name}`);
	}
}

checkSettings();
checkToolRepositoryIsFree();
for (const path of ['packages/codkit/hooks/pretool.mjs', 'packages/codkit/hooks/pretool.sh', 'packages/codkit/hooks/pretool.ps1']) checkText(join(root, path), false);
checkSkillsPackage();

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

function checkRules(directory, expected, label) {
	if (!existsSync(directory)) {
		failures.push(`missing ${label} rules directory: ${directory.slice(root.length + 1)}`);
		return;
	}
	const present = readdirSync(directory).filter((name) => name.endsWith('.md')).sort();
	const wanted = [...expected.keys()].sort();
	if (present.join(',') !== wanted.join(',')) failures.push(`${label} rules must be exactly ${wanted.join(', ')}: found ${present.join(', ')}`);
	for (const [name, expectedPath] of expected) {
		const text = checkText(join(directory, name), false);
		if (text === null) continue;
		const frontmatter = frontmatterOf(text);
		if (expectedPath === null && frontmatter !== null) failures.push(`markers rule must be unscoped: ${name}`);
		if (expectedPath !== null && !frontmatter?.includes(`- "${expectedPath}"`)) failures.push(`wrong paths scope: ${name}`);
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
	const path = join(profileRoot, 'settings.json');
	const text = checkText(path, false);
	if (text === null) return;
	let settings;
	try {
		settings = JSON.parse(text);
	} catch (error) {
		failures.push(`settings JSON: ${error.message}`);
		return;
	}
	if (settings.permissions?.allow !== undefined) failures.push('profile settings must not grant permissions');
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
		hook.args[0] !== '<codkit-tool-root>/hooks/pretool.mjs'
	) {
		failures.push('PreToolUse hook must use the Node exec form with the <codkit-tool-root> placeholder');
	}
}

// The Codkit tool repository is worked freely: no agent hook, deny profile,
// agents, or skills may live under its own .claude/ (FEAT-004 GR-TREE-EDITS).
function checkToolRepositoryIsFree() {
	const settingsPath = join(root, '.claude', 'settings.json');
	if (existsSync(settingsPath)) {
		let settings = null;
		try {
			settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
		} catch {
			failures.push('tool repository .claude/settings.json is not JSON');
		}
		if (settings?.hooks !== undefined) failures.push('tool repository .claude/settings.json must not install hooks');
	}
	for (const name of ['agents', 'skills']) {
		if (existsSync(join(root, '.claude', name))) failures.push(`tool repository must not carry .claude/${name}; the profile lives under packages/codkit/claude/`);
	}
}

// The skills are no longer part of the hand-written profile: they ship in the
// `agent-skills` vibe package and reach a repository through `codkit standards
// load`, `vibe install --offline` and `vibe skill install` (PROP-014 §1a).
function skillsPackageRoot() {
	const parent = join(root, 'packages', 'codkit', 'vibevm', 'vibepacks', 'org.vibevm.codkit', 'agent-skills');
	const versions = existsSync(parent) ? readdirSync(parent).filter((name) => name.startsWith('v')).sort() : [];
	if (versions.length !== 1) {
		failures.push(`the agent-skills package must have exactly one version directory: found ${versions.length}`);
		return null;
	}
	return join(parent, versions[0], 'vibevm', 'vibespecs', 'skills');
}

function checkSkillsPackage() {
	const skills = skillsPackageRoot();
	if (skills === null) return;
	if (existsSync(join(profileRoot, 'skills'))) {
		failures.push('packages/codkit/claude/skills must not exist; the skills ship in the agent-skills package');
	}
	for (const name of ['ck-orient', 'ck-intervene', 'ck-review-intervention', 'ck-resolve']) {
		const body = checkText(join(skills, name, 'SKILL.md'), false);
		if (body === null) continue;
		const frontmatter = frontmatterOf(body);
		// The harness reads the frontmatter from the first bytes of the file, so
		// the licence comment has to come after it.
		if (!body.startsWith('---\n')) failures.push(`skill frontmatter must be the first bytes: ${name}`);
		for (const field of [`name: ${name}`, 'description:', 'allowed-tools:']) {
			if (!frontmatter?.includes(field)) failures.push(`skill frontmatter missing ${field}: ${name}`);
		}
		if (body.includes('TODO')) failures.push(`skill is unfinished: ${name}`);
	}
	checkResolverSkill(join(skills, 'ck-resolve'));
}

function checkResolverSkill(skillRoot) {
	const skill = checkText(join(skillRoot, 'SKILL.md'), false);
	const helper = checkText(join(skillRoot, 'scripts', 'append-journal.mjs'), false);
	const openai = checkText(join(skillRoot, 'agents', 'openai.yaml'), false);
	if (skill !== null) {
		if (!skill.includes('.codkit/agent-task-result.json')) failures.push('resolver skill lacks result binding');
		// The projection is the only copy that exists in a product, so the skill
		// names its own directory and never a path inside the tool checkout.
		if (!skill.includes('<skill-dir>/scripts/append-journal.mjs')) {
			failures.push('resolver skill must call the journal helper beside itself in the projection');
		}
		if (skill.includes('<codkit-tool-root>/claude/skills/')) {
			failures.push('resolver skill still names the retired profile path of the journal helper');
		}
	}
	if (helper !== null) {
		if (!helper.includes('agent-task-result.json') || !helper.includes('withLock')) {
			failures.push('resolver journal helper lacks result/lock binding');
		}
		// A projected copy sits at no fixed depth below the tool root.
		if (helper.includes('../../../../..')) failures.push('resolver journal helper still resolves the tool root by relative depth');
		if (!helper.includes("spawnSync('codkit'")) failures.push('resolver journal helper must resolve its roots through the installed launcher');
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
