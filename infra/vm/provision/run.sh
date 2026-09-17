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
step "40 wechat"
bash "$root/provision/40-wechat.sh"

case "$mode" in
  build)
    step "90 seal"
    bash "$root/provision/90-seal.sh"
    ;;
  apply)
    systemctl daemon-reload
    systemctl restart rome-block-metadata.service fail2ban.service
    # An enabled helper runs. It restarts only when its binary, unit, or
    # config changed, so a routine apply never orphans a running root job.
    if [[ -e "$root/wechat" ]]; then
      if [[ -e /run/rome-host/changed ]]; then
        systemctl restart rome-hostd.service
      else
        systemctl start rome-hostd.service
      fi
    fi
    rm -f /run/rome-host/changed
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
