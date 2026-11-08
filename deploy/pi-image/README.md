# Pi agent image

The container one steward job runs its agent in. `src/runner/pi-command.ts` builds the
`podman run` arguments that use it.

Build:

    podman build -t steward-pi:1.5.0 deploy/pi-image

It contains Node 22 on Debian bookworm, `git`, `ripgrep`, `bash`, `ca-certificates`, and Pi
1.5.0 plus pnpm 10 installed globally from npm. Nothing else: no GitHub or tracker client, no
SSH keys, no credentials. The model key is passed by name at run time (`podman run -e
ANTHROPIC_API_KEY ...`), so the image holds no secret and the key is not in the argument list.
Rebuild the image when the pin in `Containerfile` changes, and change the tag with it.

On a box where Podman's default rootless network (pasta) passes no traffic, build with
`podman build --network=slirp4netns -t steward-pi:1.5.0 deploy/pi-image` (verified 2026-11-08). The run
command already uses `--network=slirp4netns`.
