#!/usr/bin/env bash
# DEF-8 of LICENSING-AREA-PLAN-v1: the host recipe equal to the Linux container's
# entry.sh (packages/type-vscode/container/linux/entry.sh, step 2), for a Linux host
# that is not the upstream's build agent. It installs the fork tree's dependencies
# the way upstream CI does - the sysroots and the toolchain of the upstream's own
# setup-env.sh, so the native modules are built against glibc 2.28 and not the
# host's - and then runs the installer target in the same environment, where the
# type's glibc check passes. Run from anywhere; the tree and the tool are named
# by the first argument. The host needs the Node of the tree's .nvmrc and a
# `python` on PATH (the toolchain script calls it by that name); nothing else is
# installed on the host, the toolchain lands in the tree's .build/.
#
# Usage: [SKIP_INSTALL=1] DEF-8-linux-host-recipe.sh <root> <target> [timeout seconds]
#   <root>          a directory holding the fork tree as `vscode` and Codkit as `codkit`
#   <target>        linux-x64-tar, linux-x64-deb or linux-x64-rpm
#   SKIP_INSTALL=1  reuses the node_modules an earlier run of this recipe installed
set -euo pipefail
ROOT="${1:?root directory holding vscode/ and codkit/}"
TARGET="${2:?package target}"
TIMEOUT="${3:-3600}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"
export NPM_CONFIG_USERCONFIG=/dev/null
export npm_config_arch=x64
export VSCODE_ARCH=x64
cd "$ROOT/vscode"
echo "== host recipe: tree $(git rev-parse --short HEAD) on $(uname -sr), node $(node -v) =="
if [ "$SKIP_INSTALL" = "1" ]; then
	echo "== install skipped (SKIP_INSTALL=1): node_modules as installed by an earlier run of this recipe =="
else
	echo "== build/ dependencies =="
	(cd build && npm ci)
	echo "== upstream toolchain (setup-env.sh), preinstall, npm ci =="
	# The container starts from a tree without .build/; on a host the toolchain of another pin
	# would stay there and mix its libc++ bitcode with this pin's linker (ld.lld refused the
	# summary version), so the pin-specific caches go first. The sysroots belong to no pin.
	rm -rf .build/CR_Clang .build/libcxx-objects .build/libcxx_headers .build/libcxxabi_headers
	# shellcheck disable=SC1091
	source ./build/azure-pipelines/linux/setup-env.sh
	echo "CC=$CC"
	# The variable carries the compiler and a flag: the existence check reads its first word.
	test -x "${CC%% *}" || { echo "the toolchain compiler is not there: $CC" >&2; exit 2; }
	node build/npm/preinstall.ts
	ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip npm ci
	node build/azure-pipelines/common/checkNativeOptionalDeps.ts
fi
echo "== native modules: highest glibc symbol versions the installed .node files want =="
# The toolchain script of some pins does not export the sysroot directory; the type's default stands.
sysroot="${VSCODE_SYSROOT_DIR:-$PWD/.build/sysroots/glibc-2.28-gcc-10.5.0}"
objdump_bin="$sysroot/x86_64-linux-gnu/x86_64-linux-gnu/bin/objdump"
[ -x "$objdump_bin" ] || objdump_bin=objdump
{ find node_modules -name '*.node' -print0 | xargs -0 "$objdump_bin" -T 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -3; } || true
echo "== codkit package $TARGET =="
cd "$ROOT"
node codkit/packages/codkit/bin/codkit.mjs package "$TARGET" --timeout "$TIMEOUT"
