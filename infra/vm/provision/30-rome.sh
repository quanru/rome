#!/bin/bash
# The compose project under /opt/rome and the first-boot image load. The
# preloaded tar exists only during a build; on a live host the image is
# already in dockerd and the load unit's condition keeps it from running.
set -euo pipefail
files=/etc/rome-host/files
mkdir -p /opt/rome /var/lib/rome
install -m 0644 "$files/docker-compose.yml" /opt/rome/docker-compose.yml
install -m 0644 "$files/rome-load-image.service" /etc/systemd/system/rome-load-image.service
if [[ -f /etc/rome-host/rome.tar ]]; then
  mv /etc/rome-host/rome.tar /var/lib/rome/rome.tar
fi
chown -R root:root /etc/rome-host /opt/rome/docker-compose.yml /var/lib/rome
systemctl enable rome-load-image.service >/dev/null 2>&1
