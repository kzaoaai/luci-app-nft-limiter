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
  `tc` exists) first, installs the package, then runs the service's `start` when enabled (an
  atomic rebuild like `reapply`, no firewall restart, which also registers procd triggers a new
  version adds). Removes nothing; delete `/etc/config/nft-limiter.apk-new` after upgrades.
  Downloads use curl when installed, else the system wget, and fetch the package through the
  API's asset address (`Accept: application/octet-stream`) before the browser link: OpenWrt's
  own wget (uclient-fetch with ustream-mbedtls, 25.12) times out on github.com responses with
  ~5.7 KB of headers, such as the browser link's redirect, while the API's redirect (~2 KB),
  api.github.com and raw.githubusercontent.com work (seen 2026-11-12; a header-size limit in
  uclient is inferred). If both fail it prints the link and the manual commands. The package's
  post-upgrade ends in a bare `uci commit` (OpenWrt's default postinst after uci-defaults), which
  saves whatever the uci CLI has staged in `/tmp/.uci` on that router.
- Checks: `dash -n` and `ssh <router> 'sh -n' <` for shell; `node --check` for JS. Dry-run
  the engine against a router's live config: copy `nft-limiter` with `nft -f` → `nft -c -f`,
  `/var/run/nft-limiter.` → `/tmp/…`, the tc calls stubbed, and run `build_chain`
  (UCI_CONFIG_DIR + `uci -c` for a scratch config).
- **A test on the maintainer's routers is not a stock test unless busybox's tools are
  forced.** Those routers have gawk and GNU sed as `awk` and `sed`; a stock install has
  busybox's. Put `awk() { busybox awk "$@"; }` and `sed() { busybox sed "$@"; }` at the top
  of the script sent to the router, run it both ways, and say which tools a result came from.

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
  each rule's whole total as one interval. The exception is a row the last build carried no
  counter to (a new rule, a changed target list, every row after a start): the build lists
  those row keys in `/var/run/nft-limiter.fresh`, and a key of theirs the last snapshot lacks
  (`R` or per-address `A`) is counted from zero, since their counters and sets began at zero.
  And every command but `status`/`stats` holds `flock` on `/var/lock/nft-limiter.lock`, so a
  snapshot never reads the new keys file against the old chain.
- **nft's text output gives a size with a unit, and a used-up quota reads as its own size.**
  nft prints a size in the largest unit that divides it exactly (`over 9765625 kbytes` for
  10 GB; 1.1.6 goes up to `mbytes`); counters are always plain bytes, and `-j` output is
  always bytes. The kernel adds every packet to a quota's count but reports at most the quota
  (`nft_quota_do_dump`), so a used-up quota prints `used` equal to its size, and a size that
  is a multiple of 1024 bytes (every even number of GB) comes back as `kbytes`. So every
  reader of a size in nft's text takes the unit word with the number (`_AWK_SIZE`, awk's
  `b(number, unit)`). The kernel also refuses a quota created with `used` above `over`
  (`Invalid argument`), which fails the whole transaction, so `_emit_device` caps both
  seeds (the shared quota's and each per-device element's) at the quota. Either source can
  exceed it: the history counts dropped and throttled traffic too, and a quota can be
  lowered below what is already used.
- **Busybox awk prints `%d` as a 32-bit number**: 6000000000 comes out as 2147483647
  (BusyBox 1.37.0; gawk prints it whole). `print`, `%s` and string joins are whole. So awk
  prints sizes, IPv4 addresses as numbers, and anything else that can pass 2^31 with `%.0f`.
  The epochs in `history`'s first line are still `%d`, which holds until 2038.
- **A class's fq_codel leaf has the handle tag + 0x100** (`101:` to `1ff:`), never the tag's
  own number: a handle is one of a kind on the device, and tag 1 (rule 0) would ask for the
  root HTB's `1:`. Nothing reads the leaf handles; the classes stay `1:<hex tag>`.

## Current state

- v3.1.9 (2026-11-27): three faults older than v3.1.8, found while installing it.
  **Sizes above 2 GB under busybox awk.** Five `%d` prints carried numbers that pass 2^31,
  which busybox awk cuts to 2147483647: the history's totals and bars, the quota seeds taken
  from the history (`_quota_used`, `_quota_used_addrs`), and the DHCP pool bounds of the
  `unreserved` target, so a pool in a 192.168 network came out as 127.255.255.255 and the
  target matched nothing of the LAN. A router with gawk as `awk` never showed it. Now `%.0f`.
  **Rule 0 had no fq_codel in shape mode.** Its class `1:1` asked for a leaf with handle
  `1:`, the root's, and tc refused it (`Cannot move an existing qdisc to a different
  parent`, printed at every rebuild and seen only when one runs in a terminal), so the class
  kept its rate but queued in HTB's plain default queue. Leaf handles are now tag + 0x100.
  **`sed: couldn't flush stdout: Broken pipe` during a package upgrade** came from the MAC
  lookup, where `sed` fed `head -n1`: with an address on more than one dhcp host section
  and GNU sed, under apk (which appears to run scripts with SIGPIPE ignored). Harmless; the
  reader is now an awk that reads to the end.
  Tested: the engine's own functions with their callers stubbed (`_unres_lists`,
  `_quota_used`, `_quota_used_addrs`, `history`, `_resolve_mac`), on macOS awk and on an
  MT7621 and a Filogic router with gawk and again with busybox awk and sed forced. v3.1.8
  fails under busybox awk (pool 127.255.255.255, every size 2147483647) and prints the sed
  line under GNU sed; the fix passes all four ways. `_tc_apply` with a stub `tc`: v3.1.8
  asks for `parent 1:1 handle 1:`, the fix for `handle 101:`. On a scratch IFB device on the
  Filogic router (6.12) tc refuses the first with that error and takes the second, and a
  real rebuild there gave rule 0's class its leaf (`fq_codel 101: parent 1:1`, five leaves
  for five classes). Not yet done: a stock install without gawk.
- v3.1.8 (2026-11-26): **a used-up shared quota no longer comes back to life at a
  rebuild.** The carry of a shared quota's use (`_snapshot_counters`, the `Q` lines) took the
  number after `used` and dropped its unit, so a quota of an even number of GB that was used
  up (`used 1953125 kbytes` for 2 GB) was seeded with 1/1024 of that at the next rebuild, and
  the devices it had blocked or throttled were let go until they used the quota again. Any
  other quota had the same fault whenever its count was an exact multiple of 1024 bytes. The
  per-device reader (`_qe_elements`) already applied the unit; both now share `_AWK_SIZE`.
  Tested: the three reader functions cut from the engine, run on sample nft output with a
  stub `nft` (macOS awk, and on an MT7621 and a Filogic router with gawk at the release and
  with busybox awk and sed the day after): v3.1.7 carries
  1953125 for a used-up 2 GB quota, the fix 2000000000. The print rule was read in nftables
  1.1.6, seen on three routers for `over`, and seen for `used` on an MT7621: a quota object
  made in a scratch table with `used` at its size prints `over 1953125 kbytes used 1953125
  kbytes`, from which the v3.1.7 reader takes 1953125 and the fix 2000000000. The report
  limit was read in kernels 6.6 and 6.12. The patched engine then ran one real rebuild on
  that MT7621: its three quotas' use was carried unchanged, the seeds written in bytes.
  Not yet seen on a router: a quota used up by real traffic, across a rebuild.
  Also: **a seed above the quota no longer fails the rebuild.** The seeds were not limited
  to the quota, and the kernel refuses `used` above `over`. With a seed from the history
  (boot, or a start after a stop) in a period in which the quota was used up, no rules
  loaded until a rebuild after that period ended; with a quota lowered below what was used,
  the old rules stayed in force and that apply and every later one failed until the quota's
  reset. Both seeds are now min(used, quota). Tested: the engine's own `_emit_device` with
  its helpers stubbed, eight rows (macOS awk, and gawk then busybox awk on the same two
  routers), the
  statements then given to `nft -c` there (6.12): v3.1.7 writes five seeds above their quota
  and the kernel refuses all five, shared and per-device; the fix writes none and all are
  accepted, values under the quota unchanged. Not reproduced on a router: a boot or a
  lowered quota with the real build. A quota lowered below its use and raised again in the
  same period counts on from the lower figure: the rebuild knows no more than the kernel
  reports, and that is at most the quota.
- Open, found the same day, not fixed:
  - `nft-limiter-switch` finds its rule by position and writes by position. A LuCI save that
    deletes or moves an earlier rule between the two (some tens of ms) sends the write to the
    neighbouring rule. Fix when that file is next touched: take the section's own name from
    `uci -X show` and stop if `uci set` fails (uci rejects a name whose section changed).
  - `_tc_apply` deletes the IFB root qdisc and adds the classes again at every rebuild, so
    shaped downloads run unshaped meanwhile (about 0.1 s on a Filogic router, 0.5 s on an
    MT7621 with 9 classes; estimated from the time of read-only tc calls, not measured), and
    the packets queued in the old classes are dropped. Blocks are not affected. Fix: leave
    the tree alone when the new tags file equals the old one, else change classes in place.

- v3.1.7 (2026-11-12): **quota-only rules** (UCI `quota_only`, LuCI "Quota Only" in the Edit dialog).
  A rule with no block and no speeds normally exempts its targets from everything after it (its
  terminal `accept`), the global limit included; with `quota_only` its pass rules count and carry no
  verdict, so until the quota is used up the next rule, else the global limit, applies. Past the
  quota the throttle (or block) works as for any quota. `coverageMap` no longer calls the rules after
  such a rule "never reached". Checked with a dry build (`nft -c`) against an MT7621's live config.
  Also: **per-device quotas** (`quota_each`): a dynamic set `nftlim_qe_<idx>` whose elements
  carry their own quota (`update @set { ip daddr quota over N bytes }`; kernel and nft 1.1.6 count each
  element and honour a seeded `used`, tested on loopback), plus per-device throttle limit sets
  `nftlim_qel_<idx>_dl|ul`, so a throttle is policed per device even in shape mode. IPv4 only. Seeded from
  the live set's elements across rebuilds (carry `E` lines), else the history's per-address `A` records;
  flushed at the quota rollover; `history` prints them as a third line. And the **`unreserved` target**:
  `nftlim_unres` (the DHCP pools: start/limit of each dhcp section with an interface, not ignored) less
  `nftlim_res` (static hosts' ip, name-only hosts' current lease, the router's own address). `unresync`
  rebuilds only when those lists changed (`/var/run/nft-limiter.unres`); it runs from the dhcp hotplug hook
  and a procd config trigger on dhcp. dnsmasq calls hotplug.d/dhcp only if a script there existed when it
  started, so on a router with none the hook works after dnsmasq's next restart (the rebuild on a dhcp
  config change works at once). Accepted: a firewall reload restores per-device quota use as of the last
  rebuild, as it does for the shared quota objects.
  Also (0c202ed): **waste in shape mode** was d - S, so a row whose downloads pass without a
  class tag (no speed limit: a quota-only rule, or a no-limit rule with a throttle quota, which v3.1.6 had
  too) showed every byte under its quota as waste. Unmarked download passes are now counted apart (`dn`,
  kept in `last.vals`, never in the history) and waste is d - dn - S; the interval in which `dn` first
  appears gets no class waste. Seen on an MT7621's two quota-only rules, whose stored `w` entries were
  removed by hand the same day. Also: **a new row's first interval** was a baseline, so
  what a new rule counted before its first snapshot never reached the history (that
  router's unreserved rule: about 1.2 GB in its quota, missing from its usage). The build now writes the row
  keys it carried nothing to (`/var/run/nft-limiter.fresh`) and `_delta_line` counts their missing
  keys from zero. Tested on synthetic snapshots (macOS awk and busybox) and read-only on that router:
  with no fresh file the delta is identical to before, and a reload there now marks no row fresh.
  A new address in an existing multi-address row is still a baseline for its first interval.

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
