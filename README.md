# kubernetes-novolume-hooks

Container hooks for the `kubernetes-novolume` container mode of
[actions-runner-controller](https://github.com/actions/actions-runner-controller) (ARC). The
bundle replaces `/home/runner/k8s-novolume/index.js` in the
[actions/runner](https://github.com/actions/runner) image, and runs each job in its own pod
with no volume shared between the runner pod and the job pod.

## Status

Under development and not ready for use. There are no releases yet, and contributions are not
being accepted while the design settles. Changes are recorded in [CHANGELOG.md](./CHANGELOG.md).

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

## Disclaimer

This project is largely vibe coded: it is written with an AI coding agent. The author runs it in
their own CI, so it is exercised for real, but it comes with no warranty or guarantee of any
kind. Use it at your own risk, as the MIT license also says.

## License

MIT, see [LICENSE](./LICENSE).
