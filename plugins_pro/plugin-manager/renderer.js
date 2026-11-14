// 插件管理器：在左侧栏「更多」下方插入入口，点开是插件列表（启停 + 热更新）。
// 思路：克隆官方「更多」那一行的 DOM，继承它的样式，只替换图标与文字。
// 这样官方改类名 / 改样式都不用跟着改，抗更新。

var NAV_LABEL = '插件管理';
var ANCHOR_TEXTS = ['更多', 'More']; // 中英文界面都试
var NAV_FLAG = 'data-wbpro-nav';
var ICON_PUZZLE =
    'M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 1.998 12c0-.617.236-1.234.706-1.704L4.23 8.77c.24-.24.581-.353.917-.303.515.077.877.528 1.073 1.01a2.5 2.5 0 1 0 3.259-3.259c-.482-.196-.933-.558-1.01-1.073-.05-.336.062-.676.303-.917l1.525-1.525A2.402 2.402 0 0 1 12 1.998c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z';

/* ---------- DOM 定位 ---------- */

// 找到文本完全等于 target 的叶子节点（取渲染面积最小的那个）
function findLeafByText(target) {
    var nodes = document.querySelectorAll('span,a,div,button,p,label');
    var best = null;
    for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        if (el.children.length) continue;
        if ((el.textContent || '').trim() !== target) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        if (!best || r.width * r.height < best.area) best = { el: el, area: r.width * r.height };
    }
    return best ? best.el : null;
}

// 从文字节点向上找「一行」：高度像导航项、宽度足够、可点击
function findRow(leaf) {
    var el = leaf;
    for (var i = 0; i < 6 && el && el.parentElement; i++) {
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        var clickable = cs.cursor === 'pointer' || el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button';
        if (r.height >= 26 && r.height <= 64 && r.width >= 90 && clickable) return el;
        el = el.parentElement;
    }
    // 兜底：退回两层祖先
    return leaf.parentElement ? leaf.parentElement.parentElement || leaf.parentElement : leaf;
}

function makeIcon(template) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.8');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (template) {
        // 继承原图标的尺寸与样式类
        var w = template.getAttribute('width');
        var h = template.getAttribute('height');
        if (w) svg.setAttribute('width', w);
        if (h) svg.setAttribute('height', h);
        if (!w && !h) {
            svg.style.width = getComputedStyle(template).width;
            svg.style.height = getComputedStyle(template).height;
        }
        if (template.getAttribute('class')) svg.setAttribute('class', template.getAttribute('class'));
    } else {
        svg.style.width = '16px';
        svg.style.height = '16px';
    }
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICON_PUZZLE);
    svg.appendChild(path);
    return svg;
}

function stripActiveState(node) {
    node.removeAttribute('aria-current');
    node.removeAttribute('aria-selected');
    var cls = (node.className || '').toString();
    if (cls) {
        var kept = cls
            .split(/\s+/)
            .filter(function (c) { return c && !/active|selected|current/i.test(c); })
            .join(' ');
        if (kept !== cls) node.className = kept;
    }
}

/* ---------- 插件管理器 ---------- */

function activate(ctx) {
    var panelRef = null;
    var navRef = null;
    var timer = null;

    ctx.ui.css(
        [
            '[' + NAV_FLAG + ']{position:relative}',
            '[' + NAV_FLAG + '] *{cursor:pointer}',
        ].join('\n'),
    );

    /* ----- 列表渲染 ----- */
    function row(plugin, onChange) {
        var el = document.createElement('div');
        el.style.cssText = 'display:flex;align-items:center;gap:10px;padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.07);';

        var left = document.createElement('div');
        left.style.cssText = 'flex:1;min-width:0;';

        var title = document.createElement('div');
        title.style.cssText = 'display:flex;align-items:center;gap:6px;';
        var name = document.createElement('span');
        name.textContent = plugin.name;
        name.style.cssText = 'font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        title.appendChild(name);

        var ver = document.createElement('span');
        ver.textContent = 'v' + plugin.version;
        ver.style.cssText = 'font-size:11px;opacity:.45;flex:none;';
        title.appendChild(ver);

        if (plugin.system) {
            var sys = document.createElement('span');
            sys.textContent = '内置';
            sys.style.cssText =
                'font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(127,119,221,.22);color:#c9c4f7;flex:none;';
            title.appendChild(sys);
        }

        var meta = document.createElement('div');
        meta.style.cssText = 'font-size:11px;opacity:.5;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        var tags = [];
        if (plugin.ui) tags.push('UI');
        if (plugin.backend) tags.push('后端');
        meta.textContent = plugin.id + (tags.length ? ' · ' + tags.join(' + ') : '') + (plugin.description ? ' · ' + plugin.description : '');

        left.appendChild(title);
        left.appendChild(meta);

        var sw = document.createElement('label');
        sw.style.cssText = 'flex:none;position:relative;width:34px;height:19px;';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!plugin.enabled;
        input.style.cssText = 'position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer;';
        var track = document.createElement('span');
        track.style.cssText =
            'position:absolute;inset:0;border-radius:20px;transition:background .16s;background:' +
            (plugin.enabled ? 'rgba(127,119,221,.85)' : 'rgba(255,255,255,.18)') + ';';
        var knob = document.createElement('span');
        knob.style.cssText =
            'position:absolute;top:2px;left:' + (plugin.enabled ? '17px' : '2px') +
            ';width:15px;height:15px;border-radius:50%;background:#fff;transition:left .16s;pointer-events:none;';
        sw.appendChild(track);
        sw.appendChild(knob);
        sw.appendChild(input);

        if (plugin.system) {
            input.disabled = true;
            sw.style.opacity = '.45';
            sw.title = '内置插件不可停用';
        }

        input.addEventListener('change', function () {
            onChange(plugin, input.checked);
        });

        el.appendChild(left);
        el.appendChild(sw);
        return el;
    }

    function openPanel() {
        if (panelRef) {
            panelRef.el.style.display = '';
            return;
        }
        ctx.storage.set('open', true);

        panelRef = ctx.ui.panel({
            title: '插件管理器',
            position: 'top-right',
            css: '.p{min-width:360px;}',
            render: function (body) {
                // 运行时可能是旧版本（页面没刷新），先给出可执行的提示而不是崩掉
                if (!ctx.control) {
                    body.textContent =
                        '运行时版本过旧（缺少 control 接口）。重新执行 wbpro up，或在窗口里按 Ctrl+R 刷新后重试。';
                    return;
                }
                var head = document.createElement('div');
                head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;';
                var count = document.createElement('span');
                count.style.cssText = 'flex:1;font-size:12px;opacity:.6;';
                count.textContent = '读取中…';
                var refresh = document.createElement('button');
                refresh.textContent = '热更新';
                refresh.onclick = function () {
                    ctx.ui.toast('正在热更新…');
                    ctx.control.reload().catch(function (e) {
                        ctx.ui.toast('热更新失败: ' + e.message);
                    });
                };
                head.appendChild(count);
                head.appendChild(refresh);

                var list = document.createElement('div');
                list.style.cssText = 'max-height:46vh;overflow:auto;margin:0 -2px;';

                var foot = document.createElement('div');
                foot.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:10px;';
                var open = document.createElement('button');
                open.textContent = '打开插件目录';
                open.onclick = function () {
                    ctx.control.openDir();
                };
                var dirTip = document.createElement('span');
                dirTip.style.cssText = 'font-size:11px;opacity:.42;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
                foot.appendChild(open);
                foot.appendChild(dirTip);

                body.appendChild(head);
                body.appendChild(list);
                body.appendChild(foot);

                function renderList(data) {
                    list.textContent = '';
                    var items = (data.plugins || []).slice();
                    var on = items.filter(function (p) { return p.enabled; }).length;
                    count.textContent = items.length + ' 个插件 · ' + on + ' 个启用';
                    dirTip.textContent = data.dir || '';
                    dirTip.title = data.dir || '';

                    if (!items.length) {
                        var empty = document.createElement('div');
                        empty.style.cssText = 'padding:14px 2px;font-size:12px;opacity:.55;';
                        empty.textContent = '插件目录为空。把插件文件夹放进上面的目录即可。';
                        list.appendChild(empty);
                        return;
                    }

                    items.forEach(function (p) {
                        list.appendChild(
                            row(p, function (plugin, checked) {
                                ctx.control
                                    .toggle(plugin.id, checked)
                                    .then(function () {
                                        ctx.ui.toast((checked ? '已启用 ' : '已禁用 ') + plugin.name + '，正在热更新…');
                                    })
                                    .catch(function (e) {
                                        ctx.ui.toast('切换失败: ' + e.message);
                                    });
                            }),
                        );
                    });
                }

                var load = function () {
                    ctx.control
                        .list()
                        .then(renderList)
                        .catch(function (e) {
                            count.textContent = '读取失败';
                            list.textContent = e.message + '（控制服务未启动？请用 wbpro up 启动）';
                        });
                };
                load();
                // 面板开着时定时刷新，外部改了目录也能看到
                var poll = setInterval(load, 4000);
                ctx.onCleanup(function () { clearInterval(poll); });
            },
        });

        // 面板被关掉时记住状态
        var mo = new MutationObserver(function () {
            if (!panelRef || !panelRef.el.isConnected) {
                ctx.storage.set('open', false);
                panelRef = null;
                mo.disconnect();
            }
        });
        mo.observe(document.body, { childList: true });
        ctx.onCleanup(function () { mo.disconnect(); });
    }

    /* ----- 侧边栏入口 ----- */
    function removeNav() {
        document.querySelectorAll('[' + NAV_FLAG + ']').forEach(function (n) { n.remove(); });
        navRef = null;
    }

    function insertNav() {
        if (navRef && navRef.isConnected) return true;
        var leaf = null;
        var anchorText = '';
        for (var i = 0; i < ANCHOR_TEXTS.length && !leaf; i++) {
            leaf = findLeafByText(ANCHOR_TEXTS[i]);
            if (leaf) anchorText = ANCHOR_TEXTS[i];
        }
        if (!leaf) return false;
        var rowEl = findRow(leaf);

        removeNav();
        var clone = rowEl.cloneNode(true);
        clone.setAttribute(NAV_FLAG, 'plugin-manager');
        stripActiveState(clone);
        clone.querySelectorAll('*').forEach(stripActiveState);
        clone.style.cursor = 'pointer';

        // 换图标
        var oldSvg = clone.querySelector('svg');
        var icon = makeIcon(oldSvg);
        if (oldSvg && oldSvg.parentNode) oldSvg.parentNode.replaceChild(icon, oldSvg);

        // 换文字：找到克隆体里原来那串文字
        var textLeaf = null;
        clone.querySelectorAll('*').forEach(function (n) {
            if (textLeaf) return;
            if (!n.children.length && (n.textContent || '').trim() === anchorText) textLeaf = n;
        });
        if (textLeaf) textLeaf.textContent = NAV_LABEL;
        else if (oldSvg && oldSvg.nextSibling && oldSvg.nextSibling.nodeType === 3) oldSvg.nextSibling.textContent = ' ' + NAV_LABEL;

        clone.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            openPanel();
        });

        rowEl.parentNode.insertBefore(clone, rowEl.nextSibling);
        navRef = clone;
        return true;
    }

    // 首屏可能还没渲染完，轮询等到出现为止；之后负责在被 React 重渲染掉时补回去
    var tries = 0;
    var warned = false;
    timer = setInterval(function () {
        tries++;
        var ok = insertNav();
        if (ok && tries < 40) ctx.log('侧边栏入口已插入');
        if (!ok && !warned && tries > 12) {
            warned = true;
            ctx.log('还没找到侧边栏「更多」，继续等待…（若一直不出现，说明导航结构变了）');
        }
    }, 1200);
    insertNav();

    // 上次面板开着，重载后自动打开
    if (ctx.storage.get('open', false)) {
        setTimeout(function () {
            if (!panelRef) openPanel();
        }, 900);
    }

    ctx.log('插件管理器已加载');

    return function () {
        clearInterval(timer);
        removeNav();
        if (panelRef) panelRef.remove();
        panelRef = null;
    };
}
