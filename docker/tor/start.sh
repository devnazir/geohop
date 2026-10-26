#!/bin/sh
# TOR_COUNTRY is a two-letter country code; only exit relays in that country are used.
set -e
cat > /tmp/torrc <<CONF
SocksPort 0.0.0.0:1080
SocksPolicy accept *
DataDirectory /tmp/tor
ExitNodes {$TOR_COUNTRY}
StrictNodes 1
Log notice stdout
CONF
exec tor -f /tmp/torrc
