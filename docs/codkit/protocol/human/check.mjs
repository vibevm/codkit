#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const caps = new Map([
	['01-quickstart.md', 150],
	['02-daily.md', 250],
	['03-interventions.md', 350],
	['04-team.md', 200],
	['05-upgrade-cycle.md', 500],
	['06-history.md', 120],
	['07-upstream-watch.md', 200],
	['08-release-ci.md', 300],
	['09-incidents.md', 250],
	['10-roles.md', 200],
	['11-metrics.md', 150],
	['12-maintenance.md', 100],
	['13-standards.md', 120],
	['14-runtime.md', 140]
]);
const required = [
	'00-index.md',
	...caps.keys(),
	'templates/pr-checklist.md',
	'templates/cycle-issue.md',
	'templates/retrospective.md',
	'templates/decision-journal.md'
];
const failures = [];

for (const relative of required) {
	const path = resolve(root, relative);
	if (!existsSync(path)) {
		failures.push(`missing: ${relative}`);
		continue;
	}
	const bytes = readFileSync(path);
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		failures.push(`not UTF-8: ${relative}`);
		continue;
	}
	if (!text.endsWith('\n')) failures.push(`no final LF: ${relative}`);
	if (text.includes('\r')) failures.push(`CR is forbidden: ${relative}`);
	const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
	const cap = caps.get(relative);
	if (cap !== undefined && lines > cap) failures.push(`line cap: ${relative} has ${lines}, max ${cap}`);
	if (/\u043d\u0435 \u0437\u0430\u0431\u0443\u0434/i.test(text)) failures.push(`unmechanized reminder phrase: ${relative}`);
	if (/\u0434\u0435\u0439\u0441\u0442\u0432\u0443\u0439 \u043f\u043e \u0441\u0438\u0442\u0443\u0430\u0446\u0438\u0438/i.test(text)) failures.push(`unobservable branch phrase: ${relative}`);

	for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
		const target = match[1];
		if (target.startsWith('#') || /^[a-z]+:/i.test(target)) continue;
		const [rawFile, rawFragment] = target.split('#', 2);
		const file = decodeURIComponent(rawFile);
		const linkedPath = resolve(dirname(path), file);
		if (file !== '' && !existsSync(linkedPath)) {
			failures.push(`broken link: ${relative} -> ${target}`);
			continue;
		}
		if (rawFragment !== undefined && linkedPath.endsWith('.md') && existsSync(linkedPath)) {
			const linked = readFileSync(linkedPath, 'utf8');
			const anchors = new Set(
				[...linked.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) => slug(heading[1]))
			);
			const fragment = decodeURIComponent(rawFragment);
			if (!anchors.has(fragment)) failures.push(`broken anchor: ${relative} -> ${target}`);
		}
	}
}

function slug(heading) {
	return heading
		.trim()
		.replace(/`/g, '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.replace(/\s+/g, '-');
}

if (failures.length > 0) {
	for (const failure of failures) process.stderr.write(`${failure}\n`);
	process.exitCode = 1;
} else {
	process.stdout.write('human protocol check: ok\n');
}
