# Changelog

All notable changes to this project are recorded here. The project uses
[semantic versioning](https://semver.org/).

Forked from [actions/runner-container-hooks](https://github.com/actions/runner-container-hooks)
`main` at `d4731a4`. Last reviewed upstream commit: `d4731a4`.

## [Unreleased]

### Added

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

- The Docker hook (`packages/docker`), upstream's GitHub workflows and Dependabot configuration.
- Upstream's contributing guide, code of conduct, security policy and release notes, which
  describe GitHub's processes and contacts.
