(function() {
    var PLUGIN_ID = 'com.custom.read-receipts';
    var readReceiptsStore = {};
    var scanTimeout = null;

    function pluginRoute() {
        return '/plugins/' + PLUGIN_ID;
    }

    function notifyChannelRead(channelId) {
        if (!channelId) return;
        fetch(pluginRoute() + '/api/v1/channel-read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel_id: channelId }),
        }).catch(function() {});
    }

    function fetchBatch(postIds, cb) {
        if (!postIds.length) return;
        fetch(pluginRoute() + '/api/v1/batch-read-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ post_ids: postIds }),
        }).then(function(r) { return r.ok ? r.json() : {}; })
          .then(cb)
          .catch(function() {});
    }

    function injectCSS() {
        if (document.getElementById('rr-css')) return;
        var s = document.createElement('style');
        s.id = 'rr-css';
        s.textContent = '.rr-i{display:inline-flex;align-items:center;margin-left:4px;position:relative;cursor:default;vertical-align:middle}'
            + ' .rr-c{font-size:14px;font-weight:bold;line-height:1}'
            + ' .rr-s{color:#999}.rr-r{color:#4a90d9}'
            + ' .rr-t{visibility:hidden;background:#333;color:#fff;border-radius:6px;padding:6px 10px;position:absolute;z-index:9999;bottom:125%;right:0;min-width:100px;max-width:250px;font-size:12px;line-height:1.4;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:pre-line;pointer-events:none}'
            + ' .rr-i:hover .rr-t{visibility:visible}';
        document.head.appendChild(s);
    }

    function makeIndicator(postId) {
        var w = document.createElement('span');
        w.className = 'rr-i';
        w.setAttribute('data-rr', postId);
        var c = document.createElement('span');
        c.className = 'rr-c rr-s';
        c.textContent = '\u2713';
        var t = document.createElement('span');
        t.className = 'rr-t';
        t.textContent = '\u041e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d\u043e';
        w.appendChild(c);
        w.appendChild(t);
        var rd = readReceiptsStore[postId];
        if (rd && rd.length) applyRead(w, rd);
        return w;
    }

    function applyRead(el, readers) {
        var c = el.querySelector('.rr-c');
        var t = el.querySelector('.rr-t');
        if (!c || !t) return;
        if (readers && readers.length) {
            c.className = 'rr-c rr-r';
            c.textContent = '\u2713\u2713';
            var n = [];
            for (var i = 0; i < readers.length && i < 10; i++) n.push(readers[i].display_name || readers[i].user_id);
            t.textContent = '\u041f\u0440\u043e\u0447\u0438\u0442\u0430\u043d\u043e:\n' + n.join('\n') + (readers.length > 10 ? '\n...\u0438 \u0435\u0449\u0451 ' + (readers.length - 10) : '');
        }
    }

    function scan() {
        var posts = document.querySelectorAll('.post.current--user');
        var need = [];
        for (var i = 0; i < posts.length; i++) {
            var p = posts[i];
            if (p.querySelector('.rr-i')) continue;
            var id = p.id ? p.id.replace('post_', '') : '';
            if (!id || id.length < 10) continue;
            need.push(id);
            var h = p.querySelector('.post__header');
            if (h) {
                var tm = h.querySelector('.post__time');
                if (tm) tm.parentNode.insertBefore(makeIndicator(id), tm.nextSibling);
            }
        }
        if (need.length) {
            var toFetch = need.filter(function(x) { return !(x in readReceiptsStore); });
            if (toFetch.length) {
                fetchBatch(toFetch, function(res) {
                    for (var pid in res) {
                        if (!res.hasOwnProperty(pid)) continue;
                        readReceiptsStore[pid] = res[pid];
                        var els = document.querySelectorAll('[data-rr="' + pid + '"]');
                        for (var j = 0; j < els.length; j++) applyRead(els[j], res[pid]);
                    }
                });
            }
        }
    }

    function debouncedScan() {
        if (scanTimeout) return;
        scanTimeout = setTimeout(function() { scanTimeout = null; scan(); }, 2500);
    }

    // Register plugin using Mattermost's window.registerPlugin
    window.registerPlugin(PLUGIN_ID, {
        initialize: function(registry, store) {
            injectCSS();

            registry.registerWebSocketEventHandler(
                'custom_' + PLUGIN_ID + '_read_receipt_update',
                function(msg) {
                    if (!msg || !msg.data || !msg.data.post_id) return;
                    var pid = msg.data.post_id;
                    if (!readReceiptsStore[pid]) readReceiptsStore[pid] = [];
                    var exists = false;
                    for (var i = 0; i < readReceiptsStore[pid].length; i++) {
                        if (readReceiptsStore[pid][i].user_id === msg.data.user_id) { exists = true; break; }
                    }
                    if (!exists) readReceiptsStore[pid].push(msg.data);
                    var els = document.querySelectorAll('[data-rr="' + pid + '"]');
                    for (var j = 0; j < els.length; j++) applyRead(els[j], readReceiptsStore[pid]);
                }
            );

            registry.registerWebSocketEventHandler(
                'channel_viewed',
                function(msg) {
                    if (msg && msg.data && msg.data.channel_id) {
                        notifyChannelRead(msg.data.channel_id);
                        setTimeout(scan, 2000);
                    }
                }
            );

            registry.registerWebSocketEventHandler(
                'posted',
                function() { debouncedScan(); }
            );

            setTimeout(scan, 4000);
            setInterval(debouncedScan, 10000);
        },

        uninitialize: function() {
            var s = document.getElementById('rr-css');
            if (s) s.remove();
            var els = document.querySelectorAll('.rr-i');
            for (var i = 0; i < els.length; i++) els[i].remove();
        }
    });
})();
