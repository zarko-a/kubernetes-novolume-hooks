# Changelog

All notable changes to this project are recorded here. The project uses
[semantic versioning](https://semver.org/).

Forked from [actions/runner-container-hooks](https://github.com/actions/runner-container-hooks)
`main` at `d4731a4`. Last reviewed upstream commit: `d4731a4` (upstream `main`, 2026-11-09).

## [Unreleased]

### Added

- Each `run:` step syncs `_temp` with the hook over HTTP, in the same exec session as the
  step, instead of six exec sessions through the API server (mkdir, the copy in, its check,
  the merge, the copy of `_runner_file_commands` back, its check; ~0.1s each). A small
  client, written into `_work/_custom_hook/` by `prepare_job` and run with the runner's
  `node24` (or `node24_alpine` on musl images) from `/__e`, downloads and merges `_temp`
  before the step's script and uploads `_runner_file_commands` after it succeeds. The hook
  serves both on an ephemeral port for the length of the step, to requests carrying a
  one-time token, and accepts only `_runner_file_commands/` entries back. If the client
  cannot start the step, the hook warns and uses the exec path for that step and the rest
  of the job; a job container the runner has no Node.js for (a musl image on arm64: the
  runner ships `node24_alpine` for x64 only) takes the exec path the same way, with an info
  line instead of the warning. If the upload does not arrive, it copies the file commands
  back over exec.
  `HOOK_WORK_TRANSFER=exec` turns it off together with the `_work` transfer. Copies over
  HTTP are not compared file by file afterwards; tar's exit status and the HTTP status are
  the check.
- git trusts the workspace in every step: the hook adds `safe.directory=*` to the job
  container's environment as git config (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`,
  `GIT_CONFIG_VALUE_<n>`, appended after any entries the workflow sets). The workspace is
  owned by uid 1001 while the job container usually runs as another user, and
  actions/checkout adds `safe.directory` only for its own git calls, so a later step's git
  failed with "dubious ownership" unless the workflow added it. No file owners change.
  `HOOK_GIT_SAFE_DIRECTORY` (`true` by default, or `false`, from the job container's env,
  then the runner's env) turns it off.
- Per-job sizing: a job asks for its pod's size in the job container's env (`container.env`
  in the workflow), so one runner scale set serves every size. `HOOK_JOB_MEMORY` (request and
  limit, `Mi`/`Gi`) and `HOOK_JOB_CPU` (request, cores or millicores) are required;
  `HOOK_JOB_DISK` (ephemeral-storage request), `HOOK_JOB_ARCH` (`amd64` by default, or
  `arm64`) and `HOOK_JOB_PROFILE` (`standard` by default) are optional. The hook builds the
  pod template from `profile-<profile>.yaml` in the runner's `HOOK_JOB_PROFILE_DIR`, sets the
  job container's resources and the `kubernetes.io/arch` node selector, and annotates the pod
  with the requested values (`custom-hook/memory`, `cpu`, `disk`, `arch`, `profile`). The
  runner's env sets the limits: `HOOK_JOB_MAX_MEMORY` and `HOOK_JOB_MAX_CPU` (required),
  `HOOK_JOB_MAX_DISK` (without it, `HOOK_JOB_DISK` is refused), `HOOK_JOB_CPU_LIMIT` (the job
  container's CPU limit; none without it) and `HOOK_JOB_PROFILES` (allowed profiles,
  comma-separated, `standard` by default). Values are parsed strictly and never rounded; a
  malformed, missing or over-limit value fails the job before a pod is created, naming every
  problem. A job that sets none of these uses the runner's fixed template
  (`ACTIONS_RUNNER_CONTAINER_HOOK_TEMPLATE`) as before; on a runner with
  `HOOK_JOB_PROFILE_DIR` and no fixed template, it fails and names the variables to set.
- The runner's externals (`/__e`: node20, node24 and their Alpine builds, ~600 MB) are mounted
  read-only from the runner image as an image volume, instead of `fs-init` copying them into
  an emptyDir for every job. The copy wrote ~600 MB to the node's root volume per job; with a
  few job pods starting together the volume sat at its throughput limit and containerd timed
  out tearing down finished containers, holding job containers back by 10-15s.
  `HOOK_EXTERNALS` (`image` by default, or `copy`) chooses; `image` needs image volumes
  (Kubernetes 1.35+, or the `ImageVolume` feature gate on 1.33-1.34). The HTTP transfer's
  status file moved from `/__e` to `/github`.
- `prepare_job` reads `_work` into the runner pod's page cache as soon as it starts, with 32
  readers in parallel, so the copy to the job pod does not read the files from disk one at a
  time. The runner's freshly downloaded actions were often not cached: packing 11.6k files
  took 11-13s from disk and 1.4s from the cache. The read-ahead stops when the copy is done,
  and never fails the job.
- The job pod's `fs-init` container downloads `_work` straight from the hook over HTTP, so
  `prepare_job` no longer streams it through the API server and the kubelet after the pod is
  Running. The hook serves a tar of `_work` on an ephemeral port for the length of
  `prepare_job`, to requests carrying a one-time token, and passes the URL and token to
  `fs-init` as `HOOK_WORK_URL` and `HOOK_WORK_TOKEN`. The runner pod's IP comes from
  `ACTIONS_RUNNER_POD_IP` (set it from `status.podIP`), else from the first non-internal IPv4
  address. Files arrive owned by uid 1001 and group-writable, so non-root job containers can
  write them. If the download fails, or the IP is unknown, the hook warns and falls back to
  the exec copy. The `fs-init` image needs `curl`, which the `actions-runner` image has.
  `HOOK_WORK_TRANSFER` (`http` by default, or `exec`, from the job container's env, then the
  runner's env) turns the HTTP transfer off, for clusters where the job pod cannot reach the
  runner pod.
- Pod status in the job log while the job pod starts: every event about the pod (once each,
  again when an aggregated event repeats), the pod's phase, conditions and container states
  whenever they change, a heartbeat every 5 quiet seconds, and once Running, when each
  condition turned true and each container started. Kubernetes' reasons and messages are
  passed through as they are. Needs `get` and `list` on `events`; without them a warning says
  so and only the pod's status is shown.
- Fail fast: when a container in the job pod waits with `ErrImagePull`/`ImagePullBackOff` or
  `CreateContainerConfigError` for longer than a grace period, or with `InvalidImageName` at
  all, `prepare_job` fails with the kubelet's message instead of waiting for the 10-minute
  timeout. `HOOK_FAIL_FAST` (default `true`) and `HOOK_FAIL_FAST_SECONDS` (default `60`) are
  read from the job container's env, then the runner's env.
- When a step fails, the job pod's trouble is printed as errors: an OOM kill with the memory
  limit, an eviction, the pod gone, and the pod's events since the step started. A plain
  failure, like a failing test, prints nothing extra. After a SIGKILL (exit 137) or a broken
  session the pod is re-read for up to 15s, because the kubelet reports an OOM kill a few
  seconds after the container dies; any failure in a step's copies is reported too.
- Timing lines in the job log, prefixed `[custom-hook]`: job pod creation and time to
  Running, every copy to and from the job pod (files, bytes, transfer time, retries, and
  whether the hash check matched), the `_temp` merge, and the total time of `prepare_job` and
  of each `run_script_step` with the hook's own overhead.
- `npm run test:unit` in `packages/k8s` runs every test that needs no cluster; the
  `Dockerfile` runs it.
- A `Dockerfile` that builds the hook bundle (npm as a non-root user, lockfile installs with
  install scripts disabled, registry signatures checked, no-cluster unit tests run) and drops
  it over `/home/runner/k8s-novolume/index.js` in a pinned `actions-runner` image.
  The bundle builds on the build host's platform, so a multi-arch image needs no npm under
  emulation.
- `scripts/container-npm.sh`, which runs npm and npx in the builder image as the calling user,
  with only the repository mounted and install scripts disabled.

### Fixed

- An exec whose stream closes before Kubernetes sends its exit status (the API server or the
  kubelet dropped it) now fails, instead of never settling: the hook exited 0 once nothing
  else was pending, so the runner marked a step that may still have been running as passed.
  A step fails with `the exec stream closed before the command reported an exit status`; a
  copy counts it as a failed attempt and retries. Reported upstream in
  actions/runner-container-hooks#449 (open when this was written); written here for every
  exec the hook runs, not only steps.
- No `DeprecationWarning` lines in the job log. `Buffer() is deprecated` (DEP0005) came from
  stream-buffers, which the copies used to collect the exec's stderr; a small stream on
  Node's built-ins replaces it. `punycode` (DEP0040) and `url.parse()` (DEP0169) came from
  `node-fetch` 2 inside `@kubernetes/client-node` 1.x, gone with 2.x (see "Changed").
- A copy from the job pod returns only after every file is written on the runner. It returned
  when the exec's status arrived, while tar-fs could still be writing, so the runner could read
  incomplete step outputs. Upstream's 15 silent hash retries hid the race; comparing once
  exposed it.
- Job containers that run as a non-root user other than 1001 can write the workspace: `fs-init`
  creates its directories group-writable (`umask 0002`), and `fsGroup: 1001` puts every
  container in that group. Checkout used to fail with `EACCES`.

### Changed

- `@kubernetes/client-node` 1.4.0 -> 2.0.1. Every API call and exec now goes through
  `undici` (the HTTP client behind Node's own `fetch`) instead of `node-fetch` 2, which
  removes `node-fetch`, `whatwg-url`, `tr46` and `webidl-conversions` from the bundle, and
  with them two deprecation warnings per hook process. 2.x needs Node 22 or later; the
  runner runs the hook with its internal `node24`. Shared dependencies moved with it:
  `js-yaml` 5.5.0, `form-data` 4.0.6, `ip-address` 10.7.5, `socks-proxy-agent` 10.1.0,
  which also clears their open advisories. Resolving needs `--legacy-peer-deps` because of
  upstream's dev-only `ts-jest` 29 / Babel 8 peer conflict; no dev package changed.
- The copy to the job pod and the hash check behind every copy run `chmod` and `stat` once per
  batch of files (`find -exec ... {} +`) instead of once per file, and the per-step `_temp`
  merge starts one `sh` per batch instead of one per file. On an 11k-file tree that cut
  `chmod` from 7.7s to 0.08s and `stat` from 10.1s to 0.06s in a local benchmark. Hashes are
  unchanged: the listings are sorted before hashing.
- Waiting for the job pod polls after 1s, then 15% longer each
  time up to 3s, instead of doubling up to 20s: a pod Running at 16s was noticed at 31s, now
  at 16.7s. The prepare-job timeout counts wall-clock time, API calls included, and its error
  says `timed out after <N>s` instead of `backoff timeout`.
- Copies fail fast instead of retrying silently. A copy command that exits non-zero (a failed
  `tar`) is a failed attempt and is retried; the error carries `tar`'s stderr, which is no
  longer discarded. Stderr from a successful copy is logged. The `chmod` after unpacking stays
  best effort, because a non-root job container cannot chmod directories it does not own. GNU
  tar run by a non-root user exits non-zero when it cannot set the mode or times of such
  directories, after unpacking every file; a failure with only those errors counts as success.
- After each copy, the files on both sides are compared once, in parallel, instead of up to 15
  times with a second's sleep between tries. A mismatch, or a comparison that could not run, is
  a warning naming both file counts; the job continues, as it did after upstream's last retry.
- README, `CODEOWNERS`, `LICENSE` and `package.json` metadata describe this fork.

### Removed

- Code left from upstream's volume-backed `kubernetes` mode, which nothing called: the PVC
  name (`ACTIONS_RUNNER_CLAIM_NAME`), the `ACTIONS_RUNNER_USE_KUBE_SCHEDULER` switch, and the
  Job-based container step's helpers (waiting on a Job, the env Secret, following pod logs,
  reading a pod's status). The startup permission check no longer asks for `pods/log`,
  which only those log helpers used, and the package README no longer asks for it or a PVC.
- The `uuid` dependency (Node's `crypto.randomUUID()` replaces it), and `@actions/exec` and
  `@actions/io`, which nothing imported.
- The Docker hook (`packages/docker`), upstream's GitHub workflows and Dependabot configuration.
- Upstream's contributing guide, code of conduct, security policy and release notes, which
  describe GitHub's processes and contacts.
