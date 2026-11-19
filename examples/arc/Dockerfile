# A runner image with this project's hook, for an infrastructure repository of your own: it
# builds the bundle from a pinned commit of the project instead of from a checkout, so the
# only thing to maintain is the commit below. (The Dockerfile in the project's root builds
# from the checkout it is in.)
#
#   podman build --platform linux/amd64,linux/arm64 --manifest <registry>/<repository>:<tag> .
#   podman manifest push --all <registry>/<repository>:<tag>
#
# Build it for every architecture your runner pods can land on: ARC does not pin the runner
# pod to the job pod's architecture.

# --- Stage 1: build the hook bundle ---
# The bundle is plain JavaScript, so it is built once on the build host's platform and copied
# into each architecture's runner image.
FROM --platform=$BUILDPLATFORM node:24-slim AS hooks-builder

# hadolint ignore=DL3008
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && \
  rm -rf /var/lib/apt/lists/* && \
  install -d -o node -g node /build

# npm runs as the non-root `node` user, installs exactly what the project's lockfiles name
# with install scripts disabled, and checks the registry signatures of everything it
# installed. Do not drop --ignore-scripts to make a package work.
USER node
WORKDIR /build

# A commit, not a tag name: tags can be moved. For a release, `git rev-list -n 1 <tag>`.
# v1.1.0
ARG HOOKS_COMMIT=430d284b2907d1a4b602436934167876fa1864e6

RUN git init -q . && \
  git remote add origin https://github.com/zarko-a/kubernetes-novolume-hooks.git && \
  git fetch -q --depth 1 origin "${HOOKS_COMMIT}" && \
  git checkout -q FETCH_HEAD

WORKDIR /build/packages/hooklib
RUN npm ci --ignore-scripts --no-audit --no-fund && npm audit signatures
WORKDIR /build/packages/k8s
RUN npm ci --ignore-scripts --no-audit --no-fund && npm audit signatures

# hooklib first: k8s links it (file:../hooklib) and imports its compiled lib/.
WORKDIR /build
RUN npm run build --prefix packages/hooklib && npm run build --prefix packages/k8s

# The unit tests that need no cluster. --maxWorkers=2: Jest otherwise starts one worker per
# CPU it sees, and each needs about 2 GiB to type-check against @kubernetes/client-node, so
# on a large build host it runs out of memory. Two workers peak at about 4.4 GiB.
WORKDIR /build/packages/k8s
RUN npm run test:unit -- --maxWorkers=2

# --- Stage 2: the stock runner image with the bundle dropped over the stock hook ---
FROM ghcr.io/actions/actions-runner:2.338.2

# Only the kubernetes-novolume bundle is replaced; /home/runner/k8s (the volume-backed mode)
# is left as shipped.
COPY --chown=runner:docker --from=hooks-builder /build/packages/k8s/dist/index.js /home/runner/k8s-novolume/index.js
