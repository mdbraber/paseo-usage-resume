#!/usr/bin/env bash
# Copy the plugin to Paseo daemons over SSH and install or reload it there.
# Usage: scripts/deploy.sh [host ...]   ("local" means this machine's daemon)
set -euo pipefail

PLUGIN_ID="paseo-usage-resume"
REMOTE_DIR="src/$PLUGIN_ID"
SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Hosts and SSH options live in an untracked file next to this script:
#   HOSTS=(local host-a host-b)          # "local" is this machine's daemon
#   SSH_OPTS=(-o BatchMode=yes)
HOSTS=(local)
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10)
LOCAL_CONFIG="$(dirname "$0")/deploy.local"
# shellcheck source=/dev/null
[ -f "$LOCAL_CONFIG" ] && source "$LOCAL_CONFIG"

hosts=("$@")
[ ${#hosts[@]} -eq 0 ] && hosts=("${HOSTS[@]}")

# Installs on first deploy, reloads afterwards, then prints the plugin's status.
INSTALL_OR_RELOAD='
  dir="$1"; id="$2"
  if paseo plugin ls 2>/dev/null | grep -q "^$id "; then
    paseo plugin reload "$id" >/dev/null
  else
    paseo plugin install "$dir" >/dev/null
  fi
  sleep 2
  paseo plugin ls | awk -v id="$id" "\$1 == id { print \$2 }"
'

failed=0
for host in "${hosts[@]}"; do
  if [ "$host" = local ]; then
    status=$(bash -c "$INSTALL_OR_RELOAD" _ "$SOURCE_DIR" "$PLUGIN_ID" 2>&1 | tail -1) || true
  else
    status=$(
      COPYFILE_DISABLE=1 tar -C "$SOURCE_DIR" --exclude node_modules --exclude .git -czf - . |
        ssh "${SSH_OPTS[@]}" "$host" \
          "rm -rf ~/$REMOTE_DIR && mkdir -p ~/$REMOTE_DIR && tar -xzf - -C ~/$REMOTE_DIR 2>/dev/null
           bash -c '$INSTALL_OR_RELOAD' _ ~/$REMOTE_DIR $PLUGIN_ID" 2>&1 | tail -1
    ) || true
  fi
  printf '%-10s %s\n' "$host" "${status:-no response}"
  [ "$status" = running ] || failed=1
done
exit $failed
