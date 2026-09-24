# The Linux build container of the `vscode` project type
# (spec://codkit/modules/vscode/PROP-004#VSCODE-LINUX-CONTAINER-RECIPE).
#
# `codkit package` builds the Linux targets in this container on a host that is
# not Linux. It is a public image plus exactly what the upstream Linux build
# installs, so a package built here is built the way upstream CI builds it:
#
#   * the base is the operating system of upstream's Linux build pool, Ubuntu
#     22.04 (`1es-ubuntu-22.04-x64` in build/azure-pipelines/product-build.yml,
#     `1es-vscode-oss-ubuntu-22.04-x64` in .github/workflows/pr.yml) - the
#     public image, never Microsoft's private build images;
#   * glibc compatibility is not this image's: upstream builds the native
#     modules against its own sysroots (build/azure-pipelines/linux/setup-env.sh),
#     and the entry runs that script, so the glibc of this image never reaches a
#     package;
#   * Node is the version of the tree's `.nvmrc`, which codkit hands over as
#     NODE_VERSION, from the official tarball checked against its SHASUMS256.txt
#     - what upstream's `NodeTool@0` with `versionFilePath: .nvmrc` installs;
#     NODEJS_ORG_MIRROR, the variable node-gyp and nvm read for the same
#     downloads, names a mirror of nodejs.org/dist when the operator set one.
#
# The packages, and where each list comes from:
#   * build/azure-pipelines/linux/steps/product-build-linux-compile.yml, step
#     "Setup system services": pkg-config xvfb libgtk-3-0 libxkbfile-dev
#     libkrb5-dev libgbm1 rpm bubblewrap socat;
#   * .github/workflows/pr.yml, step "Install build tools" - upstream's list for
#     a stock Ubuntu runner: build-essential pkg-config libx11-dev
#     libx11-xcb-dev libxkbfile-dev libnotify-bin libkrb5-dev;
#   * the tools upstream's own steps call, which its build agent image carries:
#     curl and ca-certificates (setup-env.sh, build/linux/debian/calculate-deps.ts,
#     build/linux/debian/install-sysroot.ts), python3 and python-is-python3
#     (node-gyp; setup-env.sh pipes into `python`), git (build/npm/postinstall.ts
#     ends with `git config`), fakeroot and dpkg-dev (the `build-deb` task runs
#     `fakeroot dpkg-deb`; `prepare-deb` runs Chromium's dpkg-shlibdeps.pl on the
#     Dpkg perl modules), file (the deb step of the compile pipeline checks the
#     compression with it);
#   * rsync is the entry's own: it mirrors the fork tree into the container.
FROM ubuntu:22.04

ARG NODE_VERSION
ARG NODEJS_ORG_MIRROR=https://nodejs.org/dist
ARG DEBIAN_FRONTEND=noninteractive

RUN test -n "$NODE_VERSION" || { echo "NODE_VERSION is required: codkit reads it from the tree's .nvmrc" >&2; exit 1; }

RUN apt-get update \
	&& apt-get install -y \
		pkg-config xvfb libgtk-3-0 libxkbfile-dev libkrb5-dev libgbm1 rpm bubblewrap socat \
		build-essential libx11-dev libx11-xcb-dev libnotify-bin \
		curl ca-certificates python3 python-is-python3 git fakeroot dpkg-dev file \
		rsync \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eu; \
	cd /tmp; \
	curl -fsSLO "${NODEJS_ORG_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz"; \
	curl -fsSLO "${NODEJS_ORG_MIRROR}/v${NODE_VERSION}/SHASUMS256.txt"; \
	grep " node-v${NODE_VERSION}-linux-x64.tar.gz\$" SHASUMS256.txt | sha256sum -c -; \
	tar -xzf "node-v${NODE_VERSION}-linux-x64.tar.gz" -C /usr/local --strip-components=1 --no-same-owner; \
	rm -f "node-v${NODE_VERSION}-linux-x64.tar.gz" SHASUMS256.txt; \
	node --version; npm --version

COPY entry.sh /codkit/recipe/entry.sh

ENTRYPOINT ["bash", "/codkit/recipe/entry.sh"]
