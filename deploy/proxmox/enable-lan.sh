#!/usr/bin/env bash
# Lets Business Hub listen on the home network as well as through Tailscale. Runs inside
# the container. This only makes it possible: home-network access stays off until you
# turn it on under Settings > Access, where you can also turn Tailscale off.
#
# Name any local DNS names you've pointed at the container, for example:
#   bash enable-lan.sh hub.home
# Run again to change the names.
#   bash enable-lan.sh --off             stop listening on the home network at all
#   bash enable-lan.sh --reset-switches  Tailscale on, home network off (if you're locked out)
set -euo pipefail

ENV_FILE=/etc/expense-hub/env
DB=/var/lib/expense-hub/orders.db
PORT="$(sed -n 's/^OHE_PORT=//p' "$ENV_FILE" | tail -n 1)"
PORT="${PORT:-8787}"

set_value() {
  if grep -q "^#\?$1=" "$ENV_FILE"; then
    sed -i "s|^#\?$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >>"$ENV_FILE"
  fi
}

case "${1:-}" in
  --reset-switches)
    sqlite3 "$DB" "DELETE FROM app_settings WHERE key IN ('access.lan', 'access.tailscale');"
    echo "Tailscale is on and home-network access is off."
    exit 0
    ;;
  --off)
    set_value OHE_HOST 127.0.0.1
    set_value OHE_NETWORK 0
    set_value OHE_LAN_HOSTS ""
    systemctl restart expense-hub
    echo "Business Hub listens only inside its container again (Tailscale only)."
    exit 0
    ;;
esac

NAMES="$(printf '%s,' "$@" | sed 's/,$//')"
set_value OHE_HOST 0.0.0.0
set_value OHE_NETWORK 1
set_value OHE_LAN_HOSTS "$NAMES"
systemctl restart expense-hub

IP="$(hostname -I | awk '{print $1}')"
echo
echo "Business Hub can now be reached on the home network once you turn it on"
echo "under Settings > Access. Its addresses:"
echo "  http://$IP:$PORT"
echo "  http://$(hostname):$PORT"
for name in "$@"; do echo "  http://$name:$PORT"; done
echo "Don't forward this port to the internet."
