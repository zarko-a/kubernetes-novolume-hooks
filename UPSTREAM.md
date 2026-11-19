# Upstream review log

This fork does not merge or rebase upstream
([actions/runner-container-hooks](https://github.com/actions/runner-container-hooks)); fixes
worth having are ported one by one. This file records which upstream commits have been
reviewed and what was decided for each, so each review starts where the last one stopped
instead of from the fork point.

- **Fork point:** `d4731a4` (upstream `main`, v0.8.1 plus 13 commits)
- **Reviewed through:** `cc83f88` (upstream `main`, reviewed 2026-11-19)

## How to review

1. `git fetch upstream`, then list what is new, oldest first:
   `git log --reverse --format='%h %ad %s' --date=short <reviewed through>..upstream/main`
2. Read the changes to the paths that matter:
   - `packages/k8s-novolume`: upstream's copy of this hook since #445. Compare a change with
     our `packages/k8s`.
   - `packages/hooklib`: shared by both.
   - `packages/k8s`: upstream's volume-backed hook since #445. Most of it does not apply,
     but fixes to code both hooks share (the pod spec, the `prepare_job` response, cleanup)
     may.
3. Skip without analysis, one row each: dependency and lockfile bumps (Renovate keeps the
   fork's own), `packages/docker`, upstream CI, release and repository files.
4. Add a section at the top of the log with one row per commit. A squashed commit that holds
   several changes gets one row per change. Then move "Reviewed through" forward.
5. Port with `git cherry-pick -x` when the change applies cleanly; otherwise by hand, with
   `Ported from upstream <sha> (#<PR>)` in the commit message. A port that changes behaviour
   goes through the usual feature cycle and gets a changelog entry. Change the row's
   decision to "Ported" with the fork commit.

Decisions:

| Decision      | Meaning                                                       |
| ------------- | ------------------------------------------------------------- |
| Port          | Worth having and not done yet.                                |
| Ported        | Done; the row names the fork commit.                          |
| Already fixed | The fork fixed the same problem its own way.                  |
| Declined      | Applies to the fork, but we do not want it; the row says why. |
| N/A           | Touches code the fork does not have or no longer runs.        |
| Skipped       | Out of scope by the rule in step 3.                           |

## Log

### 2026-11-19: `d4731a4..cc83f88`

One commit, `cc83f88` (#445, merged 2026-11-18): splits upstream's hook into
`packages/k8s` (back to a shared volume) and `packages/k8s-novolume` (the volume-less hook
this fork started from, with the fixes below). Reviewed as
`git diff d4731a4:packages/k8s cc83f88:packages/k8s-novolume` plus the volume package's
changes to shared code. #445 was also read while still open (devops fork plan, Phase 5 step
3b); the merged version holds the same decisions.

| Change in #445                                                                                                                                                                                   | Decision      | Notes                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare_job` response: `job.container.ports` read `hostPort` from the wrong object, so it was always empty.                                                                                     | Ported        | `aa35177`. Same bug was in `packages/k8s/src/hooks/prepare-job.ts`; job and service ports now share `contextPorts`, tested in `tests/context-ports-test.ts`.                                                                                                                                                                |
| `fixArgs`: a job or service container's `entryPointArgs` that start with `-c` keep the script as one argument, and a quoted script the runner split on spaces is decoded.                        | Ported        | `aa35177`. Ours split `["-c", "echo hello world"]` into words, so `sh` ran only `echo`; only service containers with a shell `-c` script were affected. Upstream's `tests/container-args-test.ts` came with it.                                                                                                             |
| `run_script_step`: copy `_actions` into the job pod before each step, and copy the whole repository workspace back to the runner after each step, so local actions (`uses: ./path`) work (#280). | Declined      | A full workspace download per step; upstream's README calls it expensive for large checkouts. Our workflows reference such actions through their repository (`$/` refs); README "Known limitations" documents it. Revisit only if local actions are needed, with a cheaper design (e.g. copy back only `action.yml` files). |
| `run_script_step`: a failed copy back from the job pod fails the step instead of a warning.                                                                                                      | Ported        | Fails the step when the file commands arrive neither over HTTP nor through the API server. Also copies them back after a failed script, as upstream now does (the HTTP client uploaded them only after exit 0), so a failed step keeps its outputs and summary. Not after a lost connection or a cancel.                    |
| `run_script_step`: validates `state.jobPod` and `RUNNER_WORKSPACE`.                                                                                                                              | Declined      | Defensive checks on values the runner always sets; no failure seen.                                                                                                                                                                                                                                                         |
| `execCpFromPod`: waits for tar extraction to finish, checks the exec status, drops the 15 hash-check retries.                                                                                    | Already fixed | Fork 1.0.0 (`waitForFinish`, `settleCopyExec`, one hash comparison).                                                                                                                                                                                                                                                        |
| `getPodLogs`: propagates log stream errors and aborts the request.                                                                                                                               | N/A           | Only volume mode used it; the fork deleted it (`a1919ab`).                                                                                                                                                                                                                                                                  |
| `tsconfig.json`: `esModuleInterop` moved into `compilerOptions`.                                                                                                                                 | Declined      | Ours is misplaced the same way, but the root `tsconfig.json` sets it, so it has no effect. Fix in passing if the file is touched.                                                                                                                                                                                           |
| `packages/k8s`: volume mode again (RWX by default, `ACTIONS_RUNNER_HOOK_RWO`, node affinity), container steps as Kubernetes Jobs, `pruneJobs` on cleanup, ADR 0135.                              | N/A           | Volume mode; the fork has none.                                                                                                                                                                                                                                                                                             |
| Dev dependencies (Babel 8 back to 7), lockfiles, `packages/docker`, CI workflows, Dependabot, release notes, READMEs.                                                                            | Skipped       | Babel 7 removes the `ts-jest` peer conflict that needs `--legacy-peer-deps`; Renovate will meet the same conflict.                                                                                                                                                                                                          |
