#!/bin/bash
# Host-layer provisioning for a local Rome VM. Mirrors the cloud-init script
# Rome Cloud generates for a hosted box (rome-cloud:
# packages/pantheon/src/lib/cloud-init.ts) step for step, so a change to the
# host setup is developed here and then ported there. Two deliberate gaps:
# the compose bundle arrives via cloud-config write_files instead of inline
# heredocs, and the baked upgrade.sh is not reproduced.
#
# Runs as root under cloud-init's x-shellscript handler. Parameters come from
# /etc/rome-vm/provision.env, written by scripts/vm/vm.sh.
set -euo pipefail

step() {
  echo "[rome-vm] $(date -u +%FT%TZ) $*"
}

if [ -f /etc/rome-vm/provision.env ]; then
  set -a
  # shellcheck source=/dev/null
  . /etc/rome-vm/provision.env
  set +a
fi

step "start"

# First boot races unattended-upgrades for the dpkg lock; make every apt call
# wait instead of failing under `set -e`. Same guard as the hosted script.
if [ -d /etc/apt/apt.conf.d ]; then
  echo 'DPkg::Lock::Timeout "600";' >/etc/apt/apt.conf.d/99rome-dpkg-lock-timeout
fi

if ! command -v curl &>/dev/null; then
  apt-get update && apt-get install -y curl
fi

if [ "${ROME_VM_HOST_FAIL2BAN:-0}" = "1" ]; then
  step "fail2ban install"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y fail2ban
  mkdir -p /etc/fail2ban/jail.d /etc/fail2ban/fail2ban.d
  cat >/etc/fail2ban/jail.d/rome-sshd.local <<'FAIL2BANJAIL'
[sshd]
enabled = true
backend = systemd
journalmatch = _SYSTEMD_UNIT=ssh.service + _COMM=sshd
port = ssh
maxretry = 5
findtime = 86400
bantime = 604800
ignoreip = 127.0.0.1/8 ::1
FAIL2BANJAIL
  cat >/etc/fail2ban/fail2ban.d/rome.local <<'FAIL2BANCONFIG'
[Definition]
dbpurgeage = 691200
FAIL2BANCONFIG
  fail2ban-client -t
  systemctl enable fail2ban
  systemctl restart fail2ban
  for _ in $(seq 1 30); do
    if fail2ban-client status sshd >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  fail2ban-client status sshd
fi

# Written before the daemon starts, so the install picks it up and no restart
# is needed. The host registry speaks plain HTTP, which the daemon refuses
# without this. A hosted box pulls from Docker Hub over TLS and has no
# equivalent; this is the one provisioning step with no hosted counterpart.
if [ -n "${ROME_VM_INSECURE_REGISTRY:-}" ]; then
  step "trust host registry ${ROME_VM_INSECURE_REGISTRY}"
  mkdir -p /etc/docker
  cat >/etc/docker/daemon.json <<DAEMONEOF
{ "insecure-registries": ["${ROME_VM_INSECURE_REGISTRY}"] }
DAEMONEOF
fi

step "docker install"
if ! docker info &>/dev/null 2>&1; then
  if ! command -v docker &>/dev/null; then
    curl -fsSL https://get.docker.com | sh
  fi
  dockerd &
  for _ in $(seq 1 30); do
    if docker info &>/dev/null; then break; fi
    sleep 1
  done
fi

step "metadata block"
# Same DOCKER-USER rule as the hosted box. Under QEMU user networking there is
# no metadata service, so the rule only proves the mechanism applies cleanly.
if command -v iptables >/dev/null 2>&1; then
  iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null ||
    iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
  if command -v systemctl >/dev/null 2>&1; then
    cat >/etc/systemd/system/rome-block-metadata.service <<'METAEOF'
[Unit]
Description=Block container egress to instance metadata endpoint
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/bin/sh -c "iptables -C DOCKER-USER -d 169.254.169.254 -j DROP 2>/dev/null || iptables -I DOCKER-USER -d 169.254.169.254 -j DROP"
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
METAEOF
    systemctl daemon-reload
    systemctl enable rome-block-metadata.service
  fi
fi

if [ -n "${PANTHEON_SSH_PUBLIC_KEY:-}" ]; then
  mkdir -p /root/.ssh
  chmod 700 /root/.ssh
  echo "$PANTHEON_SSH_PUBLIC_KEY" >>/root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
fi

step "write /opt/rome"
mkdir -p /opt/rome
cd /opt/rome
for bundle_file in docker-compose.yml otel-collector-config.yaml; do
  if [ ! -f "/opt/rome/$bundle_file" ]; then
    echo "[rome-vm] missing /opt/rome/$bundle_file (expected from cloud-config write_files)" >&2
    exit 1
  fi
done

ROME_DOCKER_IMAGE="${ROME_DOCKER_IMAGE:?ROME_DOCKER_IMAGE is required}"
PANTHEON_DOMAIN="${PANTHEON_DOMAIN:-localhost}"
PANTHEON_BASE_ORIGIN="${PANTHEON_BASE_ORIGIN:-https://romeos.cc}"
PANTHEON_SLUG="${ROME_VM_SLUG:-rome-vm}"

cat >.env <<ENVEOF
ROME_JWT_SECRET=$(openssl rand -hex 32)
ROME_OAUTH_TOKEN_ENCRYPTION_KEY=$(openssl rand -hex 32)
PANTHEON_SLUG=${PANTHEON_SLUG}
PANTHEON_DOMAIN=${PANTHEON_DOMAIN}
PANTHEON_BASE_ORIGIN=${PANTHEON_BASE_ORIGIN}
PANTHEON_INSTANCE_ORIGIN=${PANTHEON_INSTANCE_ORIGIN:-http://localhost:8080}
${ROME_INSTANCE_TOKEN:+ROME_INSTANCE_TOKEN=${ROME_INSTANCE_TOKEN}}
${ROME_CHROME_TIMEZONE:+ROME_CHROME_TIMEZONE=${ROME_CHROME_TIMEZONE}}
${STATSIG_SERVER_SECRET_KEY:+STATSIG_SERVER_SECRET_KEY=${STATSIG_SERVER_SECRET_KEY}}
ROME_DOCKER_IMAGE=${ROME_DOCKER_IMAGE}
DOCKERHUB_USERNAME=${DOCKERHUB_USERNAME:-}
DOCKERHUB_TOKEN=${DOCKERHUB_TOKEN:-}
ENVEOF
chmod 600 .env

# The hosted script refuses to provision without ClickHouse credentials. A
# local VM has none by default, so the collector crash-loops until you export
# CLICKHOUSE_* before `up`. Rome does not depend on it and boots regardless.
cat >.env.collector <<COLLECTORENVEOF
CLICKHOUSE_ENDPOINT=${CLICKHOUSE_ENDPOINT:-}
CLICKHOUSE_USERNAME=${CLICKHOUSE_USERNAME:-}
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD:-}
CLICKHOUSE_DATABASE=${CLICKHOUSE_DATABASE:-}
COLLECTORENVEOF
chmod 600 .env.collector

step "docker pull ${ROME_DOCKER_IMAGE}"
set -a
# shellcheck source=/dev/null
source /opt/rome/.env
set +a
if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  echo "$DOCKERHUB_TOKEN" | docker login -u "$DOCKERHUB_USERNAME" --password-stdin
fi
docker pull "$ROME_DOCKER_IMAGE"
if [ -n "${DOCKERHUB_USERNAME:-}" ] && [ -n "${DOCKERHUB_TOKEN:-}" ]; then
  docker logout
fi

step "docker compose up"
docker compose --project-name rome up -d

step "done"
