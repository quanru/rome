#!/bin/bash
# Build only. Strips per-machine identity so every VM cloned from the image
# generates its own. Never run on a live host.
set -euo pipefail
truncate -s0 /etc/machine-id
rm -f /var/lib/dbus/machine-id /etc/ssh/ssh_host_*
cloud-init clean --logs || true
