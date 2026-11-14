/* WorkBuddy 插件运行时（注入到渲染进程主世界执行）。
 * 由 wbpro 通过 CDP 注入，不写入任何官方文件。
 * 约定：每个插件在 activate(ctx) 中注册 UI/能力，返回值为卸载函数。
 */
(function () {
    'use strict';
    var KEY = '__wbpro';
    var Z = 2147483000;
    // 每次改动运行时能力都要 +1：版本不同会替换掉页面里的旧 host，
    // 否则旧 host 会因为下面的 early-return 一直占着位置，新 API（如 control）永远不生效。
    var RUNTIME_VERSION = '0.6.0';

    var prev = window[KEY];
    if (prev && prev.alive && prev.runtimeVersion === RUNTIME_VERSION) return;

    // 旧版本运行时：先尽量卸载干净，再整体替换
    if (prev && prev.alive) {
        try {
            prev.keeper && clearInterval(prev.keeper);
            prev.__reset && prev.__reset();
        } catch (e) {
            /* 旧运行时状态可能不完整，忽略 */
        }
        document.querySelectorAll('[data-wbpro-panel],[data-wbpro-style],[data-wbpro-nav]').forEach(function (n) {
            try { n.remove(); } catch (e) { /* ignore */ }
        });
        try { delete window[KEY]; } catch (e) { window[KEY] = undefined; }
    }

    var host = {
        alive: true,
        runtimeVersion: RUNTIME_VERSION,
        // 单一来源：不要在这里再写一遍字面量，否则改了上面那行这里会漏改，
        // 导致 status 显示的版本与 early-return 的判断口径不一致。
        version: RUNTIME_VERSION,
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
        var id = opts.id;
        // 持久化面板：热重载时会被保留，重新激活时复用同一个节点，不闪不丢
        var reuse = null;
        if (opts.persist) {
            reuse = host.mounted.filter(function (n) {
                return n.__persist && n.getAttribute('data-wbpro-panel') === id && n.isConnected;
            })[0] || null;
        }

        var wrap, shadow, card, head, title, close, body;

        if (reuse) {
            wrap = reuse;
            wrap.removeAttribute('data-wbpro-closed');
            wrap.__closed = false;
            var parts = wrap.__parts;
            shadow = parts.shadow;
            card = parts.card;
            head = parts.head;
            title = parts.title;
            close = parts.close;
            body = parts.body;
            body.textContent = ''; // 清空旧内容，用新实例的闭包重渲染
            title.textContent = opts.title || id;
        } else {
            wrap = document.createElement('div');
            wrap.setAttribute('data-wbpro-panel', id);
            css(wrap, anchorStyle(opts.position));

            shadow = wrap.attachShadow({ mode: 'open' });
            var style = document.createElement('style');
            style.textContent = PANEL_CSS + (opts.css || '');
            card = document.createElement('div');
            card.className = 'p';
            head = document.createElement('div');
            head.className = 'h';
            title = document.createElement('span');
            title.className = 't';
            title.textContent = opts.title || id;
            close = document.createElement('span');
            close.className = 'x';
            close.textContent = '\u00d7';
            close.title = '关闭（会话内隐藏）';
            body = document.createElement('div');
            body.className = 'b';

            head.appendChild(title);
            if (opts.closable !== false) head.appendChild(close);
            card.appendChild(head);
            card.appendChild(body);
            shadow.appendChild(style);
            shadow.appendChild(card);

            wrap.__parts = { shadow: shadow, card: card, head: head, title: title, body: body, close: close };

            // 只绑一次；通过 __closeHandler 指向「当前实例」的销毁函数，
            // 这样面板被复用时，关闭动作作用在新的 api 上。
            close.addEventListener('click', function () {
                var fn = wrap.__closeHandler;
                if (typeof fn === 'function') fn();
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
        }

        wrap.__persist = !!opts.persist;
        wrap.__claimed = true;

        // 统一的销毁出口：必须走这里，否则 host.mounted 里留着已移除的节点，
        // 保活定时器会在 2 秒后把它重新挂回 body（表现为「关了又自己打开」）。
        var disposed = false;
        var api = {
            el: wrap,
            body: body,
            title: title,
            persist: !!opts.persist,
            remove: function () {
                if (disposed) return;
                disposed = true;
                wrap.__closed = true;
                wrap.setAttribute('data-wbpro-closed', '1');
                try {
                    wrap.remove();
                } catch (e) {
                    /* ignore */
                }
                host.mounted = host.mounted.filter(function (n) { return n !== wrap; });
                if (typeof opts.onClose === 'function') {
                    try {
                        opts.onClose();
                    } catch (e) {
                        log('onClose 回调失败', opts.id, e);
                    }
                }
            },
        };
        wrap.__closeHandler = api.remove;

        if (typeof opts.render === 'function') {
            try {
                opts.render(body, ctx);
            } catch (e) {
                body.textContent = '渲染失败: ' + e.message;
                log('panel render 失败', opts.id, e);
            }
        }
        return api;
    }

    /* ---------------- 控制服务 ---------------- */
    function ctl(pathname, init) {
        var meta = host.meta || {};
        if (!meta.controlUrl) return Promise.reject(new Error('控制服务未启动（请用 wbpro up 启动）'));
        var sep = pathname.indexOf('?') > -1 ? '&' : '?';
        var url = meta.controlUrl + pathname + sep + 't=' + meta.controlToken;
        var opts = Object.assign({ headers: { 'Content-Type': 'application/json' } }, init || {});
        return fetch(url, opts).then(function (r) { return r.json(); });
    }

    host.control = {
        list: function () { return ctl('/api/plugins'); },
        toggle: function (id, enabled) {
            return ctl('/api/plugins/' + encodeURIComponent(id) + '/enabled', {
                method: 'POST',
                body: JSON.stringify({ enabled: !!enabled }),
            });
        },
        reload: function () { return ctl('/api/reload', { method: 'POST', body: '{}' }); },
        openDir: function () { return ctl('/api/open-dir', { method: 'POST', body: '{}' }); },
        // 插件运行时配置：写在插件目录的 runtime.json，Node 侧也读同一份
        configGet: function (id) { return ctl('/api/config/' + encodeURIComponent(id)); },
        configSet: function (id, config) {
            return ctl('/api/config/' + encodeURIComponent(id), {
                method: 'POST',
                body: JSON.stringify(config || {}),
            });
        },
    };

    /* ---------------- 插件上下文 ---------------- */
    function makeContext(def) {
        var id = def.id;
        var manifest = def.manifest || {};
        var cleanups = [];

        // 插件被原地保留时，host.plugins 里的 def 会换成新一轮的对象
        function currentDef() {
            var entry = host.plugins.get(id);
            return (entry && entry.def) || def;
        }

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
                    // 持久化面板不自动销毁：它由运行时在重置时保留、在下一轮激活时复用，
                    // 若插件被停用则由 reclaimPanels 统一回收。
                    if (!p.persist) cleanups.push(p.remove);
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

            // 插件自带后端进程（由 wbpro 拉起），无后端时抛错。
            // 注意：热更新时插件可能被保留（def 换了新对象），这里必须动态取，
            // 否则后端换端口后旧闭包还指向老地址。
            backend: {
                get baseUrl() { return currentDef().backendUrl || null; },
                fetch: function (p, init) {
                    var base = currentDef().backendUrl;
                    if (!base) return Promise.reject(new Error('该插件未声明 backend.entry'));
                    return fetch(base + (p || '/'), init);
                },
                json: function (p, init) {
                    return ctx.backend.fetch(p, init).then(function (r) { return r.json(); });
                },
            },

            onCleanup: function (fn) { cleanups.push(fn); },
        };

        ctx.control = host.control;

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
        // 持久化面板不销毁，标记为「未认领」，等本轮激活时复用
        host.mounted = host.mounted.filter(function (n) {
            if (n.__persist && !n.__closed) {
                n.__claimed = false;
                return true;
            }
            try { n.remove(); } catch (e) { /* ignore */ }
            return false;
        });
        document.querySelectorAll('[data-wbpro-style]').forEach(function (n) { n.remove(); });
    };

    /** 代码与清单都没变，就不必重建：这是热更新不闪的前提 */
    function sameDef(a, b) {
        if (!a || !b) return false;
        if (a.id !== b.id) return false;
        if (a.sig && b.sig) return a.sig === b.sig;
        // 老 bundle 没带 sig（理论上不会出现），退回比较函数源码
        try {
            return String(a.code) === String(b.code);
        } catch (e) {
            return false;
        }
    }

    function reclaimPanels() {
        // 插件被停用/删除后，它遗留的持久化面板要清掉
        host.mounted = host.mounted.filter(function (n) {
            if (!n.__persist || n.__claimed) return true;
            try { n.remove(); } catch (e) { /* ignore */ }
            return false;
        });
    }

    /**
     * 差分挂载：只卸载「消失或已变更」的插件，其余原地保留。
     * 这样开关某个插件时，插件管理器不会被牵连重建，面板不会闪。
     */
    host.__mount = function (meta, defs) {
        host.meta = meta || {};
        defs = (defs || []).filter(function (d) { return d && d.id; });

        var incoming = {};
        defs.forEach(function (d) { incoming[d.id] = d; });

        var kept = {};
        host.plugins.forEach(function (p, id) {
            var next = incoming[id];
            if (next && sameDef(p.def, next)) {
                kept[id] = true;
                p.def = next; // 只更新引用，不重跑代码
                return;
            }
            try { p.ctx.cleanup(); } catch (e) { log('卸载失败', id, e); }
            host.plugins.delete(id);
        });

        // 面板：保留插件的节点一律不动（含非 persist 面板）；其余按原规则回收
        host.mounted = host.mounted.filter(function (n) {
            var owner = n.getAttribute ? n.getAttribute('data-wbpro-panel') : null;
            if (owner && kept[owner]) return true;
            if (n.__persist && !n.__closed) {
                n.__claimed = false;
                return true;
            }
            try { n.remove(); } catch (e) { /* ignore */ }
            return false;
        });

        // 样式同理，别把保留插件的 style 删掉，否则会闪一下无样式
        document.querySelectorAll('[data-wbpro-style]').forEach(function (n) {
            var owner = n.getAttribute('data-wbpro-style');
            if (owner && kept[owner]) return;
            try { n.remove(); } catch (e) { /* ignore */ }
        });

        var pending = defs.filter(function (d) { return !kept[d.id]; });
        var run = function () {
            activateAll(pending);
            reclaimPanels();
        };
        if (document.body) run();
        else document.addEventListener('DOMContentLoaded', run, { once: true });

        // 保活：SPA 若替换 body/根节点，把面板重新挂回（已关闭的不复活）
        if (!host.keeper) {
            host.keeper = setInterval(function () {
                if (!document.body) return;
                host.mounted.forEach(function (n) {
                    if (n.isConnected) return;
                    if (n.hasAttribute && n.hasAttribute('data-wbpro-closed')) return;
                    document.body.appendChild(n);
                });
            }, 2000);
        }
        return { plugins: defs.length, reloaded: pending.length, kept: Object.keys(kept).length };
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
