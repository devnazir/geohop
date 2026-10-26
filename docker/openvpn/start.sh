#!/bin/sh
# The CLI passes VPN_COUNT servers as VPN_CONFIG_<i> (base64 OpenVPN config) and VPN_NAME_<i>.
# Server 0 is the one the CLI picked: if it never connects, exit so the CLI can try another.
# Once a tunnel has worked, a dropped server switches to the next one on the same port.
# --dev tun0 overrides names like "tun1" in custom configs; sockd.conf routes through tun0.
set -u
count=${VPN_COUNT:-1}
i=0
while :; do
  eval "config=\${VPN_CONFIG_$i}"
  eval "name=\${VPN_NAME_$i:-server $i}"
  printf '%s' "$config" | base64 -d > /vpn/config.ovpn
  echo "$name" > /vpn/current
  echo "vpngate: connecting to $name"
  openvpn --config /vpn/config.ovpn --dev tun0 --connect-retry-max 1 \
    --script-security 2 --route-up /vpn/route-up.sh
  [ -f /vpn/connected ] || exit 1
  echo "vpngate: $name disconnected, switching to the next server"
  i=$(( (i + 1) % count ))
  sleep 3
done
