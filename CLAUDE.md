# luci-app-nft-limiter

LuCI app + shell engine for per-device bandwidth limits on OpenWrt 25.12+ (fw4/nftables;
24.10 ipk also built). Public repo; users install it with `install.sh` from the latest GitHub
release. Never put lab data (hostnames, LAN IPs, MACs, names) in code, docs, fixtures or
commit messages; use `192.0.2.x` placeholders.

## Layout

- `root/usr/bin/nft-limiter` — the engine (busybox ash). `start` = one atomic nft
  transaction (`build_chain`); `stop`, `stats`, `snapshot`, `history`, `tcsync`.
- `root/usr/libexec/nft-limiter-switch` — family switch command (status/on/off/hours) for a
  limited rpcd login; ACL `root/usr/share/rpcd/acl.d/luci-app-nft-limiter-switch.json`.
- `root/etc/init.d/nft-limiter` (`on`/`off`/`reapply`, STOP=10 so stop runs at shutdown),
  `root/etc/hotplug.d/iface/10-nft-limiter` (WAN ifup → reapply; LAN ifup → `tcsync`),
  `root/etc/hotplug.d/ntp/30-nft-limiter` (ntpd "periodic", ~11 min: history snapshot;
  rebuild when the UTC offset changed).
- `htdocs/luci-static/resources/view/nft-limiter.js` — **stable loader**; the real view is
  `nftlimiter/app.js`, plus `nftctl.js` (header/status block).
- `contrib/make-shortcut.py` — builds the iOS Shortcut for a family switch.

## Build, test, release

- No local build. CI (`.github/workflows/build.yml`) builds apk (25.12 SDK) and ipk (24.10)
  on a `v*` tag and stamps the version into the Makefile and `nftctl.js` (`pkgVersion` in
  the repo stays a placeholder). Builds have taken from 15 min to 5 h.
- Release: commit, `git tag -a vX.Y.Z`, push tag; when CI is done make sure that tag is
  GitHub's "Latest" (`gh release edit vX.Y.Z --latest`) — a slower older build can take it
  over, and `install.sh` installs whatever is Latest.
- `gh` needs `--repo kzaoaai/luci-app-nft-limiter` (or `gh repo set-default`): a checkout
  with the `upstream` remote (the eqosplus project this forked from) otherwise resolves
  `gh run list` and `gh release list` to that repo and shows its old runs and releases.
- Install/upgrade on a router: `wget -qO- https://raw.githubusercontent.com/kzaoaai/luci-app-nft-limiter/main/install.sh | sh`.
  It refreshes package lists, installs `kmod-sched-core`, `kmod-ifb` and `tc-tiny` (unless a
  `tc` exists) first, installs the package, `reapply`s (no firewall restart). Removes nothing;
  delete `/etc/config/nft-limiter.apk-new` after upgrades.
- Checks: `dash -n` and `ssh <router> 'sh -n' <` for shell; `node --check` for JS. Dry-run
  the engine against a router's live config: copy `nft-limiter` with `nft -f` → `nft -c -f`,
  `/var/run/nft-limiter.` → `/tmp/…`, the tc calls stubbed, and run `build_chain`
  (UCI_CONFIG_DIR + `uci -c` for a scratch config).

## Invariants (the code does not say why)

- **On/off is the service's boot enable, nothing else** (since v3.1.5). Home Assistant's
  service switch, System > Startup and `rc init` only flip the boot link and call
  start/stop, so a second switch drifts: up to v3.1.4 the UCI `enabled` flag also had to be 1,
  and HA "on" left the limiter showing on with no rules. `start_service` still gates on the
  link because LuCI apply (ucitrack) and procd's config trigger call it. The uci-defaults
  script `nft-limiter-master` carries an old flag over once and deletes it.
- **cgi-exec answers 200 with an empty body when the command fails** (it drops the exit
  code), so `fs.exec_direct` output must be checked for content, never for null:
  `nftctl.probe()` returns null unless the output holds a chain.
- **Every rebuild is one nft transaction** and nothing stops-then-starts: a gap gives blocked
  devices seconds of internet. fw4 includes the rules through the symlink
  `/usr/share/nftables.d/table-post/30-nft-limiter.nft` → `/var/run/nft-limiter.fw4.nft`, so
  firewall reloads keep them.
- **Shape mode (default)**: nft only tags download packets (mark top byte, `TAG_MASK`
  0xff000000: tag = rule index + 1, quota throttle + 127, global limit 255; pbr/mwan3/fw4
  use the low 24 bits). LAN-side devices (static, no gateway, not a rate-limited iface) get
  a clsact egress `fw` filter → mirred to `ifb-nftl`, whose HTB classes have fq_codel and a
  filter that **clears the tag** (LAN bridges whose port is a VLAN on another bridge would
  otherwise be shaped twice). Uploads are always policed (dropped uploads waste no ISP data).
- History keys: `R|<row key>|d|u|dd|ud|w`, `S|<row key>|d` (tc delivered, minus 14 B per
  packet), `A|<row key>|<addr>|d|u`, `I|<iface>|rx|tx`. Row key = sorted targets joined by
  commas. Waste `w` = dropped downloads + (shape) arrived − delivered, signed per interval.
- **Reading the history is cheap only if it stays this way** (measured on an MT7621, where a
  7-day `history` took 3.1 s and now 1.1-1.2 s): `_hist_records` passes only the records in
  the range; the live read (`_collect_values`) runs only when the range ends within a minute
  of now; a whole-hour bar reads the closed hourly records inside the range in place of their
  11-minute lines (an hourly record is exactly the sum of the 11-minute lines stamped in its
  hour; the first line of `hour.acc` is the open hour, still 11-minute only); the main loop
  makes one cheap test per value (per-address and tc values only add to totals); the live
  read lists every per-address set with one `nft list sets` and the interfaces with one
  `ubus` dump (a command chain per set cost 0.9 s for 12 sets). Bars are whole sizes (11, 22,
  30 min, 1, 2, 3, 6, 12 h, days), at most 180, and a record in the minute after `<to>` counts
  in the last bar as in the totals. Per-address values are about 70% of the logs; giving them
  their own log would take a further ~40% off long ranges (estimate), at the cost of a format
  change, and is not done.
- The loader reads `nftlimiter/app.js` over RPC (`fs.read`, never cached) because LuCI
  stamps module URLs with its own version. Keep the loader unchanged between releases (a
  change needs a browser cache clear), keep `LUCI_MINIFY_JS:=0` (v3.0.x loaders expect one
  `'require …'` per line), and note LuCI binds `load`/`render` before `load` runs.
- Counters carry over rebuilds via `/var/run/nft-limiter.keys` (index → row key). So in
  `_delta_line` a key missing from the last snapshot, or a counter that went down, is a
  baseline, never traffic: before v3.1.4 a stop/start or upgrade, and every firewall reload
  (fw4 re-reads the include file, whose counters are frozen at the last rebuild), re-counted
  each rule's whole total as one interval. And
  every command but `status`/`stats` holds `flock` on `/var/lock/nft-limiter.lock`, so a
  snapshot never reads the new keys file against the old chain.

## Current state

- v3.1.6 (2026-11-07): the faster `history` above (live read in one pass, one test per
  value, only the records in range, closed hours for whole-hour bars, whole-size bars, the
  last bar keeps the minute after `<to>`). Checked side by side against v3.1.5 on three
  routers (an MT7621 and two Filogic), each on a frozen copy of its own history in `/tmp`:
  identical totals for every closed range tried (seven per router), bars that add up to the
  totals, the same live values. MT7621: today 1.2 to 0.6 s, 7 days 3.1 to 1.2 s, this
  period 3.2 to 1.1 s, 45 days 4.5 to 2.7 s, the live read (also every snapshot) 0.9 to 0.3 s.

- v3.1.5 released 2026-10-23: boot enable is the only on/off switch, LuCI's probe sees an
  unloaded chain. The flag migration has run on real upgrades with the flag at 1; the
  flag-0 branch (disable on upgrade) has only run against a scratch config. No open bugs.
- Since v3.1.4: shape mode, waste counter, family switches, stable loader, history that
  survives stop/start and firewall reloads.
- Shape mode is proven on slow MIPS routers (MT7621): ~2.5% CPU at ~41 Mbit/s under load,
  and in daily use since v3.0 (4.7 and 7.4 GB through HTB, load average near 0, checked
  2026-10-12). Shaping
  wastes ≈3× less than policing (measured on real devices).
- Accepted limits, by design, not to fix unless a user asks:
  - Waste for traffic arriving through WireGuard tunnels reads ~0.6% low (per-packet
    overhead not corrected; cosmetic).
  - Quota resets land at the first snapshot after midnight (≤ ~11 min late), since there
    is no cron; history and DST rebuilds ride the ntpd hotplug (`history` takes a
    snapshot itself if none for 15 min).
  - A billing day past the month's end (29-31) falls on the month's last day.
- `contrib/make-shortcut.py` Shortcut works on iOS and macOS (status, menu, change hours).
  An If only offers a text operand when its variable holds Text, so values from "Get
  Dictionary Value" go through a Text action first; the error otherwise is "Please choose a
  value for each parameter in this action". Open the generated file in the Shortcuts
  editor (or press Show on that error) to see which action is incomplete. Times go out
  as ISO 8601 and are cut to HH:MM (a custom "HH:mm" follows the phone's 12-hour setting).
  The time pickers start at the rule's current hours: a Time picker reads its start only
  from `WFAskActionDefaultAnswerTime` holding a Date action's output.
- Ideas not requested yet: days of the week in the family-switch hours; translations
  (`po/templates/nft-limiter.pot` is kept in sync, no languages); "block/allow for N
  minutes" from the Shortcut, deferred: it belongs on the router (a switch command storing
  an override with an absolute end, rendered as an nft rule with `meta time <` so it ends
  on time with no timer, shown in status/LuCI, cleared by the next explicit change), not in
  the Shortcut, which cannot run later to undo it.

## Cloud and web sessions

A session that runs in a cloud sandbox (Claude Code on the web, a scheduled routine, an `ultra`
review) does not load the maintainer's global instructions and cannot reach the lab: no LAN or
tailnet route, no memory notes, no vault. These rules stand in for the global ones there. All
but the branch rule bind local sessions too.

- **No AI attribution** in commit messages, PR bodies or comments: no `Co-Authored-By: Claude`
  trailer, no "Generated with Claude Code" footer. This overrides the harness's own attribution
  reminder.
- **In the cloud, work on a branch and open a draft PR. Never push to `main`, never merge.** The
  maintainer validates on real hardware before anything lands.
- **Sanitize before the first push.** Grep the diff, any new fixtures and the commit messages for
  private and tailnet addresses (`192.168.`, `10.x.x.x`, `172.16-31.`, `100.64-127.`), `.home`,
  `.lan`, `ts.net`, MAC addresses, and anything that looks like a real hostname, domain, SSID or
  person's name. Use `192.0.2.x` / `198.51.100.x`, `aa:bb:cc:dd:ee:NN` and generic names. A
  force-push does not take a leak back: GitHub keeps the old commit reachable.
- **PR bodies and comments: one paragraph per line.** GitHub renders a single newline as a line
  break, so hard-wrapped prose arrives broken mid-sentence.
- **Nothing can be deployed or tested live from the cloud.** Skip deploy steps, and say in the PR
  what still needs checking on a real install.
