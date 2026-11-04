#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/../.." && pwd)"
recorder_user="$(id -un)"
if [ "$recorder_user" = root ]; then
  echo 'Lancer en utilisateur wattman, sans sudo devant bash.' >&2
  exit 1
fi
python3 -m venv "$project_root/.venv-recorder"
"$project_root/.venv-recorder/bin/pip" install -r "$project_root/requirements.txt"
mkdir -p "$HOME/wattman-data"
sudo mkdir -p /etc/wattman
if ! sudo test -f /etc/wattman/recorder.env; then
  printf 'ENGINEERING_APP_DATA=%s/wattman-data\nESP32_BASE_URL=http://192.168.4.1\nWATTMAN_PORT=8080\n' "$HOME" | sudo tee /etc/wattman/recorder.env >/dev/null
fi
sudo tee /etc/systemd/system/wattman-recorder.service >/dev/null <<EOF
[Unit]
Description=Wattman autonomous measurement recorder
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$recorder_user
WorkingDirectory=$project_root
EnvironmentFile=/etc/wattman/recorder.env
Environment=PYTHONUNBUFFERED=1
ExecStart=$project_root/.venv-recorder/bin/python $project_root/desktop/recorder.py
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now wattman-recorder
sudo systemctl status wattman-recorder --no-pager
