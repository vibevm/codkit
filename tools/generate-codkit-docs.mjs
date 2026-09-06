#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_NEEDS_HUMAN, EXIT_OK } from '../codkit/src/lib/command.ts';
import { loadConventions } from '../codkit/src/lib/conventionsFile.ts';
import { ERROR_CODES, WARNING_CODES } from '../codkit/src/lib/messages.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const unexpected = process.argv.slice(2).filter((argument) => argument !== '--check');
if (unexpected.length > 0) {
	process.stderr.write('usage: node tools/generate-codkit-docs.mjs [--check]\n');
	process.exit(2);
}

function main() {
	const help = codkitHelp();
	const parsedHelp = parseHelp(help);
	const flagKinds = readFlagKinds();
	const conventions = loadConventions(root);
	const outputs = new Map([
		[join(root, 'docs/codkit/reference/commands.md'), renderCommands(parsedHelp, flagKinds)],
		[join(root, 'docs/codkit/reference/conventions.md'), renderConventions(conventions)],
		[join(root, 'docs/codkit/reference/faq.md'), renderFaq()]
	]);

	let stale = false;
	for (const [path, content] of outputs) {
		if (check) {
			let actual = '';
			try {
				actual = readFileSync(path, 'utf8');
			} catch {
				// A missing generated file is simply stale.
			}
			if (actual !== content) {
				process.stderr.write(`stale generated documentation: ${relative(root, path)}\n`);
				stale = true;
			}
			continue;
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content, 'utf8');
		process.stdout.write(`wrote ${relative(root, path)}\n`);
	}

	if (stale) {
		process.stderr.write('run: node tools/generate-codkit-docs.mjs\n');
		process.exit(1);
	}
	if (check) checkLocalLinks([...outputs.keys(), join(root, 'codkit/README.md'), ...ciExampleMarkdownFiles()]);
}

function codkitHelp() {
	const result = spawnSync(process.execPath, [join(root, 'codkit/bin/codkit.mjs')], {
		cwd: root,
		encoding: 'utf8',
		env: process.env
	});
	if (result.status !== EXIT_OK) {
		throw new Error(`codkit help failed with exit ${String(result.status)}: ${result.stderr.trim()}`);
	}
	if (result.stderr !== '') {
		throw new Error(`codkit help unexpectedly wrote stderr: ${result.stderr.trim()}`);
	}
	return result.stdout;
}

function parseHelp(text) {
	const lines = text.trimEnd().split('\n');
	const commandStart = lines.indexOf('commands:');
	const globalStart = lines.indexOf('global flags:');
	if (commandStart === -1 || globalStart === -1 || globalStart <= commandStart) {
		throw new Error('cannot find command/global sections in codkit help');
	}
	const commands = lines.slice(commandStart + 1, globalStart - 1).map((line) => {
		const match = /^  (.+?) {2,}(.+)$/.exec(line);
		if (match === null) throw new Error(`cannot parse codkit command help line: ${line}`);
		const name = match[1].trimEnd();
		let summary = match[2];
		let flags = [];
		const flagMatch = / \(flags: ([^)]+)\)$/.exec(summary);
		if (flagMatch !== null) {
			flags = flagMatch[1].split(', ');
			summary = summary.slice(0, flagMatch.index);
		}
		return { name, summary, flags };
	});
	const globalFlags = lines.slice(globalStart + 1).map((line) => {
		const match = /^  (.+?) {2,}(.+)$/.exec(line);
		if (match === null) throw new Error(`cannot parse codkit global flag help line: ${line}`);
		return { syntax: match[1].trimEnd(), description: match[2] };
	});
	return { commands, globalFlags };
}

function readFlagKinds() {
	const source = readFileSync(join(root, 'codkit/src/lib/argv.ts'), 'utf8');
	const kinds = new Map();
	for (const match of source.matchAll(/\['(--[^']+)', '(boolean|value|repeatable)'\]/g)) {
		kinds.set(match[1], match[2]);
	}
	if (kinds.size === 0) throw new Error('cannot read command flag kinds from codkit/src/lib/argv.ts');
	return kinds;
}

const valueLabels = {
	'--from': 'url|path',
	'--message': 'text',
	'--allow-new-file': 'path',
	'--diff': 'ref',
	'--channel': 'name',
	'--timeout': 'seconds',
	'--profile': 'verify|build',
	'--effective-diff': 'base-ref',
	'--pin-guard-base': 'ref',
	'--id': 'id',
	'--type': 'type',
	'--owner': 'owner',
	'--reason': 'text',
	'--category': 'category',
	'--layer': 'patch|entry-module',
	'--line': 'n',
	'--patch': 'contained-old-patch',
	'--ref': 'ref',
	'--release': 'semver',
	'--keep-consumed': 'n',
	'--older-than': 'days',
	'--branding-dir': 'path'
};

const commandGuidance = {
	where: {
		positional: '',
		detail:
			'Resolve the external roots without loading patch-set configuration and report schema-2 `roots.tool`, `roots.patches`, and `roots.fork` with their winning sources.'
	},
	'check-tree': {
		positional: '',
		detail: 'Read-only identity and pin/LFS checks. `--require-clean` also returns 1 when paths outside the own directory are dirty.'
	},
	clone: {
		positional: '',
		detail: 'Clone from `--from` or `publishRemoteUrl`, check out the pin, and fetch LFS content. Rejected by `--ci`.'
	},
	load: {
		positional: '',
		detail:
			'Apply the delta at the configured pin. `--dry-run` reports without writing; `--fresh` uses the configured cleanup whitelist and replaces an overlay target that still carries the exact materialization `overlay apply` wrote; `--clone-if-missing` is networked and therefore rejected by `--ci`; `--discard` drops fork-tree commits on purpose (kept reachable under `refs/codkit/consumed/`) and is likewise refused under `--ci`.'
	},
	status: { positional: '', detail: 'Show the pin/generated branch and work in the fork tree that has not been extracted.' },
	save: {
		positional: '[path ...]',
		detail:
			'Extract all changed paths, or only the named paths, back into patchset. Tree commits replay one by one into patchset history with their own subject, author and date plus a `Codkit-Tree-Commit` trailer; `--squash` folds them into one commit, and without tree commits it is a no-op that says so. `--allow-new-file` is repeatable. `--commit` commits the uncommitted remainder; `--message` supplies its message (or the squash subject under `--squash`).'
	},
	sync: {
		positional: '',
		detail:
			"The two-way command: extract the fork tree work and apply the patch set shifts in one run, per target and under a durable transaction. A file both sides changed stops the run with the 3-way materialized as diff3 markers inside the file's codkit block - resolve them by hand, then `sync --continue` finishes the run and `sync --abort` returns everything to the state before it. `--dry-run` prints the classification; `--discard` drops fork-tree commits on purpose (refused under `--ci`); `--squash`/`--commit`/`--message` shape the patchset history and `--fresh` the rebuild (the extraction flags also apply to `--continue`)."
	},
	gc: {
		positional: '',
		detail:
			"Remove spent runtime state: consumed refs beyond `--keep-consumed <n>` (default 5) that are also `--older-than <days>` old (default 30), crash scratch under `.codkit/tmp`, dead-owner tree locks, apply caches of trees that no longer exist, and generated `.codkit/out` output. `--dry-run` prints the same plan without removing anything; the kept classes - a stopped sync's transaction, pending draft headers, daemon records, a live owner's lock - are named as kept in the plan and never touched."
	},
	'marker new': {
		positional: '<tree-file>',
		requiredFlags: ['--id', '--type', '--owner', '--reason'],
		detail:
			'Create an empty marker block and pending patch header. `--id`, `--type`, `--owner`, and `--reason` are required; category defaults to `follow` and layer defaults to `patch`.'
	},
	reresolve: {
		positional: '<tree-file>',
		detail: 'Replay a contained old patch over one current tree file; `--patch` selects the source when automatic lookup is not sufficient.'
	},
	inventory: {
		positional: '',
		detail: 'Write `.codkit/out/inventory.json`; `--md` also writes Markdown and `--diff` compares with a local patchset ref.'
	},
	verify: {
		positional: '',
		detail: 'Read-only full delta integrity report. The hook-only `--staged-fast` flag is intentionally not public.'
	},
	'overlay apply': {
		positional: '<target|overlay-file>',
		detail: 'Materialize the composed overlay target for packaging, CI, or publish.'
	},
	'overlay check': {
		positional: '<target|overlay-file>',
		detail: 'Check overlay expectations and any materialized tree target without applying it.'
	},
	'build up': {
		positional: '',
		detail:
			'Start configured watch channels under a short-lived per-channel operation lock, with an exclusive complete reservation; starting/unknown records refuse and a busy channel refuses without touching its record. `--channel` selects one channel.'
	},
	'build down': {
		positional: '',
		detail:
			'Stop each proven watcher process group under the same per-channel operation lock and retire only its exact record after every member exits; starting/unknown records, and records owned by another fork tree, refuse without a signal. `--channel` selects one channel.'
	},
	'build status': {
		positional: '',
		detail:
			'Report starting/living/dead/unknown watcher truth, including descendants left after an npm leader exits; `--channel` selects one channel. It is read-only and point-in-time: exit 0 means the observation succeeded, not that every daemon is healthy, and a record owned by another fork tree is reported as `unknown` with that tree named.'
	},
	'build errors': {
		positional: '',
		detail:
			'Wait for the current proven daemon pass and print its errors. Starting/unknown state never certifies an old log, and neither does a record whose generation rotated while the log was read or whose tree is not this one; `--mine` narrows channels and `--timeout` is positive seconds.'
	},
	cycle: {
		positional: '<start <tag-or-sha> | continue | status | restart>',
		detail: '`restart` alone accepts and requires `--yes`. Exit 3 is a deliberate stop for human input.'
	},
	forecast: {
		positional: '',
		detail: 'Classify against a ref already present in the fork tree. It never fetches; `--ci` requires an explicit `--ref`.'
	},
	'rebase-onto-pin': {
		positional: '',
		detail: 'Replay feature-only patches after the target patchset branch, with its new pin, has been merged.'
	},
	ci: {
		positional: '',
		detail:
			'Run the no-network container threshold. Profile defaults to `verify`; `build` additionally requires supplied tree `node_modules`. Pin-guard/effective-diff refs must already exist locally.'
	},
	publish: {
		positional: '<immutable-patchset-ref>',
		requiredFlags: ['--yes-i-am-publish-bot'],
		detail:
			'Release-bot-only network transaction. It requires `--yes-i-am-publish-bot`, rejects global `--ci`, gates with `ls-remote` before mutation, and only then checks and pushes leased/immutable refs.'
	},
	hooks: {
		positional: '<install | check>',
		detail:
			'Install or inspect effective Codkit-owned patchset hooks. Check is green only when Git demonstrably executes the current owned bytes; linked/custom/foreign hook paths are inactive refusals.'
	},
	imageset: {
		positional: '<gen | index>',
		detail:
			'A namespace, not a command: it never generates. Bare `codkit imageset`, and any unknown subcommand, print the subcommand list and exit 2 before any root is resolved. `--help` lives here and answers the tools question for the whole namespace: none are required, on every supported OS, with the linked libraries and their licences listed so the claim can be checked.'
	},
	'imageset gen': {
		positional: '',
		detail:
			'Regenerate the product icon set from the branding masters in `<patchset>/branding` (`--branding-dir` overrides). The first run seeds that directory with the fork tree\'s own icons; `<family>.svg`/`<family>.png` masters serve every size, a per-size `<family>-<N>.png` override wins verbatim, and the output lands in the resource layer - `delta/resources/files/` plus `map.json` entries - for `load` to materialise. `--dry-run` prints the plan, including which master serves each frame, and writes nothing. A family without a master is skipped with a warning and exit 1; a new map entry needs its `guard.brand.<family>` suite declared under `delta/own/test/` first.'
	},
	'imageset index': {
		positional: '',
		detail:
			'Read-only index of the icon set, computed from the distribution and the masters directory rather than written down: per target its role and container, the exact sizes the distribution requires, and for each size whether it comes from a hand-made master, is generated from a base master, or has no master at all. It writes nothing - not even the seeding `gen` does - and exits 0 whether or not masters are missing. Markdown by default; `--json` carries the same model structurally.'
	}
};

function renderCommands({ commands, globalFlags }, kinds) {
	assertExactKeys(
		'command guidance',
		commands.map((command) => command.name),
		Object.keys(commandGuidance)
	);
	const commandRows = commands.map((command) => {
		const guide = commandGuidance[command.name];
		const required = new Set(guide.requiredFlags ?? []);
		for (const flag of required) {
			if (!command.flags.includes(flag)) throw new Error(`${command.name} marks an unadvertised flag required: ${flag}`);
		}
		const ownFlags = command.flags.map((flag) => {
			const rendered = renderFlag(flag, kinds);
			return required.has(flag) ? rendered : `[${rendered}]`;
		});
		const synopsis = ['codkit', command.name, guide.positional, ...ownFlags].filter((part) => part !== '').join(' ');
		return `| \`${escapeCell(synopsis)}\` | ${escapeCell(command.summary)} | ${escapeCell(guide.detail)} |`;
	});
	const globalRows = globalFlags.map((flag) => `| \`${flag.syntax}\` | ${flag.description} |`);
	return (
		generatedHeader('Command reference') +
		`
Codkit manages an external patch set and a separate VS Code fork tree. The public command and flag tables below are rendered from the output of the live CLI; command-flag arity is read from \`codkit/src/lib/argv.ts\`.

Install the launcher as \`codkit\` on \`PATH\`, or invoke the explicit Bash launcher as \`<codkit-tool-root>/bin/codkit ...\` and the PowerShell launcher as \`& <codkit-tool-root>\\bin\\codkit.ps1 ...\`. Never look for a launcher or \`package.json\` in the patch-set directory. Running the launcher with no arguments prints the current help and exits 0. There is no global \`--help\`; \`codkit imageset --help\` is the one command-scoped help and it answers before any root is required, while passing \`--help\` to another command is a usage error (exit 2).

## Global flags

Global flags are accepted before or after the command name (before a bare \`--\`).

| Flag | Meaning |
| --- | --- |
${globalRows.join('\n')}

External paths are independent. Fork-tree resolution is \`--fork-dir\` → \`CODKIT_FORK_DIR\` → \`~/.codkit/settings.json\` \`forkDir\`; patch-set resolution is \`--patches-dir\` → \`CODKIT_PATCHES_DIR\` → the same settings file's \`patchesDir\`. There is no sibling-directory fallback. Tool, patch-set, and fork roots must be pairwise disjoint. \`codkit --json where\` is configuration-free and reports the three selected roots and their sources in a schema-2 envelope.

## Commands

The synopsis lists public command flags only. Global flags may be added to every command.

| Synopsis | CLI summary | Operational detail |
| --- | --- | --- |
${commandRows.join('\n')}

## Exit status and output

| Exit | Meaning |
| --- | --- |
| ${EXIT_OK} | Command completed and requested checks passed. |
| ${EXIT_CHECK_FAILED} | The command ran, but a check/conflict/integrity verdict is red. The reported problem is normally actionable in the repositories. |
| ${EXIT_ENVIRONMENT} | Usage, configuration, dependency, repository, permission, or other environment/startup failure. Unknown commands/flags are codeless usage errors on stderr and do not produce a JSON envelope. |
| ${EXIT_NEEDS_HUMAN} | The upgrade cycle reached a deliberate human decision point. Do not automate past it. |

With \`--json\`, an invoked command writes one versioned envelope to stdout. Human progress and diagnostics remain on stderr. Require \`codkit.schema == 2\`; inspect \`roots.tool\`, \`roots.patches\`, \`roots.fork\`, \`ok\`, \`exitCode\`, \`errors[].code\`, and the command-specific \`data\`; do not parse human prose.

## Network boundary

- Global \`--ci\` is non-interactive and forbids Codkit network operations. The \`ci\` command implies the same restriction even when \`--ci\` is not typed.
- \`clone\` and \`load --clone-if-missing\` are the local, explicit ways to obtain a missing tree; both are rejected in \`--ci\` mode.
- \`forecast\`, \`check-tree\`, and \`ci\` use only objects/refs already present locally. The CI wrapper must provide missing refs, LFS objects, and dependencies.
- \`publish\` is intentionally not a CI-mode command. It is the only release push path, requires the bot confirmation flag, and refuses the combination with \`--ci\`.

See [conventions](conventions.md), [failure guidance](faq.md), and the [air-gapped supply-kit contract](../ci-examples/air-gapped-supply-kit.md).
`
	);
}

function renderFlag(flag, kinds) {
	const kind = kinds.get(flag);
	if (kind === undefined) throw new Error(`help advertises flag absent from COMMAND_FLAG_KINDS: ${flag}`);
	if (kind === 'boolean') return flag;
	const label = valueLabels[flag];
	if (label === undefined) throw new Error(`value label missing for ${flag}`);
	return `${flag} <${label}>${kind === 'repeatable' ? ' ...' : ''}`;
}

function renderConventions(conventions) {
	const markerRows = Object.entries(conventions.markerComment)
		.filter(([extension]) => !extension.startsWith('_'))
		.map(([extension, form]) => {
			if (!isMarkerForm(form)) throw new Error(`invalid marker form after schema load: ${extension}`);
			return `| \`${extension}\` | \`${escapeCell(`${form.open}begin <ID>${form.close}`)}\` | \`${escapeCell(`${form.open}end <ID>${form.close}`)}\` |`;
		});
	return (
		generatedHeader('Conventions reference') +
		`
This page is rendered from [\`codkit/config/conventions.json\`](../../../codkit/config/conventions.json), schema \`codkitConventions: ${conventions.codkitConventions}\`. Change the JSON source, then regenerate this page; do not hand-maintain copies of these values.

## Intervention identity and metadata

| Field | Current values |
| --- | --- |
| ID pattern | \`${escapeCell(conventions.idPattern)}\` |
| Subsystems | ${codeList(conventions.subsystems)} |
| Intervention types | ${codeList(conventions.interventionTypes)} |
| Categories | ${codeList(conventions.categories)} |
| Layers, highest preference first | ${codeList(conventions.layers)} |

An intervention ID belongs to exactly one intervention and must match the pattern. Choose the highest applicable layer: keep new code in \`own\`; use narrower declarative/registration layers before a patch. Format and behavior are defined in [PROP-003](../../../vibevm/vibespecs/modules/codkit/PROP-003-config-and-data.xml), [PROP-004](../../../vibevm/vibespecs/modules/codkit/PROP-004-markers-and-patch-format.xml), and [PROP-005](../../../vibevm/vibespecs/modules/codkit/PROP-005-delta-layers.xml); this page only renders operational values.

## Marker forms

Marker lines use the file's existing indentation. Content belongs between a matching pair with the same ID.

| Extension | Begin line after indentation | End line after indentation |
| --- | --- | --- |
${markerRows.join('\n')}

Use \`codkit marker new <tree-file> ...\` to scaffold markers and the pending header. Use \`codkit save\` to generate/update the patch artifact; do not synthesize patch files by hand.

## Protected targets and service overrides

Forbidden patch-target patterns: ${codeList(conventions.forbiddenPatchTargets)}.

Own code must not re-register these bootstrap services (${conventions.forbiddenServiceIds.length} current entries):

${bulletCodeList(conventions.forbiddenServiceIds)}

## Fresh cleanup whitelist

\`codkit load --fresh\` preserves untracked paths matched by this configured whitelist; other untracked content is disposable. Patterns use Codkit's documented gitignore-style subset.

${bulletCodeList(conventions.cleanupWhitelist)}

## Branch names

Branch prefixes are patch-set configuration, not conventions data. Never derive
or hard-code them in automation; read \`generatedBranchPrefix\`,
\`cycleBranchPrefix\`, and \`releaseRefPrefix\` from the selected patch set and
let Codkit create or use the refs. A release tag requested by
\`publish --release\` is separate from these branch prefixes.

See the [command reference](commands.md) and [failure guidance](faq.md).
`
	);
}

const faqEntries = {
	CONFIG: [
		'Configuration or a command value is invalid or missing.',
		'Read the emitted hint; restore/repair the named config or use the exact usage it prints.'
	],
	'NOT-A-REPO': [
		'The resolved fork path is not a usable Git work tree.',
		'Check `codkit where`, then point `--fork-dir`/`CODKIT_FORK_DIR` at the supplied checkout or run `codkit clone` outside CI.'
	],
	'NOT-UPSTREAM': [
		'The tree does not contain the configured upstream anchor.',
		'Supply the correct fork repository; do not repurpose an unrelated checkout.'
	],
	'PIN-UNREACHABLE': [
		'The configured pin/ref is absent or outside the expected upstream history.',
		'Fetch/provide that object outside Codkit CI, then rerun `codkit check-tree`; Codkit does not fetch it implicitly.'
	],
	LFS: [
		'Git LFS support or required LFS content is missing.',
		'Install Git LFS and populate LFS objects outside `--ci`, or include them in the offline fork-tree supply.'
	],
	LOCKED: [
		'Another Codkit operation owns the per-tree lock.',
		'Wait for the named process; if it is gone, follow the stale-lock hint instead of deleting active state blindly.'
	],
	'DIRTY-TREE': [
		'Unextracted or otherwise disallowed work makes the requested transition unsafe.',
		'Run `codkit status`, then `codkit save` for work to keep or restore it deliberately. Fork-tree commits can also be dropped on purpose with `codkit load --discard` (they stay reachable under `refs/codkit/consumed/`, where `codkit gc` eventually spends them; the flag is refused under `--ci`). A tree left by `overlay apply` returns to dev mode with `codkit load --fresh` (only the exact overlay materialization is replaced). CI should receive a disposable clean tree.'
	],
	'TREE-READONLY': [
		'Codkit cannot write the fork tree or its required runtime state.',
		'Fix ownership/permissions and rerun. The patchset source may be read-only only when `.codkit` is supplied as a separate writable mount; the fork tree itself must be writable for `ci`.'
	],
	CRLF: [
		'A patchable text target contains carriage returns.',
		'Normalize the intended file to LF without changing unrelated bytes, then save again.'
	],
	'EOF-NEWLINE': ['A file that had a final newline at the pin lost it.', 'Restore the final LF and rerun the command.'],
	ENCODING: ['Patch input is binary or not valid UTF-8.', 'Use the resource layer for binary content or restore valid UTF-8 for text.'],
	'MARKER-MALFORMED': [
		'A marker line has invalid syntax.',
		'Repair the exact named line to the configured form; use `codkit marker new` for new blocks.'
	],
	'MARKER-NESTED': ['A marker begins inside another marker.', 'Separate the interventions into non-nested blocks.'],
	'MARKER-UNBALANCED': ['Begin/end marker IDs do not pair.', 'Make the closing ID match its opening block.'],
	'MARKER-UNCLOSED': ['A marker block has no closing line.', 'Add the configured end marker for the same ID.'],
	'MARKER-DUP-ID': ['An intervention ID is reused.', 'Assign a fresh ID matching `idPattern`; IDs are unique across layers/artifacts.'],
	'MARKER-BAD-ID': [
		'A marker ID violates the configured pattern.',
		'Choose a configured subsystem and three-digit suffix shown in the conventions reference.'
	],
	'HUNK-OUTSIDE-MARKER': [
		'A patch hunk changes content outside its marker block.',
		'Move the intended edit into the block or choose another layer; do not widen the patch silently.'
	],
	'DELETES-UPSTREAM-LINE': [
		'A patch removes an upstream line.',
		'Preserve/comment the upstream line and express the behavior inside a marker or higher layer.'
	],
	'DELETES-UPSTREAM-FILE': [
		'A patch removes an upstream file.',
		'Use the hide/removed mechanism with its guard instead of a deletion patch.'
	],
	'NEW-FILE-IN-UPSTREAM-ZONE': [
		'A new file appeared outside own code without explicit authorization.',
		'Prefer `delta/own`; only when the path is inherently upstream-shaped, rerun save with repeatable `--allow-new-file <path>`.'
	],
	'HEADER-MISSING': [
		'A new patch has no pending metadata header.',
		'Scaffold with `codkit marker new`, complete its metadata, then run `codkit save`.'
	],
	'FORBIDDEN-TARGET': [
		'The selected path cannot carry this patch/marker operation.',
		'Follow the emitted layer/path hint; binary, own, protected, and unsupported-extension targets need another mechanism.'
	],
	'MARKER-ARTIFACT-MISMATCH': [
		'Tree markers, pending metadata, and patch artifacts disagree.',
		'Inspect the named pair and use the normal marker/save transaction to restore one-to-one ownership.'
	],
	'UNTRACKED-INTERVENTION': [
		'A change is not represented by a known delta artifact.',
		'Extract it with `codkit save` or remove/restore the unintended tree edit.'
	],
	'STALE-ARTIFACT': [
		'An artifact no longer has a valid current target/effect.',
		'Review the upstream change; reresolve, retarget, or remove the intervention through the upgrade procedure.'
	],
	'OWN-UNCOVERED': [
		'An own file is missing inventory/manifest coverage.',
		'Declare it in the own manifest/entry structure named by the hint, then verify.'
	],
	'OWNER-UNKNOWN': [
		'Metadata names an owner absent from `delta/owners.json`.',
		'Use an existing owner key or add the team-owned mapping deliberately.'
	],
	'GUARD-MISSING': [
		'An intervention that requires a contract guard has none or names an undeclared guard.',
		'Add/declare the required own guard test and rerun `codkit verify`.'
	],
	'FORBIDDEN-SERVICE': [
		'Own code overrides a configured bootstrap service.',
		'Do not override that decorator; choose a supported seam or escalate the design.'
	],
	'OVERLAY-SCHEMA': [
		'An overlay is syntactically/schema invalid or writes outside the allowed target policy.',
		'Repair the named overlay operation; for non-product `package.json`, only script additions are allowed.'
	],
	'OVERLAY-DRIFT': [
		'An overlay expectation or materialized target no longer matches the pin.',
		'Review upstream, update the overlay expectation intentionally, and use `overlay check/apply`; do not hand-edit the target.'
	],
	'RULE-DRIFT': [
		'A rewrite rule matched a different count/content than declared.',
		'Review upstream and update or replace the rule; never weaken the expected count merely to get green.'
	],
	'ARTIFACT-BROKEN': [
		'A delta/cycle artifact cannot be parsed, replayed, or trusted.',
		'Repair the named source or resume its durable transaction; do not edit transaction state files unless the hint explicitly says so.'
	],
	'NET-FORBIDDEN': [
		'The requested action would cross the active no-network boundary.',
		'Provide the clone/ref/LFS object through the CI or supply kit, or run the explicitly networked command outside `--ci`.'
	],
	'LOG-INCOMPLETE': [
		'An upgrade-cycle journal/history record is incomplete or inconsistent.',
		'Complete the required record through `codkit cycle` before continuing.'
	],
	'BOTH-SIDES-EDITED': [
		'The same file changed on both sides of the two repositories and needs a human decision.',
		'For a `codkit sync` conflict the 3-way is already in the fork-tree file as diff3 markers: keep both sides and the block ids, then `codkit sync --continue` (`codkit sync --abort` returns everything to the state before the run; while markers remain, `--continue` refuses naming the file). For own code and mixed `--discard` runs there are no blocks to materialize into - pick a side by hand as the printed recipe says.'
	],
	'WORKTREE-REF-SHARED': [
		'The generated branch is checked out in another worktree of the same repository, and moving it here would leave that worktree dirty.',
		'Let the named worktree use its own branch (git -C <path> switch --detach) or remove it (git worktree remove <path>), then re-run; nothing was changed.'
	],
	'TREE-HEAD': [
		'HEAD of the fork tree is off the generated branch while carrying commits that are not in patchset, or the line below the generated tip was rewritten.',
		'Return HEAD to the generated branch (git switch codkit/applied/<tag>) or merge the commits there, then run codkit save; for a rewritten line reset the branch to the named generated tip or restore it from refs/codkit/consumed/.'
	],
	'PATCHSET-MOVED': [
		'The patch set moved under a fork tree loaded from an older state: an artifact was edited or the patchset branch was switched between the load and the save.',
		'Follow the printed manual merge recipe: return the delta to the loaded state (`git stash`, `git switch <branch>`, or `git checkout <sha> -- delta/`), run `codkit save`, bring the shift back (`git stash pop`, `git merge`, or `git rebase`), then `codkit load` - or let `codkit sync` perform all four in one command. Switching branches deliberately starts with a full `codkit save`, not a switch.'
	],
	'SYNC-IN-PROGRESS': [
		'A two-way `codkit sync` left its transaction record behind without finishing, so the fork tree and the patch set are half one state and half another - or the abort found commits above the record that were not made by that run.',
		'Wait for the running sync; otherwise resolve the record: resolve the conflict markers and `codkit sync --continue`, or `codkit sync --abort` to return everything to the state before the run. An abort that names foreign commits refuses on purpose - move or remove them by hand first. The record at `.codkit/sync-transaction.json` carries the pre-run heads and byte snapshots; do not delete it blind.'
	],
	INTERNAL: [
		'An unexpected Codkit failure escaped domain diagnosis.',
		'Rerun with `--verbose` and attach the complete output to a bug report.'
	],
	'DEPS-MISSING': [
		'Required runtime dependencies or their npm cache receipts are absent.',
		'Install/restore Codkit dependencies in the tool root; for `ci --profile build`, also supply tree `node_modules` and `build/node_modules` through the air-gapped cache/mount. The patch set is not the tool installation, and empty bind-mount directories do not count as restored caches.'
	]
};

const warningEntries = {
	'MARK-RO': 'A marker is being treated read-only in the reported context; review before expecting save/materialization to change it.',
	'PATCHSET-SIDE-EDIT': 'The patchset-side artifact changed while related tree work exists; reconcile both sources before continuing.',
	'EMPTY-BLOCK': 'A marker block contains no intervention content; remove it through the normal save flow or fill it intentionally.'
};

function renderFaq() {
	assertExactKeys('FAQ error entries', ERROR_CODES, Object.keys(faqEntries));
	assertExactKeys('FAQ warning entries', WARNING_CODES, Object.keys(warningEntries));
	const errorRows = ERROR_CODES.map((code) => {
		const [meaning, action] = faqEntries[code];
		return `| \`CK-E-${code}\` | ${meaning} | ${action} |`;
	});
	const warningRows = WARNING_CODES.map((code) => `| \`CK-W-${code}\` | ${warningEntries[code]} |`);
	return (
		generatedHeader('Troubleshooting FAQ') +
		`
This page is keyed from the live registry in [\`codkit/src/lib/messages.ts\`](../../../codkit/src/lib/messages.ts). It covers every currently registered error and warning code. The hint printed for the specific failure is authoritative; the table gives the usual operator path.

## How should automation read a failure?

Use \`--json\` and branch on \`exitCode\` plus \`errors[].code\`. Exit 1 is a red check/result, exit 2 is usage/environment/startup, and exit 3 is a required human decision. A CLI typo occurs before a command context exists: it prints codeless \`error:\`/\`hint:\` lines to stderr, exits 2, and does not emit a JSON envelope.

## Error codes

| Code | What it means | Typical next action |
| --- | --- | --- |
${errorRows.join('\n')}

## Warning codes

Warnings do not by themselves define the process exit status; read the surrounding command result.

| Code | Operator interpretation |
| --- | --- |
${warningRows.join('\n')}

## Common operational traps

- Running \`codkit --help\`: help is currently the no-argument invocation; \`--help\` is an unknown flag and exits 2.
- Expecting \`ci\` to clone, fetch, pull LFS, install dependencies, or push: it does none of those. Prepare the Codkit installation, patch-set checkout, fork checkout, and caches first.
- Adding global \`--ci\` to \`publish\`: publication is a separate release-bot operation and deliberately rejects that combination.
- Treating \`verify\` exit 1 as a crash: it means the report completed and found violations. Read all findings from the same run.
- Editing a materialized overlay target or generated patch by hand: update the overlay source or edit inside the fork-tree marker and run \`save\`.

See the [command reference](commands.md), [conventions](conventions.md), and [CI examples](../ci-examples/README.md).
`
	);
}

function generatedHeader(title) {
	return `# ${title}\n\n<!-- Generated by tools/generate-codkit-docs.mjs; do not edit by hand. -->\n`;
}

function assertExactKeys(label, expected, actual) {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	const missing = expected.filter((key) => !actualSet.has(key));
	const extra = actual.filter((key) => !expectedSet.has(key));
	if (missing.length > 0 || extra.length > 0) {
		throw new Error(`${label} mismatch; missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'}`);
	}
}

function isMarkerForm(value) {
	return typeof value === 'object' && value !== null && typeof value.open === 'string' && typeof value.close === 'string';
}

function escapeCell(value) {
	return value.replaceAll('|', '\\|');
}

function codeList(values) {
	return values.length === 0 ? '_none_' : values.map((value) => `\`${escapeCell(value)}\``).join(', ');
}

function bulletCodeList(values) {
	return values.length === 0 ? '_None._' : values.map((value) => `- \`${value}\``).join('\n');
}

function ciExampleMarkdownFiles() {
	return ['README.md', 'air-gapped-supply-kit.md'].map((name) => join(root, 'docs/codkit/ci-examples', name));
}

function checkLocalLinks(files) {
	const planned = new Set(['docs/codkit/protocol/human/00-index.md', 'docs/codkit/protocol/agent/00-index.md']);
	for (const file of files) {
		const source = readFileSync(file, 'utf8');
		for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
			const destination = match[1].split('#', 1)[0];
			if (destination === '' || /^[a-z]+:/i.test(destination)) continue;
			const absolute = resolve(dirname(file), destination);
			const repoPath = relative(root, absolute).replaceAll('\\', '/');
			if (!existsSync(absolute) && !planned.has(repoPath)) {
				throw new Error(`broken local link in ${relative(root, file)}: ${destination}`);
			}
		}
	}
}

main();
