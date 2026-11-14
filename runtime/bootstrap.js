/* WorkBuddy 插件运行时（注入到渲染进程主世界执行）。
 * 由 wbpro 通过 CDP 注入，不写入任何官方文件。
 * 约定：每个插件在 activate(ctx) 中注册 UI/能力，返回值为卸载函数。
 */
(function () {
    'use strict';
    var KEY = '__wbpro';
    var Z = 2147483000;

    if (window[KEY] && window[KEY].alive) return;

    var host = {
        alive: true,
        version: '0.1.0',
        plugins: new Map(),
        mounted: [], // 面板宿主节点，用于重挂
        log: [],
    };

    function log() {
        var args = Array.prototype.slice.call(arguments);
        host.log.push([Date.now()].concat(args));
        if (host.log.length > 500) host.log.shift();
        try {
            console.log('%c[wbpro]', 'color:#7F77DD', ...args);
        } catch (e) {
            /* ignore */
        }
    }

    function css(el, obj) {
        for (var k in obj) el.style[k] = obj[k];
    }

    /* ---------------- 面板 ---------------- */
    var PANEL_CSS = [
        '.p{font:13px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#e9e9ec;',
        'background:rgba(26,26,29,.97);border:1px solid rgba(255,255,255,.13);border-radius:12px;',
        'box-shadow:0 8px 28px rgba(0,0,0,.38);overflow:hidden;min-width:220px;max-width:min(460px,42vw);}',
        '.h{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:move;user-select:none;',
        'background:rgba(255,255,255,.05);border-bottom:1px solid rgba(255,255,255,.08);font-weight:500;}',
        '.h .t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.h .x{cursor:pointer;opacity:.55;padding:0 2px;font-size:14px;line-height:1;}',
        '.h .x:hover{opacity:1;}',
        '.b{padding:10px;}',
        '.b :is(button){font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);',
        'border-radius:6px;padding:3px 9px;cursor:pointer;}',
        '.b :is(button):hover{background:rgba(255,255,255,.15);}',
        '.b code{font-family:ui-monospace,Consolas,monospace;font-size:12px;}',
    ].join('');

    function anchorStyle(position) {
        var p = position || 'top-right';
        var s = { position: 'fixed', zIndex: Z, maxHeight: '70vh', overflow: 'auto' };
        if (p.indexOf('top') === 0) s.top = '96px';
        else s.bottom = '24px';
        if (p.indexOf('right') > -1) s.right = '16px';
        else s.left = '16px';
        return s;
    }

    function makePanel(ctx, opts) {
        var wrap = document.createElement('div');
        wrap.setAttribute('data-wbpro-panel', opts.id);
        css(wrap, anchorStyle(opts.position));

        var shadow = wrap.attachShadow({ mode: 'open' });
        var style = document.createElement('style');
        style.textContent = PANEL_CSS + (opts.css || '');
        var card = document.createElement('div');
        card.className = 'p';
        var head = document.createElement('div');
        head.className = 'h';
        var title = document.createElement('span');
        title.className = 't';
        title.textContent = opts.title || opts.id;
        var close = document.createElement('span');
        close.className = 'x';
        close.textContent = '\u00d7';
        close.title = '关闭（会话内隐藏）';
        var body = document.createElement('div');
        body.className = 'b';

        head.appendChild(title);
        if (opts.closable !== false) head.appendChild(close);
        card.appendChild(head);
        card.appendChild(body);
        shadow.appendChild(style);
        shadow.appendChild(card);

        close.addEventListener('click', function () {
            wrap.remove();
        });

        // 拖动（指针事件，避免触发页面选中）
        (function drag() {
            var sx = 0, sy = 0, ox = 0, oy = 0, moving = false;
            head.addEventListener('pointerdown', function (e) {
                if (e.target === close) return;
                var r = wrap.getBoundingClientRect();
                moving = true;
                sx = e.clientX;
                sy = e.clientY;
                ox = r.left;
                oy = r.top;
                wrap.style.left = r.left + 'px';
                wrap.style.top = r.top + 'px';
                wrap.style.right = 'auto';
                wrap.style.bottom = 'auto';
                head.setPointerCapture(e.pointerId);
                e.preventDefault();
            });
            head.addEventListener('pointermove', function (e) {
                if (!moving) return;
                wrap.style.left = ox + (e.clientX - sx) + 'px';
                wrap.style.top = oy + (e.clientY - sy) + 'px';
            });
            var stop = function () { moving = false; };
            head.addEventListener('pointerup', stop);
            head.addEventListener('pointercancel', stop);
        })();

        document.body.appendChild(wrap);
        host.mounted.push(wrap);

        if (typeof opts.render === 'function') {
            try {
                opts.render(body, ctx);
            } catch (e) {
                body.textContent = '渲染失败: ' + e.message;
                log('panel render 失败', opts.id, e);
            }
        }
        return {
            el: wrap,
            body: body,
            title: title,
            remove: function () {
                wrap.remove();
                host.mounted = host.mounted.filter(function (n) { return n !== wrap; });
            },
        };
    }

    /* ---------------- 插件上下文 ---------------- */
    function makeContext(def) {
        var id = def.id;
        var manifest = def.manifest || {};
        var cleanups = [];

        var ctx = {
            id: id,
            manifest: manifest,
            version: host.version,
            app: host.meta || {},
            pluginDir: manifest.__dir || '',
            log: function () { log.apply(null, ['[' + id + ']'].concat([].slice.call(arguments))); },

            ui: {
                panel: function (opts) {
                    var p = makePanel(ctx, Object.assign({ id: id }, opts || {}));
                    cleanups.push(p.remove);
                    return p;
                },
                css: function (text) {
                    var s = document.createElement('style');
                    s.setAttribute('data-wbpro-style', id);
                    s.textContent = text;
                    document.head.appendChild(s);
                    cleanups.push(function () { s.remove(); });
                },
                toast: function (msg, ms) {
                    var n = document.createElement('div');
                    n.textContent = String(msg);
                    css(n, {
                        position: 'fixed', left: '50%', bottom: '56px', transform: 'translateX(-50%)',
                        zIndex: Z + 1, padding: '8px 14px', borderRadius: '8px',
                        background: 'rgba(26,26,29,.96)', color: '#e9e9ec',
                        border: '1px solid rgba(255,255,255,.14)', font: '13px system-ui',
                    });
                    document.body.appendChild(n);
                    host.mounted.push(n);
                    setTimeout(function () {
                        n.remove();
                        host.mounted = host.mounted.filter(function (x) { return x !== n; });
                    }, ms || 2600);
                },
                // 观察页面结构变化，用于把插件挂到某个已知节点旁边
                observe: function (fn, opts) {
                    var mo = new MutationObserver(fn);
                    mo.observe(document.body, Object.assign({ childList: true, subtree: true }, opts || {}));
                    cleanups.push(function () { mo.disconnect(); });
                    return mo;
                },
                waitFor: function (selector, timeout) {
                    return new Promise(function (resolve, reject) {
                        var found = document.querySelector(selector);
                        if (found) return resolve(found);
                        var mo = new MutationObserver(function () {
                            var el = document.querySelector(selector);
                            if (el) { mo.disconnect(); clearTimeout(t); resolve(el); }
                        });
                        var t = setTimeout(function () { mo.disconnect(); reject(new Error('等待超时: ' + selector)); }, timeout || 15000);
                        mo.observe(document.body, { childList: true, subtree: true });
                    });
                },
            },

            // 复用官方 IPC 通道（渲染层已有 __wbInvoke 桥）
            ipc: {
                invoke: function (channel) {
                    var args = [].slice.call(arguments, 1);
                    if (typeof window.__wbInvoke !== 'function') return Promise.reject(new Error('__wbInvoke 不可用'));
                    return window.__wbInvoke.apply(null, [channel].concat(args));
                },
                on: function (channel, cb) {
                    if (typeof window.__wbOn !== 'function') return function () {};
                    var wrapped = function () { cb.apply(null, arguments); };
                    window.__wbOn(channel, wrapped);
                    var off = function () {
                        try { window.__wbOff && window.__wbOff(channel, wrapped); } catch (e) { /* ignore */ }
                    };
                    cleanups.push(off);
                    return off;
                },
            },

            storage: {
                get: function (k, dflt) {
                    try {
                        var v = localStorage.getItem('wbpro:' + id + ':' + k);
                        return v == null ? dflt : JSON.parse(v);
                    } catch (e) { return dflt; }
                },
                set: function (k, v) {
                    try { localStorage.setItem('wbpro:' + id + ':' + k, JSON.stringify(v)); } catch (e) { /* ignore */ }
                },
            },

            // 插件自带后端进程（由 wbpro 拉起），无后端时抛错
            backend: {
                get baseUrl() { return def.backendUrl || null; },
                fetch: function (p, init) {
                    if (!def.backendUrl) return Promise.reject(new Error('该插件未声明 backend.entry'));
                    return fetch(def.backendUrl + (p || '/'), init);
                },
                json: function (p, init) {
                    return ctx.backend.fetch(p, init).then(function (r) { return r.json(); });
                },
            },

            onCleanup: function (fn) { cleanups.push(fn); },
        };

        ctx.cleanup = function () {
            while (cleanups.length) {
                try { cleanups.pop()(); } catch (e) { log('cleanup 失败', id, e); }
            }
        };
        return ctx;
    }

    /* ---------------- 装载 ---------------- */
    function activateAll(defs) {
        defs.forEach(function (def) {
            if (!def || !def.id) return;
            var ctx = makeContext(def);
            try {
                var deactivate = typeof def.code === 'function' ? def.code(ctx) : null;
                if (typeof deactivate === 'function') ctx.onCleanup(deactivate);
                host.plugins.set(def.id, { ctx: ctx, def: def, error: null });
                log('已加载', def.id, '@' + (def.manifest && def.manifest.version));
            } catch (e) {
                host.plugins.set(def.id, { ctx: ctx, def: def, error: e });
                log('加载失败', def.id, e);
                try { ctx.cleanup(); } catch (_) { /* ignore */ }
            }
        });
    }

    host.__reset = function () {
        host.plugins.forEach(function (p) { try { p.ctx.cleanup(); } catch (e) { log('卸载失败', p.def.id, e); } });
        host.plugins.clear();
        host.mounted.forEach(function (n) { try { n.remove(); } catch (e) { /* ignore */ } });
        host.mounted = [];
        document.querySelectorAll('[data-wbpro-style]').forEach(function (n) { n.remove(); });
    };

    host.__mount = function (meta, defs) {
        host.__reset();
        host.meta = meta || {};
        var run = function () { activateAll(defs || []); };
        if (document.body) run();
        else document.addEventListener('DOMContentLoaded', run, { once: true });

        // 保活：SPA 若替换 body/根节点，把面板重新挂回
        if (!host.keeper) {
            host.keeper = setInterval(function () {
                if (!document.body) return;
                host.mounted.forEach(function (n) {
                    if (!n.isConnected) document.body.appendChild(n);
                });
            }, 2000);
        }
        return { plugins: (defs || []).length };
    };

    host.status = function () {
        var out = [];
        host.plugins.forEach(function (p, id) {
            out.push({ id: id, version: p.def.manifest && p.def.manifest.version, error: p.error ? String(p.error) : null });
        });
        return { version: host.version, meta: host.meta || null, plugins: out };
    };

    window[KEY] = host;
    log('运行时就绪');
})();
