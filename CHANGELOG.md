# Changelog

All notable changes to this project are recorded here. The project uses
[semantic versioning](https://semver.org/).

Forked from [actions/runner-container-hooks](https://github.com/actions/runner-container-hooks)
`main` at `d4731a4`. Last reviewed upstream commit: `d4731a4`.

## [Unreleased]

### Added

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

- The `Buffer() is deprecated` warning (DEP0005) no longer appears in every hook step's log.
  It came from stream-buffers, which the copies used to collect the exec's stderr; a small
  stream on Node's built-ins replaces it. The `punycode` (DEP0040) and `url.parse()`
  (DEP0169) warnings remain: they come from `node-fetch` 2 inside `@kubernetes/client-node`
  1.x, which 2.x replaces.
- A copy from the job pod returns only after every file is written on the runner. It returned
  when the exec's status arrived, while tar-fs could still be writing, so the runner could read
  incomplete step outputs. Upstream's 15 silent hash retries hid the race; comparing once
  exposed it.
- Job containers that run as a non-root user other than 1001 can write the workspace: `fs-init`
  creates its directories group-writable (`umask 0002`), and `fsGroup: 1001` puts every
  container in that group. Checkout used to fail with `EACCES`.

### Changed

- The copy to the job pod and the hash check behind every copy run `chmod` and `stat` once per
  batch of files (`find -exec ... {} +`) instead of once per file, and the per-step `_temp`
  merge starts one `sh` per batch instead of one per file. On an 11k-file tree that cut
  `chmod` from 7.7s to 0.08s and `stat` from 10.1s to 0.06s in a local benchmark. Hashes are
  unchanged: the listings are sorted before hashing.
- Waiting for the job pod (and a container step's Job) polls after 1s, then 15% longer each
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

- The `uuid` dependency (Node's `crypto.randomUUID()` replaces it), and `@actions/exec` and
  `@actions/io`, which nothing imported.
- The Docker hook (`packages/docker`), upstream's GitHub workflows and Dependabot configuration.
- Upstream's contributing guide, code of conduct, security policy and release notes, which
  describe GitHub's processes and contacts.
