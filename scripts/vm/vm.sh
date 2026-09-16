#!/usr/bin/env bash
# Local production-shaped VM. Boots the Ubuntu 22.04 cloud image under
# QEMU/KVM and provisions it with cloud-init the way Rome Cloud provisions a
# Vultr box. Commands, layout, and the fidelity limits: scripts/vm/README.md.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/vm/vm.sh <command> [options]

Commands:
  up [options]          Create (first run) and start the VM, then wait for
                        cloud-init to finish. Prints a timing breakdown.
  down                  Power the VM off (ssh poweroff, then SIGTERM).
  reset                 Power off and delete the disk. The next `up` is a
                        fresh first boot.
  build                 Build the Rome image from the current worktree and
                        push it to the host registry.
  deploy                Build, push, then pull and restart Rome in the VM.
                        The loop for changing Rome code.
  ssh [cmd...]          Open a root shell in the VM, or run a command.
  scp <src> <dst>       Copy files. Prefix the VM side with `vm:`.
  status                Running state, ports, disk, snapshots.
  console               Tail the serial console log.
  snapshot save NAME    Power off, snapshot the disk, start again.
  snapshot restore NAME Power off, roll the disk back, start again.
  snapshot list         List disk snapshots.
  print-user-data       Print the cloud-init user-data `up` would seed.

`up` options:
  --cpus N              vCPUs (default 4)
  --mem SIZE            RAM, QEMU syntax (default 8G)
  --disk SIZE           Disk size for a NEW VM (default 40G)
  --no-provision        Boot a bare Ubuntu box: SSH access only, no Rome.
  --no-build            Reuse the image already in the host registry.
  --image IMAGE         Run this image instead of building from source. Pulled
                        in the VM, so it must be reachable from there.
  --share               Expose this worktree read-only in the VM at /mnt/rome-src
  --fail2ban            Also install host sshd fail2ban, like a hosted box
  --wechat              Install the host helper and enable personal WeChat
                        (docs/wechat-personal.md). Applies to a new or an
                        existing VM, and survives `deploy`.

Environment:
  ROME_VM_SLUG          VM identity (default: scripts/worktree-slug.sh)
  ROME_VM_STATE_ROOT    State dir (default ~/.rome-vm)
  ROME_VM_IMAGE_URL     Cloud image URL (default: Ubuntu jammy amd64)
  ROME_CLOUD_DIR        rome-cloud checkout holding the deployment bundle
                        (default ~/workspace/rome-cloud)
  ROME_VM_REGISTRY_PORT Host port for the image registry singleton (default 5000)
  ROME_DOCKER_APP_CODE_MODE
                        source (default) or compiled, as in the Dockerfile
  DOCKERHUB_USERNAME / DOCKERHUB_TOKEN, CLICKHOUSE_ENDPOINT / _USERNAME /
  _PASSWORD / _DATABASE, PANTHEON_BASE_ORIGIN, PANTHEON_DOMAIN,
  ROME_INSTANCE_TOKEN   Forwarded into the VM's /opt/rome/.env when set.
USAGE
}

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

slug="${ROME_VM_SLUG:-$(scripts/worktree-slug.sh)}"
state_root="${ROME_VM_STATE_ROOT:-$HOME/.rome-vm}"
image_url="${ROME_VM_IMAGE_URL:-https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img}"
rome_cloud_dir="${ROME_CLOUD_DIR:-$HOME/workspace/rome-cloud}"

base_dir="$state_root/base"
base_image="$base_dir/$(basename "$image_url")"
vm_dir="$state_root/$slug"
disk="$vm_dir/disk.qcow2"
seed="$vm_dir/seed.iso"
pidfile="$vm_dir/qemu.pid"
console_log="$vm_dir/console.log"
ports_env="$vm_dir/ports.env"
ssh_key="$vm_dir/id_ed25519"
known_hosts="$vm_dir/known_hosts"
vm_name="rome-vm-$slug"

# Image registry singleton on the host. Every worktree VM shares it, so a
# rebuilt image moves as changed layers instead of a whole 5GB export. The
# guest reaches it at the slirp gateway, which forwards to the host loopback.
registry_name="rome-vm-registry"
registry_port="${ROME_VM_REGISTRY_PORT:-5000}"
host_registry="127.0.0.1:$registry_port"
guest_registry="10.0.2.2:$registry_port"
image_repo="rome"

die() {
  echo "vm: $*" >&2
  exit 1
}

log() {
  echo "vm: $*"
}

now_ms() {
  date +%s%3N
}

require_tools() {
  local missing=()
  for tool in qemu-system-x86_64 qemu-img cloud-localds write-mime-multipart ssh ssh-keygen curl openssl docker node; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    die "missing on PATH: ${missing[*]} — run inside \`nix develop\` (Linux devShell vendors qemu + cloud-utils)"
  fi
  [ -c /dev/kvm ] || die "/dev/kvm is missing — this host cannot run KVM guests"
  [ -r /dev/kvm ] && [ -w /dev/kvm ] || die "/dev/kvm is not readable/writable by $(id -un)"
}

# ---------------------------------------------------------------------------
# State helpers
# ---------------------------------------------------------------------------

qemu_pid() {
  [ -f "$pidfile" ] || return 1
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

is_running() {
  qemu_pid >/dev/null
}

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# Ports are derived from the slug so a VM keeps its addresses across restarts
# and sibling worktrees do not collide. Written once, on first `up`.
ensure_ports() {
  if [ -f "$ports_env" ]; then
    # shellcheck source=/dev/null
    . "$ports_env"
    return
  fi
  local hash offset
  hash="$(printf '%s' "$slug" | cksum | cut -d' ' -f1)"
  offset=$((hash % 1000))
  ssh_port=$((22000 + offset))
  http_port=$((23000 + offset))
  while port_in_use "$ssh_port" || port_in_use "$http_port"; do
    ssh_port=$((ssh_port + 1))
    http_port=$((http_port + 1))
  done
  printf 'ssh_port=%s\nhttp_port=%s\n' "$ssh_port" "$http_port" >"$ports_env"
}

ensure_ssh_key() {
  if [ ! -f "$ssh_key" ]; then
    ssh-keygen -q -t ed25519 -N "" -C "$vm_name" -f "$ssh_key"
  fi
}

ensure_base_image() {
  mkdir -p "$base_dir"
  if [ -f "$base_image" ]; then
    return
  fi
  log "downloading $(basename "$image_url") ..."
  curl -fSL --retry 3 -o "$base_image.part" "$image_url"
  mv "$base_image.part" "$base_image"
}

ensure_registry() {
  if [ -n "$(docker ps -q --filter "name=^${registry_name}$" 2>/dev/null)" ]; then
    return
  fi
  if [ -n "$(docker ps -aq --filter "name=^${registry_name}$" 2>/dev/null)" ]; then
    docker start "$registry_name" >/dev/null
    return
  fi
  log "starting the image registry ($registry_name on $host_registry) ..."
  docker run -d --name "$registry_name" --restart unless-stopped \
    -p "$host_registry:5000" \
    -v "$registry_name:/var/lib/registry" \
    registry:2 >/dev/null
}

# Builds the image the way CI builds the published one: the prepared runtime
# workspace as context, not the repository root. The two differ — the prepared
# context drops packages the runtime never loads — so building from the root
# would test an image nobody ships.
build_and_push() {
  local tag="$host_registry/$image_repo:$slug"
  log "preparing the runtime build context ..."
  node scripts/docker/prepare-runtime-workspace.mjs
  log "building $image_repo:$slug from this worktree (mode: $app_code_mode) ..."
  docker build \
    --file .docker/rome-runtime-workspace/Dockerfile \
    --tag "$tag" \
    --build-arg "ROME_DOCKER_APP_CODE_MODE=$app_code_mode" \
    --build-arg "ROME_BUILD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    --build-arg "ROME_BUILD_TIME=$(date -u +%FT%TZ)" \
    .docker/rome-runtime-workspace
  ensure_registry
  log "pushing to $tag ..."
  docker push --quiet "$tag" >/dev/null
}

vm_ssh() {
  ssh -p "$ssh_port" -i "$ssh_key" \
    -o BatchMode=yes -o ConnectTimeout=3 \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile="$known_hosts" \
    -o LogLevel=ERROR \
    "root@127.0.0.1" "$@"
}

# ---------------------------------------------------------------------------
# cloud-init seed
# ---------------------------------------------------------------------------

provision=1
share=0
fail2ban=0
cpus="${ROME_VM_CPUS:-4}"
mem="${ROME_VM_MEM:-8G}"
disk_size="${ROME_VM_DISK:-40G}"
app_code_mode="${ROME_DOCKER_APP_CODE_MODE:-source}"
build_image=1
wechat=0
# Default: whatever `build` last pushed for this worktree. --image replaces it.
rome_image="$guest_registry/$image_repo:$slug"

bundle_file() {
  local rel="$1"
  local path="$rome_cloud_dir/packages/pantheon/deployment/$rel"
  [ -f "$path" ] || die "deployment bundle file missing: $path (set ROME_CLOUD_DIR to a rome-cloud checkout)"
  printf '%s' "$path"
}

write_file_entry() {
  local path="$1" mode="$2" src="$3"
  printf -- '  - path: %s\n    permissions: "%s"\n    encoding: b64\n    content: %s\n' \
    "$path" "$mode" "$(base64 -w0 <"$src")"
}

render_cloud_config() {
  local pubkey
  pubkey="$(cat "$ssh_key.pub")"
  cat <<YAML
#cloud-config
hostname: $vm_name
manage_etc_hosts: true
disable_root: false
ssh_pwauth: false
ssh_authorized_keys:
  - $pubkey
users:
  - default
  - name: root
    ssh_authorized_keys:
      - $pubkey
YAML
  if [ "$share" -eq 1 ]; then
    cat <<'YAML'
mounts:
  - [rome-src, /mnt/rome-src, 9p, "trans=virtio,version=9p2000.L,ro,nofail", "0", "0"]
YAML
  fi
  if [ "$provision" -eq 1 ]; then
    local env_file
    env_file="$(mktemp)"
    {
      echo "ROME_VM_SLUG=$slug"
      echo "ROME_DOCKER_IMAGE=$rome_image"
      echo "PANTHEON_INSTANCE_ORIGIN=${PANTHEON_INSTANCE_ORIGIN:-http://localhost:$http_port}"
      echo "ROME_VM_HOST_FAIL2BAN=$fail2ban"
      # Plain HTTP on the slirp gateway; the guest daemon rejects it otherwise.
      case "$rome_image" in
        "$guest_registry"/*) echo "ROME_VM_INSECURE_REGISTRY=$guest_registry" ;;
      esac
      for var in PANTHEON_BASE_ORIGIN PANTHEON_DOMAIN ROME_INSTANCE_TOKEN \
        DOCKERHUB_USERNAME DOCKERHUB_TOKEN STATSIG_SERVER_SECRET_KEY \
        CLICKHOUSE_ENDPOINT CLICKHOUSE_USERNAME CLICKHOUSE_PASSWORD CLICKHOUSE_DATABASE \
        PANTHEON_SSH_PUBLIC_KEY; do
        if [ -n "${!var:-}" ]; then
          echo "$var=${!var}"
        fi
      done
    } >"$env_file"
    echo "write_files:"
    write_file_entry /etc/rome-vm/provision.env "0600" "$env_file"
    write_file_entry /opt/rome/docker-compose.yml "0644" "$(bundle_file docker-compose.yml)"
    write_file_entry /opt/rome/otel-collector-config.yaml "0644" "$(bundle_file otel-collector-config.yaml)"
    rm -f "$env_file"
  fi
}

render_user_data() {
  local tmp cc
  tmp="$(mktemp -d)"
  cc="$tmp/cloud-config.yaml"
  render_cloud_config >"$cc"
  if [ "$provision" -eq 1 ]; then
    write-mime-multipart --output="$tmp/user-data" \
      "$cc:text/cloud-config" \
      "scripts/vm/provision/rome-host.sh:text/x-shellscript" >/dev/null
    cat "$tmp/user-data"
  else
    cat "$cc"
  fi
  rm -rf "$tmp"
}

build_seed() {
  local tmp
  tmp="$(mktemp -d)"
  render_user_data >"$tmp/user-data"
  printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$vm_name" "$(date +%s)" "$vm_name" >"$tmp/meta-data"
  cloud-localds "$seed" "$tmp/user-data" "$tmp/meta-data"
  rm -rf "$tmp"
}

# ---------------------------------------------------------------------------
# Personal WeChat
# ---------------------------------------------------------------------------

# Personal WeChat needs a root host helper on the VM and a Rome container that
# can reach its socket (docs/wechat-personal.md). Rome Cloud installs both from
# its deployment bundle. Here the helper is built from this worktree and the
# container settings go in a compose override, which `deploy` keeps.
install_wechat() {
  command -v go >/dev/null 2>&1 || die "go is missing on PATH — run inside \`nix develop\`"
  log "building the host helper ..."
  (cd packages/host-helper && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o dist/rome-hostd ./cmd/rome-hostd)
  # A running helper holds its binary open, so upload beside it and rename.
  cmd_scp packages/host-helper/dist/rome-hostd vm:/usr/local/bin/.rome-hostd.new
  log "installing the host helper and enabling WeChat ..."
  # ROME_DOCKER_USER_MODE=root runs the backend as root, so root's group owns
  # the socket. WeChat needs root mode for the client and the reader to share
  # files under /home/rome.
  vm_ssh "bash -s" <<EOF
set -euo pipefail
chmod 755 /usr/local/bin/.rome-hostd.new
mv /usr/local/bin/.rome-hostd.new /usr/local/bin/rome-hostd
mkdir -p /etc/rome-host
cat >/etc/rome-host/config.json <<'JSON'
{"hostId":"$slug","enabled":true,"socketPath":"/run/rome-host/control.sock","stateDir":"/var/lib/rome-host","socketGid":0,"maxTimeoutSeconds":600,"maxOutputBytes":131072}
JSON
chmod 644 /etc/rome-host/config.json
cat >/etc/systemd/system/rome-hostd.service <<'UNIT'
[Unit]
Description=Rome host helper
After=network.target
# The socket directory lives on /run. It must exist before Docker restores the
# container that mounts it.
Before=docker.service

[Service]
ExecStart=/usr/local/bin/rome-hostd --config /etc/rome-host/config.json
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable rome-hostd >/dev/null 2>&1
systemctl restart rome-hostd
for _ in \$(seq 1 30); do
  [ -S /run/rome-host/control.sock ] && break
  sleep 1
done
[ -S /run/rome-host/control.sock ] || { echo "rome-hostd did not create its socket" >&2; exit 1; }
cat >/opt/rome/docker-compose.override.yml <<'YAML'
services:
  rome:
    shm_size: 1gb
    environment:
      WECHAT_USER_ENABLED: "true"
      ROME_HOST_EXECUTION_ENABLED: "true"
      ROME_HOST_EXECUTION_SOCKET: /run/rome-host/control.sock
      ROME_DOCKER_USER_MODE: root
    volumes:
      - /run/rome-host:/run/rome-host
YAML
cd /opt/rome
docker compose --project-name rome up -d
EOF
  wait_for_rome
}

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

start_qemu() {
  # shellcheck disable=SC2054 # commas are QEMU option syntax, not separators
  local args=(
    -name "$vm_name"
    -machine q35,accel=kvm
    -cpu host
    -smp "$cpus"
    -m "$mem"
    -drive "file=$disk,if=virtio,format=qcow2,discard=unmap"
    -drive "file=$seed,if=virtio,format=raw,readonly=on"
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$ssh_port-:22,hostfwd=tcp:127.0.0.1:$http_port-:8080"
    -device virtio-net-pci,netdev=net0
    -device virtio-rng-pci
    -display none
    -serial "file:$console_log"
    -daemonize
    -pidfile "$pidfile"
  )
  if [ "$share" -eq 1 ]; then
    args+=(-virtfs "local,path=$repo_root,mount_tag=rome-src,security_model=none,readonly=on")
  fi
  : >"$console_log"
  qemu-system-x86_64 "${args[@]}"
}

wait_for_ssh() {
  local deadline=$(($(date +%s) + 300))
  while ! vm_ssh true 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      die "ssh did not come up within 300s — see $console_log"
    fi
    is_running || die "qemu exited during boot — see $console_log"
    sleep 1
  done
}

wait_for_cloud_init() {
  # `--wait` exits 0 when done, 2 when done with recoverable errors, 1 on
  # failure. Both 0 and 2 mean the box is up, so report and continue.
  local status=0
  vm_ssh cloud-init status --wait --long || status=$?
  case "$status" in
    0 | 2) ;;
    *) die "cloud-init failed (exit $status) — inspect with: scripts/vm/vm.sh ssh cat /var/log/cloud-init-output.log" ;;
  esac
}

# `docker compose up -d` returns once the container starts, but the entrypoint
# then rsyncs /opt/rome to /app before the daemon boots. That takes minutes on
# a new image, so a command that returned at `up -d` would report a deploy that
# is not yet serving. Poll the dashboard instead: Caddy answers 502 until the
# backend is listening.
wait_for_rome() {
  local timeout="${1:-600}"
  local deadline=$(($(date +%s) + timeout))
  local code=""
  while :; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 "http://127.0.0.1:$http_port/" || true)"
    if [ "$code" = "200" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "Rome did not answer on :$http_port within ${timeout}s (last status: ${code:-none})."
      log "Inspect: scripts/vm/vm.sh ssh docker logs rome-rome-1"
      return 1
    fi
    is_running || die "qemu exited while waiting for Rome — see $console_log"
    sleep 3
  done
}

cmd_up() {
  local fresh=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --cpus) cpus="${2:?}" && shift 2 ;;
      --mem) mem="${2:?}" && shift 2 ;;
      --disk) disk_size="${2:?}" && shift 2 ;;
      --image) rome_image="${2:?}" && build_image=0 && shift 2 ;;
      --no-build) build_image=0 && shift ;;
      --no-provision) provision=0 && shift ;;
      --share) share=1 && shift ;;
      --fail2ban) fail2ban=1 && shift ;;
      --wechat) wechat=1 && shift ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown option for up: $1" ;;
    esac
  done
  require_tools
  if [ "$wechat" -eq 1 ] && [ "$provision" -eq 0 ]; then
    die "--wechat needs a provisioned VM"
  fi
  mkdir -p "$vm_dir"
  ensure_ports
  ensure_ssh_key
  if is_running; then
    log "$vm_name already running (pid $(qemu_pid)); ssh -p $ssh_port, http://127.0.0.1:$http_port"
    if [ "$wechat" -eq 1 ]; then
      install_wechat
    fi
    return
  fi
  # Only a first boot pulls an image, so only a first boot builds one. Code
  # changes reach an existing VM through `deploy`. Build before the disk
  # exists, so a failed build leaves no half-made VM behind.
  if [ ! -f "$disk" ]; then
    fresh=1
    if [ "$provision" -eq 1 ]; then
      if [ "$build_image" -eq 1 ]; then
        build_and_push
      else
        ensure_registry
      fi
    fi
    ensure_base_image
    qemu-img create -q -f qcow2 -b "$base_image" -F qcow2 "$disk" "$disk_size"
    build_seed
    rm -f "$known_hosts"
  fi

  local t0 t_ssh t_done
  t0="$(now_ms)"
  start_qemu
  log "started $vm_name (pid $(qemu_pid)), ssh -p $ssh_port, waiting for ssh ..."
  wait_for_ssh
  t_ssh="$(now_ms)"
  log "ssh up after $(((t_ssh - t0) / 1000))s; waiting for cloud-init ..."
  wait_for_cloud_init
  if [ "$provision" -eq 1 ]; then
    log "cloud-init done; waiting for Rome to serve ..."
    wait_for_rome || true
  fi
  if [ "$wechat" -eq 1 ]; then
    install_wechat
  fi
  t_done="$(now_ms)"

  echo
  echo "$vm_name is up."
  echo "  ssh:        scripts/vm/vm.sh ssh"
  echo "  dashboard:  http://127.0.0.1:$http_port  (tailscale serve --bg --https=8443 $http_port)"
  echo "  image:      $rome_image"
  echo "  console:    $console_log"
  echo
  echo "Timing (this boot):"
  printf '  qemu start → ssh ready       %6ss\n' "$(((t_ssh - t0) / 1000))"
  printf '  ssh ready  → Rome serving     %6ss\n' "$(((t_done - t_ssh) / 1000))"
  printf '  total                        %6ss\n' "$(((t_done - t0) / 1000))"
  if [ "$fresh" -eq 1 ] && [ "$provision" -eq 1 ]; then
    echo
    echo "Provisioning steps (from the VM):"
    vm_ssh 'grep "^\[rome-vm\]" /var/log/cloud-init-output.log' || true
    echo
    echo "cloud-init blame (top 5):"
    vm_ssh 'cloud-init analyze blame | head -6' || true
  fi
}

power_off() {
  local pid
  pid="$(qemu_pid || true)"
  [ -n "$pid" ] || return 0
  vm_ssh poweroff >/dev/null 2>&1 || true
  local deadline=$(($(date +%s) + 60))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "guest did not power off in 60s, terminating qemu"
      kill "$pid" 2>/dev/null || true
      sleep 1
      break
    fi
    sleep 1
  done
  rm -f "$pidfile"
}

cmd_down() {
  ensure_ports
  if ! is_running; then
    log "$vm_name is not running"
    return
  fi
  power_off
  log "$vm_name stopped"
}

cmd_reset() {
  ensure_ports
  power_off
  rm -f "$disk" "$seed" "$known_hosts"
  log "$vm_name disk removed; next \`up\` is a fresh first boot"
}

cmd_ssh() {
  ensure_ports
  is_running || die "$vm_name is not running"
  if [ $# -eq 0 ]; then
    vm_ssh -t
  else
    vm_ssh "$@"
  fi
}

cmd_scp() {
  ensure_ports
  is_running || die "$vm_name is not running"
  [ $# -eq 2 ] || die "scp needs exactly <src> <dst>"
  local src="${1/#vm:/root@127.0.0.1:}" dst="${2/#vm:/root@127.0.0.1:}"
  scp -P "$ssh_port" -i "$ssh_key" -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile="$known_hosts" -o LogLevel=ERROR -r "$src" "$dst"
}

cmd_status() {
  ensure_ports
  echo "vm:        $vm_name"
  echo "state dir: $vm_dir"
  if is_running; then
    echo "running:   yes (pid $(qemu_pid))"
  else
    echo "running:   no"
  fi
  echo "ssh:       127.0.0.1:$ssh_port"
  echo "http:      127.0.0.1:$http_port → guest 8080"
  if [ -f "$disk" ]; then
    qemu-img info -U "$disk" | awk -F': ' '/^virtual size/{v=$2} /^disk size/{u=$2} END{print "disk:      " u " used of " v}'
    echo "snapshots:"
    qemu-img snapshot -l -U "$disk" | tail -n +3 | awk '{print "  " $2}' || true
  else
    echo "disk:      none (never booted)"
  fi
}

cmd_console() {
  [ -f "$console_log" ] || die "no console log yet"
  tail -n 100 -f "$console_log"
}

cmd_snapshot() {
  ensure_ports
  local action="${1:-}" name="${2:-}"
  [ -f "$disk" ] || die "no disk yet — run \`up\` first"
  case "$action" in
    list)
      qemu-img snapshot -l -U "$disk"
      ;;
    save | restore)
      [ -n "$name" ] || die "snapshot $action needs a NAME"
      local was_running=0
      is_running && was_running=1
      power_off
      if [ "$action" = save ]; then
        qemu-img snapshot -c "$name" "$disk"
        log "snapshot '$name' saved"
      else
        qemu-img snapshot -a "$name" "$disk"
        rm -f "$known_hosts"
        log "disk rolled back to '$name'"
      fi
      if [ "$was_running" -eq 1 ]; then
        local t0
        t0="$(now_ms)"
        start_qemu
        wait_for_ssh
        log "$vm_name back up, ssh ready after $((($(now_ms) - t0) / 1000))s"
      fi
      ;;
    *)
      die "snapshot needs save|restore|list"
      ;;
  esac
}

cmd_build() {
  require_tools
  mkdir -p "$vm_dir"
  ensure_ports
  build_and_push
  log "pushed. Apply it to a running VM with: scripts/vm/vm.sh deploy"
}

cmd_deploy() {
  require_tools
  ensure_ports
  is_running || die "$vm_name is not running — start it with \`up\`"
  build_and_push
  local t0
  t0="$(now_ms)"
  log "pulling the image in the VM and restarting Rome ..."
  vm_ssh "set -e; cd /opt/rome; docker pull '$guest_registry/$image_repo:$slug'; docker compose --project-name rome up -d"
  log "restarted; waiting for Rome to serve the new image ..."
  wait_for_rome
  log "deployed in $((($(now_ms) - t0) / 1000))s; dashboard http://127.0.0.1:$http_port"
}

cmd_print_user_data() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-provision) provision=0 && shift ;;
      --share) share=1 && shift ;;
      --fail2ban) fail2ban=1 && shift ;;
      --image) rome_image="${2:?}" && shift 2 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  mkdir -p "$vm_dir"
  ensure_ports
  ensure_ssh_key
  render_user_data
}

command="${1:-}"
shift || true
case "$command" in
  up) cmd_up "$@" ;;
  build) cmd_build ;;
  deploy) cmd_deploy ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  ssh) cmd_ssh "$@" ;;
  scp) cmd_scp "$@" ;;
  status) cmd_status ;;
  console) cmd_console ;;
  snapshot) cmd_snapshot "$@" ;;
  print-user-data) cmd_print_user_data "$@" ;;
  -h | --help | help | "") usage ;;
  *) die "unknown command: $command" ;;
esac
