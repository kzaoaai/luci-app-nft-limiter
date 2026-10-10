'use strict';
'require view';
'require fs';

// Stable loader for the NFT Limiter page. Keep this file unchanged between
// releases.
//
// LuCI stamps module URLs with its own build version (?v=...), not with the
// app's, and uhttpd sends no cache headers, so after an app update browsers
// keep serving the old view code (a hard refresh does not reload modules
// LuCI fetches itself). This loader reads the app's real code over RPC,
// which is never cached, and compiles it the way LuCI compiles modules:
// 'require' directives become arguments, the factory runs with
// (window, document, L, ...deps). Required LuCI classes come from
// L.require; this app's own modules are read the same uncached way.
var BASE = '/www/luci-static/resources/';
var OWN = { nftctl: 'nftctl.js' };

function loadModule(path) {
    return fs.read(BASE + path).then(function(source) {
        // The leading string-literal directives ('use strict', 'require x',
        // 'require x as y'), read one after another from the start, as
        // LuCI does: release builds minify the file onto one line.
        var deps = [], args = '', m, r;
        var tok = /(?:\s+|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(['"])([^'"\n]*)\1\s*;?/y;
        tok.lastIndex = 0;
        while ((m = tok.exec(source)) !== null) {
            if (/^use\s+strict$/.test(m[2])) continue;
            r = /^require\s+(\S+?)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(m[2]);
            if (!r) break;
            deps.push(OWN[r[1]]
                ? loadModule(OWN[r[1]]).then(function(Cls) { return new Cls(); })
                : L.require(r[1]));
            args += ', ' + (r[2] || r[1].replace(/[^a-zA-Z0-9_]/g, '_'));
        }
        return Promise.all(deps).then(function(inst) {
            var factory = eval('(function(window, document, L' + args + ') { ' + source +
                ' })\n//# sourceURL=' + BASE.replace('/www', '') + path);
            return factory.apply(factory, [ window, document, L ].concat(inst));
        });
    });
}

return view.extend({
    // Compile the app's view class and take over its methods (LuCI has
    // already created this instance, so the real class is not instantiated
    // a second time), then run its own load. LuCI binds load and render
    // before load runs, so both stay defined here and hand over to the
    // app's; the other handlers are looked up by name later and are copied.
    load: function() {
        var self = this;
        return loadModule('nftlimiter/app.js').then(function(App) {
            var proto = App.prototype;
            self.appLoad = proto.load;
            self.appRender = proto.render;
            Object.getOwnPropertyNames(proto).forEach(function(k) {
                if (k !== 'constructor' && k !== '__init__' && k !== 'load' && k !== 'render' &&
                    typeof proto[k] === 'function')
                    self[k] = proto[k];
            });
            return self.appLoad();
        });
    },

    render: function(data) {
        return this.appRender(data);
    }
});
