#!/bin/bash
# Docker Engine at the pinned version, plus fail2ban. Versions come from
# /etc/rome-host/pins.env.
set -euo pipefail
. /etc/rome-host/pins.env
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release

if ! dpkg -s docker-ce 2>/dev/null | grep -q "^Version: ${DOCKER_CE_VERSION}$"; then
  apt-get update
  apt-get install -y --no-install-recommends ca-certificates curl gnupg fail2ban
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-mark unhold docker-ce docker-ce-cli docker-compose-plugin 2>/dev/null || true
  apt-get install -y --no-install-recommends --allow-downgrades \
    "docker-ce=${DOCKER_CE_VERSION}" \
    "docker-ce-cli=${DOCKER_CE_VERSION}" \
    containerd.io \
    "docker-compose-plugin=${DOCKER_COMPOSE_PLUGIN_VERSION}"
  apt-get clean
  rm -rf /var/lib/apt/lists/*
fi
# Hold so an unattended-upgrades run cannot move the engine off the pin.
apt-mark hold docker-ce docker-ce-cli docker-compose-plugin >/dev/null
systemctl enable docker >/dev/null 2>&1
