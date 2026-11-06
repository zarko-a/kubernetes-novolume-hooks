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
- README, `CODEOWNERS`, `LICENSE` and `package.json` metadata describe this fork.

### Removed

- The Docker hook (`packages/docker`), upstream's GitHub workflows and Dependabot configuration.
- Upstream's contributing guide, code of conduct, security policy and release notes, which
  describe GitHub's processes and contacts.
