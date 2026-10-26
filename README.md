# vpngate-cli

Free VPN from your terminal. No signup, no account, multiple countries.

```
$ vpngate connect JP
[1/5] Japan · public-vpn-187 219.100.37.179 tcp/443 · 221 Mbps
      ✓ Connected
      Your IP is now 219.100.37.179 (Tokyo, JP)
      Press Ctrl+C to disconnect
```

It uses the public server list from [VPN Gate](https://www.vpngate.net), an academic project at the University of Tsukuba in Japan. Volunteers around the world run the servers. `vpngate` picks the best server, connects with OpenVPN and moves on to the next server automatically if one is down.

## Install

You need **Node.js 18+** and **OpenVPN**.

```bash
# macOS
brew install openvpn

# Debian / Ubuntu
sudo apt install openvpn
```

Then install the CLI:

```bash
git clone https://github.com/devnazir/vpngate-cli.git
cd vpngate-cli
npm link        # makes the `vpngate` command available everywhere
```

Windows is not supported yet.

## Usage

```bash
vpngate countries            # which countries are available right now
vpngate list JP              # servers in Japan, best first
vpngate connect              # connect to the best server anywhere
vpngate connect KR           # connect to Korea
vpngate connect japan        # country names work too
vpngate ip                   # check your current IP and location
```

Press **Ctrl+C** to disconnect.

You'll be asked for your password once, because creating a VPN tunnel needs admin rights.

| Option | What it does |
| --- | --- |
| `--proto tcp\|udp` | Only use servers with this protocol |
| `--tries <n>` | How many servers to try before giving up (default 5) |
| `--timeout <sec>` | How long to wait for each server (default 20) |
| `--limit <n>` | Rows shown by `list` (default 20) |
| `--refresh` | Fetch a fresh server list (it's cached for 10 minutes) |
| `-v, --verbose` | Show OpenVPN's output |

## Is it safe?

The OpenVPN software is secure. **The servers are run by volunteers you don't know**, so:

- ✅ Fine for: everyday browsing on HTTPS sites, accessing region-locked content.
- ❌ Not for: banking, important logins, or anything where you need real privacy or anonymity.
- The server operator can see which sites you visit and anything not using HTTPS. VPN Gate also keeps connection logs.
- If your browser shows a **certificate warning while connected, disconnect**.
- Your DNS lookups may not go through the VPN. Turn on DNS over HTTPS in your browser for better privacy.

## Limits

- No data cap or time limit, but speed depends on the volunteer server.
- Most servers are in Japan and Korea. Other countries come and go.
- Servers can disappear at any time. Just run `connect` again.

## Credits

All servers are provided by the [VPN Gate Academic Experiment](https://www.vpngate.net). This project is not affiliated with VPN Gate. Please use it responsibly and follow [their terms](https://www.vpngate.net/en/about_abuse.aspx).

## License

MIT
