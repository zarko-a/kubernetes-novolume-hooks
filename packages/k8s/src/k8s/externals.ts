import * as k8s from '@kubernetes/client-node'
import { Env, resolveEnvChoice } from './settings'
import { EXTERNALS_VOLUME_NAME } from './utils'

// The runner's externals (node20, node24 and their Alpine builds, ~600 MB in 9k files) are
// mounted at /__e in the job pod. Upstream has fs-init copy them out of the runner image into
// an emptyDir for every job. That writes ~600 MB to the node's root volume per job, and with a
// few job pods starting at once the volume sits at its throughput limit: containerd then times
// out tearing down finished containers (10s, then a retry), which held every job container on
// the node back by 10-15s (measured 2026-11-06). An image volume mounts the same directory
// straight from the runner image, read-only, and writes nothing.

export const EXTERNALS_ENV = 'HOOK_EXTERNALS'

export type ExternalsMode = 'image' | 'copy'

// Where the externals are in the runner image.
export const RUNNER_EXTERNALS = '/home/runner/externals'

// HOOK_EXTERNALS: `image` (default) mounts them from the runner image, which needs image
// volumes (Kubernetes 1.35+, or the ImageVolume feature gate on 1.33-1.34, and a container
// runtime that supports them, e.g. containerd 2.1+). `copy` copies them in fs-init, as
// upstream.
export function resolveExternals(
  jobEnv: Env | undefined,
  runnerEnv: Env
): { mode: ExternalsMode; source: string; warning?: string } {
  const { value, source, warning } = resolveEnvChoice<ExternalsMode>(
    EXTERNALS_ENV,
    ['image', 'copy'],
    'image',
    jobEnv,
    runnerEnv
  )
  return warning ? { mode: value, source, warning } : { mode: value, source }
}

export function externalsVolume(
  mode: ExternalsMode,
  runnerImage: string
): k8s.V1Volume {
  if (mode === 'copy') {
    return { name: EXTERNALS_VOLUME_NAME, emptyDir: {} }
  }
  // No pullPolicy: the kubelet's default (Always for :latest, IfNotPresent otherwise) is
  // what fs-init gets for the same image.
  return { name: EXTERNALS_VOLUME_NAME, image: { reference: runnerImage } }
}

// fs-init's part in providing the externals.
export function externalsInitCommands(mode: ExternalsMode): string[] {
  if (mode === 'image') {
    return []
  }
  return ['mkdir -p /mnt/externals', `mv ${RUNNER_EXTERNALS}/* /mnt/externals/`]
}

// With an image volume, every container's externals mount takes the image's externals
// directory, read-only (image volumes are always read-only). Each container gets a new mount
// list: containers share one mount array (CONTAINER_VOLUMES), which must not change.
export function mountExternalsFromImage(containers: k8s.V1Container[]): void {
  for (const container of containers) {
    container.volumeMounts = container.volumeMounts?.map(mount =>
      mount.name === EXTERNALS_VOLUME_NAME
        ? { ...mount, subPath: RUNNER_EXTERNALS.slice(1), readOnly: true }
        : mount
    )
  }
}
