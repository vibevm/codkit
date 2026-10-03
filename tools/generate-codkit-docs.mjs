#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT_CHECK_FAILED, EXIT_ENVIRONMENT, EXIT_NEEDS_HUMAN, EXIT_OK } from '../packages/codkit/src/lib/command.ts';
import { loadConventions } from '../packages/codkit/src/lib/conventionsFile.ts';
// The conventions reference documents the effective policy of a patch set, and
// that is the engine's half composed with a project type's defaults. The
// generated page is written against the type the tool's own polygon uses
// (PROP-016 ##TYPE-AREA-CONVENTIONS); a second type would get its own page.
import { projectType as vscodeType } from '@codkit/type-vscode';
import { ERROR_CODES, WARNING_CODES } from '../packages/codkit/src/lib/messages.ts';

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
	const conventions = loadConventions(vscodeType, root);
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
	if (check) checkLocalLinks([...outputs.keys(), join(root, 'packages/codkit/README.md'), ...ciExampleMarkdownFiles()]);
}

function codkitHelp() {
	const result = spawnSync(process.execPath, [join(root, 'packages/codkit/bin/codkit.mjs')], {
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
	const source = readFileSync(join(root, 'packages/codkit/src/lib/argv.ts'), 'utf8');
	const kinds = new Map();
	for (const match of source.matchAll(/\['(--[^']+)', '(boolean|value|repeatable)'\]/g)) {
		kinds.set(match[1], match[2]);
	}
	if (kinds.size === 0) throw new Error('cannot read command flag kinds from packages/codkit/src/lib/argv.ts');
	return kinds;
}

const valueLabels = {
	'--from': 'url|path',
	'--message': 'text',
	'--allow-new-file': 'path',
	'--diff': 'ref',
	'--channel': 'name',
	'--timeout': 'seconds',
	'--inputs': 'dir',
	'--container-prefix': 'name',
	'--profile': 'verify|build',
	'--effective-diff': 'base-ref',
	'--pin-guard-base': 'ref',
	'--id': 'id',
	'--type': 'type',
	'--owner': 'owner',
	'--reason': 'text',
	'--category': 'category',
	'--contract-test': 'guard-test-id',
	'--layer': 'patch|entry-module',
	'--line': 'n',
	'--patch': 'contained-old-patch',
	'--ref': 'ref',
	'--release': 'semver',
	'--branch': 'name',
	'--author': 'name-and-email',
	'--message-file': 'path',
	'--export-bare': 'dir',
	'--export-repo': 'dir',
	'--keep-consumed': 'n',
	'--older-than': 'days',
	'--branding-dir': 'path',
	'--dir': 'path',
	'--year': 'YYYY',
	'--holder': 'name',
	'--license': 'spdx-id',
	'--source': 'text',
	'--title': 'text',
	'--header-style': 'line|block',
	'--header-file': 'path'
};

const commandGuidance = {
	config: { positional: '', detail: 'Configuration namespace; use config migrate for the explicit schema transition.' },
	'config migrate': {
		positional: '',
		detail:
			'Preview config v2/v3 to v4 with minimal-intervention@1 without importing a type adapter. --write explicitly applies the canonical conversion under the config lock; active operations and changed bytes refuse. Repeating an already-v4 conversion writes nothing. V4 permits pin.tag to be absent; pin.sha remains the immutable revision, pin.date the commit date, resolvedAt the resolution timestamp when known, and provenance declarative source/digest evidence. Ordinary v2/v3 writes preserve their schema. No fork is required.'
	},
	where: {
		positional: '',
		detail:
			'Resolve the external roots and report schema-2 `roots.tool`, `roots.patches`, and `roots.fork` with their winning sources, plus the project type the patch set declares.'
	},
	types: {
		positional: '',
		detail:
			'Print the project types this installation carries: the identifier a `codkit.json` may declare, the package that implements it, its version and the capabilities it answers. Needs no patch set.'
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
		flagLabels: { '--inputs': 'working|pinned' },
		detail:
			"Apply the delta at the configured pin. `--dry-run` reports without writing; `--fresh` uses the configured cleanup whitelist and replaces an overlay target that still carries the exact materialization `overlay apply` wrote; `--clone-if-missing` is networked and therefore rejected by `--ci`; `--discard` drops fork-tree commits on purpose (kept reachable under `refs/codkit/consumed/`) and is likewise refused under `--ci`. With `--fresh`, `--discard` also drops the working-tree edits of tracked upstream files that carry no marker block - a build artifact in a dev tree - printing `discard <path>` for each before the first write and reporting them in `data.discardedPaths`; a file with a marker block, own code, own extensions and untracked paths are never dropped. A plain load also passes over a materialized own extension no record declares any more instead of refusing over it: it neither writes into that directory nor removes it, `codkit status` names it, and `--fresh` is what sweeps it. Every other guarded command treats the directory as it did. `--inputs working|pinned` chooses where the inputs of the configuration come from - the working tree of each input's repository, uncommitted edits included (the default), or its pinned commit - and `--no-inputs` delivers none and leaves the delivered ones as they are; an input lands untracked at its `to`, hidden by the managed exclude block, a build is skipped while the stamp of its content stays the same, and an edit made in an input directory is named and replaced by the input's bytes."
	},
	status: {
		positional: '',
		detail:
			"Show the pin/generated branch and work in the fork tree that has not been extracted. The own-extension line also counts the stranded materializations - untracked `extensions/<name>/` directories that no record of the manifest declares and the pin does not ship, which only `codkit load --fresh` removes; each is listed with that recipe and raises the exit code to 1. Changed upstream files that are exactly the overlay materialization codkit itself writes are reported in `data.upstream.materializedOverlayTargets`, and when they are the only thing the tree carries the printed next step is `codkit load --fresh` rather than `codkit save`, which is not what withdraws an overlay target. Every input of the configuration is reported: what the tree carries of it, each path edited in its directory (exit 1; the change belongs to the input's repository), and warnings for a pin behind the HEAD of that repository or a repository with uncommitted changes."
	},
	save: {
		positional: '[path ...]',
		detail:
			'Extract all changed paths, or only the named paths, back into patchset. Tree commits replay one by one into patchset history with their own subject, author and date plus a `Codkit-Tree-Commit` trailer; `--squash` folds them into one commit, and without tree commits it is a no-op that says so. `--allow-new-file` is repeatable. `--commit` commits the uncommitted remainder; `--message` supplies its message (or the squash subject under `--squash`). An edit in the directory of an input is refused before anything is written: that content belongs to the repository of the input.'
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
			'Create an empty marker block and pending patch header. `--id`, `--type`, `--owner`, and `--reason` are required; category defaults to `follow` and layer defaults to `patch`. With `--add-block`, only `--id` (and `--line`) are given: it opens another block of an intervention the file already carries, for a graft that is an import line and a call site.'
	},
	reresolve: {
		positional: '<tree-file>',
		detail: 'Replay a contained old patch over one current tree file; `--patch` selects the source when automatic lookup is not sufficient.'
	},
	inventory: {
		positional: '',
		detail:
			'Write `.codkit/out/inventory.json`; `--md` also writes Markdown and `--diff` compares with a local patchset ref. The inputs of the configuration are listed with their pinned commits.'
	},
	verify: {
		positional: '',
		detail: 'Read-only full delta integrity report. The hook-only `--staged-fast` flag is intentionally not public.'
	},
	'overlay new': {
		positional: '<target>',
		requiredFlags: ['--id', '--type', '--owner', '--reason', '--contract-test'],
		detail:
			'Scaffold the artifact of the config-overlay layer for a target: canonical metadata in the schema key order, the pin of `codkit.json`, the guard tests of `--contract-test` (repeatable and required - the layer leaves no marker in the target file, so the test is the only thing that fails when upstream moves the key) and an empty list of operations to fill in. The metadata is held to the vocabularies of `marker new`; an existing artifact of the target is never overwritten. No fork tree is needed, and there is no `--layer`: the artifact is the layer.'
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
		detail: 'In config v4, a full SHA target stays unlabelled and operational names use sha- plus the full SHA; a tag target retains its label. Config v2/v3 retain their original tag-selection rules. `restart` alone accepts and requires `--yes`. Exit 3 is a deliberate stop for human input.'
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
			'Run the no-network container threshold. Profile defaults to `verify`; `build` additionally requires supplied tree `node_modules`. Pin-guard/effective-diff refs must already exist locally. Every input is built from its pinned commit and committed on the generated branch; the effective diff leaves the directories of the inputs out.'
	},
	package: {
		positional: '[<selector>]',
		detail:
			"Build the distributable out of the already loaded tree: the drift guard of `load`, then the overlay targets materialized into the tree, the stamps the project type names put into the environment, the package build of the type, the packaging step the patch set declared, and finally the targets this run materialized put back and the dev channel rewritten. `<selector>` is a target of the type's catalog, a platform family (`windows`, `linux`, `macos`) or `all`; without it the patch set's default targets are built. Each target runs on the route its type answers for this host - natively in the tree, or in the type's container over a read-only view of the tree, whose artifacts are copied back into it - and a target with no route here is refused with the reason the type gives (`CK-E-CONFIG`). The inputs the targets download are checked first: `--inputs <dir>` names the pre-provisioned copies, and the global `--ci` makes the run offline, so a missing input, or a container image that is not there, is `CK-E-NET-FORBIDDEN` before any write. `--container-prefix <name>` is the first word of the names of the container route's image, volume and container (default `codkit`). `--keep-overlay` leaves the overlay targets materialized for a hand check (`codkit load --fresh` takes them back); `--skip-type-build` runs only the product step over a tree the watch channels already built; `--timeout <seconds>` bounds each command. Where the artifacts land is the answer of the type and of each target, and a raw bundle written beside the managed tree names none. A failing command is exit 1 `CK-E-PACKAGE-FAILED` with the tail of its output; there is no `--discard`."
	},
	publish: {
		positional: '<immutable-patchset-ref>',
		requiredFlags: ['--yes-i-am-publish-bot'],
		detail:
			"Release-bot-only transaction. It requires `--yes-i-am-publish-bot` and rejects global `--ci`; into `publishRemoteUrl` it gates with `ls-remote` before mutation, and only then checks and pushes leased/immutable refs. `--branch <name>` names the release branch instead of `codkit/release/<patchset12>+<pin-key>` (the label when present, otherwise sha- plus the full SHA), outside the prefixes of the patch set. Three forms of the history: without `--squash`, the pin's history and the generated commits, one per artifact and input, with the Codkit trailers; `--squash` publishes one commit on the pin whose tree is the checked tree, with `--author` as author and committer and the UTF-8 `--message-file` as its message, dated like the patchset commit and without Codkit trailers; `--squash --orphan` writes that commit without a parent - one commit for the whole product, which a push into an empty repository carries without upstream history. The `--release` tag names the published tip. `--scrub` (with `--squash`) removes the codkit marker lines and the `spec://` references of comment lines from the delivered files, and the bare references the patch set learns from itself - its intervention ids and the ids of its spec documents under `publish.scrub.specRoots` (default `vibevm/vibespecs`), plus `publish.scrub.vocabulary` - as whole groups in comment text and Markdown prose: a parenthetical of references, a sentence of them, a leading group with its colon, a group after a preposition. It leaves out the files `publish.exclude` names, and refuses to push while `codkit:begin`, `codkit:end`, `spec://` or `vibevm` is left anywhere in the tree, or a learned reference in any delivered file. `--no-lfs` publishes a tip that needs no git-lfs: it leaves out every path the tree's own `.gitattributes` give to `filter=lfs` whose blob is a pointer, and removes each rule that names `filter=lfs` with the comment lines directly above it - in the squashed tree, or as one more generated commit, `codkit: leave out git-lfs content`, without `--squash`; a tree without git-lfs content stays as it is, and a rule the rewrite does not remove, such as a macro, stops the run with `lfs-failed` before anything is written. `--export-bare <dir>` or `--export-repo <dir>` writes the release into a new bare repository, or a new repository with the branch checked out, instead of `publishRemoteUrl`, which is then neither required nor read - no gate, no push, no network. The directory must be new or empty, with an existing parent, outside the patch set and the fork tree; the repository gets the branch, the release tag and only the objects the tip reaches, with no remote and no alternates, `core.longpaths=true`, and `core.autocrlf=false` with `core.eol=lf` for a working tree that plain git sees clean. Unless `--no-lfs` is given, the export carries the git-lfs objects of the tip, copied from the lfs storage of the fork tree and checked against their pointers; a missing object is `CK-E-LFS` before anything is created. A failed run leaves no export behind, and a second run into the same directory is refused. The inputs of the patch set enter the release from their pinned commits: one commit each on top of the history, part of the one commit under `--squash`, and scrubbed and searched like every file the patch set adds; the result names each input with its commit and file count."
	},
	hooks: {
		positional: '<install | check>',
		detail:
			'Install or inspect effective Codkit-owned patchset hooks. Check is green only when Git demonstrably executes the current owned bytes; linked/custom/foreign hook paths are inactive refusals.'
	},
	imageset: {
		positional: '<gen | index | verify>',
		detail:
			'A namespace, not a command: it never generates. Bare `codkit imageset`, and any unknown subcommand, print the subcommand list and exit 2 before any root is resolved. `--help` lives here and answers the tools question for the whole namespace: none are required, on every supported OS, with the linked libraries and their licences listed so the claim can be checked.'
	},
	'imageset gen': {
		positional: '',
		detail:
			'Regenerate the product\'s brand images from the branding masters in `<patchset>/branding` (`--branding-dir` overrides) - the application icon, the Windows installer bitmaps, the web client\'s icons, one drawing per registered file type and the empty-editor watermarks. The first run seeds that directory with the fork tree\'s own artwork; `<key>.svg`/`<key>.png` masters serve every size and a per-size `<key>-<N>.png` override wins verbatim, where `<key>` is the family for a family holding one drawing and `<family>/<artwork>` for one holding several. Output lands in the resource layer - `delta/resources/files/` plus `map.json` entries - for `load` to materialise; a vector target is emitted unchanged rather than rasterised. `--dry-run` prints the plan, including which master serves each frame, and writes nothing; it reads every master the run would read, so a master the run would refuse, or a per-size override of the wrong size, fails the plan the way it fails the run. A frame a vector master renders at an aspect other than its own is still delivered at the exact size, and the plan, the run, a warning line and the `--json` fields `stretched` and `stretchPercent` all say how far it is stretched from the master\'s aspect. A PNG master with 16 bits per channel is reduced to 8, and the plan, the run and the `--json` field `reducedFrom16Bit` say so. A drawing without a master is skipped with a warning and exit 1; a new map entry needs its `guard.brand.<family>` suite declared under `delta/own/test/` first - one suite per family, not one per drawing. What the shipped files cannot say, the product declares in `imageset.json` in the masters directory: the frame set of a target whose container allows one - the frames written in place of those the shipped file carries - and `sources`, rules that give the frames of some sizes to another master key (`{"key": "taskbar", "maxSize": 64}`, or explicit `sizes`). A declaration that cannot be applied exactly is refused with `CK-E-CONFIG` before anything is read or written; every frame is reported with its key, its master and its origin - in `--json` as `key`, `keyDeclared`, `master` and `origin` - and a patch set without a declaration gets exactly the files it got before.'
	},
	'imageset index': {
		positional: '',
		detail:
			"Read-only index of the image set, computed from the distribution and the masters directory rather than written down: a per-family summary, then per target its role and container, the exact sizes the distribution requires, and for each size whether it comes from a hand-made master, is generated from a base master, or has no master at all - and, for a size a vector master renders, how far it is stretched from the master's aspect, for a size a 16-bit PNG master serves that it is reduced to 8 bits per channel, and for the size `gen` would skip the target at, the reason `gen` gives. A declared frame set is listed with the frames the shipped file carries, and a size a rule of the declaration gives to another key says so. It reads every master `gen` would read and writes nothing - not even the seeding `gen` does; it exits 0 whether or not masters are missing, and 2 with the refusal of `gen` when `gen` would refuse a master or the declaration. Markdown by default; `--json` carries the same model structurally."
	},
	'imageset verify': {
		positional: '',
		detail:
			'The acceptance bands as an executable gate, run against the distribution the fork tree already holds. For every raster target the largest layer of a container becomes the master, the other layers of that same container are regenerated from it through the pipeline `gen` uses, and each is compared with the layer the distribution ships: structure exactly, pixels within the band of their size range - at most 10/255 mean absolute RGB difference from 256 px up, at most 25/255 from 64 px, nothing asserted below that. The master is always a layer of the same file, so no flag can make it compare one container with another; a target with a single layer has no round trip and is reported as unverifiable rather than counted as passed. A target of the declaration in the masters directory is verified against it: its file must carry the declared frames - a missing or an extra frame is a structural failure - and its layers are round-tripped one master key at a time, so a layer of one drawing is never measured against another. Read-only: no lock, nothing written to the patchset, nothing written to or seeded into the masters directory. Exit 0 when every asserted comparison is inside its band, 1 when one is outside, 2 when the tree or a container cannot be read. Markdown by default; `--json` carries the same model structurally.'
	},
	license: {
		positional: '<check | annotate | notices>',
		detail:
			'A namespace, not a command: bare `codkit license` and any unknown subcommand print the subcommand list and exit 2 before any root is resolved. The subcommands are `check`, `annotate` and `notices`, and none of them needs a patch set or a fork tree.'
	},
	'license check': {
		positional: '[<dir>]',
		detail:
			'Check the licence carriers of a package directory the way REUSE reads them: every file resolves to a carrier - an adjacent `<file>.license` sidecar, a `REUSE.toml` annotation, or a header in its first 20 non-empty lines (copyright lines are read up to the `SPDX-License-Identifier` line). An own file (every holder in the policy) must carry a year and exactly `UPL-1.0`; a third-party file must be covered by a `REUSE.toml` annotation that agrees with its carrier, and its licence must be on the policy allowlist. `LICENSE`, one `LICENSES/<ID>.txt` per licence in use, the manifest `license` field and a current `THIRD-PARTY-NOTICES.md` are required. Without `<dir>` it checks the standards package codkit ships. Read-only, needs no root, never calls git. Exit 0 clean, 1 with one line per problem (`CK-E-LICENSE-HEADER` per carrier, `CK-E-LICENSE-THIRD-PARTY` per third-party rule, `CK-E-LICENSE-PACKAGE` for the package), 2 when the directory, the policy or the SPDX list cannot be read.'
	},
	'license annotate': {
		positional: '<path ...>',
		detail:
			"Give files a licence carrier: for an own file a four-line header in the comment style of its extension, placed after the prelude (shebang, `<?xml?>`, encoding line, doctype, front matter), or a `<file>.license` sidecar for binaries and comment-less formats; with `--third-party --holder <name> --license <SPDX-ID> [--source <text>]` a carrier with the other party's holder and licence plus an annotation appended to `REUSE.toml` (the licence must be on the allowlist and an SPDX identifier). `--dir` names the package root (default `.`); a path outside it is refused. `--year` and `--holder` default to the current year and the first policy holder. Idempotent: a file that already resolves to a carrier is reported `unchanged`, so a second run leaves `git diff` empty. `--dry-run` prints the plan and writes nothing. Never downloads a licence text: put `LICENSES/<ID>.txt` in place yourself."
	},
	'license notices': {
		positional: '',
		detail:
			'Generate `THIRD-PARTY-NOTICES.md` from the `REUSE.toml` registry of the package named by `--dir` (default `.`): one table row per third-party annotation, in the order the registry lists them. Writes only when the bytes would change (`written` / `unchanged`), removes the file when the registry declares no third-party row, and `--dry-run` prints the generated body on stdout instead of writing - which is what makes `codkit license notices --dry-run | diff - THIRD-PARTY-NOTICES.md` a check anyone can run. `license check` reports a hand-edited or outdated notices file as stale.'
	},
	standards: {
		positional: '<load | check | license>',
		detail:
			'A namespace, not a command: bare `codkit standards` and any unknown subcommand print the subcommand list and exit 2 before any root is resolved. `load` and `check` work on the whole set of packages codkit ships and need only the patch-set root - no fork tree, no codkit.json, no tree lock; `license` needs no root at all.'
	},
	'standards load': {
		positional: '',
		detail:
			'Deliver every package codkit ships into the patch-set repository in one run - `standards`, the norms, and `agent-skills`, the skills `vibe skill install` projects into every coding agent - `standards` first and the rest by name: a byte-for-byte copy of each under `vibevm/vibepacks/org.vibevm.codkit/<name>/v<version>/`, the codkit licence notice `LICENSE-CODKIT.md` in the repository root and in `delta/own/codkit/` (from where `codkit load` carries it into the fork tree as a file codkit delivers; `codkit publish` leaves it out of the release branch), rendered with a components block that lists what is installed (an edition-2 copy at `delta/own/` is moved), one managed block in the product `vibe.toml` (between `# codkit:begin standards` and `# codkit:end standards`) with one `[requires.packages]` table per package, each pinning its exact version with `link = "static"`, and - when `vibevm/scrape/contract.toml` exists - a managed block in it (between `# codkit:begin scrape` and `# codkit:end scrape`) with the two rows that remove the notice from a `vibe scrape` export; without a contract it says so and writes nothing there. The licence check runs first, over every package, and a failing package is never copied - there is no bypass flag, and one failure stops the whole run before the first write. An installed copy that differs from the shipped one is refused with `CK-E-STANDARDS-DRIFT`, the package name and the list of changed paths; a malformed block or an entry outside it is `CK-E-CONFIG`; nothing is written on any refusal. `--upgrade` is the word that takes the shipped copy instead: it prints the `replace` and `remove` paths, swaps the whole package directory through a temporary directory and a rename, drops the version directories the shipped edition supersedes, and makes the next step `vibe install --offline --force` - an edition may be extended in place under the same version number, and codkit cannot tell that from an edit of yours. An edited `LICENSE-CODKIT.md` copy is refused even then; delete the copy and run again. Codkit does not run `vibe`: the next steps it prints are `vibe install --offline` and, when a delivered package declares skills, `vibe skill install`, followed by a four-line licence note and the recommendations for the notice file (its full text is printed when a copy was created; `codkit standards license` prints it any time). A repeat is `up to date` with no byte changed. `--dry-run` prints the same plan and exit code without writing.'
	},
	'standards check': {
		positional: '',
		detail:
			'Read-only report on every installed package: whether each copy is absent, identical to the shipped package or drifted (with the package name and the paths), whether its licence carriers are intact, whether the two `LICENSE-CODKIT.md` copies (repository root and `delta/own/codkit/`) are identical to the notice rendered for this repository (a copy whose components block is out of date is `stale`, a legacy copy at `delta/own/` is a warning), whether the managed block in `vibe.toml` is absent, current, stale, malformed or shadowed by an entry outside it, and the same for the scrape-contract block (a missing contract is reported as information, not as a finding). Exit 0 only when every copy and both notice files are identical, the licence check is clean and both blocks are current (or the contract is absent); 1 otherwise, one line per finding; the hint for a drifted copy names `codkit standards load --upgrade`, for an edited notice copy `delete the copy and run codkit standards load`, and otherwise `run codkit standards load`. `--json` adds `data.packages: [{name, version, target:{state, paths}}]`.'
	},
	'standards license': {
		positional: '',
		detail:
			"Print, needing no root: the full text of `LICENSE-CODKIT.md` - the notice a delivering command places in the repository root and in `delta/own/codkit/`, with an empty components block here - then the recommendations (where the copies live, that nobody edits them, that linking to them is the product owner's choice, where the three licence scopes end), the scrape-contract rows that `standards load` keeps in `vibevm/scrape/contract.toml` (paste them only into a contract kept elsewhere), and a `REUSE.toml` annotation naming the four paths the notice describes, for the product's own registry. `--json` returns `file`, `text`, `recommendations`, `scrapeContractRows` and `reuseAnnotation`."
	},
	runtime: {
		positional: '<load | check>',
		detail:
			'A namespace, not a command: bare `codkit runtime` and any unknown subcommand print the subcommand list and exit 2 before any root is resolved. Both subcommands need only the patch-set root - no fork tree, no `codkit.json` to run, no tree lock; the pin is read only for the compatibility warning.'
	},
	'runtime load': {
		positional: '',
		detail:
			"Deliver the Codkit runtime library - the feature-flag service, the features host and the brand engine - into `delta/own/codkit/` of the patch set, from where `codkit load` carries it into `<ownRoot>/codkit/` of the fork tree, the own root the patch set declares in `typeConfig`. It is a managed copy: the product never edits it, the copy is compared byte for byte with the shipped version, and drift refuses with `CK-E-RUNTIME-DRIFT` and the list of paths before anything is written. `--upgrade` replaces the directory as a whole and prints what it replaces and removes - Codkit keeps no older version, so there is nothing to merge; `--dry-run` prints the same plan and writes nothing. The library's own licence check runs first and a failing library is never copied (`CK-E-LICENSE-PACKAGE`, exit 2), and a shipped tree that is not exactly one version directory whose `common/version.ts` literal matches its name is `CK-E-RUNTIME-PACKAGE`. The `LICENSE-CODKIT.md` copy inside the target directory belongs to `standards load` and is carried across a replacement; both notice copies are rewritten with a components block that now lists the runtime. The run ends with three next steps: the single import for the product's composition root, the `code-import-patterns` block to take from the library's `LAYERS.md`, and `codkit gen feature`. A pin outside `CODKIT_RUNTIME_VERIFIED_UPSTREAM` is a warning, not a refusal. A repeat is `unchanged` with no byte written."
	},
	'runtime check': {
		positional: '',
		detail:
			'Read-only report on the installed runtime library: `runtime not installed` when `delta/own/codkit/` is absent (exit 0), `identical` when it matches the shipped library, or `CK-E-RUNTIME-DRIFT` with every modified, extra and missing path and the hint `run codkit runtime load --upgrade` (exit 1). It also reports the state of both `LICENSE-CODKIT.md` copies - an edited copy is `CK-E-STANDARDS-DRIFT`, an out-of-date components block is reported without being a finding - and warns about a legacy copy at `delta/own/`.'
	},
	inputs: {
		positional: '<pin>',
		detail:
			'A namespace, not a command: bare `codkit inputs` prints its subcommand and exits 2 before any root is resolved. The inputs themselves are declared in the top-level `inputs` list of `codkit.json`.'
	},
	'inputs pin': {
		positional: '[name ...]',
		detail:
			"Move the pin (`ref` in `codkit.json`) of the named inputs, or of every input with `--all`, to the HEAD of each input's repository, rewriting `codkit.json` canonically. A repository with uncommitted changes is refused with its paths before anything is written, because a pin names committed content; commit the new pin together with the change that needs it."
	},
	gen: {
		positional: '<feature | brand>',
		detail:
			'A namespace, not a command: bare `codkit gen` and any unknown subcommand print the subcommand list and exit 2 before any root is resolved. Both subcommands write into `delta/own/` of the patch set and need no fork tree.'
	},
	'gen feature': {
		positional: '<id>',
		requiredFlags: ['--title'],
		detail:
			"Write the skeleton of a flag-gated product feature: `delta/own/contrib/<name>/common/<name>.ts` with the feature id (and the setting id under `--setting`), `delta/own/contrib/<name>/browser/<name>.contribution.ts` with a `Disposable` subclass and the `registerFeature` call the runtime library reads, and `delta/own/contrib/<name>/test/browser/<name>.test.ts` - the test lives inside the feature, so one unit covers the code and the test alike. The id must be two or more dot-separated camelCase segments (`acme.smartPaste`) or the run is `CK-E-GEN-ID` (exit 2); its last segment names the directory. `--cold` declares `hotToggle: false`, so the flag is frozen at startup and a change asks for a restart. The files are product code: `--holder` and `--license` (with `--year`, defaulting to this year) head them in the style `--header-style` names - `line`, four `//` lines, or `block`, the ruled comment upstream files carry, so own code sits flush with the code beside it. `--header-file <path>`, a path inside the patch set, writes a header the fields cannot express verbatim instead, and the file must end with a newline; it does not combine with `--holder`, `--license`, `--year` or `--header-style`, and `--header-style` without `--holder` and `--license` has nothing to shape - either combination is exit 2 with nothing written. Without any header flag the files are written without a header and the run warns `no header written` - Codkit's own notice is never placed in a product file. An existing target is `CK-E-GEN-EXISTS` (exit 1) and nothing is written at all. The run prints the import line for the product's composition root and the reminder to declare the one unit in `delta/own/patchset.delta.json`."
	},
	'gen brand': {
		positional: '',
		detail:
			"Write `delta/own/common/brand.ts` - the product's brand rules table with one worked example and the `except` explanation, exporting `brandMessage` built by the runtime library's `createBrandTransform` - and print the graft for `_format` in `src/vs/nls.ts`, which the product writes itself as a patch with `type = hook`. Two reminders come with it: the hook budget (at most three lines of code between the markers, one of them naming own code) and the `code-import-patterns` target for `src/vs/{monaco.d.ts,nls.ts}`, which has to allow the own root's `common/~`. Headers follow the same rule as `gen feature`; an existing file is `CK-E-GEN-EXISTS` (exit 1)."
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
			const rendered = renderFlag(flag, kinds, guide.flagLabels);
			return required.has(flag) ? rendered : `[${rendered}]`;
		});
		const synopsis = ['codkit', command.name, guide.positional, ...ownFlags].filter((part) => part !== '').join(' ');
		return `| \`${escapeCell(synopsis)}\` | ${escapeCell(command.summary)} | ${escapeCell(guide.detail)} |`;
	});
	const globalRows = globalFlags.map((flag) => `| \`${flag.syntax}\` | ${flag.description} |`);
	return (
		generatedHeader('Command reference') +
		`
Codkit manages an external patch set and a separate fork tree; which family of upstreams that tree belongs to is the project type's answer (\`codkit types\`). The public command and flag tables below are rendered from the output of the live CLI; command-flag arity is read from \`packages/codkit/src/lib/argv.ts\`.

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
- \`publish\` is intentionally not a CI-mode command. It is the only release push path, requires the bot confirmation flag, and refuses the combination with \`--ci\`. An export into a new local repository (\`--export-bare\`, \`--export-repo\`) reaches no network and pushes nothing, and keeps both refusals.

See [conventions](conventions.md), [failure guidance](faq.md), and the [air-gapped supply-kit contract](../ci-examples/air-gapped-supply-kit.md).
`
	);
}

function renderFlag(flag, kinds, commandLabels = {}) {
	const kind = kinds.get(flag);
	if (kind === undefined) throw new Error(`help advertises flag absent from COMMAND_FLAG_KINDS: ${flag}`);
	if (kind === 'boolean') return flag;
	// A flag two commands spell alike may take another value on each: `load --inputs
	// working|pinned` and `package --inputs <dir>`.
	const label = commandLabels[flag] ?? valueLabels[flag];
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
This page is rendered from [\`packages/codkit/config/conventions.json\`](../../../packages/codkit/config/conventions.json), schema \`codkitConventions: ${conventions.codkitConventions}\`, plus the answers of the project type \`${vscodeType.id}\`. Change the JSON source, then regenerate this page; do not hand-maintain copies of these values.

The marker forms, the intervention types, the categories and the order of the layers are the engine's and are the same for every project type. The subsystems an identifier may name, the forbidden service ids, the cleanup whitelist and the forbidden patch targets are the type's answer, so a patch set of another type reads its own values with \`codkit types\` and its own \`conventionsExtensionFile\`; the values below are the \`${vscodeType.id}\` ones.

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
		'Install Git LFS and populate LFS objects outside `--ci`, or include them in the offline fork-tree supply. A `publish` export that keeps git-lfs needs every object of the tip in the lfs storage of the fork tree: fetch them there (`git -C <fork tree> lfs fetch origin <pin.sha>`), or publish with `--no-lfs`.'
	],
	LOCKED: [
		'Another Codkit operation owns the per-tree lock.',
		'Wait for the named process; if it is gone, follow the stale-lock hint instead of deleting active state blindly.'
	],
	'DIRTY-TREE': [
		'Unextracted or otherwise disallowed work makes the requested transition unsafe.',
		'Run `codkit status`, then `codkit save` for work to keep or restore it deliberately. Fork-tree commits can also be dropped on purpose with `codkit load --discard` (they stay reachable under `refs/codkit/consumed/`, where `codkit gc` eventually spends them; the flag is refused under `--ci`). A tracked upstream file a build rewrote is dropped by name with `codkit load --fresh --discard`, which announces every path it drops and never touches a file carrying a marker block - extract that one with `codkit save`, or move the edit out of the file. A tree left by `overlay apply` returns to dev mode with `codkit load --fresh` (only the exact overlay materialization is replaced). CI should receive a disposable clean tree.'
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
		'Provide the clone/ref/LFS object through the CI or supply kit, or run the explicitly networked command outside `--ci`. For `codkit package`, put each missing input at the path the message names inside the `--inputs` directory, or build the container image once without `--ci`.'
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
		'Install/restore Codkit dependencies in the tool root; for `ci --profile build`, also supply every dependency root the project type names (the message lists the missing `.package-lock.json` receipts) through the air-gapped cache/mount. The patch set is not the tool installation, and empty bind-mount directories do not count as restored caches.'
	],
	'LICENSE-HEADER': [
		'A file of the standards package has no licence carrier, or a wrong one: no copyright line, no year on an own file, no `SPDX-License-Identifier`, an identifier that is not SPDX, an own file under a licence other than `UPL-1.0`, a binary or JSON without its `.license` sidecar, or a sidecar without its file.',
		'Run `codkit license annotate` for the file, or fix the header (or the sidecar) as PROP-014 sec. 2 shows, within the first 20 non-empty lines; an own file carries exactly `UPL-1.0`.'
	],
	'LICENSE-THIRD-PARTY': [
		'A file whose holder is not in the policy breaks the third-party rules: no `REUSE.toml` annotation covers it (a typo in the holder, or an undeclared third-party file), its licence is outside the allowlist or is `LicenseRef-*`/`NOASSERTION`, the carrier and the annotation disagree, or `THIRD-PARTY-NOTICES.md` is missing or stale.',
		'Declare the file with `codkit license annotate --third-party --holder <name> --license <SPDX-ID> --source <where it came from>` (or fix the holder typo), keep the carrier and the annotation on the same licence, put the licence text in `LICENSES/`, then run `codkit license notices`.'
	],
	'LICENSE-PACKAGE': [
		'The package as a whole is inconsistent: the manifest `license` field is not `UPL-1.0`, `LICENSE` or `LICENSES/UPL-1.0.txt` differs from the canonical UPL text, a licence in use has no `LICENSES/<ID>.txt` or `LICENSES/` carries a text nobody uses, `REUSE.toml` does not parse, a notices file exists without third-party files, or a symlink sits inside the package.',
		'Restore the canonical files from the shipped package (never edit a licence text), add the missing `LICENSES/<ID>.txt` verbatim from SPDX or remove the unused one, fix `REUSE.toml`, remove the symlink; rerun `codkit license check <dir>`.'
	],
	'STANDARDS-DRIFT': [
		'An installed copy under `vibevm/vibepacks/org.vibevm.codkit/` differs from the package codkit ships: a file was modified, added or removed. The same code covers an edited `LICENSE-CODKIT.md` copy.',
		'The copy is codkit-owned. Run `codkit standards load --upgrade` to take the shipped copy (an edition may be extended in place under the same version), or move local edits into your own specs as a recorded deviation, delete the copy directory and run `codkit standards load` again; for an edited notice copy, delete the copy. Run `vibe install --offline` (after an upgrade `--force`) afterwards.'
	],
	'RUNTIME-DRIFT': [
		'The installed copy of the codkit runtime library under `delta/own/codkit/` differs from the library codkit ships: a file was edited, added or removed, or an older version is installed.',
		'The library is codkit-owned. Change it in codkit, not in the product; to take the shipped version run `codkit runtime load --upgrade`, which replaces the directory as a whole and lists what it replaced.'
	],
	'RUNTIME-PACKAGE': [
		'The codkit installation carries no usable runtime library: `runtime/` of the installation has zero or several version directories, or the `CODKIT_RUNTIME_VERSION` literal in `common/version.ts` disagrees with the directory name.',
		'Restore the codkit installation from the approved supply; nothing in the product repository is wrong.'
	],
	'DELIVERED-EDIT': [
		'`codkit save` found a file under `src/vs/<own>/codkit/` in the fork tree that differs from `delta/own/codkit/`: a file delivered by codkit was edited in the tree.',
		'Nothing was mirrored. Revert the edit in the tree, or make the change in codkit and run `codkit runtime load --upgrade`.'
	],
	'OWN-UNDER-CODKIT': [
		'A unit in `patchset.delta.json` roots a path under `codkit/`, which is reserved for files codkit delivers and licenses.',
		'Move the unit to another own path; `codkit/` belongs to codkit and the licence notice describes it as such.'
	],
	'HOOK-TOO-LARGE': [
		'A patch declared `type = hook` carries more than three lines of code between its markers, or none of its lines imports or calls own code.',
		'A hook is a graft: keep one import or one call that delegates into own code and move the logic into the own layer.'
	],
	'GEN-EXISTS': [
		'`codkit gen` would overwrite a file that already exists under `delta/own/`.',
		'Nothing was written. Remove or rename the existing file, or pick another feature id.'
	],
	'GEN-ID': [
		'The feature id passed to `codkit gen feature` is not two or more dot-separated camelCase segments (for example `acme.smartPaste`).',
		'Use a product prefix followed by camelCase segments; the first segment names the product.'
	],
	'OWN-EXTENSION-MANIFEST': [
		'The `extensions` section of `delta/own/patchset.delta.json` does not describe a materializable extension: the `name` is not of the form `[a-z0-9][a-z0-9-]*`, two records claim one name, `delta/own-extensions/<name>/package.json` is missing, a directory under `delta/own-extensions/` is declared by no record, or the name collides with an extension the pin already ships.',
		'Fix the record named by the finding: rename the extension, add the `package.json` the upstream build looks for, declare the directory, or remove it. Nothing was materialized.'
	],
	'OWN-EXTENSION-DRIFT': [
		'A file under `extensions/<name>/` in the fork tree differs from `delta/own-extensions/<name>/`, or one side carries a file the other does not.',
		'Extract the tree-side edit with `codkit save`, or bring the tree back to the delta with `codkit load`; the delta is the source of truth for an own extension.'
	],
	'TYPE-UNKNOWN': [
		'The `type` of `codkit.json` is not in the registry of this codkit, or the package the registry names for it is not installed next to the tool.',
		'Run `codkit types` for the identifiers this installation carries, and set `type` to one of them; if the identifier is right, install the package the row names.'
	],
	'TYPE-CAPABILITY': [
		'The command needs an ability the declared project type does not have - brand images, the brand generator, the build channels, the runtime library - or `verify` was asked about an artifact of a layer that type does not provide.',
		'Nothing was written. Use the verbs the type answers (`codkit types` prints the capability matrix), or move the artifact to a layer the type provides.'
	],
	'PACKAGE-FAILED': [
		'A command of the package build the project type names exited non-zero, or could not be started at all - on the container route also docker itself, the image build or the container; the message carries the exit code and the tail of what the command printed.',
		'Run the command named in the hint inside the fork tree and read its own output. The fork tree was already put back: `codkit package` restores the overlay targets it materialized whatever the verdict.'
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
This page is keyed from the live registry in [\`packages/codkit/src/lib/messages.ts\`](../../../packages/codkit/src/lib/messages.ts). It covers every currently registered error and warning code. The hint printed for the specific failure is authoritative; the table gives the usual operator path.

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
- Adding global \`--ci\` to \`publish\`: publication - an export into a local repository included - is a separate release-bot operation and deliberately rejects that combination.
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
