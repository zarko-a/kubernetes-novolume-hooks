# kubernetes-novolume-hooks

Container hooks for the `kubernetes-novolume` container mode of
[actions-runner-controller](https://github.com/actions/actions-runner-controller) (ARC). The
bundle replaces `/home/runner/k8s-novolume/index.js` in the
[actions/runner](https://github.com/actions/runner) image, and runs each job in its own pod
with no volume shared between the runner pod and the job pod.

## Status

1.0.0 is the first release, and the author runs it in production CI. Contributions are not
being accepted yet. Changes are recorded in [CHANGELOG.md](./CHANGELOG.md).

## Relationship to upstream

This is a fork of [actions/runner-container-hooks](https://github.com/actions/runner-container-hooks),
taken from upstream `main` at `d4731a4` (v0.8.1 plus 13 commits). It is a divergent fork, not a
mirror: it does not track upstream, and upstream fixes worth having are cherry-picked. Thanks to
the upstream maintainers and contributors, whose work this builds on.

This project is not affiliated with or endorsed by GitHub.

## What it is not

Only ARC's `kubernetes-novolume` mode is covered. This repository does not contain:

- the Docker hook (upstream's `packages/docker`);
- the volume-backed `kubernetes` mode, where the job pod mounts the runner's work volume;
- anything for ARC's `dind` mode, which uses no hooks;
- Windows support.

## Goals

- Faster job startup: less time between a runner picking up a job and its first step.
- Visible pod status in the job log while a job starts, so a slow or stuck job explains itself.
- Clear failures instead of silent retries.

## Configuration

The hooks are configured through environment variables. Each one is read from one or two
places:

- **job**: the job container's env, `container.env` in the workflow;
- **runner**: the runner container's env, set in the scale set's pod template;
- **step**: the step's env (`env:` on the step, the job or the workflow).

Where both are listed, the job's value wins over the runner's, so the runner sets a default
for the scale set and a workflow can override it. An empty value counts as unset.

### Settings

| Variable                           | Read from   | Default | Values and effect                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOOK_WORK_TRANSFER`               | job, runner | `http`  | `http`: the job pod downloads `_work` from the hook, and each `run:` step syncs `_temp` the same way. `exec`: copy through the Kubernetes API, as upstream does; use it where the job pod cannot reach the runner pod (a NetworkPolicy, a firewall).                                     |
| `HOOK_EXTERNALS`                   | job, runner | `image` | `image`: mount the runner's externals (`/__e`) read-only from the runner image as an image volume. Needs Kubernetes 1.35+, or the `ImageVolume` feature gate on 1.33-1.34, and a runtime that supports image volumes (e.g. containerd 2.1+). `copy`: `fs-init` copies them, as upstream. |
| `HOOK_GIT_SAFE_DIRECTORY`          | job, runner | `true`  | `true`: add `safe.directory=*` to the job container's git config through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>`/`GIT_CONFIG_VALUE_<n>`, after any entries the workflow sets. `false`: leave git's config alone.                                                                         |
| `HOOK_FAIL_FAST`                   | job, runner | `true`  | `true`: fail `prepare_job` with the kubelet's message when a job pod container stays in `ErrImagePull`, `ImagePullBackOff` or `CreateContainerConfigError` past the grace period, or hits `InvalidImageName`. `false`: wait for the prepare-job timeout, as upstream.                    |
| `HOOK_FAIL_FAST_SECONDS`           | job, runner | `60`    | The grace period, in whole seconds. It must be below `ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS`, or that timeout comes first.                                                                                                                                                          |
| `HOOK_STEP_RECONNECT_SECONDS`      | runner      | `300`   | How long the hook keeps reconnecting to a `run:` step after its exec session drops (see "Steps that survive a dropped connection"). The step keeps running meanwhile; past this, it is stopped and fails. Each drop gets the full time.                                                  |
| `HOOK_STEP_ORPHAN_SECONDS`         | runner      | `15`    | How long a step runs on after its hook is gone (the runner pod died, or the hook was killed): this many seconds of failed liveness polls, with no exec session reading the step's output. Then the step's processes get SIGTERM, and SIGKILL 3s later.                                   |
| `HOOK_STEP_OUTPUT_LIMIT_MB`        | runner      | `2048`  | How much output (stdout plus stderr, in MiB) a `run:` step may write before it is stopped the same way. The output waits in files in the job pod until the hook has read it, so nothing slows down a step that writes faster than that.                                                  |
| `HOOK_TEST_DROP_STEP_EXEC_SECONDS` | step        | none    | Testing only: cut each of the step's exec sessions after this many seconds, as an API server restart would, so the reconnect can be tested on demand (a step longer than twice this is cut more than once). Ignored unless the runner sets `HOOK_TEST_ALLOW_STEP_EXEC_DROP`.             |
| `HOOK_TEST_ALLOW_STEP_EXEC_DROP`   | runner      | `false` | `true`: steps may use `HOOK_TEST_DROP_STEP_EXEC_SECONDS`. For a test scale set only: on any other, a workflow could cut its own steps.                                                                                                                                                   |

A value that is not one of the listed ones is a warning in the job log, and the default is
used. The job log's `[custom-hook]` lines say which value each setting took and where it came
from.

### Per-job sizing

A runner with `HOOK_JOB_PROFILE_DIR` set builds each job pod's template from a profile and the
size the job asks for, so one scale set can serve jobs of every size. A job that sets none of
the job variables below gets the runner's fixed template (`ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE`)
as upstream; if the runner has no fixed template, the job fails and names the variables to set. A
job that sets them on a runner without `HOOK_JOB_PROFILE_DIR` fails. Values are parsed strictly
and never rounded, and a malformed, missing or over-limit value fails the job before a pod is
created, naming every problem at once.

| Variable               | Read from | Default             | Values and effect                                                                                                                                                                                         |
| ---------------------- | --------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOOK_JOB_MEMORY`      | job       | required            | The job container's memory request and limit, in `Mi` or `Gi` (`512Mi`, `7Gi`, `1.5Gi`).                                                                                                                  |
| `HOOK_JOB_CPU`         | job       | required            | The job container's CPU request, in cores (`2`, `0.5`) or millicores (`500m`).                                                                                                                            |
| `HOOK_JOB_DISK`        | job       | the profile's       | The job container's `ephemeral-storage` request, in `Mi` or `Gi`. Refused unless the runner sets `HOOK_JOB_MAX_DISK`.                                                                                     |
| `HOOK_JOB_ARCH`        | job       | `amd64`             | `amd64` or `arm64`: the job pod's `kubernetes.io/arch` node selector. `any`: no selector, for multi-arch job images; the job log says which architecture the pod ran on.                                  |
| `HOOK_JOB_PROFILE`     | job       | `standard`          | The profile to build the pod from; one of `HOOK_JOB_PROFILES`.                                                                                                                                            |
| `HOOK_JOB_PROFILE_DIR` | runner    | none (sizing off)   | The directory holding the profiles, one pod template per profile named `profile-<name>.yaml`, in the same format as `ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE` (e.g. a mounted ConfigMap). Turns sizing on. |
| `HOOK_JOB_PROFILES`    | runner    | `standard`          | The profiles jobs may ask for, comma-separated.                                                                                                                                                           |
| `HOOK_JOB_MAX_MEMORY`  | runner    | required for sizing | The most memory a job may ask for.                                                                                                                                                                        |
| `HOOK_JOB_MAX_CPU`     | runner    | required for sizing | The most CPU a job may ask for.                                                                                                                                                                           |
| `HOOK_JOB_MAX_DISK`    | runner    | none                | The most disk a job may ask for. Without it, jobs cannot set `HOOK_JOB_DISK`.                                                                                                                             |
| `HOOK_JOB_CPU_LIMIT`   | runner    | none (no CPU limit) | The job container's CPU limit, the same for every job. It must be at least `HOOK_JOB_MAX_CPU`.                                                                                                            |

The hook owns the job container's memory and CPU: the profile's values for them are replaced.
The pod is annotated with the requested values (`custom-hook/memory`, `cpu`, `disk`, `arch`,
`profile`), so usage can be compared with requests.

### Runner variables

Set on the runner container. ARC sets `ACTIONS_RUNNER_POD_NAME`, and the runner sets
`RUNNER_WORKSPACE` and `RUNNER_TEMP`; the others are yours to set.

| Variable                                     | Default                                 | Effect                                                                                                                                                                                                    |
| -------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ACTIONS_RUNNER_POD_IP`                      | the first non-internal IPv4 address     | The address the job pod downloads from (`HOOK_WORK_TRANSFER=http`). Set it from the downward API (`fieldRef: status.podIP`). If no address is found, the hook warns and copies over exec.                 |
| `ACTIONS_RUNNER_IMAGE`                       | `ghcr.io/actions/actions-runner:latest` | The image `fs-init` runs, and the image the externals volume mounts (`HOOK_EXTERNALS=image`). Set it to the runner container's own image, so the job pod's externals (`/__e`) match the runner's version. |
| `ACTIONS_RUNNER_POD_NAME`                    | required                                | The runner pod's name. Job pod, step pod and Secret names derive from it; a name too long for Kubernetes loses characters from the middle and keeps its unique tail.                                      |
| `ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE`     | none                                    | A fixed pod template for the job pod, as upstream. Template `initContainers` run after the hook's `fs-init`.                                                                                              |
| `ACTIONS_RUNNER_PREPARE_JOB_TIMEOUT_SECONDS` | `600`                                   | How long the job pod has to reach Running.                                                                                                                                                                |
| `ACTIONS_RUNNER_KUBERNETES_NAMESPACE`        | the service account's namespace         | The namespace job pods are created in.                                                                                                                                                                    |
| `ACTIONS_RUNNER_HEARTBEAT_PERIOD_MS`         | `5000`                                  | The ping period on exec sessions.                                                                                                                                                                         |
| `ACTIONS_RUNNER_HEARTBEAT_DEADLINE_MS`       | 12 periods plus 1s                      | How long an exec session may go without a pong before it fails.                                                                                                                                           |

`HOOK_WORK_URL`, `HOOK_WORK_TOKEN`, `HOOK_STEP_URL`, `HOOK_STEP_TOKEN`, `HOOK_STEP_UNPACK`,
`HOOK_STEP_MERGE`, `HOOK_STEP_PACK` and `HOOK_RUN_*` are set by the hook for `fs-init` and
its step client. They are internal, not settings.

## Steps that survive a dropped connection

Every `run:` step's output and exit code come back to the runner over an exec session through
the Kubernetes API server and the kubelet. Upstream's hook runs the step inside that session,
so when the connection drops (a restarted or replaced API server instance, as happens during
managed control-plane maintenance), the container runtime kills the step with it.

Here the step runs detached in the job pod. A supervisor, started by the step's exec session
in its own session, runs the step in its own process group, with stdout and stderr appended
to files under `/__w/_custom_hook/steps/` and the exit code recorded in a third file. The exec
session prints the files as they grow. When it drops, the hook logs a `[custom-hook] lost the
connection to the step` line and reconnects with backoff for up to
`HOOK_STEP_RECONNECT_SECONDS`, resuming the output from the bytes it has received, so nothing
is printed twice or lost. A `[custom-hook] reconnected to the step` line says how long it
took. A later drop in the same step gets the full time again. In the normal case a step still
costs one exec session.

- **Never twice.** The supervisor takes a lock in the step's directory before it runs the
  step, so a launch the hook has to repeat cannot run it a second time.
- **Cancel and `timeout-minutes`.** The runner's SIGINT goes to the step's process group, so
  the step can clean up as on a VM runner. A group still running 6s later, or the runner's
  SIGTERM, gets SIGKILL. The signal goes both through an exec session and through the
  supervisor's next poll of the hook, which does not need the API server; the step gets the
  SIGINT once, whichever arrives first. Once a cancelled step has ended, whatever it left
  running in its process group is killed too.
- **A hook that is gone.** The supervisor polls the hook's per-step server every second, pod
  to pod. When `HOOK_STEP_ORPHAN_SECONDS` polls in a row have failed and no exec session is
  reading the step's output, the hook is gone, and the supervisor stops the step. One of the
  two alone is not enough: the polls fail during a pod network blip, and the exec session is
  gone during an API server restart.
- **No overlap.** Before a step starts, anything an earlier step left running without a
  recorded exit code (its hook was killed) is killed. Processes a finished step started in
  the background on purpose (`nohup server &`) are left alone, as on a VM runner.
- **A reconnect that fails.** When the hook cannot reconnect in time, it has the supervisor
  kill the step before it reports the failure, so the step does not run on unseen.
- **A dead supervisor or reader** (a step that runs `pkill -9 node`). Without its supervisor
  the step fails within a second or two, instead of at `timeout-minutes`. When only the
  process reading the output was killed, the hook sees that the step has recorded no exit
  code and reads on; plain `pkill node` (SIGTERM) reaches neither.
- **Too much output.** A step that has written more than `HOOK_STEP_OUTPUT_LIMIT_MB` is
  stopped, with a `[custom-hook]` line saying so, before it fills the node's disk.
- **A job container that is gone** (OOM-killed) fails the step, and the steps after it,
  with a plain message instead of retrying.

## Permissions

The runner's service account needs upstream's rules, which the hook checks before every
command, plus `events`:

```yaml
- apiGroups: ['']
  resources: ['pods']
  verbs: ['get', 'list', 'create', 'delete']
- apiGroups: ['']
  resources: ['pods/exec']
  verbs: ['get', 'create']
- apiGroups: ['']
  resources: ['secrets']
  verbs: ['get', 'list', 'create', 'delete']
- apiGroups: ['']
  resources: ['events']
  verbs: ['get', 'list']
```

With ARC, add the `events` rule through `containerMode.kubernetesModeAdditionalRoleRules`.
Without it, the job log has a warning and shows only the pod's status while it starts, not
the scheduler's, Karpenter's or the kubelet's events.

The hooks never patch pods. A runner job-started hook (`ACTIONS_RUNNER_HOOK_JOB_STARTED`)
that annotates its own pod, for example so Karpenter does not disrupt a long-lived runner
while it runs a job, needs `patch` on `pods` as well.

## Known limitations

- JavaScript actions in Alpine (musl) job containers need both the job pod and the runner pod
  on amd64. The runner ships Node.js for musl on x64 only, and refuses such actions when it
  runs on arm64 itself, whatever the job pod's architecture. `run:` steps work in them on
  both architectures (on arm64 the hook syncs `_temp` over exec, with an info line), and
  glibc job images have no such limit.
- Local actions (`uses: ./path`) fail with "Can't find 'action.yml'": the checkout happens in
  the job pod, and the runner reads the action from its own workspace. Reference the action
  through its repository instead.
- Steps that do not sync `_temp` over HTTP (`HOOK_WORK_TRANSFER=exec`, or a job image the
  runner has no Node.js for) run attached, as upstream: a dropped exec session fails them.
  So do container-action steps (`uses: docker://...`).
- A step's stdout and stderr are read from two files, so lines written to both within a
  fraction of a second appear in the job log grouped by stream rather than in the order
  they were written: a `set -x` trace can follow the output of its commands. Each line is
  whole.
- A step whose hook is gone, but whose exec session stays half-open (the runner's node
  failed without closing its connections), runs on until that session ends or the job pod
  is deleted.

## Disclaimer

This project is largely vibe coded: it is written with an AI coding agent. The author runs it in
their own CI, so it is exercised for real, but it comes with no warranty or guarantee of any
kind. Use it at your own risk, as the MIT license also says.

## License

MIT, see [LICENSE](./LICENSE).
