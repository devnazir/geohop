#!/bin/sh
# The CLI passes the OpenVPN config base64-encoded in VPN_CONFIG.
set -e
printf '%s' "$VPN_CONFIG" | base64 -d > /vpn/config.ovpn
exec openvpn --config /vpn/config.ovpn --connect-retry-max 1 \
  --script-security 2 --route-up /vpn/route-up.sh
