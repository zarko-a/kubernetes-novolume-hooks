# Runner image with this repository's kubernetes-novolume hook bundle.
#
# Builds packages/k8s into a single index.js and drops it over the stock
# /home/runner/k8s-novolume/index.js of the actions/runner image. Point ARC's runner
# `image` (and ACTIONS_RUNNER_IMAGE, if you set it) at the result.
#
# Build it for every architecture your runner pods can land on. ARC does not pin the runner
# pod to the job pod's architecture, so an amd64-only image on an arm64 node fails to start,
# or runs under emulation if the node has a QEMU binfmt handler registered.
#
#   podman build --platform linux/amd64,linux/arm64 --manifest <registry>/<repository>:<tag> .
#   podman manifest push --all <registry>/<repository>:<tag>
#
# Supply chain: npm runs only in the builder stage, as the non-root `node` user, installs
# exactly what the lockfiles name with install scripts disabled, and checks the registry
# signatures of everything it installed. Base images are pinned by tag and digest; bump both
# together.

# The bundle is plain JavaScript, so it is built once on the build host's platform and
# copied into each architecture's runner image, instead of running npm under emulation.
FROM --platform=$BUILDPLATFORM docker.io/library/node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS builder

RUN install -d -o node -g node /build
USER node
WORKDIR /build

# Manifests first, so the dependency layers are reused when only the source changes.
COPY --chown=node:node tsconfig.json ./
COPY --chown=node:node packages/hooklib/package.json packages/hooklib/package-lock.json packages/hooklib/
COPY --chown=node:node packages/k8s/package.json packages/k8s/package-lock.json packages/k8s/

# --ignore-scripts: install scripts are the main npm attack vector, and nothing here needs one
# (ncc, tsc and jest are plain JavaScript). Do not remove it to make a new package work.
WORKDIR /build/packages/hooklib
RUN npm ci --ignore-scripts --no-audit --no-fund && npm audit signatures
WORKDIR /build/packages/k8s
RUN npm ci --ignore-scripts --no-audit --no-fund && npm audit signatures
WORKDIR /build

COPY --chown=node:node packages/hooklib/ packages/hooklib/
COPY --chown=node:node packages/k8s/ packages/k8s/

# hooklib first: k8s links it (file:../hooklib) and imports its compiled lib/.
RUN npm run build --prefix packages/hooklib && npm run build --prefix packages/k8s

# Unit tests that need no cluster: `test:unit` skips the upstream tests that run against a kind
# cluster, so every new test file runs here by default.
WORKDIR /build/packages/k8s
RUN npm run test:unit

FROM ghcr.io/actions/actions-runner:2.338.2@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232

COPY --chown=runner:docker --from=builder /build/packages/k8s/dist/index.js /home/runner/k8s-novolume/index.js
