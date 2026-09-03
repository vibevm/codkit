FROM node:24-bookworm

# Build this environment image where Debian packages are available (or from
# internal mirrors), then promote it into the air-gapped image registry.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends git git-lfs \
	&& git lfs install --system \
	&& rm -rf /var/lib/apt/lists/*

# The Codkit installation, patch set, and fork tree are mounted at run time.
# This image deliberately carries none of them, nor credentials or caches.
WORKDIR /work/patchset
