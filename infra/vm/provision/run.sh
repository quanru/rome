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
. "$root/provision/lib.sh"
rm -rf /run/rome-host-changes

if [[ -e "$root/wechat" && ! -x /usr/local/bin/rome-hostd ]]; then
  echo "run.sh: WeChat is enabled on this host but no helper is installed; apply with --hostd PATH" >&2
  exit 1
fi

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
    # Only what a step changed is restarted. A routine apply on a converged
    # host touches nothing: no fail2ban blip, no orphaned root job, no
    # container recreate.
    systemctl daemon-reload
    changed rome-block-metadata.service && systemctl restart rome-block-metadata.service
    changed rome-sshd.local && systemctl restart fail2ban.service
    if [[ -e "$root/wechat" ]]; then
      if changed rome-hostd; then
        systemctl restart rome-hostd.service
      else
        systemctl start rome-hostd.service
      fi
    fi
    if changed docker-compose.override.yml && [[ -f /opt/rome/.env ]]; then
      # The project name comes from the compose file, so a tenant's bundle
      # keeps its own.
      (cd /opt/rome && docker compose up -d)
    fi
    rm -rf /run/rome-host-changes
    ;;
  *)
    echo "run.sh: unknown mode $mode" >&2
    exit 2
    ;;
esac

printf 'HOST_LAYER_VERSION=%s\nAPPLIED_AT=%s\nMODE=%s\n' \
  "$HOST_LAYER_VERSION" "$(date -u +%FT%TZ)" "$mode" >"$root/applied"
step "done: host layer $HOST_LAYER_VERSION ($mode)"
