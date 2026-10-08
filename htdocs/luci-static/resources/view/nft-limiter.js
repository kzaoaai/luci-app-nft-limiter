'use strict';
'require view';
'require form';
'require fs';
'require dom';
'require ui';
'require poll';
'require network';
'require uci';
'require nftctl';

var REPO_URL = 'https://github.com/kzaoaai/luci-app-nft-limiter';
var INSTALL_CMD = 'wget -qO- https://raw.githubusercontent.com/kzaoaai/luci-app-nft-limiter/main/install.sh | sh';

function cmpVersions(a, b) {
    var pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}

// About footer: version + repo/releases links, plus a best-effort update check
// that compares the running version against the latest GitHub release. The check
// runs in the admin's browser and fails silently with no internet / on CORS.
function buildFooter() {
    var updateSpan = E('span', {});
    var footer = E('div', {
        'style': 'margin-top:1.5em;padding-top:.6em;border-top:1px solid #ddd;' +
                 'font-size:90%;color:#888'
    }, [
        'luci-app-nft-limiter v' + nftctl.pkgVersion + ' · ',
        E('a', { 'href': REPO_URL, 'target': '_blank', 'rel': 'noreferrer' }, _('GitHub')),
        ' · ',
        E('a', { 'href': REPO_URL + '/releases', 'target': '_blank', 'rel': 'noreferrer' }, _('Releases')),
        ' ', updateSpan
    ]);

    fetch('https://api.github.com/repos/kzaoaai/luci-app-nft-limiter/releases/latest',
          { headers: { 'Accept': 'application/vnd.github+json' } })
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(j) {
            if (!j || !j.tag_name) return;
            var latest = String(j.tag_name).replace(/^v/, '');
            if (cmpVersions(latest, nftctl.pkgVersion) <= 0) return;
            updateSpan.appendChild(E('a', {
                'href': j.html_url || (REPO_URL + '/releases'),
                'target': '_blank', 'rel': 'noreferrer',
                'style': 'color:#4CAF50;font-weight:bold'
            }, '· ' + _('Update available:') + ' v' + latest));
            footer.appendChild(E('div', {
                'style': 'margin-top:.5em'
            }, [
                _('Update via SSH:') + ' ',
                E('code', {
                    'style': 'user-select:all;background:rgba(127,127,127,.15);' +
                             'padding:.1em .4em;border-radius:3px;white-space:nowrap'
                }, INSTALL_CMD)
            ]));
        })
        .catch(function() {});

    return footer;
}

function isIp4(s) {
    var m = String(s).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    for (var i = 1; i <= 4; i++) { if (+m[i] > 255) return false; }
    return true;
}

function ip4ToInt(s) {
    var p = s.split('.').map(Number);
    return (p[0] * 16777216) + (p[1] * 65536) + (p[2] * 256) + p[3];
}

function intToIp4(n) {
    return [ n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255 ].join('.');
}

// A rule's targets as an array: UCI lists come back as arrays, older
// single-value configs as a string (possibly space-separated).
function toList(v) {
    if (Array.isArray(v)) return v.filter(function(x) { return x; });
    return String(v || '').trim().split(/\s+/).filter(function(x) { return x; });
}

// IPv4 address span [lo, hi] of a target (host, CIDR or range), or null
// for IPv6 / unparseable targets.
function ip4Span(t) {
    t = String(t || '').trim();
    var m;
    if (isIp4(t)) return [ ip4ToInt(t), ip4ToInt(t) ];
    if ((m = t.match(/^([\d.]+)\/(\d{1,2})$/)) && isIp4(m[1]) && +m[2] <= 32) {
        var size = Math.pow(2, 32 - m[2]);
        var lo = Math.floor(ip4ToInt(m[1]) / size) * size;
        return [ lo, lo + size - 1 ];
    }
    if ((m = t.match(/^([\d.]+)-([\d.]+)$/)) && isIp4(m[1]) && isIp4(m[2]))
        return [ ip4ToInt(m[1]), ip4ToInt(m[2]) ];
    return null;
}

function hasSchedule(dev) {
    var ts = dev.timestart || '00:00', te = dev.timeend || '00:00';
    return (ts !== '00:00' || te !== '00:00') || (dev.week && dev.week !== '0');
}

var DAY_NAMES = { '1': 'Mon', '2': 'Tue', '3': 'Wed', '4': 'Thu', '5': 'Fri', '6': 'Sat', '7': 'Sun' };

function describeRule(dev) {
    var dl = +(dev.download || 0), ul = +(dev.upload || 0);
    var what = (dev.block === '1') ? _('blocked')
        : (!dl && !ul) ? _('no limit')
        : _('Down %s / Up %s Mbit/s').format(dl || '\u221e', ul || '\u221e');
    var when = _('always');
    if (hasSchedule(dev)) {
        when = (dev.timestart || '00:00') + '\u2013' + (dev.timeend || '00:00');
        if (dev.week && dev.week !== '0')
            when += ' ' + dev.week.split(',').map(function(d) { return DAY_NAMES[d] || d; }).join(',');
    }
    var t = toList(dev.target).join(', ');
    var name = dev.comment ? (dev.comment + ' (' + t + ')') : t;
    return name + ': ' + what + ', ' + when;
}

// For each enabled row that other enabled rows also match (same addresses,
// or a broader target containing them), the rules for those addresses in
// the engine's checking order: fewest addresses first (a list counts the
// total of its members), then scheduled before always-on, then list order.
// The first match wins, and an always-on rule always matches, so everything
// after it is never reached. A row with several targets gets one list per
// target that another rule also matches. Returns
// { sid: { text, dead, related } }; dead = no part of this row is ever
// reached; related = the other rows listed.
function coverageMap(devs) {
    var rows = [];
    devs.forEach(function(dev, idx) {
        if (dev.enable === '0') return;
        var members = toList(dev.target).map(function(t) {
            var span = ip4Span(t);
            return { t: t, span: span, v6: span ? null : t.toLowerCase() };
        });
        if (!members.length) return;
        var size = 0;
        members.forEach(function(m) { size += m.span ? m.span[1] - m.span[0] + 1 : Infinity; });
        rows.push({ dev: dev, idx: idx, members: members, size: size, always: !hasSchedule(dev) });
    });
    var order = function(a, b) {
        if (a.size !== b.size) return (a.size < b.size) ? -1 : 1;
        if (a.always !== b.always) return a.always ? 1 : -1;
        return a.idx - b.idx;
    };
    var covers = function(row, m) {
        return row.members.some(function(o) {
            return (m.span && o.span) ? (o.span[0] <= m.span[0] && o.span[1] >= m.span[1])
                                      : (!!m.v6 && m.v6 === o.v6);
        });
    };
    var out = {};
    rows.forEach(function(r) {
        var lines = [], anyReached = false, anyShown = false, related = [];
        r.members.forEach(function(m) {
            var chain = rows.filter(function(o) { return o === r || covers(o, m); }).sort(order);
            var reached = true, mine = true;
            chain.forEach(function(o) {
                if (o === r) mine = reached;
                if (o.always) reached = false;
            });
            if (mine) anyReached = true;
            if (chain.length < 2) return;
            chain.forEach(function(o) {
                if (o !== r && related.indexOf(o.dev['.name']) < 0) related.push(o.dev['.name']);
            });
            anyShown = true;
            if (lines.length) lines.push('');
            // Listed in checking order: the first that matches wins. "#n"
            // rather than "n." since the addresses themselves contain dots.
            lines.push(r.members.length > 1
                ? _('Multiple rules for %s:').format(m.t)
                : _('Multiple rules for this entry:'));
            reached = true;
            chain.forEach(function(o, i) {
                var line = '#' + (i + 1) + ' ' + describeRule(o.dev);
                if (o === r) line += '  \u2190 ' + _('this row');
                if (!reached) line += '  (' + _('never reached') + ')';
                lines.push(line);
                if (o.always) reached = false;
            });
        });
        if (anyShown)
            out[r.dev['.name']] = { text: lines.join('\n'), dead: !anyReached, related: related };
    });
    return out;
}

// Subnets of the router's own LANs/VLANs as dropdown entries: every
// static-address interface's IPv4 network, e.g. guest -> 192.168.2.0/24.
// Uplinks (DHCP/PPPoE, or a static one with a default gateway such as a 4G
// modem), tunnels and loopback are left out.
function networkTargets(networks) {
    var out = [], seen = {};
    networks.forEach(function(net) {
        if (net.getName() === 'loopback' || net.getProtocol() !== 'static') return;
        if (net.getGatewayAddr()) return;
        (net.getIPAddrs() || []).forEach(function(a) {
            var p = String(a).split('/'), len = +p[1];
            if (!isIp4(p[0]) || !(len >= 0 && len <= 32)) return;
            var mask = len ? (0xFFFFFFFF << (32 - len)) >>> 0 : 0;
            var cidr = intToIp4((ip4ToInt(p[0]) & mask) >>> 0) + '/' + len;
            if (seen[cidr]) return;
            seen[cidr] = true;
            out.push({ val: cidr, name: net.getName() });
        });
    });
    return out.sort(function(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
}

// Accept a single IPv4/IPv6, a v4/v6 CIDR, or an IPv4 range a.b.c.d-e.f.g.h.
// The backend (root/usr/bin/nft-limiter) handles all of these natively.
function validateTarget(value) {
    if (!value) return true;
    var v = String(value).trim();
    if (isIp4(v)) return true;
    var cidr = v.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/);
    if (cidr && isIp4(cidr[1]) && +cidr[2] <= 32) return true;
    var rng = v.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})-(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (rng && isIp4(rng[1]) && isIp4(rng[2]) && ip4ToInt(rng[1]) <= ip4ToInt(rng[2])) return true;
    if (v.indexOf(':') !== -1 && /^[0-9a-fA-F:]+(\/\d{1,3})?$/.test(v)) return true;
    return false;
}

// A CIDR whose address is not on its block boundary (192.168.1.100/28)
// silently covers the aligned block (192.168.1.96-111). Returns a message
// describing what it really covers, or null when it is fine.
function cidrMisaligned(t) {
    var m = String(t).match(/^([\d.]+)\/(\d{1,2})$/);
    if (!m || !isIp4(m[1]) || +m[2] > 32) return null;
    var span = ip4Span(t);
    if (span[0] === ip4ToInt(m[1])) return null;
    return _('%s covers %s-%s; use %s/%s, or a range such as %s-%s').format(
        t, intToIp4(span[0]), intToIp4(span[1]), intToIp4(span[0]), m[2], m[1], intToIp4(span[1]));
}

// --- Stats tab -------------------------------------------------------------
// Data: `nft-limiter stats` prints one JSON document per line, the chain
// first (rule counters, keyed by comment), then each per-address accounting
// set (nftlim_acct_<row>_<dir>, row "def" = global limit). Totals carry over
// rule rebuilds (the engine reseeds the counters) and reset on reboot.
// Speeds come from the difference between two polls.
// Decimal units (1 GB = 10^9 bytes), as quotas are entered and as ISPs
// count, so the numbers line up with both.
function fmtBytes(b) {
    b = Number(b) || 0;
    var units = ['B', 'kB', 'MB', 'GB', 'TB'], i = 0;
    while (b >= 1000 && i < units.length - 1) { b /= 1000; i++; }
    return (i === 0 ? b : b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2)) + ' ' + units[i];
}

function fmtRate(bps) {
    if (bps == null) return '—';
    var m = bps / 1e6;
    return (m >= 100 ? m.toFixed(0) : m >= 1 ? m.toFixed(1) : m.toFixed(2)) + ' Mbit/s';
}

// Parse the stats output: { counters: {comment: {packets, bytes}} (summed
// over rules sharing a comment), sets: {name: [{addr, bytes, packets}]} },
// or null when the chain is not loaded.
function parseStats(text) {
    if (!text) return null;
    var lines = String(text).split('\n'), counters = null, sets = {}, quotas = null;
    lines.forEach(function(line, n) {
        if (!line.trim()) return;
        var data;
        try { data = JSON.parse(line); } catch (e) { return; }
        if (n === 0) counters = {};
        (data && data.nftables || []).forEach(function(item) {
            var r = item.rule;
            if (r && r.comment && Array.isArray(r.expr)) {
                var c = null;
                r.expr.forEach(function(e) { if (e && e.counter) c = e.counter; });
                if (!c) return;
                var m = counters[r.comment] || (counters[r.comment] = { packets: 0, bytes: 0 });
                m.packets += c.packets || 0;
                m.bytes += c.bytes || 0;
            }
            if (item.quota) (quotas = quotas || []).push(item.quota);
            var st = item.set;
            if (st && st.name) {
                sets[st.name] = (st.elem || []).map(function(el) {
                    var e = el && el.elem ? el.elem : el;
                    var cnt = (e && e.counter) || {};
                    return { addr: String(e && e.val != null ? e.val : e), bytes: cnt.bytes || 0, packets: cnt.packets || 0 };
                });
            }
        });
    });
    return counters ? { counters: counters, sets: sets, quotas: quotas || [] } : null;
}

// The Stats view: one row per rule (speed now, totals, dropped), rows that
// cover several addresses expand into a per-address breakdown, and the
// global limit expands into its top talkers. Rows dropping traffic right
// now are tinted.
function createStats(hints) {
    var box = E('div', {});
    var prev = null;      // { t, bytes: {key: bytes} } from the last poll
    var open = {};        // expanded rows, by row id

    var hostName = function(addr) {
        return hints.getHostnameByIPAddr(addr) || hints.getHostnameByIP6Addr(addr) || '';
    };

    var render = function(st) {
        if (st === null) {
            dom.content(box, E('div', { 'class': 'alert-message warning' },
                _('The QoS chain is not loaded. Use the Enable button above to start the limiter.')));
            prev = null;
            return;
        }
        var now = Date.now(), cur = {};
        var dt = prev ? (now - prev.t) / 1000 : 0;
        var val = function(key, bytes) {
            cur[key] = bytes;
            if (!prev || dt <= 0 || prev.bytes[key] == null || bytes < prev.bytes[key]) return null;
            return (bytes - prev.bytes[key]) * 8 / dt;
        };
        var sum = function(names) {
            var b = 0, any = false;
            names.forEach(function(n) { var c = st.counters[n]; if (c) { b += c.bytes; any = true; } });
            return any ? b : null;
        };
        // Per-address entries of a row's accounting sets, merged across
        // IPv4/IPv6 and directions.
        // null when the row has no accounting sets (single-host rows).
        var breakdown = function(id) {
            if (!('nftlim_acct_' + id + '_dl' in st.sets) && !('nftlim_acct_' + id + '_dl6' in st.sets)) return null;
            var by = {};
            [ 'dl', 'ul', 'dl6', 'ul6' ].forEach(function(dir) {
                var dl = (dir.charAt(0) === 'd');
                (st.sets['nftlim_acct_' + id + '_' + dir] || []).forEach(function(e) {
                    var a = by[e.addr] || (by[e.addr] = { addr: e.addr, down: 0, up: 0 });
                    if (dl) a.down += e.bytes; else a.up += e.bytes;
                });
            });
            return Object.keys(by).map(function(k) {
                var a = by[k];
                a.downRate = val('a:' + id + ':' + a.addr + ':d', a.down);
                a.upRate = val('a:' + id + ':' + a.addr + ':u', a.up);
                return a;
            }).sort(function(x, y) { return (y.down + y.up) - (x.down + x.up); });
        };

        var rows = [];
        var addRow = function(id, label, d) {
            var hasDetail = Array.isArray(d.detail);
            var limiting = (d.dlDropRate > 0) || (d.ulDropRate > 0);
            var toggle = hasDetail ? E('span', {
                'class': 'nftl-expand', 'click': function() { open[id] = !open[id]; render(st); }
            }, open[id] ? '▾' : '▸') : E('span', { 'class': 'nftl-expand' });
            var total = function(acc, drop) {
                if (acc == null && drop == null) return '—';
                var parts = [ E('div', {}, fmtBytes(acc || 0)) ];
                if (drop) parts.push(E('div', { 'class': 'nftl-dropped' }, _('%s dropped').format(fmtBytes(drop))));
                return parts;
            };
            // A block shows "trying" when its drop counters grew since the
            // last poll. A scheduled block that is idle may simply be
            // outside its hours, so it shows its window instead of claiming
            // to be blocking (the router's clock decides, not the browser's).
            var now = function(rate, dropRate, blocked) {
                if (blocked) return dropRate > 0 ? E('span', { 'class': 'nftl-limiting' }, _('blocked, trying'))
                    : (d.when ? _('block %s').format(d.when) : _('blocked'));
                var out = [ fmtRate(rate) ];
                if (dropRate > 0) out.push(E('div', { 'class': 'nftl-limiting' }, _('limiting')));
                return out;
            };
            rows.push(E('tr', { 'class': 'tr' + (limiting ? ' nftl-row-limiting' : '') }, [
                E('td', { 'class': 'td' }, [ toggle, label ]),
                E('td', { 'class': 'td' }, now(d.dlRate, d.dlDropRate, d.blocked)),
                E('td', { 'class': 'td' }, now(d.ulRate, d.ulDropRate, d.blocked)),
                E('td', { 'class': 'td' }, total(d.dl, d.dlDrop)),
                E('td', { 'class': 'td' }, total(d.ul, d.ulDrop))
            ]));
            if (hasDetail && open[id] && !d.detail.length)
                rows.push(E('tr', { 'class': 'tr nftl-sub' }, [
                    E('td', { 'class': 'td', 'colspan': 5 }, _('No traffic since the counters started.'))
                ]));
            if (hasDetail && open[id]) d.detail.forEach(function(a) {
                var name = hostName(a.addr);
                rows.push(E('tr', { 'class': 'tr nftl-sub' }, [
                    E('td', { 'class': 'td' }, name ? (name + ' — ' + a.addr) : a.addr),
                    E('td', { 'class': 'td' }, fmtRate(a.downRate)),
                    E('td', { 'class': 'td' }, fmtRate(a.upRate)),
                    E('td', { 'class': 'td' }, fmtBytes(a.down)),
                    E('td', { 'class': 'td' }, fmtBytes(a.up))
                ]));
            });
        };

        uci.sections('nft-limiter', 'device').forEach(function(dev, idx) {
            var target = toList(dev.target).join(', ') || '—';
            var label = dev.comment ? (dev.comment + ' — ' + target) : target;
            if (dev.enable === '0') label += ' ' + _('(disabled)');
            var p = 'dev_' + idx + '_';
            var dlAcc = sum([ p + 'dl_pass', p + 'dl6_pass' ]), ulAcc = sum([ p + 'ul_pass', p + 'ul6_pass' ]);
            var dlDrop = sum([ p + 'dl', p + 'dl6', p + 'dl_q', p + 'dl6_q' ]), ulDrop = sum([ p + 'ul', p + 'ul6', p + 'ul_q', p + 'ul6_q' ]);
            if (dlAcc == null && ulAcc == null && dlDrop == null && ulDrop == null && dev.enable === '0') return;
            addRow('r' + idx, label, {
                blocked: dev.block === '1',
                when: hasSchedule(dev) ? describeRule(dev).replace(/^.*, /, '') : null,
                dl: dlAcc, ul: ulAcc, dlDrop: dlDrop, ulDrop: ulDrop,
                dlRate: dlAcc == null ? null : val(p + 'dlA', dlAcc),
                ulRate: ulAcc == null ? null : val(p + 'ulA', ulAcc),
                dlDropRate: dlDrop == null ? null : val(p + 'dlD', dlDrop),
                ulDropRate: ulDrop == null ? null : val(p + 'ulD', ulDrop),
                detail: breakdown(idx)
            });
        });
        if (st.counters['default_dl'] || st.counters['default_ul']) {
            var det = breakdown('def') || [];
            var tot = { d: 0, u: 0 };
            det.forEach(function(a) { tot.d += a.down; tot.u += a.up; });
            var dd = sum([ 'default_dl' ]), ud = sum([ 'default_ul' ]);
            addRow('def', E('em', {}, _('Global default limit (shared)')), {
                dl: Math.max(0, tot.d - (dd || 0)), ul: Math.max(0, tot.u - (ud || 0)),
                dlDrop: dd, ulDrop: ud,
                dlRate: val('defD', tot.d), ulRate: val('defU', tot.u),
                dlDropRate: dd == null ? null : val('defDD', dd),
                ulDropRate: ud == null ? null : val('defUD', ud),
                detail: det
            });
        }
        prev = { t: now, bytes: cur };

        if (!rows.length) {
            dom.content(box, E('div', { 'class': 'alert-message' },
                _('Chain loaded, but no device or global limit rules are active.')));
            return;
        }
        dom.content(box, [ E('table', { 'class': 'table nftl-stats' }, [
            E('tr', { 'class': 'tr table-titles' }, [
                E('th', { 'class': 'th' }, _('Device')),
                E('th', { 'class': 'th' }, _('Down now')),
                E('th', { 'class': 'th' }, _('Up now')),
                E('th', { 'class': 'th' }, _('Down total')),
                E('th', { 'class': 'th' }, _('Up total'))
            ])
        ].concat(rows)), quotaTable(st.quotas) ]);
    };

    var last = null;
    return {
        node: box,
        update: function(text) { last = parseStats(text); render(last); }
    };
}

// --- Usage over a time range (history) ---------------------------------
// Data: `nft-limiter history <preset|from to>` prints the range's totals and
// per-bucket series as JSON, then a line with the live quota objects.
function spark(values) {
    var max = 0;
    values.forEach(function(v) { if (v > max) max = v; });
    var w = 120, h = 22, n = values.length || 1, bw = w / n;
    var bars = values.map(function(v, i) {
        var bh = max ? Math.max(v ? 1 : 0, Math.round(v / max * h)) : 0;
        return '<rect x="' + (i * bw).toFixed(2) + '" y="' + (h - bh) + '" width="' + Math.max(bw - 0.5, 0.5).toFixed(2) + '" height="' + bh + '"/>';
    }).join('');
    var svg = E('span', { 'class': 'nftl-spark' });
    svg.innerHTML = '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + bars + '</svg>';
    return svg;
}

function addSeries(a, b) {
    if (!a) return b ? b.slice() : [];
    if (!b) return a.slice();
    return a.map(function(v, i) { return v + (b[i] || 0); });
}

function createUsage(hints) {
    var box = E('div', {});
    var open = {};
    var hostName = function(addr) {
        return hints.getHostnameByIPAddr(addr) || hints.getHostnameByIP6Addr(addr) || '';
    };
    var fmtTime = function(t) {
        return new Date(t * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    };

    var render = function(text) {
        var lines = String(text || '').split('\n'), data = null, quotas = [];
        try { data = JSON.parse(lines[0]); } catch (e) {}
        try {
            (JSON.parse(lines[1] || '{}').nftables || []).forEach(function(it) { if (it.quota) quotas.push(it.quota); });
        } catch (e) {}
        if (!data) {
            dom.content(box, E('div', { 'class': 'alert-message warning' },
                _('No usage history yet. It starts recording when the limiter runs, about every 11 minutes.')));
            return;
        }
        var T = data.totals || {}, S = data.series || {};
        var rows = [];
        var sub = function(prefix) {
            var by = {};
            Object.keys(T).forEach(function(k) {
                if (k.indexOf(prefix) !== 0) return;
                var rest = k.substr(prefix.length), cut = rest.lastIndexOf('|');
                var addr = rest.substr(0, cut), dir = rest.substr(cut + 1);
                var a = by[addr] || (by[addr] = { addr: addr, d: 0, u: 0 });
                a[dir] += T[k];
            });
            return Object.keys(by).map(function(k) { return by[k]; })
                .sort(function(x, y) { return (y.d + y.u) - (x.d + x.u); });
        };
        var addRow = function(id, label, d, u, dropped, series, detail) {
            var hasDetail = Array.isArray(detail);
            var toggle = hasDetail ? E('span', {
                'class': 'nftl-expand', 'click': function() { open[id] = !open[id]; render(text); }
            }, open[id] ? '\u25be' : '\u25b8') : E('span', { 'class': 'nftl-expand' });
            rows.push(E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td' }, [ toggle, label ]),
                E('td', { 'class': 'td' }, fmtBytes(d)),
                E('td', { 'class': 'td' }, fmtBytes(u)),
                E('td', { 'class': 'td' }, dropped ? E('span', { 'class': 'nftl-dropped' }, fmtBytes(dropped)) : '\u2014'),
                E('td', { 'class': 'td' }, spark(series || []))
            ]));
            if (hasDetail && open[id]) {
                if (!detail.length) rows.push(E('tr', { 'class': 'tr nftl-sub' }, [
                    E('td', { 'class': 'td', 'colspan': 5 }, _('No traffic in this range.')) ]));
                detail.forEach(function(a) {
                    var name = hostName(a.addr);
                    rows.push(E('tr', { 'class': 'tr nftl-sub' }, [
                        E('td', { 'class': 'td' }, name ? (name + ' \u2014 ' + a.addr) : a.addr),
                        E('td', { 'class': 'td' }, fmtBytes(a.d)),
                        E('td', { 'class': 'td' }, fmtBytes(a.u)),
                        E('td', { 'class': 'td' }, ''), E('td', { 'class': 'td' }, '')
                    ]));
                });
            }
        };

        uci.sections('nft-limiter', 'device').forEach(function(dev, idx) {
            var list = toList(dev.target);
            if (!list.length) return;
            var rk = list.slice().sort().join(','), p = 'R|' + rk + '|';
            var d = T[p + 'd'] || 0, u = T[p + 'u'] || 0, dr = (T[p + 'dd'] || 0) + (T[p + 'ud'] || 0);
            if (!d && !u && !dr && dev.enable === '0') return;
            var label = dev.comment ? (dev.comment + ' \u2014 ' + list.join(', ')) : list.join(', ');
            if (dev.enable === '0') label += ' ' + _('(disabled)');
            var multi = list.length > 1 || /[\/-]/.test(list[0]);
            addRow('r' + idx, label, d, u, dr, addSeries(S[p + 'd'], S[p + 'u']), multi ? sub('A|' + rk + '|') : null);
        });
        var def = sub('A|default|');
        if (def.length || T['R|default|dd'] || T['R|default|ud']) {
            var od = 0, ou = 0;
            def.forEach(function(a) { od += a.d; ou += a.u; });
            var dd = T['R|default|dd'] || 0, ud = T['R|default|ud'] || 0;
            addRow('def', E('em', {}, _('Global default limit (shared)')),
                Math.max(0, od - dd), Math.max(0, ou - ud), dd + ud, null, def);
        }

        var ifRows = [];
        Object.keys(T).forEach(function(k) {
            var m = k.match(/^I\|(.+)\|rx$/);
            if (!m) return;
            var n = m[1];
            ifRows.push(E('tr', { 'class': 'tr' }, [
                E('td', { 'class': 'td' }, n),
                E('td', { 'class': 'td' }, fmtBytes(T['I|' + n + '|rx'] || 0)),
                E('td', { 'class': 'td' }, fmtBytes(T['I|' + n + '|tx'] || 0)),
                E('td', { 'class': 'td' }, fmtBytes((T['I|' + n + '|rx'] || 0) + (T['I|' + n + '|tx'] || 0))),
                E('td', { 'class': 'td' }, spark(addSeries(S['I|' + n + '|rx'], S['I|' + n + '|tx'])))
            ]));
        });

        var head = function(cols) {
            return E('tr', { 'class': 'tr table-titles' }, cols.map(function(c) { return E('th', { 'class': 'th' }, c); }));
        };
        var out = [
            E('p', { 'class': 'nftl-range-label' }, _('%s to %s').format(fmtTime(data.from), fmtTime(Math.min(data.to, data.now))))
        ];
        out.push(rows.length ? E('table', { 'class': 'table nftl-stats' },
            [ head([ _('Device'), _('Down'), _('Up'), _('Dropped'), _('Trend') ]) ].concat(rows))
            : E('div', { 'class': 'alert-message' }, _('No rule traffic in this range.')));
        if (ifRows.length) {
            out.push(E('h4', {}, _('Uplinks')));
            out.push(E('p', {}, _('All traffic through each rate-limited interface, the router\'s own included: the figure to compare with your ISP\'s counter.')));
            out.push(E('table', { 'class': 'table nftl-stats' },
                [ head([ _('Interface'), _('Received'), _('Sent'), _('Total'), _('Trend') ]) ].concat(ifRows)));
        }
        if (quotas.length) out.push(quotaTable(quotas));
        dom.content(box, out);
    };

    return { node: box, render: render };
}

// Quota usage, from the live quota objects (nftlim_q_<row index>).
function quotaTable(quotas) {
    var devs = uci.sections('nft-limiter', 'device');
    var rows = quotas.filter(function(q) { return /^nftlim_q_\d+$/.test(q.name); }).map(function(q) {
        var dev = devs[+q.name.substr(9)] || {};
        var used = q.used || 0, limit = q.bytes || 0, pct = limit ? Math.min(100, used / limit * 100) : 0;
        var label = dev.comment || toList(dev.target).join(', ');
        var action = dev.quota_action === 'throttle'
            ? _('then %s Mbit/s').format(dev.quota_rate || '1') : _('then blocked');
        return E('tr', { 'class': 'tr' }, [
            E('td', { 'class': 'td' }, label),
            E('td', { 'class': 'td' }, [
                E('div', { 'class': 'nftl-qbar' }, E('div', {
                    'class': 'nftl-qfill' + (pct >= 100 ? ' nftl-qfull' : ''), 'style': 'width:' + pct.toFixed(1) + '%'
                })),
                E('div', { 'class': 'nftl-qtext' }, _('%s of %s').format(fmtBytes(used), fmtBytes(limit)))
            ]),
            E('td', { 'class': 'td' }, dev.quota_period === 'period' ? _('this billing period') : _('today')),
            E('td', { 'class': 'td' }, pct >= 100 ? E('strong', {}, action) : action)
        ]);
    });
    if (!rows.length) return '';
    return E('div', {}, [
        E('h4', {}, _('Quotas')),
        E('table', { 'class': 'table nftl-stats' }, [
            E('tr', { 'class': 'tr table-titles' }, [ _('Rule'), _('Used'), _('Period'), _('When used up') ]
                .map(function(c) { return E('th', { 'class': 'th' }, c); }))
        ].concat(rows))
    ]);
}

return view.extend({
    load: function() {
        return Promise.all([
            network.getHostHints(),
            uci.load('nft-limiter'),
            L.resolveDefault(uci.load('firewall'), null),
            network.getNetworks(),
            L.resolveDefault(fs.exec_direct('/sbin/ip', ['-j', 'neigh', 'show']), null),
            L.resolveDefault(fs.exec_direct('/usr/bin/nft-limiter', [ 'stats' ]), null)
        ]);
    },

    render: function(data) {
        var hints = data[0];
        var networks = data[3];

        // Map of IP address -> kernel neighbour (ARP/NDP) state for a
        // simple online/offline dot next to each device in the dropdown.
        var neighState = {};
        if (data[4]) {
            try {
                JSON.parse(data[4]).forEach(function(n) {
                    if (n.dst && Array.isArray(n.state) && n.state.length)
                        neighState[n.dst] = n.state[0];
                });
            } catch (e) {}
        }
        var deviceLabel = function(text, ip) {
            var state = neighState[ip];
            var online = state && /^(REACHABLE|STALE|DELAY|PROBE|PERMANENT|NOARP)$/.test(state);
            return E('span', { 'title': state || _('not in neighbour table') }, [
                E('span', {
                    'style': 'display:inline-block;width:8px;height:8px;border-radius:50%;' +
                             'margin-right:6px;vertical-align:middle;background:' +
                             (online ? '#4CAF50' : '#bbb')
                }),
                text
            ]);
        };

        var m, s, o;

        // HH:MM time field, shared by the global and per-device sections.
        var addTimeOption = function(section, name, label) {
            var opt = section.option(form.Value, name, label);
            opt.placeholder = '00:00';
            opt.editable = true;
            opt.validate = function(section_id, value) {
                if (!value) return true;
                if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))
                    return _('Must be HH:MM (00:00–23:59)');
                return true;
            };
            return opt;
        };

        // Weekday selector (none checked = every day), shared by both sections.
        // UCI stores week as comma-separated day numbers, '0' meaning every day.
        var addWeekOption = function(section, label, desc) {
            var opt = section.option(form.MultiValue, 'week', label);
            opt.placeholder = _('Every day');
            var weekDesc = desc || _('Leave empty for every day.');
            var origWeekRender = opt.render;
            opt.render = function(option_index, section_id, in_table) {
                this.description = in_table ? null : weekDesc;
                return origWeekRender.apply(this, arguments);
            };
            opt.value('1', _('Mon'));
            opt.value('2', _('Tue'));
            opt.value('3', _('Wed'));
            opt.value('4', _('Thu'));
            opt.value('5', _('Fri'));
            opt.value('6', _('Sat'));
            opt.value('7', _('Sun'));
            opt.cfgvalue = function(section_id) {
                var val = uci.get('nft-limiter', section_id, 'week');
                if (!val || val === '0') return '';
                return val.replace(/,/g, ' ');
            };
            opt.write = function(section_id, formvalue) {
                var val = Array.isArray(formvalue) ? formvalue.join(',') :
                          (formvalue ? String(formvalue).trim().replace(/\s+/g, ',') : '0');
                if (!val) val = '0';
                uci.set('nft-limiter', section_id, 'week', val);
            };
            opt.remove = function(section_id) {
                uci.set('nft-limiter', section_id, 'week', '0');
            };
            opt.textvalue = function(section_id) {
                var val = uci.get('nft-limiter', section_id, 'week');
                if (!val || val === '0') return _('Every day');
                var days = val.split(',').sort();
                var names = {'1':'Mon','2':'Tue','3':'Wed','4':'Thu','5':'Fri','6':'Sat','7':'Sun'};
                if (days.length === 7) return _('Every day');
                if (days.join(',') === '1,2,3,4,5') return _('Weekdays');
                if (days.join(',') === '6,7') return _('Weekend');
                return days.map(function(d) { return names[d] || d; }).join(', ');
            };
            return opt;
        };

        // The Map's description is shown beside its title (decorateMap).
        m = new form.Map('nft-limiter', _('NFT Limiter'));

        // ------------------------------------------------------------------
        // Global settings section
        // ------------------------------------------------------------------
        s = m.section(form.TypedSection, 'nft-limiter', _('Global Settings'));
        s.anonymous = true;
        s.addremove = false;

        // Service on/off and live status now live on the Status tab
        // (Enable / Disable / Restart controls).

        // Which interfaces are rate-limited (applies to per-device AND global rules).
        o = s.option(form.MultiValue, 'iface', _('Rate-Limited Interfaces'),
            _('Select WAN / VPN interfaces whose traffic should be rate-limited. ' +
              'Traffic between local interfaces is never affected.'));
        o.default = 'wan';
        networks.forEach(function(net) {
            var name = net.getName();
            if (name !== 'loopback')
                o.value(name, name + ' (' + net.getI18n() + ')');
        });
        // Warn about uplinks that are not selected: interfaces in a
        // masquerading (NAT) firewall zone, i.e. where LAN traffic can leave
        // the router. Traffic routed out through one of those (failover, or
        // policy-routed VPN) skips every limit and block. Overlay networks
        // with no protocol of their own (e.g. Tailscale) are left out.
        var protoOf = {};
        networks.forEach(function(net) { protoOf[net.getName()] = net.getProtocol(); });
        var natUplinks = [];
        uci.sections('firewall', 'zone').forEach(function(z) {
            if (z.masq !== '1') return;
            L.toArray(z.network).forEach(function(n) {
                if (protoOf[n] && protoOf[n] !== 'none' && natUplinks.indexOf(n) < 0)
                    natUplinks.push(n);
            });
        });
        var uplinkWarn = E('div', { 'class': 'nftl-warn' });
        var updateUplinkWarn = function(selected) {
            selected = L.toArray(selected);
            var missing = natUplinks.filter(function(n) { return selected.indexOf(n) < 0; });
            uplinkWarn.style.display = missing.length ? '' : 'none';
            uplinkWarn.textContent = missing.length ? _('Not rate-limited: %s. Traffic routed out through these uplinks (e.g. failover, or policy-routed VPN) skips every limit and block.').format(missing.join(', ')) : '';
        };
        updateUplinkWarn(uci.get_first('nft-limiter', 'nft-limiter', 'iface') || 'wan');
        o.onchange = function(ev, section_id, value) { updateUplinkWarn(value); };

        o = s.option(form.Value, 'period_day', _('Billing Period Starts On Day'),
            _('Day of the month (1-31) your ISP starts a new billing period; in shorter months, the last day. Used by the Stats ranges "This period" / "Last period" and by per-period quotas.'));
        o.datatype = 'range(1,31)';
        o.placeholder = '1';

        // Toggle for the global default (catch-all) limit, backed by a real UCI
        // flag the engine honours. Initial state is inferred from existing limit
        // values so upgrades don't silently drop a configured global limit.
        o = s.option(form.Flag, 'glimit', _('Enable Global Default Limit'),
            _('Apply one shared limit to all traffic not covered by a per-device ' +
              'rule: a single cap for all of those devices together, not a ' +
              'limit per device. When off, only per-device rules apply.'));
        o.rmempty = false;
        o.default = '0';
        o.cfgvalue = function(section_id) {
            var v = uci.get('nft-limiter', section_id, 'glimit');
            if (v === '0' || v === '1') return v;
            var dl = parseFloat(uci.get('nft-limiter', section_id, 'download'));
            var ul = parseFloat(uci.get('nft-limiter', section_id, 'upload'));
            return ((dl > 0) || (ul > 0)) ? '1' : '0';
        };

        // Keep a gated field's stored value when it is merely collapsed by the
        // glimit toggle, so re-enabling restores the previous numbers. The
        // backend ignores these while glimit=0, so a remembered value is inert.
        // A genuine clear (field visible but emptied) still removes normally.
        var keepWhenCollapsed = function(opt) {
            var origRemove = opt.remove;
            opt.remove = function(section_id) {
                if (!this.isActive(section_id)) return;
                return origRemove.apply(this, arguments);
            };
            return opt;
        };

        o = s.option(form.Value, 'download', _('Global Download Limit (Mbit/s)'),
            _('One total shared by all devices without their own rule, not a per-device limit. Set to 0 for unlimited.'));
        o.datatype = 'ufloat';
        o.placeholder = '10';
        o.depends('glimit', '1');
        keepWhenCollapsed(o);

        o = s.option(form.Value, 'upload', _('Global Upload Limit (Mbit/s)'),
            _('One total shared by all devices without their own rule, not a per-device limit. Set to 0 for unlimited.'));
        o.datatype = 'ufloat';
        o.placeholder = '5';
        o.depends('glimit', '1');
        keepWhenCollapsed(o);

        // Schedule sub-toggle: reveals the time/day fields and is honoured by the
        // engine (off => global limit applies whenever enabled, all hours/days).
        // Initial state is inferred from an existing window so upgrades don't hide
        // a configured schedule.
        o = s.option(form.Flag, 'gschedule', _('Limit Only During Certain Times'),
            _('Restrict the global limit to a time window and/or specific days. ' +
              'When off, the global limit applies whenever it is enabled.'));
        o.rmempty = false;
        o.default = '0';
        o.depends('glimit', '1');
        o.cfgvalue = function(section_id) {
            var v = uci.get('nft-limiter', section_id, 'gschedule');
            if (v === '0' || v === '1') return v;
            var ts = uci.get('nft-limiter', section_id, 'timestart');
            var te = uci.get('nft-limiter', section_id, 'timeend');
            var wk = uci.get('nft-limiter', section_id, 'week');
            var hasWindow = (ts && ts !== '00:00') || (te && te !== '00:00');
            var hasDays = wk && wk !== '0';
            return (hasWindow || hasDays) ? '1' : '0';
        };

        keepWhenCollapsed(addTimeOption(s, 'timestart', _('Global Time Start'))).depends({ glimit: '1', gschedule: '1' });
        keepWhenCollapsed(addTimeOption(s, 'timeend', _('Global Time End'))).depends({ glimit: '1', gschedule: '1' });
        keepWhenCollapsed(addWeekOption(s, _('Global Days'),
            _('The global limit applies only inside this window/days; outside it, ' +
              'un-matched traffic is unrestricted. Leave times at 00:00 and days ' +
              'empty to always apply.'))).depends({ glimit: '1', gschedule: '1' });

        // Advanced: off by default, shown with the switch below. The switch
        // is only a view setting (stored, but not read by the engine).
        o = s.option(form.Flag, 'show_advanced', _('Advanced Settings'));
        o.default = '0';
        o = s.option(form.Value, 'hist_months', _('Keep History For (months)'),
            _('How long daily usage totals are kept (detailed history: 7 days; hourly: 45 days). Default 13.'));
        o.datatype = 'range(1,60)';
        o.placeholder = '13';
        o.depends('show_advanced', '1');
        o = s.option(form.Flag, 'hist_save', _('Save History To Flash'),
            _('Copy the usage history to flash once a day and at shutdown (a few hundred kB at most), so it survives reboots. Off keeps it in RAM only and removes the flash copy.'));
        o.default = '1';
        o.rmempty = false;
        o.depends('show_advanced', '1');
        o = s.option(form.Value, 'burst', _('Burst (seconds)'),
            _('How much traffic may pass above a limit in a short burst, in seconds of that limit (default 2). Lower is stricter and smoother; higher keeps web browsing snappier.'));
        o.datatype = 'range(0.1,30)';
        o.placeholder = '2';
        o.depends('show_advanced', '1');

        // ------------------------------------------------------------------
        // Per-device rules section
        // ------------------------------------------------------------------
        s = m.section(form.GridSection, 'device', _('Per-Device Rules'));
        s.anonymous = true;
        s.addremove = true;
        s.sortable  = true;
        s.nodescription = true;
        // Shown as a "?" hint on the section heading (decorateMap).
        var deviceHelp = _('Targets are matched most-specific first: a single IP (or smaller subnet) takes priority over a broader subnet or range that contains it, regardless of row order. Two partially overlapping ranges cannot both apply where they overlap.') + ' ' +
            _('A single IPv4 device whose MAC is known is also matched on IPv6, sharing the same limit. Subnets and ranges apply to IPv4 only. Block drops the device\'s WAN traffic instead of limiting it.');

        // enable toggle
        // Column widths: fixed for the short fields, the rest shared by
        // Device and Comment. The grid CSS (see render) makes each input
        // fill its cell, so these widths are what the fields get.
        o = s.option(form.Flag, 'enable', _('Enabled'));
        o.default = '1';
        o.rmempty = false;
        o.editable = true;
        o.width = 36;

        // Compact one-line grid headers, with the full wording on hover. The
        // Edit dialog keeps each option's full title.
        var shortHeads = {
            enable:    [ '\u2713', _('Enabled') ],
            download:  [ _('Down'), _('Download limit (Mbit/s)') ],
            upload:    [ _('Up'), _('Upload limit (Mbit/s)') ],
            timestart: [ _('Start'), _('Time start (HH:MM)') ],
            timeend:   [ _('End'), _('Time end (HH:MM)') ]
        };
        var origHeaderRows = s.renderHeaderRows;
        s.renderHeaderRows = function() {
            var rows = origHeaderRows.apply(this, arguments);
            var ths = rows.querySelectorAll('tr.cbi-section-table-titles th');
            var cols = this.children.filter(function(opt) { return !opt.modalonly; });
            cols.forEach(function(opt, i) {
                var head = shortHeads[opt.option], th = ths[i];
                if (!head || !th) return;
                dom.content(th, head[0]);
                th.title = head[1];
                if (opt.option === 'enable') th.style.textAlign = 'center';
            });
            return rows;
        };

        // Targets: tick any mix of networks and devices, or type an IP, CIDR
        // or range (custom entry). All of a row's targets share its limit.
        o = s.option(form.MultiValue, 'target', _('Device (IP / Range)'));
        o.width = '22%';
        o.rmempty   = false;
        o.editable  = true;
        o.create    = true;
        o.placeholder = _('Pick devices, or type an IP / CIDR / range');
        o.validate = function(section_id, value) {
            var list = toList(value);
            var bad = list.filter(function(t) { return !validateTarget(t); });
            if (bad.length) return _('Not an IP, CIDR, or IPv4 range: %s').format(bad.join(', '));
            for (var i = 0; i < list.length; i++) {
                var mis = cidrMisaligned(list[i]);
                if (mis) return mis;
            }
            return true;
        };
        var namedDevices = [], unnamedDevices = [];
        var macByIp4 = {};
        hints.getMACHints().forEach(function(entry) {
            var mac  = entry[0];
            var ip4  = hints.getIPAddrByMACAddr(mac);
            if (ip4) macByIp4[ip4] = mac.toLowerCase();
            var name = hints.getHostnameByMACAddr(mac) || '';
            var ip   = hints.getIPAddrByMACAddr(mac);
            var ip6  = hints.getIP6AddrByMACAddr(mac);
            var addr = ip || ip6;
            if (!addr) return;
            var list = name ? namedDevices : unnamedDevices;
            list.push({ val: addr, label: name ? (name + ' \u2014 ' + addr) : addr, named: !!name, ip: addr });
        });
        namedDevices.sort(function(a, b) {
            return a.label.toLowerCase() < b.label.toLowerCase() ? -1
                 : a.label.toLowerCase() > b.label.toLowerCase() ? 1 : 0;
        });
        unnamedDevices.sort(function(a, b) {
            var aParts = (a.ip || a.val).split('.').map(Number);
            var bParts = (b.ip || b.val).split('.').map(Number);
            for (var i = 0; i < 4; i++) {
                if ((aParts[i] || 0) !== (bParts[i] || 0))
                    return (aParts[i] || 0) - (bParts[i] || 0);
            }
            return a.val < b.val ? -1 : a.val > b.val ? 1 : 0;
        });
        // Whole networks first, then devices.
        var netNames = {};
        networkTargets(networks).forEach(function(n) {
            netNames[n.val] = n.name;
            o.value(n.val, E('span', { 'title': _('Whole network') }, [
                E('strong', {}, n.name), ' \u2014 ' + n.val
            ]));
        });
        namedDevices.concat(unnamedDevices).forEach(function(d) { o.value(d.val, deviceLabel(d.label, d.ip)); });
        o.textvalue = function(section_id) {
            return toList(this.cfgvalue(section_id)).map(function(val) {
                if (netNames[val]) return netNames[val] + ' \u2014 ' + val;
                var name = hints.getHostnameByIPAddr(val)
                        || hints.getHostnameByIP6Addr(val);
                return name ? (name + ' \u2014 ' + val) : val;
            }).join(', ');
        };

        // Block: drop all of the device's WAN traffic (both directions, IPv4
        // and IPv6) instead of rate-limiting it. Sits just before Down/Up and
        // greys them out while ticked; their values are kept but ignored.
        // Follows the row's time window and days like a limit.
        var lockSpeeds = function(node, locked) {
            if (!node) return;
            node.querySelectorAll('input').forEach(function(i) { i.disabled = locked; });
            node.style.opacity = locked ? '0.4' : '';
            node.title = locked ? _('Ignored while Block is ticked') : '';
        };
        o = s.option(form.Flag, 'block', _('Block'));
        o.default = '0';
        o.editable = true;
        o.width = 52;
        o.onchange = function(ev, section_id, value) {
            var sect = this.section;
            ['download', 'upload'].forEach(function(name) {
                var el = sect.getUIElement(section_id, name);
                lockSpeeds(el && el.node, value === '1');
            });
        };
        // Down/Up render locked when the row is already blocked.
        var lockIfBlocked = function(opt) {
            var origRender = opt.renderWidget;
            opt.renderWidget = function(section_id) {
                var node = origRender.apply(this, arguments);
                lockSpeeds(node, uci.get('nft-limiter', section_id, 'block') === '1');
                return node;
            };
            return opt;
        };

        // download limit
        o = s.option(form.Value, 'download', _('Down (Mbit/s)'));
        o.datatype = 'ufloat';
        o.placeholder = '0';
        o.editable = true;
        o.width = 72;
        lockIfBlocked(o);

        // upload limit
        o = s.option(form.Value, 'upload', _('Up (Mbit/s)'));
        o.datatype = 'ufloat';
        o.placeholder = '0';
        o.editable = true;
        o.width = 72;
        lockIfBlocked(o);

        // time start / end
        addTimeOption(s, 'timestart', _('Time Start')).width = 84;
        addTimeOption(s, 'timeend', _('Time End')).width = 84;

        // weekday selector (none checked = every day), editable inline in the grid
        o = addWeekOption(s, _('Days'));
        o.editable = true;
        o.width = 120;

        // description / comment
        o = s.option(form.Value, 'comment', _('Comment'));
        o.placeholder = _('optional note');
        o.editable = true;
        o.width = '18%';

        // Quota (Edit dialog only): a data allowance for the rule, both
        // directions and all its targets together. Once used up, the rule
        // blocks or throttles until the period ends (reset shortly after
        // midnight, router time). Ignored while Block is ticked.
        o = s.option(form.Value, 'quota', _('Quota (GB)'),
            _('Data allowance for this rule, download and upload together, across all its targets. Leave empty for none.'));
        o.modalonly = true;
        o.datatype = 'ufloat';
        o.placeholder = _('none');
        o = s.option(form.ListValue, 'quota_period', _('Quota Period'));
        o.modalonly = true;
        o.value('day', _('Per day'));
        o.value('period', _('Per billing period'));
        o.default = 'day';
        o = s.option(form.ListValue, 'quota_action', _('When Used Up'));
        o.modalonly = true;
        o.value('block', _('Block'));
        o.value('throttle', _('Throttle'));
        o.default = 'block';
        o = s.option(form.Value, 'quota_rate', _('Throttle To (Mbit/s)'));
        o.modalonly = true;
        o.datatype = 'ufloat';
        o.placeholder = '1';
        o.depends('quota_action', 'throttle');

        // On save, record each single-IPv4 rule's MAC so the backend can add
        // IPv6 rules even while the device is offline at boot. Unknown or
        // non-host targets clear it (the backend then falls back to leases
        // and the neighbour table). Runs after the form is parsed, so a
        // target edited in this save is seen.
        this.fillMacs = function() {
            uci.sections('nft-limiter', 'device').forEach(function(dev) {
                var macs = [];
                toList(dev.target).forEach(function(t) {
                    var mac = isIp4(t) ? macByIp4[t] : null;
                    if (mac && macs.indexOf(mac) < 0) macs.push(mac);
                });
                if (macs.length) {
                    if (toList(dev.mac).join(' ') !== macs.join(' '))
                        uci.set('nft-limiter', dev['.name'], 'mac', macs);
                } else if (dev.mac) {
                    uci.unset('nft-limiter', dev['.name'], 'mac');
                }
            });
        };
        this.map = m;

        // Compact layout, re-applied on every Map render (the grid re-renders
        // the Map when rows are added or removed):
        //   - the Map description sits on the title line;
        //   - Global Settings descriptions become "?" hints on their labels;
        //   - the Per-Device Rules heading gets its "?" hint and the live
        //     count of devices with loaded rules.
        // Hint popup: the "?" hints and coverage "i" badges show their text in a
        // small popup on click/tap, since touch browsers (iOS Safari) never
        // show title tooltips. Tapping elsewhere or the same icon closes it.
        var tip = null;
        // A coverage badge's popup also highlights its row and the related
        // rows in the grid until the popup closes.
        var setHighlight = function(sids, on) {
            (sids || []).forEach(function(sid, i) {
                var tr = document.querySelector('#cbi-nft-limiter-device tr[data-section-id="' + sid + '"]');
                if (tr) tr.classList.toggle(i ? 'nftl-related' : 'nftl-self', on);
            });
        };
        var closeTip = function() {
            if (!tip) return;
            setHighlight(tip.anchor.highlight, false);
            tip.remove();
            tip = null;
        };
        document.addEventListener('click', function(ev) {
            if (tip && !tip.contains(ev.target)) closeTip();
        });
        var toggleTip = function(ev) {
            ev.preventDefault();
            ev.stopPropagation();
            var anchor = ev.currentTarget;
            if (tip && tip.anchor === anchor) { closeTip(); return; }
            closeTip();
            tip = E('div', { 'class': 'nftl-tip' }, anchor.getAttribute('title'));
            tip.anchor = anchor;
            setHighlight(anchor.highlight, true);
            document.body.appendChild(tip);
            var r = anchor.getBoundingClientRect();
            var maxLeft = document.documentElement.clientWidth - tip.offsetWidth - 8;
            tip.style.left = (window.scrollX + Math.max(8, Math.min(r.left, maxLeft))) + 'px';
            tip.style.top = (window.scrollY + r.bottom + 6) + 'px';
        };
        var helpHint = function(text) {
            return E('span', { 'class': 'nftl-help', 'title': text, 'click': toggleTip });
        };
        var countSpan = E('span', { 'class': 'nftl-count' });
        var setCount = function(n) {
            countSpan.textContent = (n == null) ? '' : _('%d active').format(n);
        };
        var decorateMap = function(mapEl) {
            var h2 = mapEl.querySelector(':scope > h2');
            if (h2 && !h2.querySelector('.nftl-sub'))
                h2.appendChild(E('span', { 'class': 'nftl-sub' }, _(
                    'Per-device bandwidth control via nftables rate limiting. ' +
                    'Requires OpenWrt 25.12+ with firewall4 / nftables.')));

            mapEl.querySelectorAll('#cbi-nft-limiter-nft-limiter .cbi-value').forEach(function(row) {
                var d = row.querySelector('.cbi-value-description');
                var l = row.querySelector('.cbi-value-title');
                if (!d || !l) return;
                var text = d.textContent.trim();
                d.remove();
                if (text) l.append(' ', helpHint(text));
            });

            // Coverage "i" badge at the start of each covered row's Device cell:
            // blue = also matched by another rule (details on hover),
            // orange = shadowed, this row can never apply.
            var ifaceField = mapEl.querySelector('#cbi-nft-limiter-nft-limiter .cbi-value[data-name="iface"] .cbi-value-field');
            if (ifaceField && uplinkWarn.parentNode !== ifaceField)
                ifaceField.appendChild(uplinkWarn);

            var cover = coverageMap(uci.sections('nft-limiter', 'device'));
            mapEl.querySelectorAll('#cbi-nft-limiter-device tr[data-section-id]').forEach(function(tr) {
                var cell = tr.querySelector('td[data-name="target"] > div');
                if (!cell) return;
                var old = cell.querySelector('.nftl-cover');
                if (old) old.remove();
                var sid = tr.getAttribute('data-section-id');
                var c = cover[sid];
                if (!c) return;
                var badge = E('span', {
                    'class': 'nftl-cover' + (c.dead ? ' nftl-dead' : ''),
                    'title': c.text,
                    'click': toggleTip
                }, 'i');
                badge.highlight = [ sid ].concat(c.related);
                cell.insertBefore(badge, cell.firstChild);
            });

            // Global limit and schedule fields share a row each: the other
            // fields' widgets move into the first field's row under short
            // captions. LuCI finds widgets by id and checks dependencies on
            // the original rows, which stay in the DOM (hidden), so saving,
            // validation and show/hide keep working.
            var mergeRow = function(label, parts) {
                var rows = parts.map(function(p) {
                    return mapEl.querySelector('#cbi-nft-limiter-nft-limiter .cbi-value[data-name="' + p[0] + '"]');
                });
                if (rows.some(function(r) { return !r; })) return;
                var field = rows[0].querySelector('.cbi-value-field');
                var title = rows[0].querySelector('.cbi-value-title');
                if (!field || field.classList.contains('nftl-inline')) return;
                var group = E('div', { 'class': 'nftl-inline' });
                var mainHelp = title && title.querySelector('.nftl-help');
                rows.forEach(function(row, i) {
                    var f = row.querySelector('.cbi-value-field');
                    var widget = E('div', {}, Array.prototype.slice.call(f.childNodes));
                    var caption = E('span', { 'class': 'nftl-caption' }, parts[i][1]);
                    // Keep a merged field's own "?" hint when it says
                    // something the row's main hint doesn't.
                    var help = (i > 0) && row.querySelector('.cbi-value-title .nftl-help');
                    if (help && (!mainHelp || help.title !== mainHelp.title))
                        caption.append(' ', help);
                    group.appendChild(E('div', { 'class': 'nftl-part' }, [ caption, widget ]));
                    if (i > 0) row.classList.add('nftl-merged');
                });
                field.appendChild(group);
                if (title && title.firstChild && title.firstChild.nodeType === 3)
                    title.firstChild.nodeValue = label;
            };
            mergeRow(_('Global Limit (Mbit/s)'), [
                [ 'download', _('Down') ], [ 'upload', _('Up') ] ]);
            mergeRow(_('Global Schedule'), [
                [ 'timestart', _('Start') ], [ 'timeend', _('End') ], [ 'week', _('Days') ] ]);

            var h3 = mapEl.querySelector('#cbi-nft-limiter-device > h3');
            if (h3 && !h3.querySelector('.nftl-help'))
                h3.append(' ', helpHint(deviceHelp), ' ', countSpan);
        };
        var origRenderContents = m.renderContents;
        m.renderContents = function() {
            return origRenderContents.apply(this, arguments).then(function(el) {
                decorateMap(this.root);
                return el;
            }.bind(this));
        };

        return m.render().then(function(formNode) {
            // Stats tab. "Live" shows speeds and running totals, refreshed every
            // 5 s; the other ranges show usage from the history, refreshed
            // every minute. Only while the Stats tab is visible.
            var stats = createStats(hints);
            var usage = createUsage(hints);
            var tableBox = E('div', {}, [ stats.node, usage.node ]);
            stats.update(data[5]);
            var range = 'live', custom = null, lastHist = 0;
            try { range = localStorage.getItem('nftl-range') || 'live'; } catch (e) {}
            var fromIn = E('input', { 'type': 'datetime-local', 'class': 'cbi-input-text' });
            var toIn = E('input', { 'type': 'datetime-local', 'class': 'cbi-input-text' });
            var loadHistory = function() {
                var args = [ 'history' ].concat(range === 'custom' && custom ? custom : [ range ]);
                lastHist = Date.now();
                return L.resolveDefault(fs.exec_direct('/usr/bin/nft-limiter', args), null)
                    .then(function(out) { usage.render(out); });
            };
            var presets = [ [ 'live', _('Live') ], [ 'today', _('Today') ], [ 'yesterday', _('Yesterday') ],
                [ '7d', _('7 days') ], [ 'period', _('This period') ], [ 'lastperiod', _('Last period') ],
                [ 'custom', _('Custom') ] ];
            var customBox = E('span', { 'class': 'nftl-custom' }, [
                ' ', fromIn, ' \u2013 ', toIn, ' ',
                E('button', { 'class': 'cbi-button cbi-button-action', 'click': function() {
                    var f = Date.parse(fromIn.value), t = Date.parse(toIn.value);
                    if (isNaN(f) || isNaN(t) || t <= f) return;
                    custom = [ String(Math.floor(f / 1000)), String(Math.floor(t / 1000)) ];
                    loadHistory();
                } }, _('Show'))
            ]);
            var rangeBar = E('div', { 'class': 'nftl-rangebar' });
            var setRange = function(r) {
                range = r;
                try { localStorage.setItem('nftl-range', r); } catch (e) {}
                dom.content(rangeBar, presets.map(function(p) {
                    return E('button', {
                        'class': 'cbi-button' + (p[0] === range ? ' cbi-button-action' : ''),
                        'click': function() { setRange(p[0]); }
                    }, p[1]);
                }).concat(range === 'custom' ? [ customBox ] : []));
                stats.node.style.display = (range === 'live') ? '' : 'none';
                usage.node.style.display = (range === 'live') ? 'none' : '';
                liveNote.style.display = (range === 'live') ? '' : 'none';
                if (range !== 'live' && (range !== 'custom' || custom)) loadHistory();
            };
            var liveNote = E('p', {}, _('Speeds are measured over the last few seconds; totals since the router started (they carry over rule changes and Restart, and reset on Disable or reboot). Rows covering several devices, and the global limit, expand (\u25b8) into a per-device breakdown. Tinted rows are dropping traffic right now.'));
            poll.add(function() {
                if (!tableBox.offsetParent) return Promise.resolve();
                if (range === 'live')
                    return L.resolveDefault(fs.exec_direct('/usr/bin/nft-limiter', [ 'stats' ]), null)
                        .then(function(out) { stats.update(out); });
                if (Date.now() - lastHist > 60000 && (range !== 'custom' || custom)) return loadHistory();
                return Promise.resolve();
            }, 5);

            // Settings / Stats tabs below the always-visible status block.
            var tabs = E('div', {}, [
                E('div', { 'class': 'cbi-section', 'data-tab': 'settings', 'data-tab-title': _('Settings') }, [
                    formNode
                ]),
                E('div', { 'class': 'cbi-section', 'data-tab': 'stats', 'data-tab-title': _('Stats') }, [
                    E('h3', {}, _('Traffic Statistics')),
                    rangeBar,
                    liveNote,
                    tableBox
                ])
            ]);
            // Build the full tree first so the tab wrapper has a parent, then
            // init the tab group (initTabGroup inserts its menu via
            // group.parentNode, which must not be null).
            // Make the grid's inputs and dropdowns fill their cells instead of
            // the theme's fixed widths (which truncated times and left gaps).
            var gridCss = E('style', {}, [
                '#cbi-nft-limiter-device .cbi-input-text,' +
                '#cbi-nft-limiter-device .cbi-dropdown' +
                '{width:100%;min-width:0;max-width:none;box-sizing:border-box}' +
                // Same icon and colour as the theme's own description "?"
                // (bootstrap's .cbi-value-description::before), with a blue
                // fallback for themes that don't define --primary-color-high.
                '.nftl-help{--nftl-icon:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'%3E%3Cpath d=\'M10 0A10 10 0 000 10a10 10 0 0010 10 10 10 0 0010-10A10 10 0 0010 0zm1 17H9v-2h2v2zm2.1-7.7l-.9.9c-.8.7-1.2 1.3-1.2 2.8H9v-.5c0-1.1.4-2.1 1.2-2.8l1.2-1.3c.4-.3.6-.8.6-1.4a2 2 0 00-2-2 2 2 0 00-2 2H6a4 4 0 014-4 4 4 0 014 4c0 .9-.4 1.7-.9 2.3z\'/%3E%3C/svg%3E");' +
                'display:inline-block;width:1em;height:1em;font-size:14px;cursor:help;' +
                'vertical-align:middle;margin-left:.25em;' +
                'background:var(--primary-color-high,#0069d6);' +
                'mask-image:var(--nftl-icon);mask-size:cover;' +
                '-webkit-mask-image:var(--nftl-icon);-webkit-mask-size:cover}' +
                '#cbi-nft-limiter-device td[data-name="target"] > div' +
                '{display:flex;align-items:center;gap:.35em}' +
                // Device column: keep its set width (max-width:0 lets a
                // percentage-width cell stop growing to fit its content) and
                // stack a multi-device row's picks one per line, so the
                // other columns keep their room.
                '#cbi-nft-limiter-device td[data-name="target"]{max-width:0}' +
                '#cbi-nft-limiter-device td[data-name="target"] .cbi-dropdown:not(.btn):not(.cbi-button)' +
                '{height:auto;min-height:30px}' +
                '#cbi-nft-limiter-device td[data-name="target"] .cbi-dropdown > ul:not(.dropdown)' +
                '{flex-direction:column;min-width:0}' +
                '#cbi-nft-limiter-device td[data-name="target"] .cbi-dropdown > ul:not(.dropdown) > li[display]' +
                '{display:block!important;align-self:stretch;min-width:0;border-left:none;' +
                'text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
                '.nftl-cover{flex:none;width:15px;height:15px;border-radius:50%;cursor:help;' +
                'background:var(--primary-color-high,#0069d6);color:#fff;font:italic bold 11px/15px Georgia,serif;' +
                'text-align:center;user-select:none}' +
                '.nftl-cover.nftl-dead{background:#f0ad4e}' +
                '#cbi-nft-limiter-device tr.nftl-related > .td{background:rgba(0,105,214,.10)!important}' +
                '#cbi-nft-limiter-device tr.nftl-self > .td{background:rgba(0,105,214,.22)!important}' +
                '#cbi-nft-limiter-device tr.nftl-related,#cbi-nft-limiter-device tr.nftl-self' +
                '{outline:1px solid rgba(0,105,214,.45);outline-offset:-1px}' +
                '.cbi-value.nftl-merged{display:none!important}' +
                '.nftl-rangebar{display:flex;flex-wrap:wrap;gap:.3em;align-items:center;margin:.3em 0 .6em}' +
                '.nftl-rangebar .cbi-button{margin:0}' +
                '.nftl-custom input{width:auto;min-width:0}' +
                '.nftl-range-label{color:#888}' +
                '.nftl-spark svg{display:block;fill:var(--primary-color-high,#0069d6);opacity:.75}' +
                '.nftl-qbar{width:12em;max-width:100%;height:8px;border-radius:4px;background:rgba(127,127,127,.25);overflow:hidden}' +
                '.nftl-qfill{height:100%;background:var(--primary-color-high,#0069d6)}' +
                '.nftl-qfill.nftl-qfull{background:#d9534f}' +
                '.nftl-qtext{font-size:11px;color:#888;margin-top:.15em}' +
                '.nftl-stats .nftl-expand{display:inline-block;width:1.2em;cursor:pointer;color:#888}' +
                '.nftl-stats .nftl-sub .td{font-size:12px;color:#777}' +
                '.nftl-stats .nftl-sub .td:first-child{padding-left:2.2em}' +
                '.nftl-stats .nftl-dropped{font-size:11px;color:#d9534f}' +
                '.nftl-stats .nftl-limiting{font-size:11px;color:#f0ad4e;font-weight:bold}' +
                '.nftl-stats tr.nftl-row-limiting > .td{background:rgba(240,173,78,.10)}' +
                '.nftl-warn{margin-top:.4em;padding:.35em .6em;border-radius:4px;max-width:40em;' +
                'font-size:12px;line-height:1.4;background:rgba(240,173,78,.15);' +
                'border-left:3px solid #f0ad4e}' +
                '.nftl-inline{display:flex;flex-wrap:wrap;gap:.4em 1.4em;align-items:center}' +
                '.nftl-part{display:flex;align-items:center;gap:.45em}' +
                '.nftl-caption{color:#888;white-space:nowrap}' +
                '.nftl-part .cbi-input-text{width:7em;min-width:0}' +
                '.nftl-part .cbi-dropdown{min-width:10em}' +
                // Phones only (the same query bootstrap's mobile.css uses for
                // its stacked-card grid; desktop never matches it):
                //  - Enabled and Block share the first line, then Device,
                //    then the row buttons; the other fields are hidden
                //    (Edit shows them all);
                //  - the coverage badge sits beside the "Device" label, bigger
                //    for touch, instead of at the screen edge.
                '@media screen and (max-device-width:600px){' +
                '#cbi-nft-limiter-device .td[data-name="download"],' +
                '#cbi-nft-limiter-device .td[data-name="upload"],' +
                '#cbi-nft-limiter-device .td[data-name="timestart"],' +
                '#cbi-nft-limiter-device .td[data-name="timeend"],' +
                '#cbi-nft-limiter-device .td[data-name="week"],' +
                '#cbi-nft-limiter-device .td[data-name="comment"]{display:none}' +
                '#cbi-nft-limiter-device .td[data-name="enable"]{order:1}' +
                '#cbi-nft-limiter-device .td[data-name="block"]{order:2}' +
                '#cbi-nft-limiter-device .td[data-name="target"]{order:3;max-width:none;display:flex;' +
                'flex-wrap:wrap;align-items:center;column-gap:.5em}' +
                '#cbi-nft-limiter-device .td[data-name="target"]::before{flex:0 1 auto}' +
                '#cbi-nft-limiter-device .td[data-name="target"] > div{display:contents}' +
                '#cbi-nft-limiter-device .td[data-name="target"] .cbi-dropdown{flex:1 1 100%}' +
                '#cbi-nft-limiter-device .td.cbi-section-actions{order:4}' +
                '.nftl-cover{width:18px;height:18px;font-size:13px;line-height:18px}' +
                '}' +
                '.nftl-tip{position:absolute;z-index:1000;max-width:min(26em,calc(100vw - 16px));' +
                'padding:.5em .7em;border:1px solid rgba(127,127,127,.4);border-radius:4px;' +
                'background:var(--background-color-high,#fff);color:var(--text-color-highest,#333);' +
                'box-shadow:0 2px 8px rgba(0,0,0,.2);font-size:13px;font-weight:normal;' +
                'line-height:1.45;white-space:pre-line;text-align:left}' +
                '.nftl-count,.nftl-sub{font-size:13px;font-weight:normal;color:#888;' +
                'margin-left:.6em;vertical-align:middle}'
            ]);
            // The status poll also refreshes the device count on the heading.
            var status = nftctl.render(function(enabled, out) {
                setCount(enabled && out != null ? nftctl.countDevices(out) : null);
            });
            var root = E('div', {}, [ gridCss, status, tabs, buildFooter() ]);
            ui.tabs.initTabGroup(tabs.childNodes);
            setRange(range);
            return root;
        });
    },

    handleSave: function(ev) {
        return this.map.save(this.fillMacs);
    }
});
