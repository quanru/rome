# Local production VM

`scripts/vm/vm.sh` boots a production-shaped VM on a Linux host with KVM. The guest is the Ubuntu 22.04 cloud image, the same OS Rome Cloud provisions on Vultr. cloud-init provisions it with `provision/rome-host.sh`, which follows the hosted cloud-init script step for step: Docker install, metadata block, `/opt/rome` with the deployment bundle, image pull, `docker compose up`.

Use it to develop anything that lives on the host rather than inside the Rome container: the provisioning script, systemd units, the host helper install, Docker daemon settings, upgrade procedures. For work inside the container, `pnpm dev:all` is the faster loop.

## Commands

```sh
pnpm vm up              # build the image, create + start, wait for cloud-init
pnpm vm deploy          # rebuild and restart Rome in a running VM
pnpm vm build           # rebuild and push, without touching the VM
pnpm vm ssh             # root shell in the guest
pnpm vm ssh docker ps   # run one command
pnpm vm status
pnpm vm down
pnpm vm reset           # delete the disk; next `up` is a fresh first boot
pnpm vm snapshot save provisioned
pnpm vm snapshot restore provisioned
pnpm vm print-user-data # inspect the cloud-init seed without booting
```

Run them inside `nix develop`. The Linux devShell vendors `qemu_kvm` and `cloud-utils`. The host Docker CLI and `node` come from the host, as elsewhere in this repo.

## The image

`up` and `deploy` build the Rome image from the current worktree, the way CI builds the published one: `scripts/docker/prepare-runtime-workspace.mjs` writes the `.docker/rome-runtime-workspace` context, and the build runs against that rather than the repository root. `ROME_DOCKER_APP_CODE_MODE` picks `source` (default) or `compiled`.

The image reaches the guest through a registry container on the host, `rome-vm-registry` on `127.0.0.1:5000`. Every worktree VM shares it. The guest pulls from `10.0.2.2:5000`, the address the QEMU user-network gateway forwards to the host loopback, and its Docker daemon is configured to accept plain HTTP there. Only changed layers move, so a rebuild after a source edit transfers far less than the whole image.

Two ways out of building:

- `--no-build` reuses whatever the registry already holds for this worktree.
- `--image IMAGE` runs a published image instead, for example `--image yunfanye/rome:latest`. The guest pulls it, so it has to be reachable from there.

## Two loops

Changing host-level code — the provisioning script, a systemd unit, the host helper install — means re-running provisioning, so `pnpm vm reset && pnpm vm up`.

Changing Rome code means a new image in a VM that is already provisioned, so `pnpm vm deploy`. It builds, pushes, pulls in the guest, and runs `docker compose up -d`.

## Personal WeChat

[Personal WeChat](../../docs/wechat-personal.md) needs an x86-64 Linux VM with the host helper, so a Mac or a plain `pnpm dev:all` container cannot run it. `pnpm vm up --wechat` adds what the connection needs on top of provisioning:

- builds `rome-hostd` from this worktree and installs it as the `rome-hostd` systemd unit, with the socket at `/run/rome-host/control.sock`
- writes `/opt/rome/docker-compose.override.yml`, which mounts the socket, sets the WeChat and host execution flags, runs the backend as root, and gives the container 1 GB of shared memory
- restarts Rome and waits for the dashboard

The flag also applies to a VM that is already running. The override stays on the VM, so `pnpm vm deploy` keeps WeChat enabled, and `pnpm vm reset` removes it.

Then open the dashboard and follow [Connect](../../docs/wechat-personal.md#connect). The helper runs root scripts from the container by design. Use a VM whose host holds nothing else you would not hand to Rome.

## Layout

State lives under `~/.rome-vm/`:

- `base/` holds the downloaded cloud image, shared by every VM.
- `<slug>/` holds one VM: `disk.qcow2` (overlay on the base image), `seed.iso` (cloud-init NoCloud seed), an ed25519 key pair for root SSH, `console.log`, and `ports.env`.

The slug is the worktree slug from `scripts/worktree-slug.sh`, so sibling worktrees get separate VMs. Override with `ROME_VM_SLUG`.

The guest uses QEMU user networking. Nothing is bridged and no root is needed on the host. Two ports are forwarded to the host loopback, derived from the slug so they stay stable: guest 22 and guest 8080. `pnpm vm status` prints them. To reach the dashboard from another device, publish the http port with `tailscale serve`.

## Provisioning inputs

`up` reads the deployment bundle from a rome-cloud checkout at `ROME_CLOUD_DIR` (default `~/workspace/rome-cloud`), path `packages/pantheon/deployment/`. The bundle's `docker-compose.yml` and `otel-collector-config.yaml` land in `/opt/rome` through cloud-config `write_files`.

The guest's `/opt/rome/.env` mirrors the hosted one. Values come from the host shell when set: `PANTHEON_BASE_ORIGIN`, `PANTHEON_DOMAIN`, `ROME_INSTANCE_TOKEN`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`, `STATSIG_SERVER_SECRET_KEY`, `CLICKHOUSE_*`. Without Docker Hub credentials the pull is anonymous. Without ClickHouse credentials the otel-collector crash-loops. Rome does not depend on it.

## What it costs

Measured on a 32-core host with KVM, 4 vCPU and 8G for the guest.

| Step | Time |
| --- | --- |
| First build and push, cold layer cache | 2m19s |
| `up` on a fresh VM, warm build cache | 3m20s |
| The VM part of that: boot, provision, Rome serving | 63s |
| `deploy` after a one-line source change | 3m23s |
| The VM part of that: pull, restart, Rome serving | 38s |
| `down` then `up` on an existing VM | 8s |
| `snapshot restore` | 13s |

The build dominates both loops. One layer carries the whole built tree, so any source edit rewrites about 1.8GB of it, and that cost lands on every rebuild, push, and pull.

`up` and `deploy` both wait until the dashboard answers before they return. The container starts well before that: the entrypoint copies the image into the `/app` volume first, which is most of the wait on a new image.

## Fidelity limits

- cloud-init runs on first boot only. A change to `provision/rome-host.sh` needs `pnpm vm reset` and `pnpm vm up`, or run the script by hand over `pnpm vm ssh`.
- The hosted box also receives a baked `upgrade.sh` and Pantheon's SSH key. The VM gets the key only when `PANTHEON_SSH_PUBLIC_KEY` is set, and no `upgrade.sh`.
- There is no metadata service in the guest. The `DOCKER-USER` rule installs, but blocks nothing.
- User networking has no inbound path. Tailscale inside the Rome container works in userspace mode, as on the hosted box.

## Speeding up the first boot

Take a disk snapshot once provisioning is done. `snapshot restore` powers off, rolls back, and boots again, so a clean, provisioned box is a restart away rather than a full re-provision.
