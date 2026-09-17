#!/bin/bash
# The compose project under /opt/rome and the first-boot image load.
#
# The compose file is a seed: written when absent, never overwritten. A host
# that received Rome Cloud's deployment bundle keeps it; the host layer does
# not own the tenant's stack. The preloaded tar exists only during a build;
# on a live host the image is already in dockerd and the load unit's
# condition keeps it from running.
set -euo pipefail
files=/etc/rome-host/files
mkdir -p /opt/rome /var/lib/rome
[[ -f /opt/rome/docker-compose.yml ]] || install -m 0644 "$files/docker-compose.yml" /opt/rome/docker-compose.yml
install -m 0644 "$files/rome-load-image.service" /etc/systemd/system/rome-load-image.service
if [[ -f /etc/rome-host/rome.tar ]]; then
  mv /etc/rome-host/rome.tar /var/lib/rome/rome.tar
fi
# Ownership and modes are the host's, whatever umask the build ran under.
# rome-hostd refuses a config directory that others can write.
chown -R root:root /etc/rome-host /opt/rome/docker-compose.yml /var/lib/rome
chmod -R go-w /etc/rome-host
chmod 755 /etc/rome-host /etc/rome-host/provision /etc/rome-host/files
systemctl enable rome-load-image.service >/dev/null 2>&1
