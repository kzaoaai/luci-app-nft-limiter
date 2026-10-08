# luci-app-nft-limiter

<p>
<a href="https://github.com/kzaoaai/luci-app-nft-limiter/actions/workflows/build.yml"><img alt="Build" src="https://github.com/kzaoaai/luci-app-nft-limiter/actions/workflows/build.yml/badge.svg"></a>
<a href="https://github.com/kzaoaai/luci-app-nft-limiter/releases"><img alt="GitHub release" src="https://img.shields.io/github/v/release/kzaoaai/luci-app-nft-limiter"></a>
<a href="https://github.com/kzaoaai/luci-app-nft-limiter/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/kzaoaai/luci-app-nft-limiter/total"></a>
<a href="https://openwrt.org"><img alt="OpenWrt" src="https://img.shields.io/badge/OpenWrt-%E2%89%A525.12-ff0000?logo=openwrt&logoColor=white"></a>
</p>

Fast, minimal-CPU per-device bandwidth control for OpenWrt using native **nftables / fw4** rate limiting.

## Features

- **Native nftables rules** — `limit rate over … drop` policing, near-zero CPU overhead
- **Selectable Interfaces** — Select interface(s) where traffic is shaped (wan, wan2, VPN, etc...)
- **Flexible targets** — single IP, CIDR subnet, IP range (`192.168.1.10-192.168.1.50`), or any mix of them in one rule (multi-select picker with your devices, hostnames and LAN/VLAN subnets); all of a rule's targets share its one limit
- **Overlap hints** — an "i" badge on rules that other rules also match, listing them in checking order and highlighting them in the grid
- **Block toggle** — drop a device's WAN traffic outright (both directions), optionally on its schedule
- **IPv6 aware** — a single-IPv4 device with a known MAC is also matched on IPv6 (upload by MAC, download by its learned global addresses), sharing one limit across both families; IPv6 addresses and prefixes work as targets too
- **Time scheduling** — time-of-day and day-of-week windows, both per-rule and for the global default limit
- **Live stats** — current speed per rule, totals that survive rule changes, dropped traffic, a tint on rules that are limiting right now, and a per-device breakdown for subnet/range/multi-device rules and for the global limit (top talkers)
- **Self-healing** — hooks into `firewall4` include so rules survive interface reloads
- **Modern UI** — sortable GridSection with live device picker (hostname + IP from DHCP/ARP)
- **APK + IPK** — CI builds packages for OpenWrt 25.12+ (apk) and 24.10 (ipk); both are supported

## Installation

Script will automatically detect whether your router uses opkg or apk, and select the correct file to install.
Run via SSH on your router:

```sh
wget -qO- https://raw.githubusercontent.com/kzaoaai/luci-app-nft-limiter/main/install.sh | sh
```

Then open **LuCI → Network → NFT Limiter**.

## UCI config reference

```
config nft-limiter
    option enabled   1            # master service on/off
    option iface     'wan'        # interface(s) to rate-limit (space-separated). Include
                                  # every uplink (failover WAN, VPN tunnels that carry
                                  # policy-routed traffic): traffic leaving through an
                                  # unlisted one skips all limits and blocks
    option glimit    1            # enable the global default (catch-all) limit
    option download  200          # Mbit/s, ONE cap shared by all devices without
                                  # their own rule, not per device (0 = unlimited)
    option upload    100
    option gschedule 0            # restrict the global limit to a window/days
    option timestart 00:00        # global window (only when gschedule = 1)
    option timeend   00:00
    option week      0            # global days, comma-separated (0 = every day)

config device
    option enable    1
    option target    192.168.1.10          # IP, CIDR, IP range, or a list of these
                                           # (list target ...), sharing one limit
    option download  40
    option upload    10
    option timestart 08:00
    option timeend   22:00
    option week      1,2,5             # Mon-Tue-Fri (0 = every day)
    option comment   'My Laptop'
    option mac       aa:bb:cc:dd:ee:01 # optional; LuCI fills it on save. Enables IPv6 matching
                                       # (otherwise looked up in static DHCP, leases, neighbours)

config device
    option enable    1
    option target    192.168.1.30
    option block     1                 # drop all WAN traffic (download/upload ignored)
    option timestart 00:00
    option timeend   07:00
    option comment   'Overnight cutoff'

config device
    option enable    1
    option target    192.168.1.12-192.168.1.20
    option download  50
    option upload    15
    option timestart 07:00
    option timeend   13:00
    option comment   'Media Devices'

config device
    option enable    1
    option target    192.168.1.16/28
    option download  15
    option upload    15
    option comment   'Guests'
```
