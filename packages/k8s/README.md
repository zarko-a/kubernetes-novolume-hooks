# The hook package

The source of the `kubernetes-novolume` hook bundle. It builds into one file,
`dist/index.js`, which replaces `/home/runner/k8s-novolume/index.js` in the runner image.

Everything about using it is in the [root README](../../README.md): how it works, the
settings, the Role rules the runner's service account needs, what it was tested with, and its
limitations.

## Building and testing

npm runs in a container, never on the host (see `scripts/container-npm.sh` in the repository
root, which uses the `Dockerfile`'s builder image):

```sh
scripts/container-npm.sh packages/hooklib npm ci
scripts/container-npm.sh packages/k8s npm ci
scripts/container-npm.sh packages/hooklib npm run build
scripts/container-npm.sh packages/k8s npm run build
scripts/container-npm.sh packages/k8s npm run test:unit
```

`test:unit` runs every test that needs no cluster, and the `Dockerfile` runs it on every image
build. The other test files are upstream's and need a kind cluster.
