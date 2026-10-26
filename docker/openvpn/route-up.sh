#!/bin/sh
# Start the SOCKS proxy only once the tunnel is up, so nothing leaks out un-tunnelled.
# After a reconnect tun0 has a new address, so restart Dante to pick it up.
pkill sockd 2>/dev/null
touch /vpn/connected
sockd -D -f /vpn/sockd.conf
