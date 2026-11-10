#!/usr/bin/env bash
# GitHub's optional Azure Ubuntu mirror can hang before browser tests start.
# Keep signed Ubuntu packages, using the runner's existing official HTTPS fallback.
set -euo pipefail
mirrors=/etc/apt/apt-mirrors.txt
if [[ -f "$mirrors" ]] && grep -q '^https://archive.ubuntu.com/ubuntu' "$mirrors"; then
  sudo sed -i '\|^http://azure.archive.ubuntu.com/ubuntu|d' "$mirrors"
fi
printf 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::Retries "2";\n' |
  sudo tee /etc/apt/apt.conf.d/80gtd-network-timeouts >/dev/null
