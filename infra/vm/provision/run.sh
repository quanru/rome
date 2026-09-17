#!/bin/bash
# Runs every provision step in order. One entry point for both runners:
#
#   build  virt-customize runs it inside the disk image while building. Ends
#          by sealing the image (identity scrub) so it can be cloned.
#   apply  apply.sh runs it over SSH on a live host. Ends by reloading
#          systemd and restarting the units the steps declare.
#
# Steps read their inputs from /etc/rome-host: pins.env, files/, and the
# markers the runner sets. Every step is idempotent; a second run on an
# already-provisioned host changes nothing.
set -euo pipefail
mode="${1:?usage: run.sh build|apply}"
root=/etc/rome-host
cd "$root"
. "$root/pins.env"

step() { echo "[rome-host] $*"; }

step "10 docker"
bash "$root/provision/10-docker.sh"
step "20 harden"
bash "$root/provision/20-harden.sh"
step "30 rome"
bash "$root/provision/30-rome.sh"
if [[ -e "$root/wechat" ]]; then
  step "40 wechat"
  bash "$root/provision/40-wechat.sh"
fi

case "$mode" in
  build)
    step "90 seal"
    bash "$root/provision/90-seal.sh"
    ;;
  apply)
    systemctl daemon-reload
    systemctl restart rome-block-metadata.service fail2ban.service
    if [[ -e "$root/wechat" ]]; then
      systemctl restart rome-hostd.service
    fi
    if [[ -f /opt/rome/.env ]]; then
      (cd /opt/rome && docker compose --project-name rome up -d)
    fi
    ;;
  *)
    echo "run.sh: unknown mode $mode" >&2
    exit 2
    ;;
esac

printf 'HOST_LAYER_VERSION=%s\nAPPLIED_AT=%s\nMODE=%s\n' \
  "$HOST_LAYER_VERSION" "$(date -u +%FT%TZ)" "$mode" >"$root/applied"
step "done: host layer $HOST_LAYER_VERSION ($mode)"
