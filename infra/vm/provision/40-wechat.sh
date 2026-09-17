#!/bin/bash
# Host helper + personal WeChat (docs/wechat-personal.md). Runs when the
# /etc/rome-host/wechat marker exists. A new rome-hostd binary is staged at
# /etc/rome-host/rome-hostd by the runner; a running helper holds its binary
# open, so it is installed beside and renamed over the old one.
set -euo pipefail
files=/etc/rome-host/files
if [[ -f /etc/rome-host/rome-hostd ]]; then
  install -m 0755 /etc/rome-host/rome-hostd /usr/local/bin/.rome-hostd.new
  mv /usr/local/bin/.rome-hostd.new /usr/local/bin/rome-hostd
  rm -f /etc/rome-host/rome-hostd
fi
test -x /usr/local/bin/rome-hostd
install -m 0644 "$files/rome-host-config.json" /etc/rome-host/config.json
install -m 0644 "$files/rome-hostd.service" /etc/systemd/system/rome-hostd.service
install -m 0644 "$files/docker-compose.override.wechat.yml" /opt/rome/docker-compose.override.yml
mkdir -p /var/lib/rome-host && chmod 700 /var/lib/rome-host
systemctl enable rome-hostd.service >/dev/null 2>&1
