#!/usr/bin/env bash
# The entry of the Linux build container of the `vscode` project type
# (spec://codkit/modules/vscode/PROP-004#VSCODE-LINUX-CONTAINER-ENTRY).
#
# `codkit package` starts this container on a host that is not Linux, with
# (spec://codkit/modules/codkit/PROP-007#CMD-PACKAGE-CONTAINER-PROTOCOL):
#   /codkit/tree    the fork tree, read-only;
#   /codkit/work    a volume the container owns, one per fork tree;
#   /codkit/io      a directory of the host for this one run: commands.json (the
#                   target's build commands with their environment),
#                   outputs.json (the target's output patterns), executables and
#                   symlinks (git's record of the tree, NUL-separated),
#                   tree-inputs.json (the provisioned caches of the tree), out/
#                   for the artifacts, and shim/ when codkit answers fetches;
#   /codkit/inputs  the pre-provisioned inputs, read-only, when there are any;
#   CODKIT_OFFLINE  1 for an offline run.
#
# The entry
#   1. mirrors the tree into /codkit/work/tree, without any node_modules/ and
#      without the build outputs of the host, then gives the copy git's modes,
#      because a tree checked out on another OS carries neither: nothing of the
#      host's native modules reaches the build, and nothing is written to the
#      host tree;
#   2. installs the Linux dependencies of the copy the way upstream CI does
#      (build/azure-pipelines/linux/steps/product-build-linux-compile.yml:
#      `npm ci` in build/, then setup-env.sh - the sysroots and the toolchain -,
#      preinstall and `npm ci`, then the check of the native optional
#      dependencies), unless the key upstream computes for its node_modules
#      cache says that this state is installed already; an offline run installs
#      nothing and stops here when the key differs;
#   3. puts each provisioned tree input in place of its cache in the copy, then
#      runs the target's build commands there, in order;
#   4. copies every file the output patterns match into /codkit/io/out.
set -euo pipefail

TREE=/codkit/tree
WORK=/codkit/work
IO=/codkit/io
COPY="$WORK/tree"
OFFLINE="${CODKIT_OFFLINE:-0}"

say() {
	printf 'codkit-container: %s\n' "$*"
}

export HOME="$WORK/home"
export TMPDIR="$WORK/tmp"
mkdir -p "$HOME" "$TMPDIR" "$COPY" "$IO/out"
if [ -d "$IO/shim" ]; then
	export PATH="$IO/shim:$PATH"
fi

# 1. The mirror. The left-out paths are what an install or a build writes:
#    they are the host's, built for the host's OS, and the copy keeps its own.
say "mirror of the fork tree into $COPY"
rsync -a --delete --chmod=D755,F644 \
	--exclude='/.git' \
	--exclude='node_modules/' \
	--exclude='/.build/' \
	--exclude='/out*/' \
	--exclude='/extensions/**/out/' \
	--exclude='/extensions/**/dist/' \
	--exclude='/.vscode/extensions/**/out/' \
	--exclude='/cli/target/' \
	--exclude='*.tsbuildinfo' \
	"$TREE/" "$COPY/"
if [ -s "$IO/executables" ]; then
	(cd "$COPY" && xargs -0 -r chmod 755 -- <"$IO/executables")
fi
if [ -s "$IO/symlinks" ]; then
	(cd "$COPY" && node -e '
		const fs = require("node:fs");
		const parts = fs.readFileSync(process.argv[1], "utf8").split("\0").filter((part) => part !== "");
		for (let at = 0; at + 1 < parts.length; at += 2) {
			fs.rmSync(parts[at], { force: true });
			fs.symlinkSync(parts[at + 1], parts[at]);
		}
	' "$IO/symlinks")
fi
# Upstream's install ends with `git config` in the tree it installs, so the copy
# has to be a git work tree; it is one of its own and never sees the host's.
if [ ! -d "$COPY/.git" ]; then
	git -C "$COPY" init --quiet
fi
cd "$COPY"

# 2. The Linux dependencies, keyed the way upstream keys its node_modules cache.
export npm_config_arch=x64
export VSCODE_ARCH=x64
KEY="$(node build/azure-pipelines/common/computeNodeModulesCacheKey.ts linux "$VSCODE_ARCH" "$(node -p process.arch)")"
if [ "$(cat "$WORK/installed.key" 2>/dev/null || true)" = "$KEY" ]; then
	say "Linux dependencies: installed for this state ($KEY)"
else
	if [ "$OFFLINE" = "1" ]; then
		say "Linux dependencies: not installed for this state ($KEY), and an offline run installs nothing" >&2
		say "run the same codkit package once without --ci to install them into the volume of this fork tree" >&2
		exit 3
	fi
	say "Linux dependencies: installing for $KEY"
	rm -f "$WORK/installed.key"
	(cd build && npm ci)
	(
		# shellcheck disable=SC1091
		source ./build/azure-pipelines/linux/setup-env.sh
		node build/npm/preinstall.ts
		ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip npm ci
	)
	node build/azure-pipelines/common/checkNativeOptionalDeps.ts
	printf '%s' "$KEY" >"$WORK/installed.key"
fi

# 3. The provisioned caches of the tree replace the copy's own, then the
#    target's build commands run, each with its own environment.
if [ -s "$IO/tree-inputs.json" ]; then
	node -e '
		const fs = require("node:fs");
		for (const input of JSON.parse(fs.readFileSync(process.argv[1], "utf8"))) {
			fs.rmSync(input.target, { recursive: true, force: true });
			fs.cpSync(input.source, input.target, { recursive: true });
			console.log(`codkit-container: ${input.target} taken from ${input.source}`);
		}
	' "$IO/tree-inputs.json"
fi
node -e '
	const { spawnSync } = require("node:child_process");
	const fs = require("node:fs");
	const commands = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
	for (const command of commands) {
		const shown = [command.command, ...command.args].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(" ");
		console.log(`codkit-container: --- ${command.label}: ${shown}`);
		const result = spawnSync(command.command, command.args, { stdio: "inherit", env: { ...process.env, ...command.env } });
		if (result.error !== undefined) {
			console.error(`codkit-container: ${command.label} could not start: ${result.error.message}`);
			process.exit(127);
		}
		if (result.status !== 0) {
			console.error(`codkit-container: ${command.label} exited ${result.status ?? result.signal}`);
			process.exit(result.status ?? 1);
		}
	}
' "$IO/commands.json"

# 4. The artifacts. A pattern is a shell glob here, which reads it the way the
#    engine does: segment by segment, `*` never crossing a `/`.
shopt -s nullglob dotglob
mapfile -t PATTERNS < <(node -e 'for (const pattern of JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))) console.log(pattern)' "$IO/outputs.json")
for pattern in "${PATTERNS[@]}"; do
	# shellcheck disable=SC2206
	matches=($pattern)
	for match in "${matches[@]}"; do
		mkdir -p "$IO/out/$(dirname "$match")"
		cp -a "$match" "$IO/out/$match"
		say "artifact $match"
	done
done
