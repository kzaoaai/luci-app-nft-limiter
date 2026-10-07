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
    var name = dev.comment ? (dev.comment + ' (' + dev.target + ')') : dev.target;
    return name + ': ' + what + ', ' + when;
}

// For each enabled row that other enabled rows also match (same addresses,
// or a broader target containing it), the full list of rules for those
// addresses in the engine's checking order: fewest addresses first, then
// scheduled before always-on, then list order. The first match wins, and
// an always-on rule always matches, so everything after it is never reached.
// Returns { sid: { text, dead } }; dead = this row itself is never reached.
function coverageMap(devs) {
    var rows = [];
    devs.forEach(function(dev, idx) {
        if (dev.enable === '0' || !dev.target) return;
        var span = ip4Span(dev.target);
        rows.push({
            dev: dev, idx: idx, span: span,
            v6: span ? null : String(dev.target).trim().toLowerCase(),
            size: span ? span[1] - span[0] + 1 : Infinity,
            always: !hasSchedule(dev)
        });
    });
    var order = function(a, b) {
        if (a.size !== b.size) return a.size - b.size;
        if (a.always !== b.always) return a.always ? 1 : -1;
        return a.idx - b.idx;
    };
    var out = {};
    rows.forEach(function(r) {
        var chain = rows.filter(function(o) {
            if (o === r) return true;
            return (r.span && o.span) ? (o.span[0] <= r.span[0] && o.span[1] >= r.span[1])
                                      : (!!r.v6 && r.v6 === o.v6);
        }).sort(order);
        if (chain.length < 2) return;
        var lines = [ _('Rules for these addresses, in checking order (first match wins):') ];
        var reached = true, dead = false;
        chain.forEach(function(o, i) {
            var line = (i + 1) + '. ' + describeRule(o.dev);
            if (o === r) line += '  \u2190 ' + _('this row');
            if (!reached) {
                line += '  (' + _('never reached') + ')';
                if (o === r) dead = true;
            }
            lines.push(line);
            if (o.always) reached = false;
        });
        out[r.dev['.name']] = { text: lines.join('\n'), dead: dead };
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

// --- Stats tab: live per-rule traffic counters from `nft -j list chain` ------
function fmtBytes(b) {
    b = Number(b) || 0;
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'], i = 0;
    while (b >= 1024 && i < units.length - 1) { b /= 1024; i++; }
    return (i === 0 ? b : b.toFixed(2)) + ' ' + units[i];
}

// Parse `nft -j list chain` output into a map of comment -> {packets, bytes}.
// Returns null when the chain is not loaded (command failed).
function parseCounters(jsonStr) {
    if (!jsonStr) return null;
    var map = {};
    try {
        var data = JSON.parse(jsonStr);
        (data.nftables || []).forEach(function(item) {
            var r = item.rule;
            if (!r || !r.comment || !Array.isArray(r.expr)) return;
            var c = null;
            r.expr.forEach(function(e) { if (e && e.counter) c = e.counter; });
            if (c) map[r.comment] = { packets: c.packets || 0, bytes: c.bytes || 0 };
        });
        return map;
    } catch (e) {
        return {};
    }
}

// Sum the IPv4 rule and its IPv6 companion (<tag> and <tag>6, e.g. dev_0_dl
// and dev_0_dl6; pass rules dev_0_dl_pass and dev_0_dl6_pass).
function cell(counters, comment) {
    var parts = [ counters[comment] ];
    var m = comment.match(/^(dev_\d+_(?:dl|ul))(_pass)?$/);
    if (m) parts.push(counters[m[1] + '6' + (m[2] || '')]);
    var bytes = 0, packets = 0, any = false;
    parts.forEach(function(c) {
        if (!c) return;
        any = true; bytes += c.bytes; packets += c.packets;
    });
    if (!any) return '—';
    return fmtBytes(bytes) + ' (' + packets + ' pkts)';
}

function statsRows(counters) {
    var rows = [];
    uci.sections('nft-limiter', 'device').forEach(function(dev, idx) {
        var target = dev.target || '—';
        var label = dev.comment ? (dev.comment + ' — ' + target) : target;
        if (dev.enable === '0') label += ' ' + _('(disabled)');
        else if (dev.block === '1') label += ' ' + _('(blocked)');
        rows.push([
            label,
            cell(counters, 'dev_' + idx + '_dl_pass'),
            cell(counters, 'dev_' + idx + '_dl'),
            cell(counters, 'dev_' + idx + '_ul_pass'),
            cell(counters, 'dev_' + idx + '_ul')
        ]);
    });
    if (counters['default_dl'] || counters['default_ul']) {
        rows.push([
            E('em', {}, _('Global default limit')),
            '—', cell(counters, 'default_dl'),
            '—', cell(counters, 'default_ul')
        ]);
    }
    return rows;
}

function statsTable(counters) {
    if (counters === null)
        return E('div', { 'class': 'alert-message warning' }, [
            _('The QoS chain is not loaded. Use the Enable button above to start the limiter.')
        ]);
    var rows = statsRows(counters);
    if (!rows.length)
        return E('div', { 'class': 'alert-message' }, [
            _('Chain loaded, but no device or global limit rules are active.')
        ]);
    var head = E('tr', { 'class': 'tr table-titles' }, [
        E('th', { 'class': 'th' }, _('Device')),
        E('th', { 'class': 'th' }, _('Down accepted')),
        E('th', { 'class': 'th' }, _('Down dropped')),
        E('th', { 'class': 'th' }, _('Up accepted')),
        E('th', { 'class': 'th' }, _('Up dropped'))
    ]);
    var body = rows.map(function(r) {
        return E('tr', { 'class': 'tr' }, r.map(function(c) {
            return E('td', { 'class': 'td' }, [c]);
        }));
    });
    return E('table', { 'class': 'table' }, [head].concat(body));
}

return view.extend({
    load: function() {
        return Promise.all([
            network.getHostHints(),
            uci.load('nft-limiter'),
            network.getNetworks(),
            L.resolveDefault(fs.exec_direct('/sbin/ip', ['-j', 'neigh', 'show']), null),
            L.resolveDefault(fs.exec_direct('/usr/sbin/nft', nftctl.NFT_ARGS), null)
        ]);
    },

    render: function(data) {
        var hints = data[0];
        var networks = data[2];

        // Map of IP address -> kernel neighbour (ARP/NDP) state for a
        // simple online/offline dot next to each device in the dropdown.
        var neighState = {};
        if (data[3]) {
            try {
                JSON.parse(data[3]).forEach(function(n) {
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

        // Toggle for the global default (catch-all) limit, backed by a real UCI
        // flag the engine honours. Initial state is inferred from existing limit
        // values so upgrades don't silently drop a configured global limit.
        o = s.option(form.Flag, 'glimit', _('Enable Global Default Limit'),
            _('Apply a fallback rate limit to all traffic not covered by a ' +
              'per-device rule. When off, only per-device rules apply.'));
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
            _('Applies only to devices not covered by a per-device rule. Set to 0 for unlimited.'));
        o.datatype = 'ufloat';
        o.placeholder = '10';
        o.depends('glimit', '1');
        keepWhenCollapsed(o);

        o = s.option(form.Value, 'upload', _('Global Upload Limit (Mbit/s)'),
            _('Applies only to devices not covered by a per-device rule. Set to 0 for unlimited.'));
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

        o = s.option(form.Value, 'target', _('Device (IP / Range)'));
        o.width = '22%';
        o.rmempty   = false;
        o.editable  = true;
        o.placeholder = _('IP, CIDR, or IP range (a.b.c.d-e.f.g.h)');
        o.validate = function(section_id, value) {
            if (validateTarget(value)) return true;
            return _('Enter an IP, CIDR, or IPv4 range (a.b.c.d-e.f.g.h)');
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
            var val = this.cfgvalue(section_id);
            if (!val) return '';
            if (netNames[val]) return netNames[val] + ' \u2014 ' + val;
            var name = hints.getHostnameByIPAddr(val)
                    || hints.getHostnameByIP6Addr(val);
            if (name) return name + ' \u2014 ' + val;
            return val;
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

        // On save, record each single-IPv4 rule's MAC so the backend can add
        // IPv6 rules even while the device is offline at boot. Unknown or
        // non-host targets clear it (the backend then falls back to leases
        // and the neighbour table). Runs after the form is parsed, so a
        // target edited in this save is seen.
        this.fillMacs = function() {
            uci.sections('nft-limiter', 'device').forEach(function(dev) {
                var t = String(dev.target || '').trim();
                var mac = isIp4(t) ? macByIp4[t] : null;
                if (mac) {
                    if (dev.mac !== mac) uci.set('nft-limiter', dev['.name'], 'mac', mac);
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
        // Hint popup: the "?" hints and coverage dots show their text in a
        // small popup on click/tap, since touch browsers (iOS Safari) never
        // show title tooltips. Tapping elsewhere or the same icon closes it.
        var tip = null;
        var closeTip = function() { if (tip) { tip.remove(); tip = null; } };
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

            // Coverage dot at the start of each covered row's Device cell:
            // blue = also matched by another rule (details on hover),
            // orange = shadowed, this row can never apply.
            var cover = coverageMap(uci.sections('nft-limiter', 'device'));
            mapEl.querySelectorAll('#cbi-nft-limiter-device tr[data-section-id]').forEach(function(tr) {
                var cell = tr.querySelector('td[data-name="target"] > div');
                if (!cell) return;
                var old = cell.querySelector('.nftl-cover');
                if (old) old.remove();
                var c = cover[tr.getAttribute('data-section-id')];
                if (!c) return;
                cell.insertBefore(E('span', {
                    'class': 'nftl-cover' + (c.dead ? ' nftl-dead' : ''),
                    'title': c.text,
                    'click': toggleTip
                }), cell.firstChild);
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
            // Stats tab: live counter table, refreshed every 5s.
            var tableBox = E('div', {}, statsTable(parseCounters(data[4])));
            poll.add(function() {
                return L.resolveDefault(fs.exec_direct('/usr/sbin/nft', nftctl.NFT_ARGS), null)
                    .then(function(out) { dom.content(tableBox, statsTable(parseCounters(out))); });
            }, 5);

            // Settings / Stats tabs below the always-visible status block.
            var tabs = E('div', {}, [
                E('div', { 'class': 'cbi-section', 'data-tab': 'settings', 'data-tab-title': _('Settings') }, [
                    formNode
                ]),
                E('div', { 'class': 'cbi-section', 'data-tab': 'stats', 'data-tab-title': _('Stats') }, [
                    E('h3', {}, _('Traffic Statistics')),
                    E('p', {}, _('Live traffic accounting per rule. Counters reset whenever the rule set is rebuilt (service restart, or adding/editing a device).')),
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
                '.nftl-cover{flex:none;width:9px;height:9px;border-radius:50%;cursor:help;' +
                'background:var(--primary-color-high,#0069d6)}' +
                '.nftl-cover.nftl-dead{background:#f0ad4e}' +
                '.cbi-value.nftl-merged{display:none!important}' +
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
                //  - the coverage dot sits beside the "Device" label, bigger
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
                '#cbi-nft-limiter-device .td[data-name="target"]{order:3;display:flex;' +
                'flex-wrap:wrap;align-items:center;column-gap:.5em}' +
                '#cbi-nft-limiter-device .td[data-name="target"]::before{flex:0 1 auto}' +
                '#cbi-nft-limiter-device .td[data-name="target"] > div{display:contents}' +
                '#cbi-nft-limiter-device .td[data-name="target"] .cbi-dropdown{flex:1 1 100%}' +
                '#cbi-nft-limiter-device .td.cbi-section-actions{order:4}' +
                '.nftl-cover{width:14px;height:14px}' +
                '}' +
                '.nftl-tip{position:absolute;z-index:1000;max-width:min(26em,calc(100vw - 16px));' +
                'padding:.5em .7em;border:1px solid rgba(127,127,127,.4);border-radius:4px;' +
                'background:var(--background-color-high,#fff);color:var(--text-color-highest,#333);' +
                'box-shadow:0 2px 8px rgba(0,0,0,.2);font-size:12px;font-weight:normal;' +
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
            return root;
        });
    },

    handleSave: function(ev) {
        return this.map.save(this.fillMacs);
    }
});
