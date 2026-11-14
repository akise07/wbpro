// 子代理轨迹面板：把 CLI 落盘的子代理 jsonl 渲染成可读时间线。
//
// 为什么不用事件流：实测 wb:event 只推送生命周期（requestsIncluded:false），
// 思考和工具调用不经过渲染层。数据在 ~/.workbuddy/projects/<编码cwd>/<会话ID>/subagents/，
// 由同目录的 backend.cjs 读出并提供 /api/subagents 与 /api/subagent。
//
// 本文件不依赖主 renderer.js，只暴露 window.__duoSubagent，由 renderer.js 调用挂载。

(function () {
    'use strict';

    var POLL_MS = 1500;
    var MAX_ITEMS_RENDER = 400;

    /** 简易转义，面板里所有动态文本都过一遍 */
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function fmtTime(ts) {
        if (!ts) return '';
        var d = new Date(ts);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        return hh + ':' + mm + ':' + ss;
    }

    function fmtAgo(ts) {
        if (!ts) return '';
        var s = Math.round((Date.now() - ts) / 1000);
        if (s < 5) return '刚刚';
        if (s < 60) return s + ' 秒前';
        if (s < 3600) return Math.round(s / 60) + ' 分钟前';
        return Math.round(s / 3600) + ' 小时前';
    }

    function fmtSize(n) {
        if (!n) return '0';
        if (n < 1024) return n + 'B';
        if (n < 1048576) return (n / 1024).toFixed(1) + 'K';
        return (n / 1048576).toFixed(1) + 'M';
    }

    /**
     * 创建轨迹面板控制器。
     * @param {object} ctx  插件上下文（用 ctx.ui / ctx.backend / ctx.log）
     * @param {function} getSession  返回当前 sessionId 的函数
     * @param {function} getCwd      返回当前工作目录的函数
     */
    function create(ctx, getSession, getCwd) {
        var panel = null;
        var timer = null;
        var activeId = null;      // 当前展开的子代理 id
        var listEl = null;
        var detailEl = null;
        var statusEl = null;
        var lastSig = '';         // 用于判断是否需要重绘，避免打断滚动

        function api(path) {
            if (!ctx.backend || !ctx.backend.baseUrl) {
                return Promise.reject(new Error('后端未就绪（需要 wbpro up 启动）'));
            }
            // cwd 传空即可：页面里拿不到 cwd，后端会按 sessionId 全盘搜索定位
            var sep = path.indexOf('?') > -1 ? '&' : '?';
            var url = path + sep + 'cwd=' + encodeURIComponent(getCwd() || '') + '&sessionId=' + encodeURIComponent(getSession() || '');
            return ctx.backend.fetch(url).then(function (r) {
                if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || ('HTTP ' + r.status)); });
                return r.json();
            });
        }

        function setStatus(text, tone) {
            if (!statusEl) return;
            statusEl.textContent = text || '';
            statusEl.style.color = tone === 'bad' ? '#ff8f8f' : tone === 'ok' ? '#5DCAA5' : 'rgba(255,255,255,.45)';
        }

        /* ---------- 列表 ---------- */

        function renderList(data) {
            if (!listEl) return;
            listEl.textContent = '';

            if (!data.count) {
                var empty = document.createElement('div');
                empty.style.cssText = 'padding:14px 4px;font-size:12px;opacity:.55;line-height:1.7;';
                empty.textContent = '这个会话还没有子代理记录。主模型委派任务后会出现在这里。';
                listEl.appendChild(empty);
                return;
            }

            data.subagents.forEach(function (s) {
                var row = document.createElement('div');
                var isActive = s.id === activeId;
                row.style.cssText =
                    'display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:7px;cursor:pointer;' +
                    'margin-bottom:3px;border:1px solid ' + (isActive ? 'rgba(127,119,221,.7)' : 'rgba(255,255,255,.08)') + ';' +
                    'background:' + (isActive ? 'rgba(127,119,221,.16)' : 'rgba(255,255,255,.03)') + ';';

                var dot = document.createElement('span');
                var live = Date.now() - s.mtime < 8000;
                dot.style.cssText =
                    'width:6px;height:6px;border-radius:50%;flex:none;background:' + (live ? '#5DCAA5' : 'rgba(255,255,255,.3)') + ';';
                row.appendChild(dot);

                var mid = document.createElement('div');
                mid.style.cssText = 'flex:1;min-width:0;';
                var t1 = document.createElement('div');
                t1.style.cssText = 'font-size:12px;display:flex;gap:6px;align-items:center;';
                t1.innerHTML =
                    '<code style="font-size:11px;opacity:.85">' + esc(s.id.slice(0, 8)) + '</code>' +
                    '<span style="opacity:.5;font-size:11px">' + esc(fmtAgo(s.mtime)) + '</span>';
                var t2 = document.createElement('div');
                t2.style.cssText = 'font-size:11px;opacity:.55;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                var toolBits = Object.keys(s.summary.tools)
                    .map(function (k) { return k + '×' + s.summary.tools[k]; })
                    .join(' ');
                t2.textContent =
                    s.summary.reasoningCount + ' 段思考 · ' + s.summary.toolCount + ' 次工具' + (toolBits ? ' · ' + toolBits : '');
                mid.appendChild(t1);
                mid.appendChild(t2);
                row.appendChild(mid);

                var sz = document.createElement('span');
                sz.style.cssText = 'font-size:10px;opacity:.35;flex:none;';
                sz.textContent = fmtSize(s.size);
                row.appendChild(sz);

                row.onclick = function () {
                    if (activeId === s.id) {
                        activeId = null;
                        if (detailEl) detailEl.textContent = '';
                        lastSig = '';
                        loadList();
                        return;
                    }
                    activeId = s.id;
                    lastSig = '';
                    loadDetail(s.id);
                    loadList();
                };
                listEl.appendChild(row);
            });
        }

        /* ---------- 详情 ---------- */

        function buildItem(it) {
            var wrap = document.createElement('div');
            wrap.style.cssText = 'margin-bottom:8px;';

            if (it.kind === 'message') {
                wrap.style.cssText +=
                    'padding:7px 9px;border-radius:6px;background:rgba(127,119,221,.10);border-left:2px solid rgba(127,119,221,.6);';
                var tag = document.createElement('div');
                tag.style.cssText = 'font-size:10px;opacity:.5;margin-bottom:3px;';
                tag.textContent = it.role === 'user' ? '任务' : '回复';
                var body = document.createElement('div');
                body.style.cssText = 'font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;';
                body.textContent = it.text;
                wrap.appendChild(tag);
                wrap.appendChild(body);
                return wrap;
            }

            if (it.kind === 'reasoning') {
                wrap.style.cssText += 'padding:6px 9px;border-radius:6px;background:rgba(255,255,255,.04);';
                var h = document.createElement('div');
                h.style.cssText = 'font-size:10px;opacity:.45;margin-bottom:3px;display:flex;gap:6px;';
                h.textContent = '思考' + (it.step != null ? ' · step ' + it.step : '') + (it.model ? ' · ' + it.model : '');
                var b = document.createElement('div');
                b.style.cssText = 'font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;opacity:.88;';
                b.textContent = it.text;
                wrap.appendChild(h);
                wrap.appendChild(b);
                return wrap;
            }

            if (it.kind === 'tool') {
                wrap.style.cssText +=
                    'padding:6px 9px;border-radius:6px;background:rgba(93,202,165,.10);border-left:2px solid rgba(93,202,165,.55);';
                var th = document.createElement('div');
                th.style.cssText = 'font-size:11px;display:flex;gap:6px;align-items:center;margin-bottom:3px;';
                th.innerHTML =
                    '<strong style="color:#8fe3c4">' + esc(it.name) + '</strong>' +
                    '<span style="opacity:.35;font-size:10px">' + esc(fmtTime(it.ts)) + '</span>';
                wrap.appendChild(th);
                if (it.args) {
                    var pre = document.createElement('pre');
                    pre.style.cssText =
                        'margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;' +
                        'white-space:pre-wrap;word-break:break-word;opacity:.8;max-height:160px;overflow:auto;';
                    pre.textContent = it.args;
                    wrap.appendChild(pre);
                }
                return wrap;
            }

            if (it.kind === 'result') {
                wrap.style.cssText += 'padding:5px 9px;border-radius:6px;background:rgba(255,255,255,.025);';
                var rh = document.createElement('div');
                rh.style.cssText = 'font-size:10px;opacity:.4;margin-bottom:2px;';
                rh.textContent = '结果 · ' + (it.name || '') + (it.status ? ' · ' + it.status : '');
                wrap.appendChild(rh);
                var rp = document.createElement('pre');
                rp.style.cssText =
                    'margin:0;font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.5;' +
                    'white-space:pre-wrap;word-break:break-word;opacity:.62;max-height:120px;overflow:auto;';
                rp.textContent = it.text;
                wrap.appendChild(rp);
                return wrap;
            }

            return wrap;
        }

        function renderDetail(data) {
            if (!detailEl) return;
            // 签名相同就不重绘：轮询时保持滚动位置
            var sig = data.id + ':' + data.items.length + ':' + data.mtime + ':' + data.running;
            if (sig === lastSig) {
                if (statusEl) {
                    statusEl.textContent = (data.running ? '运行中' : '已结束') + ' · ' + data.items.length + ' 条 · ' + fmtAgo(data.mtime);
                    statusEl.style.color = data.running ? '#5DCAA5' : 'rgba(255,255,255,.45)';
                }
                return;
            }
            var atBottom = detailEl.scrollTop + detailEl.clientHeight >= detailEl.scrollHeight - 24;
            lastSig = sig;

            detailEl.textContent = '';
            var items = data.items.slice(-MAX_ITEMS_RENDER);
            if (data.items.length > MAX_ITEMS_RENDER) {
                var cut = document.createElement('div');
                cut.style.cssText = 'font-size:10px;opacity:.4;margin-bottom:6px;';
                cut.textContent = '仅显示最后 ' + MAX_ITEMS_RENDER + ' 条（共 ' + data.items.length + ' 条）';
                detailEl.appendChild(cut);
            }
            items.forEach(function (it) {
                detailEl.appendChild(buildItem(it));
            });

            if (statusEl) {
                statusEl.textContent =
                    (data.running ? '运行中' : '已结束') + ' · ' + data.items.length + ' 条 · ' + fmtAgo(data.mtime);
                statusEl.style.color = data.running ? '#5DCAA5' : 'rgba(255,255,255,.45)';
            }
            // 原本就在底部：跟随新内容；否则保持用户当前位置
            if (atBottom) detailEl.scrollTop = detailEl.scrollHeight;
        }

        /* ---------- 加载 ---------- */

        var boundSession = ''; // 面板当前绑定的会话，用于发现「用户切了会话」

        function loadList() {
            var sid = getSession() || '';
            if (!sid) {
                setStatus('读不到当前会话 ID，无法定位子代理记录', 'bad');
                return Promise.resolve();
            }
            return api('/api/subagents')
                .then(function (data) {
                    // 会话变了：清掉展开状态，避免把上一个会话的子代理详情留在面板里
                    if (boundSession && boundSession !== data.sessionId) {
                        activeId = null;
                        if (detailEl) detailEl.textContent = '会话已切换，选择一个子代理查看轨迹。';
                    }
                    boundSession = data.sessionId;
                    renderList(data);
                    var short = data.sessionId ? data.sessionId.slice(0, 8) : '';
                    setStatus((data.count ? data.count + ' 个子代理' : '暂无子代理') + (short ? ' · 会话 ' + short : ''));
                })
                .catch(function (e) {
                    setStatus(String(e.message || e), 'bad');
                });
        }

        function loadDetail(id) {
            return api('/api/subagent?id=' + encodeURIComponent(id))
                .then(renderDetail)
                .catch(function (e) {
                    if (detailEl) detailEl.textContent = '读取失败: ' + (e.message || e);
                });
        }

        function tick() {
            if (!panel || !panel.el || !panel.el.isConnected) return;
            loadList();
            if (activeId) loadDetail(activeId);
        }

        /* ---------- 面板 ---------- */

        function open() {
            if (panel && panel.el && panel.el.isConnected) return panel;
            panel = ctx.ui.panel({
                title: '子代理轨迹',
                position: 'bottom-left',
                persist: true,
                css: '.p{min-width:420px;max-width:min(560px,46vw);}',
                onClose: function () {
                    panel = null;
                    stopPoll();
                },
                render: function (body) {
                    var head = document.createElement('div');
                    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px;';
                    statusEl = document.createElement('span');
                    statusEl.style.cssText = 'flex:1;font-size:11px;opacity:.55;';
                    statusEl.textContent = '读取中…';
                    var refresh = document.createElement('button');
                    refresh.textContent = '刷新';
                    refresh.style.cssText = 'font-size:11px;padding:2px 8px;';
                    refresh.onclick = function () { tick(); };
                    head.appendChild(statusEl);
                    head.appendChild(refresh);

                    listEl = document.createElement('div');
                    listEl.style.cssText = 'max-height:22vh;overflow:auto;margin-bottom:6px;';

                    detailEl = document.createElement('div');
                    detailEl.style.cssText =
                        'max-height:44vh;overflow:auto;border-top:1px solid rgba(255,255,255,.09);padding-top:8px;';

                    body.appendChild(head);
                    body.appendChild(listEl);
                    body.appendChild(detailEl);

                    loadList();
                    startPoll();
                },
            });
            return panel;
        }

        function startPoll() {
            stopPoll();
            timer = setInterval(tick, POLL_MS);
        }

        function stopPoll() {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
        }

        function toggle() {
            if (panel && panel.el && panel.el.isConnected) {
                panel.remove();
                panel = null;
                stopPoll();
                return;
            }
            open();
        }

        function destroy() {
            stopPoll();
            if (panel && !panel.persist) panel.remove();
            panel = null;
            listEl = detailEl = statusEl = null;
            activeId = null;
            lastSig = '';
        }

        return { open: open, toggle: toggle, destroy: destroy, refresh: tick };
    }

    window.__duoSubagent = { create: create };
})();
