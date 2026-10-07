'use strict';
'require baseclass';
'require dom';
'require fs';
'require ui';
'require poll';

// Shared "NFT Limiter Status" block: service state line + Enable / Disable /
// Restart controls. Rendered at the top of every subpage (Settings, Stats) so
// it is always visible, PBR-style. Self-loads and polls the nft chain.

// Stamped from the git tag at CI build time (see .github/workflows/build.yml).
var pkgVersion = '1.6.0';
var INIT = '/etc/init.d/nft-limiter';
var NFT_ARGS = ['-j', 'list', 'chain', 'inet', 'fw4', 'custom_qos_enforce'];

return baseclass.extend({
    pkgVersion: pkgVersion,
    NFT_ARGS: NFT_ARGS,

    // Resolve to the raw `nft -j list chain` output, or null if not loaded.
    probe: function() {
        return L.resolveDefault(fs.exec_direct('/usr/sbin/nft', NFT_ARGS), null);
    },

    // Run an init verb (on/off/reapply) then refresh the block.
    runAction: function(box, cmd) {
        var self = this;
        return fs.exec(INIT, [cmd]).then(function(res) {
            if (res && res.code !== 0)
                ui.addNotification(null, E('p', {}, [
                    _('Service command failed (exit %d): %s').format(res.code, (res.stderr || res.stdout || '').trim())
                ]), 'danger');
            return self.refresh(box);
        }).catch(function(e) {
            ui.addNotification(null, E('p', {}, [ _('Service command failed: ') + e ]), 'danger');
        });
    },

    // Resolve to true if the service is enabled (boot symlink present), via the
    // init script's `enabled` verb. This is the master on/off that Enable/Disable
    // toggle — independent of whether the nft chain happens to be loaded — and it
    // doesn't disturb the shared UCI cache (the Settings form's unsaved changes).
    isEnabled: function() {
        return fs.exec(INIT, ['enabled'])
            .then(function(res) { return !!res && res.code === 0; })
            .catch(function() { return false; });
    },

    // Number of devices with rules in the loaded chain (dev_<n>_* comments).
    countDevices: function(out) {
        if (out == null) return 0;
        var seen = {}, m, re = /"comment":\s*"dev_(\d+)_/g;
        while ((m = re.exec(out)) !== null) seen[m[1]] = true;
        return Object.keys(seen).length;
    },

    refresh: function(box) {
        var self = this;
        return Promise.all([ this.isEnabled(), this.probe() ])
            .then(function(res) {
                self.fill(box, res[0], res[1]);
                if (typeof(self.onUpdate) == 'function')
                    self.onUpdate(res[0], res[1]);
            });
    },

    // (Re)render the inner content of the status box for one pass.
    //   enabled : master on/off -> Running/Stopped
    //   out     : raw nft chain output (null if not loaded) -> rule-count detail
    fill: function(box, enabled, out) {
        var self = this;
        var stateTxt = enabled ? _('Running') : _('Stopped');
        var color    = enabled ? '#4CAF50' : '#f44336';

        // Problems and the global limit only, shown when the service is
        // enabled. The device count is shown on the Per-Device Rules heading.
        var detail = null;
        if (enabled) {
            if (out === null)
                detail = _('no rules loaded');
            else if (/"comment":\s*"default_(dl|ul)"/.test(out))
                detail = _('global default limit active');
        }

        // Grey out the button that would not change anything: Enable while
        // running, Disable and Restart while stopped.
        var btn = function(label, cls, cmd, disabled) {
            return E('button', {
                'class': 'cbi-button ' + cls,
                'disabled': disabled ? '' : null,
                'click': ui.createHandlerFn(self, 'runAction', box, cmd)
            }, label);
        };

        dom.content(box, [
            E('div', {}, [
                E('strong', {}, 'nft-limiter v' + pkgVersion + ' — '),
                E('span', { 'style': 'color:' + color + ';font-weight:bold' }, stateTxt),
                ' (' + _('fw4 nft mode') + ')'
            ]),
            detail ? E('div', { 'style': 'color:#666;margin-top:.2em' }, detail) : '',
            E('div', { 'style': 'margin-top:.6em' }, [
                btn(_('Enable'),  'cbi-button-apply',    'on',      enabled),  ' ',
                btn(_('Disable'), 'cbi-button-negative', 'off',     !enabled), ' ',
                btn(_('Restart'), 'cbi-button-action',   'reapply', !enabled)
            ])
        ]);
    },

    // Build the always-visible status section. Self-loads the real state and
    // polls every 5s. onUpdate(enabled, out), if given, runs after each poll.
    render: function(onUpdate) {
        var self = this;
        self.onUpdate = onUpdate;
        var box = E('div', { 'style': 'margin:.25em 0 1em' });
        self.fill(box, false, null);
        self.refresh(box);
        poll.add(function() { return self.refresh(box); }, 5);
        return E('div', { 'class': 'cbi-section' }, [
            E('h3', {}, _('NFT Limiter Status')),
            box
        ]);
    }
});
