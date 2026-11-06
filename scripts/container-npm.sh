#!/usr/bin/env bash
# Run npm or npx in a container, never on the host.
#
# Usage: scripts/container-npm.sh <directory in the repository> <command> [args...]
#   scripts/container-npm.sh . npm ci
#   scripts/container-npm.sh packages/hooklib npm ci
#   scripts/container-npm.sh packages/k8s npm ci
#   scripts/container-npm.sh packages/k8s npm audit signatures
#   scripts/container-npm.sh packages/k8s npx jest tests/constants-test.ts
#   scripts/container-npm.sh . npm run lint
#
# Uses the Dockerfile's builder image (keep the two pins in sync) through rootless podman,
# as the calling user, with only this repository mounted: no credentials, SSH agent or home
# directory reach the container. Install scripts are disabled for every npm command;
# `npm run <script>` and `npm test` still run the named script itself.

set -euo pipefail

if [[ $# -lt 2 ]]; then
	sed -n '2,10p' "$0" >&2
	exit 2
fi

image='docker.io/library/node:24.22.2-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9'
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
directory="$1"
shift

exec podman run --rm -i \
	--userns=keep-id --user "$(id -u):$(id -g)" \
	--env HOME=/tmp/home \
	--env npm_config_ignore_scripts=true \
	--env npm_config_update_notifier=false \
	--env npm_config_fund=false \
	--volume "${root}:/repository:Z" \
	--workdir "/repository/${directory}" \
	"${image}" "$@"
