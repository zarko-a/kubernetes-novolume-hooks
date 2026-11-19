#!/usr/bin/env bash
# Runner job-started hook (ACTIONS_RUNNER_HOOK_JOB_STARTED), run by the runner on its own pod
# as the "Set up runner" step, before "Initialize containers". Not part of the container
# hooks: it is here because a warm runner (minRunners in values.yaml) needs it on Karpenter.
#
# Marks this runner pod karpenter.sh/do-not-disrupt once it has a job. A warm runner can sit
# idle for days, and the annotation on its pod template would block consolidation of its node
# the whole time; evicting an idle runner is harmless (ARC replaces it), evicting a busy one
# kills the job. Each runner runs one job and is deleted after it, so nothing removes the
# annotation.
#
# Mounted from a ConfigMap (see values.yaml):
#   kubectl --namespace github-actions-runners create configmap job-hooks --from-file=job-started.sh
#
# Needs `patch` on pods in the runner's Role (kubernetesModeAdditionalRoleRules).
#
# Always exits 0: a failing job-started hook fails the job, and a missing annotation only
# makes the job evictable.

set -uo pipefail

annotation='karpenter.sh/do-not-disrupt'
value='12h'
account=/var/run/secrets/kubernetes.io/serviceaccount

warn() {
	echo "::warning::job-started hook: could not mark runner pod ${ACTIONS_RUNNER_POD_NAME:-?} ${annotation}: $1; the job can be evicted by node consolidation"
	exit 0
}

[[ -n "${ACTIONS_RUNNER_POD_NAME:-}" ]] || warn 'ACTIONS_RUNNER_POD_NAME is not set'
token="$(cat "${account}/token" 2>/dev/null)" || warn 'no service account token'
namespace="$(cat "${account}/namespace" 2>/dev/null)" || warn 'no service account namespace'

url="https://kubernetes.default.svc/api/v1/namespaces/${namespace}/pods/${ACTIONS_RUNNER_POD_NAME}"
body="{\"metadata\":{\"annotations\":{\"${annotation}\":\"${value}\"}}}"

if ! response="$(curl --silent --show-error --fail --max-time 10 --retry 2 \
	--cacert "${account}/ca.crt" \
	--header "Authorization: Bearer ${token}" \
	--header 'Content-Type: application/merge-patch+json' \
	--request PATCH --data "${body}" --output /dev/null --write-out '%{http_code}' \
	"${url}" 2>&1)"; then
	warn "${response}"
fi

echo "job-started hook: marked runner pod ${ACTIONS_RUNNER_POD_NAME} ${annotation}=${value}"
exit 0
