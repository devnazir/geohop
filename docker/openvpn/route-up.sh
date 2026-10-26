#!/bin/sh
# Start the SOCKS proxy only once the tunnel is up, so nothing leaks out un-tunnelled.
sockd -D -f /vpn/sockd.conf
