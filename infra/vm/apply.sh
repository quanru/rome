#!/usr/bin/env bash
# Bring a live host up to this tree's host layer. Same scripts the image
# build runs, over SSH instead of inside a disk file. Idempotent: applying
# to a host built from the same tree changes nothing.
#
#   infra/vm/apply.sh [--wechat] [--hostd PATH] [ssh options...] user@host
#
# The user needs passwordless sudo. --wechat turns on the host helper and
# personal WeChat and stays on for later applies; --hostd stages a new
# rome-hostd binary (needs --wechat, or a host that already has it).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wechat=false
hostd=""
ssh_args=()
target=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --wechat) wechat=true; shift ;;
    --hostd) hostd="$2"; shift 2 ;;
    -*) ssh_args+=("$1" "$2"); shift 2 ;;
    *) target="$1"; shift ;;
  esac
done
[[ -n "$target" ]] || { echo "usage: apply.sh [--wechat] [--hostd PATH] [ssh options] user@host" >&2; exit 2; }

run() { ssh "${ssh_args[@]}" "$target" "$@"; }

# The tree lands whole; run.sh reads pins.env and files/ from there.
tar -C "$here" -c pins.env provision files |
  run 'sudo mkdir -p /etc/rome-host && sudo tar -x -C /etc/rome-host --no-same-owner'
if $wechat; then
  run 'sudo touch /etc/rome-host/wechat'
fi
if [[ -n "$hostd" ]]; then
  run 'sudo tee /etc/rome-host/rome-hostd >/dev/null' < "$hostd"
fi
run 'sudo bash /etc/rome-host/provision/run.sh apply'
