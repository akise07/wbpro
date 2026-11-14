/* 双模型协同：主模型决策 + 工作模型执行，并在界面上标出当前阶段。
 *
 * 两个模型的分工靠两条不同的通道：
 *   主模型 —— 当前会话模型。**只能通过点官方模型下拉项来切换**（见 applyMainModel 注释）；
 *             IPC 的 session:setModel / workbuddyDesktop.setSessionModel 都会"成功"返回，
 *             但实际请求还是旧模型，是假的。
 *   工作模型 —— 子代理模型。由 wbpro 装的 hook（hooks/router.mjs）在**每次 Agent 调用**时
 *               用 PreToolUse.updatedInput 强塞 model，所以改完下一次委派就生效，不用重启。
 *               （不能用 CODEBUDDY_CODE_SUBAGENT_MODEL：CLI 里 env 优先级高于调用参数）
 */
var PLUGIN_ID = 'dual-model';
var COOP_RULES = [
    '## 双模型协同',
    '',
    '本会话约定：你（主模型）负责决策与验收，执行交给子代理（工作模型）。',
    '',
    '1. 先判断任务量级。单文件小改动、单条查询，直接做，不要委派。',
    '2. 需要多步执行（3 步以上、跨文件、要跑命令验证）时，先用 1-3 句给出计划，',
    '   再用 Agent 工具把执行交给 general-purpose 子代理，把计划原文放进 prompt。',
    '3. 子代理返回后，你负责核对结果是否满足原始要求；不满足就再次委派，不要自己动手改。',
    '4. 每个阶段开始时说一句「规划」或「执行」，方便我确认当前由谁负责。',
].join('\n');

// 兜底列表：与官方选择器同源（cli agent 的 models 白名单，见 product.json 的 agents[].models）。
// 正常运行时会被宿主配置覆盖，这里只保证宿主不可用时不出现官方列表之外的模型。
// 兜底列表：与官方选择器同源（cli agent 的 models 白名单）。
// 正常运行时会被宿主配置覆盖，只保证宿主不可用时不出现官方列表之外的模型。
var BUILTIN_MODELS = [
    { id: "fast-model", name: "快速", credits: "x0.15", ctx: 300000, reasoning: true, onlyReasoning: true },
    { id: "balanced-model", name: "均衡", credits: "x0.50", ctx: 300000, reasoning: true, onlyReasoning: true },
    { id: "deep-model", name: "极致", credits: "x1.00", ctx: 300000, reasoning: true, onlyReasoning: true },
    { id: "hy4free", name: "Hy4", credits: "x0.00", ctx: 960000, reasoning: true, onlyReasoning: true },
    { id: "hy4std", name: "Hy4", credits: "x0.29", ctx: 960000, reasoning: true, onlyReasoning: true },
    { id: "hy3", name: "Hy3", credits: "x0.00", ctx: 192000, reasoning: true, onlyReasoning: true },
    { id: "hy3-x", name: "Hy3", credits: "x0.05", ctx: 192000, reasoning: true, onlyReasoning: true },
    { id: "deepseek-v4.1-flash", name: "DeepSeek-V4.1-Flash", credits: "x0.11", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "glm-5.3", name: "GLM-5.3", credits: "x0.69", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "glm-5.3-flash", name: "GLM-5.3-Flash", credits: "x0.08", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "glm-5.2", name: "GLM-5.2", credits: "x0.79", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "space-bunny", name: "Space-Bunny", credits: "x0.08", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "minimax-m3.1-flash", name: "MiniMax-M3.1-Flash", credits: "x0.08", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "kimi-k3.1-pro", name: "Kimi-K3.1-Pro", credits: "x0.97", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "kimi-k3-1", name: "Kimi-K3", credits: "x1.62", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "kimi-k2.8-preview", name: "Kimi-K2.8-Preview", credits: "x0.77", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", credits: "x0.51", ctx: 1000000, reasoning: true, onlyReasoning: false },
    { id: "step-5-preview", name: "Step-5-Preview", credits: "x0.33", ctx: 1000000, reasoning: true, onlyReasoning: true },
    { id: "mimo-v2.6-pro", name: "Xiaomi MiMo-V2.6-Pro", credits: "x0.13", ctx: 1000000, reasoning: true, onlyReasoning: true },
];

/* ---------- 宿主能力探测 ---------- */

// contextBridge 暴露的对象是只读代理，但可以读。这里按名递归找函数。
function findFn(root, name, depth) {
    if (!root || depth < 0) return null;
    try {
        if (typeof root[name] === 'function') return root[name].bind(root);
        for (var k of Object.keys(root)) {
            var v;
            try { v = root[k]; } catch (e) { continue; }
            if (v && typeof v === 'object' && v !== root) {
                var hit = findFn(v, name, depth - 1);
                if (hit) return hit;
            }
        }
    } catch (e) { /* 代理可能抛错 */ }
    return null;
}

// 收集所有同名函数：config.getProductConfiguration（完整配置，含 models）
// 与 sessions.getProductConfiguration（裁剪版，只有 modelGroups）同名，必须逐个试
function findFns(root, name, depth) {
    var out = [];
    (function walk(node, d) {
        if (!node || d < 0) return;
        try {
            if (typeof node[name] === 'function') out.push(node[name].bind(node));
            for (var k of Object.keys(node)) {
                var v;
                try { v = node[k]; } catch (e) { continue; }
                if (v && typeof v === 'object' && v !== node) walk(v, d - 1);
            }
        } catch (e) { /* 代理可能抛错 */ }
    })(root, depth);
    return out;
}

/**
 * 取当前会话 ID。
 *
 * 不能用「最近写入的会话目录」猜 —— 同时开两个会话时，另一个在跑的那个才是最新写的，
 * 会把面板指到错误的会话上。
 *
 * 可靠来源是主对话区的 [data-root-id]：官方 DocumentRenderer 用它标记当前渲染的文档根，
 * 值就是会话 ID，全局唯一，切换会话时随 DOM 一起变。
 * 注意别用侧边栏的 [data-conversation-id] —— 那是列表里每一项都有的，拿到的可能是任意一个。
 */
function currentSessionId() {
    try {
        var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        // 主对话区的文档根。限定在 message-list 视口内，避免拿到别的面板
        var roots = document.querySelectorAll('.cr-message-list-viewport [data-root-id]');
        if (!roots.length) roots = document.querySelectorAll('[data-root-id]');
        for (var i = 0; i < roots.length; i++) {
            var v = roots[i].getAttribute('data-root-id');
            if (v && UUID.test(v)) return v;
        }
        // 兜底：老版本可能没有 data-root-id
        var d = window.workbuddyDesktop;
        var direct = d && (d.currentSessionId || d.sessionId);
        if (typeof direct === 'string' && direct) return direct;
        var m = location.hash.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        return m ? m[1] : '';
    } catch (e) {
        return '';
    }
}

function activate(ctx) {
    var state = {
        mainModel: '',
        workerModel: '',
        workerMaxTurns: 0,
        phase: 'idle',
        auto: true,
        duo: false, // 是否处于「主从模型」协作模式
    };
    var panelRef = null;
    var badge = null;
    var badgeText = null;
    var probe = { desktop: false, setModel: false, invoke: false, onEvent: false };
    var lastApply = '';
    var syncingMain = false; // 正在用脚本点官方模型项，期间不要当成"用户切走档位"
    var modelList = BUILTIN_MODELS.slice();

    function byId(id) {
        for (var i = 0; i < modelList.length; i++) if (modelList[i].id === id) return modelList[i];
        return null;
    }

    function shortName(id) {
        var m = byId(id);
        return m ? m.name : (id || '未设置');
    }

    /* ---------- 阶段 ---------- */

    var PHASES = {
        idle: { label: '待命', hint: '等待任务' },
        planning: { label: '主模型', hint: '决策 / 验收' },
        working: { label: '工作模型', hint: '执行中' },
    };

    function setPhase(p) {
        if (!PHASES[p]) return;
        state.phase = p;
        renderBadge();
        renderPhaseRow();
        renderChip();
    }

    function currentOwner() {
        return state.phase === 'working' ? (state.workerModel || '未设置') : (state.mainModel || '未设置');
    }

    /* ---------- 浮标 ---------- */

    function mountBadge() {
        if (badge && badge.isConnected) return;
        badge = document.createElement('div');
        badge.setAttribute('data-wbpro-badge', PLUGIN_ID);
        badge.style.cssText = [
            'position:fixed', 'right:18px', 'bottom:76px', 'z-index:2147482990',
            'display:flex', 'align-items:center', 'gap:6px',
            'padding:5px 10px', 'border-radius:999px', 'cursor:pointer',
            'font:12px/1.4 system-ui,-apple-system,sans-serif',
            'background:rgba(28,28,32,.86)', 'color:#e9e9ec',
            'border:1px solid rgba(255,255,255,.14)',
            'backdrop-filter:blur(6px)', 'user-select:none',
        ].join(';');
        badge.addEventListener('click', function () {
            togglePanel();
        });
        document.body.appendChild(badge);
        renderBadge();
    }

    function renderBadge() {
        if (!badge) return;
        var isWork = state.phase === 'working';
        var dot = isWork ? '#5DCAA5' : '#7F77DD';
        badge.innerHTML = '';
        var d = document.createElement('span');
        d.style.cssText = 'width:6px;height:6px;border-radius:50%;background:' + dot + ';flex:none';
        var t = document.createElement('span');
        t.textContent =
            (state.duo ? '\u21c4 ' : '') +
            (isWork ? '工 ' : '主 ') +
            shortName(currentOwner()) +
            ' · ' +
            PHASES[state.phase].label;
        t.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        badge.appendChild(d);
        badge.appendChild(t);
        badgeText = t;
        badge.title = '双模型协同：点击设置';
    }


    /* ---------- 模型下拉里的「主从模型」 ---------- */

    var MENU_LIST = '.cr-model-selector__list';
    var MENU_ITEM = '.cr-model-selector__item';
    var MENU_FLAG = 'data-wbpro-duo-item';
    var MSG_LIST = '.cr-message-list';
    var CHIP_FLAG = 'data-wbpro-duo-chip';

    var menuObserver = null;
    var menuTimer = null;
    var chipTimer = null;
    var menuGuardTimer = null; // 下拉被 React 重渲染冲掉时补回协作项

    function closeModelPopover() {
        var open = document.querySelector('.cr-model-selector__trigger--open');
        if (open) {
            open.click();
            return;
        }
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }

    /** 克隆官方第一项，只换图标/标题/右侧文字，样式全部继承 */
    function buildDuoRow(list) {
        var sample = null;
        for (var i = 0; i < list.children.length; i++) {
            var c = list.children[i];
            if (c.getAttribute && c.getAttribute(MENU_FLAG)) continue;
            if ((c.matches && c.matches(MENU_ITEM)) || (c.querySelector && c.querySelector(MENU_ITEM))) {
                sample = c;
                break;
            }
        }
        if (!sample) return null;

        var row = sample.cloneNode(true);
        row.setAttribute(MENU_FLAG, '1');
        var item = row.matches && row.matches(MENU_ITEM) ? row : row.querySelector(MENU_ITEM);
        if (!item) return null;

        var icon = item.querySelector('.cr-model-selector__item-icon');
        if (icon) {
            icon.innerHTML =
                '<span style="display:inline-flex;align-items:center;justify-content:center;' +
                'width:16px;height:16px;font-size:13px;line-height:1;color:currentColor">\u21c4</span>';
        }
        var name = item.querySelector('.cr-model-selector__item-name');
        if (name) name.textContent = '主从模型';

        var credits = item.querySelector('.cr-model-selector__item-credits');
        if (credits) credits.textContent = state.duo ? '已启用' : '协作';

        ['.cr-model-selector__item-badge', '.cr-model-selector__tier-badge'].forEach(function (sel) {
            var n = item.querySelector(sel);
            if (n) n.remove();
        });
        var check = item.querySelector('.cr-model-selector__item-check');
        if (check) check.style.visibility = state.duo ? 'visible' : 'hidden';

        item.setAttribute('aria-selected', state.duo ? 'true' : 'false');
        if (state.duo) item.classList.add('cr-model-selector__item--selected');

        row.addEventListener(
            'click',
            function (e) {
                e.preventDefault();
                e.stopPropagation();
                // 当作一个正式档位：已经是它就收起下拉，只有选别的模型才切走
                if (state.duo) {
                    closeModelPopover();
                    return;
                }
                // 下拉此刻是展开的，setDuo 会顺手点在同主模型的官方项上（点完 React 自己收起）
                setDuo(true);
            },
            true,
        );
        return row;
    }

    /** 协作档位激活时，让顶部触发器显示「⇄ 主从模型」。
     *  注意：不能改 React 那个 label 的文本 —— 我们改了它，React 的 vdom 仍记着旧值，
     *  等用户切回真实档位时它不会重写文本，标签就永远卡在"主从模型"。
     *  正确做法是把它藏起来，另外插一个自己的节点；退出时删掉自己的、露出官方的。
     */
    var DUO_LABEL_ATTR = 'data-wbpro-duo-label';
    var DUO_ICON_ATTR = 'data-wbpro-duo-icon';

    function applyTriggerLabel() {
        var trig = document.querySelector('.cr-model-selector__trigger');
        if (!trig) return;
        var label = trig.querySelector('.cr-model-selector__trigger-label');
        var icon = trig.querySelector('.cr-model-selector__trigger-icon');
        if (!label) return;

        if (state.duo) {
            if (label.style.display !== 'none') label.style.display = 'none';
            var mine = trig.querySelector('[' + DUO_LABEL_ATTR + ']');
            if (!mine && label.parentNode) {
                mine = document.createElement('span');
                mine.setAttribute(DUO_LABEL_ATTR, '1');
                mine.textContent = '主从模型';
                mine.style.cssText =
                    'max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
                label.parentNode.insertBefore(mine, label.nextSibling);
            }
            if (icon) {
                if (icon.style.display !== 'none') icon.style.display = 'none';
                if (!trig.querySelector('[' + DUO_ICON_ATTR + ']') && icon.parentNode) {
                    var mi = document.createElement('span');
                    mi.setAttribute(DUO_ICON_ATTR, '1');
                    mi.textContent = '\u21c4';
                    mi.style.cssText =
                        'display:inline-flex;align-items:center;justify-content:center;' +
                        'width:16px;height:16px;font-size:13px;line-height:1;color:currentColor';
                    icon.parentNode.insertBefore(mi, icon);
                }
            }
            trig.setAttribute('data-wbpro-duo-active', '1');
            trig.title =
                '当前档位：主从模型（主 ' + shortName(state.mainModel) + ' / 工 ' + shortName(state.workerModel) + '）';
        } else {
            trig.removeAttribute('data-wbpro-duo-active');
            trig.removeAttribute('title');
            var l2 = trig.querySelector('[' + DUO_LABEL_ATTR + ']');
            if (l2) l2.remove();
            var i2 = trig.querySelector('[' + DUO_ICON_ATTR + ']');
            if (i2) i2.remove();
            if (label.style.display === 'none') label.style.display = '';
            if (icon && icon.style.display === 'none') icon.style.display = '';
        }
    }

    function ensureDuoRow() {
        var list = document.querySelector(MENU_LIST);
        if (!list) return;
        var mine = list.querySelector('[' + MENU_FLAG + ']');
        if (mine) {
            // 打开态可能变化，刷新一下右侧文字与勾选
            var c = mine.querySelector('.cr-model-selector__item-credits');
            if (c) c.textContent = state.duo ? '已启用' : '协作';
            return;
        }
        var row = buildDuoRow(list);
        if (row) list.insertBefore(row, list.firstChild);
    }

    /** 用户在下拉里点了真实模型 → 退出协作模式 */
    function onDocClickCapture(e) {
        if (syncingMain) return; // 我们自己点官方档位，不算用户切走
        var t = e.target;
        if (!t || !t.closest) return;
        var item = t.closest(MENU_ITEM);
        if (!item) return;
        if (item.closest('[' + MENU_FLAG + ']')) return;
        if (state.duo) setDuo(false, true);
    }

    /* ---------- 对话流里的阶段状态条 ---------- */

    function renderChip() {
        var existing = document.querySelector('[' + CHIP_FLAG + ']');
        if (!state.duo) {
            if (existing) existing.remove();
            return;
        }
        var list = document.querySelector(MSG_LIST);
        if (!list) return;

        var chip = existing;
        if (!chip) {
            chip = document.createElement('div');
            chip.setAttribute(CHIP_FLAG, '1');
            chip.style.cssText = [
                'position:sticky',
                'bottom:8px',
                'margin:6px auto 2px',
                'max-width:max-content',
                'display:flex',
                'align-items:center',
                'gap:6px',
                'padding:4px 10px',
                'border-radius:999px',
                'background:rgba(28,28,32,.9)',
                'color:#e9e9ec',
                'border:1px solid rgba(255,255,255,.16)',
                'font:11px/1.5 system-ui,-apple-system,sans-serif',
                'box-shadow:0 2px 10px rgba(0,0,0,.28)',
                'z-index:6',
                'cursor:pointer',
                'user-select:none',
            ].join(';');
            chip.title = '主从模型协作中：点击打开设置';
            chip.addEventListener('click', function () {
                if (!panelRef) openPanel();
            });
        }
        if (chip.parentNode !== list) list.appendChild(chip);

        var isWork = state.phase === 'working';
        var dot = isWork ? '#5DCAA5' : state.phase === 'idle' ? '#8a8a92' : '#7F77DD';
        var label =
            state.phase === 'idle'
                ? '主从协作 · 待命'
                : (isWork ? '工作模型 ' : '主模型 ') + shortName(currentOwner()) + ' · ' + PHASES[state.phase].hint;

        chip.textContent = '';
        var d = document.createElement('span');
        d.style.cssText = 'width:6px;height:6px;border-radius:50%;flex:none;background:' + dot;
        var t = document.createElement('span');
        t.textContent = label;
        chip.appendChild(d);
        chip.appendChild(t);
    }

    function installDuoUI() {
        // 协作档位激活时，真实模型那一项不该再显示勾选（它已不是"当前模型"）
        try {
            ctx.ui.css(
                [
                    'html.wbpro-duo-mode .cr-model-selector__list .cr-model-selector__item .cr-model-selector__item-check{visibility:hidden}',
                    'html.wbpro-duo-mode [data-wbpro-duo-item] .cr-model-selector__item-check{visibility:visible}',
                ].join('\n'),
            );
        } catch (e) {
            ctx.log('注入样式失败', e);
        }
        if (!menuObserver) {
            menuObserver = new MutationObserver(function () {
                if (menuTimer) return;
                menuTimer = setTimeout(function () {
                    menuTimer = null;
                    if (state.duo || document.querySelector(MENU_LIST)) ensureDuoRow();
                    applyTriggerLabel();
                    if (state.duo) renderChip();
                }, 120);
            });
            menuObserver.observe(document.body, { childList: true, subtree: true });
        }
        document.addEventListener('click', onDocClickCapture, true);
        // 点开下拉时立刻补几次，别等 800ms 兜底
        document.addEventListener(
            'click',
            function (e) {
                var t = e.target;
                if (!t || !t.closest || !t.closest('.cr-model-selector__trigger')) return;
                [60, 200, 420].forEach(function (ms) {
                    setTimeout(function () {
                        if (document.querySelector(MENU_LIST)) ensureDuoRow();
                    }, ms);
                });
            },
            true,
        );
        // 下拉每次打开都可能被 React 重建，MutationObserver 有 120ms 节流，
        // 这里再加一层低频兜底，保证「主从模型」不会因为时机问题消失
        if (!menuGuardTimer) {
            menuGuardTimer = setInterval(function () {
                if (!document.querySelector(MENU_LIST)) return;
                ensureDuoRow();
                applyTriggerLabel();
            }, 800);
        }
        // React 重渲染可能把状态条冲掉，兜一层
        if (!chipTimer) {
            chipTimer = setInterval(function () {
                if (!state.duo) return;
                if (!document.querySelector('[' + CHIP_FLAG + ']')) renderChip();
            }, 2000);
        }
        // 重载后如果仍是协作模式，默认落在「决策」阶段，而不是待命
        if (state.duo && state.phase === 'idle') state.phase = 'planning';
        try { ensureDuoRow(); } catch (e) { window.__duoRowErr = String((e && e.stack) || e); }
        applyTriggerLabel();
        document.documentElement.classList.toggle('wbpro-duo-mode', state.duo);
        renderChip();
        // 重启后配置仍是协作档位：官方模型可能已回到默认，静默对齐一次
        if (state.duo && state.mainModel) syncMainModelOnce();
    }

    var duoSyncTried = false;

    function syncMainModelOnce() {
        if (duoSyncTried) return;
        duoSyncTried = true;
        setTimeout(function () {
            if (!state.duo || !state.mainModel) return;
            // 模型表还没拉到就先别比，免得按 id 误判
            if (!byId(state.mainModel)) {
                applyTriggerLabel();
                return;
            }
            var cur = officialLabel();
            if (!cur || cur === '主从模型' || cur === shortName(state.mainModel)) {
                applyTriggerLabel();
                return;
            }
            applyMainModel(state.mainModel).then(function (r) {
                ctx.log('启动时对齐主模型', r.detail);
                applyTriggerLabel();
            });
        }, 1200);
    }

    function setDuo(on, silent) {
        state.duo = !!on;
        if (state.duo) {
            if (state.phase === 'idle') state.phase = 'planning';
            // 没配主模型就沿用当前官方档位，别让"主从模型"变成空壳
            if (!state.mainModel) {
                var cur = idByLabel(officialLabel());
                if (cur) {
                    state.mainModel = cur;
                    saveConfig({ mainModel: cur });
                }
            }
        } else if (state.phase !== 'idle') {
            state.phase = 'idle';
        }
        renderBadge();
        renderChip();
        renderPhaseRow();
        ensureDuoRow();
        applyTriggerLabel();
        startPhasePoll();
        document.documentElement.classList.toggle('wbpro-duo-mode', state.duo);
        saveConfig({ duo: state.duo });

        if (state.duo && state.mainModel) {
            // 真正把当前会话切到主模型（点官方下拉项）
            applyMainModel(state.mainModel).then(function (r) {
                if (document.querySelector(MENU_LIST)) closeModelPopover();
                applyTriggerLabel();
                if (!r.ok && !silent) ctx.ui.toast('主从模型已开启，但主模型没切过去：' + r.detail);
            });
        }

        if (!silent) {
            ctx.ui.toast(
                state.duo
                    ? '主从模型已开启' + (state.mainModel ? '：' + shortName(state.mainModel) : '；请先在面板里指定主模型')
                    : '已退出主从模式',
            );
        }
    }

    /* ---------- 自检 ---------- */

    function detect() {
        probe.desktop = !!window.workbuddyDesktop;
        probe.invoke = typeof window.__wbInvoke === 'function';
        probe.onEvent = typeof window.__wbOn === 'function';
        probe.setModelFn = findFn(window.workbuddyDesktop, 'setSessionModel', 3);
        probe.setModel = !!probe.setModelFn;
        // 实测（5.9.3）：workbuddyDesktop 上并没有 config.getProductConfiguration，
        // 唯一可用的是泛化 invoke + IPC 通道 config:getProductConfiguration，
        // 它返回**完整**产品配置（models=66 / agents=20 / modelPromotions / modelTiers）。
        probe.invokeFn =
            typeof window.__wbInvoke === 'function'
                ? function (ch, payload) { return window.__wbInvoke(ch, payload); }
                : window.workbuddyDesktop && typeof window.workbuddyDesktop.invoke === 'function'
                  ? function (ch, payload) {
                        return window.workbuddyDesktop.invoke(ch, payload);
                    }
                  : null;

        // 再兜一层：万一某些版本真的把方法挂在了对象上
        probe.configFns = findFns(window.workbuddyDesktop, 'getProductConfiguration', 3);
        probe.getConfigFn = probe.configFns[0] || null;
        probe.onConfigFn = findFn(window.workbuddyDesktop, 'onProductConfigurationChanged', 3);
        return probe;
    }

    /* ---------- 模型列表：优先取宿主运行时配置 ---------- */

    var modelSource = '内置';
    var modelPoolSize = 0; // 宿主配置里的模型总数，用于显示「19 / 66」

    function creditNum(c) {
        var m = String(c == null ? '' : c).match(/([0-9]+(?:\.[0-9]+)?)/);
        return m ? Number(m[1]) : null;
    }

    // 与官方选择器完全一致（renderer 里 normalizeProductModels / selectTeamsModelsByCliAgent）：
    // 1) 候选池 = models；
    // 2) 若配置里有 availableModels（非空）→ 只保留其中的 id（含去掉 custom-local: 前缀后的匹配）；
    // 3) 若 agents 里有 name === "cli" 且带 models 数组 → 以它为**白名单和顺序**，
    //    这就是官方下拉框里那十几个"均衡/极致/快速…"的来源；
    // 4) 挂上 modelPromotions / modelTiers（倍率标签、订阅角标）。
    function findCliAgent(bag) {
        var ags = Array.isArray(bag.agents) ? bag.agents : [];
        for (var i = 0; i < ags.length; i++) {
            if (ags[i] && ags[i].name === 'cli') return ags[i];
        }
        return null;
    }

    function stripCustomLocal(id) {
        return String(id).indexOf('custom-local:') === 0 ? String(id).slice(13) : String(id);
    }

    function normalizeHostModels(cfg) {
        var bag = cfg || {};
        // 兼容 {productConfiguration:{...}} 包裹
        if (!Array.isArray(bag.models) && bag.productConfiguration && Array.isArray(bag.productConfiguration.models)) {
            bag = bag.productConfiguration;
        }
        var src = Array.isArray(bag.models) ? bag.models : null;
        if (!src || !src.length) return null;
        modelPoolSize = src.length;

        var allow = null;
        if (Array.isArray(bag.availableModels) && bag.availableModels.length) {
            allow = {};
            bag.availableModels.forEach(function (id) {
                if (typeof id === 'string') allow[stripCustomLocal(id)] = true;
            });
        }

        var byId = {};
        src.forEach(function (m) {
            if (m && typeof m.id === 'string' && m.id && !byId[m.id]) byId[m.id] = m;
        });

        var cli = findCliAgent(bag);
        var order = cli && Array.isArray(cli.models) ? cli.models.filter(function (x) { return typeof x === 'string'; }) : [];

        var picked = [];
        if (order.length) {
            order.forEach(function (id) {
                var m = byId[id];
                if (!m) return;
                if (allow && !allow[stripCustomLocal(id)]) return;
                picked.push(m);
            });
        } else {
            // 没有 cli 白名单时退化为全部模型（与官方 selectTeamsModelsByCliAgent 的兜底一致）
            picked = src.filter(function (m) {
                if (!m || typeof m.id !== 'string' || !m.id) return false;
                return !allow || allow[stripCustomLocal(m.id)];
            });
        }

        // 官方选择器允许时会把「自定义模型」一起列出来（custom-local:* / tags 含 custom）
        if (order.length) {
            var seen = {};
            picked.forEach(function (m) { seen[m.id] = true; });
            src.forEach(function (m) {
                if (!m || typeof m.id !== 'string' || !m.id || seen[m.id]) return;
                var isCustom = m.id.indexOf('custom-local:') === 0 ||
                    (Array.isArray(m.tags) && m.tags.indexOf('custom') >= 0);
                if (!isCustom) return;
                if (allow && !allow[stripCustomLocal(m.id)]) return;
                picked.push(m);
                seen[m.id] = true;
            });
        }

        // 角标/倍率只做展示，缺失不影响列表
        var promoById = {};
        (Array.isArray(bag.modelPromotions) ? bag.modelPromotions : []).forEach(function (p) {
            if (!p || typeof p.id !== 'string') return;
            (Array.isArray(p.modelIds) ? p.modelIds : []).forEach(function (mid) {
                (promoById[mid] || (promoById[mid] = [])).push(p);
            });
        });
        var tierById = {};
        (Array.isArray(bag.modelTiers) ? bag.modelTiers : []).forEach(function (t) {
            if (!t || typeof t.id !== 'string') return;
            (Array.isArray(t.modelIds) ? t.modelIds : []).forEach(function (mid) {
                var cur = tierById[mid];
                if (!cur || (t.priority || 0) > (cur.priority || 0)) tierById[mid] = t;
            });
        });

        var out = [];
        picked.forEach(function (m) {
            if (!m || typeof m.id !== 'string' || !m.id) return;
            if (m.disabled === true) return;            // 官方禁用项（如 wb-lite）不出现
            if (m.videoGeneration) return;              // 视频模型不进对话选择器
            var promos = promoById[m.id] || [];
            var badge = '';
            for (var i = 0; i < promos.length; i++) {
                if (promos[i].badge && promos[i].badge.label) { badge = promos[i].badge.label; break; }
            }
            var tier = tierById[m.id];
            out.push({
                id: m.id,
                name: m.name || m.id,
                credits: typeof m.credits === 'string' ? m.credits : '',
                ctx: m.maxInputTokens || 0,
                reasoning: !!m.supportsReasoning,
                onlyReasoning: !!m.onlyReasoning,
                badge: badge,
                tierBadge: tier && tier.badge ? tier.badge.label || '' : '',
                custom: m.id.indexOf('custom-local:') === 0 ||
                    (Array.isArray(m.tags) && m.tags.indexOf('custom') >= 0),
            });
        });
        return out.length ? out : null;
    }

    function refreshModels() {
        var fns = [];
        // 首选 IPC 通道（已实测可用）
        if (probe.invokeFn) {
            fns.push(function () { return probe.invokeFn('config:getProductConfiguration'); });
        }
        (probe.configFns || (probe.getConfigFn ? [probe.getConfigFn] : [])).forEach(function (f) { fns.push(f); });
        if (!fns.length) {
            modelSource = '内置';
            return Promise.resolve(false);
        }
        // 依次尝试：有的命名空间返回裁剪过的配置（只有 modelGroups），拿不到 models
        var chain = Promise.resolve(null);
        fns.forEach(function (fn) {
            chain = chain.then(function (found) {
                if (found) return found;
                return Promise.resolve()
                    .then(function () { return fn(); })
                    .then(function (cfg) { return normalizeHostModels(cfg) || null; })
                    .catch(function () { return null; });
            });
        });
        return chain
            .then(function (list) {
                if (list) {
                    modelList = list;
                    modelSource = '运行时';
                    ctx.log('已从宿主取到模型列表', list.length);
                    return true;
                }
                modelSource = '内置';
                return false;
            })
            .catch(function (e) {
                ctx.log('读取产品配置失败，改用内置列表', e);
                modelSource = '内置';
                return false;
            })
            .then(function (ok) {
                if (panelRef) renderPanelBody();
                return ok;
            });
    }

    /* ---------- 配置 ---------- */

    // 配置有两份：页面里的 localStorage（永远可写）和插件目录的 runtime.json
    // （由 wbpro 控制服务写，Node 侧读它注入工作模型环境变量）。
    // 控制服务没起来时（没跑 wbpro up），保存不该失败——先落本地，等它回来再补写。
    var CFG_KEY = 'cfg';
    var pendingSync = false;
    var controlOk = null; // null=未探测 true/false=上次结果

    function readLocalCfg() {
        try {
            var c = ctx.storage.get(CFG_KEY, null);
            return c && typeof c === 'object' ? c : null;
        } catch (e) {
            return null;
        }
    }

    function writeLocalCfg(patch) {
        var cur = readLocalCfg() || {};
        Object.keys(patch || {}).forEach(function (k) { cur[k] = patch[k]; });
        try { ctx.storage.set(CFG_KEY, cur); } catch (e) { /* 隐私模式等 */ }
        return cur;
    }

    function applyCfg(c) {
        if (!c) return;
        if (typeof c.mainModel === 'string') state.mainModel = c.mainModel;
        if (typeof c.workerModel === 'string') state.workerModel = c.workerModel;
        if (typeof c.workerMaxTurns === 'number') state.workerMaxTurns = c.workerMaxTurns;
        if (typeof c.auto === 'boolean') state.auto = c.auto;
        if (typeof c.duo === 'boolean') state.duo = c.duo;
    }

    /** 本地有未同步的改动时，下次连上控制服务就补写 runtime.json */
    function trySyncPending() {
        if (!pendingSync) return Promise.resolve(false);
        var local = readLocalCfg();
        if (!local) return Promise.resolve(false);
        return ctx.control
            .configSet(PLUGIN_ID, local)
            .then(function () {
                pendingSync = false;
                ctx.log('本地配置已补写 runtime.json');
                return true;
            })
            .catch(function () {
                return false;
            });
    }

    function loadConfig() {
        var local = readLocalCfg();
        if (local) applyCfg(local); // 先按本地渲染，不依赖服务
        renderBadge();

        return ctx.control
            .configGet(PLUGIN_ID)
            .then(function (r) {
                controlOk = true;
                var c = (r && r.config) || {};
                if (pendingSync && local) {
                    // 本地更新过，别让旧的 runtime.json 覆盖掉
                    return trySyncPending();
                }
                if (Object.keys(c).length) {
                    applyCfg(c);
                    writeLocalCfg(c); // 服务端为准，回写本地缓存
                } else if (local) {
                    pendingSync = true; // 服务端空但本地有：待补写
                    return trySyncPending();
                }
                return false;
            })
            .catch(function (e) {
                controlOk = false;
                ctx.log('控制服务不可用，使用本地配置', e);
                if (local) pendingSync = true;
                return false;
            })
            .then(function () {
                renderBadge();
                if (panelRef) renderPanelBody();
            });
    }

    /** 返回 { ok, synced }：synced=false 表示只写进了本地 */
    function saveConfig(patch) {
        var merged = writeLocalCfg(patch);
        applyCfg(merged);
        renderBadge();

        return ctx.control
            .configSet(PLUGIN_ID, patch)
            .then(function (r) {
                controlOk = true;
                pendingSync = false;
                var c = (r && r.config) || {};
                if (Object.keys(c).length) {
                    applyCfg(c);
                    writeLocalCfg(c);
                }
                renderBadge();
                return { ok: true, synced: true };
            })
            .catch(function (e) {
                controlOk = false;
                pendingSync = true;
                ctx.log('控制服务不可用，配置已存本地，稍后自动补写', e);
                return { ok: true, synced: false, error: String((e && e.message) || e) };
            });
    }

    /* ---------- 切换主模型 ---------- */

    // 实测 5.9.3：`__wbInvoke('session:setModel', …)`、`workbuddyDesktop.setSessionModel(…)`
    // 都会返回成功（甚至还带 {success:true}），但**下一条消息仍用旧模型**——
    // 那条通道只改了主进程里的会话记录，没有通知真正跑 Agent 的 ACP 会话。
    //
    // 官方切换完全发生在渲染层：下拉项 onClick → 输入框 store.setModel(selection)
    // → onChange → 发送时 resolveAndSyncSessionModel/ensureSessionModelBeforeSend 才把
    // 模型同步进 ACP 会话。所以我们唯一的可靠做法是：把下拉展开，点在那个真实档位上。

    function menuItems() {
        var list = document.querySelector(MENU_LIST);
        if (!list) return [];
        var all = list.querySelectorAll(MENU_ITEM);
        var out = [];
        for (var i = 0; i < all.length; i++) {
            if (all[i].closest && all[i].closest('[' + MENU_FLAG + ']')) continue; // 跳过我们自己那行
            out.push(all[i]);
        }
        return out;
    }

    function itemName(el) {
        var n = el.querySelector('.cr-model-selector__item-name');
        return n ? String(n.textContent || '').trim() : '';
    }

    function findMenuItem(modelId) {
        var want = shortName(modelId);
        var keys = [want, modelId];
        var items = menuItems();
        for (var k = 0; k < keys.length; k++) {
            if (!keys[k]) continue;
            for (var i = 0; i < items.length; i++) {
                if (itemName(items[i]) === keys[k]) return items[i];
            }
        }
        // 退一步：前缀包含（Hy4 / Hy4 preview 这类同名族），优先已选中的那个
        if (want) {
            var fuzzy = [];
            for (var j = 0; j < items.length; j++) {
                var nm = itemName(items[j]);
                if (nm && (nm.indexOf(want) === 0 || want.indexOf(nm) === 0)) fuzzy.push(items[j]);
            }
            if (fuzzy.length === 1) return fuzzy[0];
            for (var q = 0; q < fuzzy.length; q++) {
                if (fuzzy[q].getAttribute('aria-selected') === 'true') return fuzzy[q];
            }
            if (fuzzy.length) return fuzzy[0];
        }
        return null;
    }

    function clickNode(el) {
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
        });
    }

    function waitForList(timeoutMs) {
        var deadline = Date.now() + (timeoutMs || 1500);
        return new Promise(function (resolve) {
            (function poll() {
                if (document.querySelector(MENU_LIST)) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 50);
            })();
        });
    }

    /** 当前官方档位的显示名（我们的覆盖标签之前调用） */
    function officialLabel() {
        var l = document.querySelector('.cr-model-selector__trigger-label');
        return l ? String(l.textContent || '').trim() : '';
    }

    function idByLabel(label) {
        if (!label) return '';
        for (var i = 0; i < modelList.length; i++) if (modelList[i].name === label) return modelList[i].id;
        for (var j = 0; j < modelList.length; j++) if (modelList[j].id === label) return modelList[j].id;
        return '';
    }

    /** 官方档位的 aria-label："Select model: Hy4" —— React 自己写的，可以用来验证真的切过去了 */
    function officialAria() {
        var t = document.querySelector('.cr-model-selector__trigger');
        return t ? String(t.getAttribute('aria-label') || '') : '';
    }

    function waitApplied(name, ms) {
        var deadline = Date.now() + (ms || 900);
        return new Promise(function (resolve) {
            (function poll() {
                var a = officialAria();
                if (a && name && a.indexOf(name) > -1) return resolve(true);
                if (Date.now() > deadline) return resolve(false);
                setTimeout(poll, 60);
            })();
        });
    }

    function applyMainModel(modelId) {
        if (!modelId) {
            lastApply = '未设置主模型';
            return Promise.resolve({ ok: false, detail: lastApply });
        }
        var trig = document.querySelector('.cr-model-selector__trigger');
        if (!trig) {
            lastApply = '当前页面没有模型选择器';
            return Promise.resolve({ ok: false, detail: lastApply });
        }
        if (!document.querySelector(MENU_LIST)) trig.click(); // 没展开就先展开
        return waitForList(1800).then(function (ready) {
            if (!ready) {
                lastApply = '模型下拉没有展开，无法切换';
                return { ok: false, detail: lastApply };
            }
            var item = findMenuItem(modelId);
            if (!item) {
                if (document.querySelector(MENU_LIST)) closeModelPopover();
                lastApply = '下拉里找不到「' + shortName(modelId) + '」';
                return { ok: false, detail: lastApply };
            }
            var name = shortName(modelId);
            syncingMain = true;
            clickNode(item);
            setTimeout(function () { syncingMain = false; }, 150);

            // 用官方 aria-label 复核：真的变了才算成功，不再"假成功"
            return waitApplied(name, 1200).then(function (applied) {
                if (!applied) {
                    lastApply = '点了「' + name + '」但官方档位没变（当前：' + officialAria().replace(/^Select model:\s*/, '') + '）';
                    return { ok: false, detail: lastApply };
                }
                lastApply = '已切到官方档位「' + name + '」';
                ctx.log('切换主模型', modelId, lastApply);
                return { ok: true, detail: lastApply };
            });
        });
    }

    /* ---------- 自动阶段检测 ---------- */

    var unsubEvent = null;

    function guessFromEvent(ev) {
        // 事件结构未公开，这里只做保守探测：找一个表示工具调用名的字符串
        var name = '';
        var walk = function (n, d) {
            if (!n || typeof n !== 'object' || d > 4 || name) return;
            for (var k in n) {
                var v = n[k];
                if (typeof v === 'string') {
                    if (k === 'toolName' || k === 'title' || k === 'kind' || k === 'subagent_type') {
                        if (/^(agent|task|subagent|delegate)/i.test(v)) { name = v; return; }
                    }
                } else if (v && typeof v === 'object') {
                    walk(v, d + 1);
                }
            }
        };
        try { walk(ev, 0); } catch (e) { /* ignore */ }
        return name;
    }

    var unsubConfig = null;

    /** 宿主拉到新的远端配置（含模型列表）时自动刷新，倍率/新模型会跟着变 */
    function subscribeConfigChange() {
        if (unsubConfig) return;
        var onUpdate = function () {
            ctx.log('产品配置已更新，重新读取模型列表');
            refreshModels();
        };
        try {
            if (probe.onConfigFn) {
                unsubConfig = probe.onConfigFn(onUpdate);
            } else if (typeof window.__wbOn === 'function') {
                // 通道名取自 preload：config:productConfigurationChanged
                unsubConfig = window.__wbOn('config:productConfigurationChanged', onUpdate);
            }
        } catch (e) {
            ctx.log('订阅产品配置失败（不影响手动刷新）', e);
        }
    }

    /* ---------- 真实阶段：hook 在子代理调用前后写 phase.json ---------- */

    var phaseTimer = null;

    function pollPhase() {
        var meta = window.__wbpro && window.__wbpro.meta;
        if (!meta || !meta.controlUrl || !state.duo) return;
        fetch(meta.controlUrl + '/api/duo/state?t=' + meta.controlToken)
            .then(function (r) { return r.json(); })
            .then(function (snap) {
                if (!state.duo || !snap) return;
                var p = snap.phase && snap.phase.phase;
                var at = (snap.phase && snap.phase.at) || 0;
                var fresh = Date.now() - at < 10 * 60 * 1000;
                var want = p === 'working' && fresh ? 'working' : 'planning';
                if (state.phase !== want) setPhase(want);
            })
            .catch(function () { /* 控制服务不在就维持现状 */ });
    }

    function startPhasePoll() {
        if (phaseTimer) return;
        phaseTimer = setInterval(pollPhase, 1500);
        ctx.onCleanup(function () {
            if (phaseTimer) { clearInterval(phaseTimer); phaseTimer = null; }
        });
        pollPhase();
    }

    function subscribeEvents() {
        if (!probe.onEvent || unsubEvent) return;
        try {
            unsubEvent = window.__wbOn('session:event', function (ev) {
                if (!state.auto) return;
                var hit = guessFromEvent(ev);
                if (hit) setPhase('working');
            });
            ctx.log('已订阅 session:event');
        } catch (e) {
            ctx.log('订阅事件失败', e);
        }
    }

    /* ---------- 面板 ---------- */

    function esc(t) {
        return String(t == null ? '' : t)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // 与官方选择器同样的呈现：名称 · 倍率 · 活动角标；能力信息放 tooltip，不占列表宽度
    function modelLabel(m) {
        var bits = [];
        var n = creditNum(m.credits);
        if (n !== null) bits.push(n === 0 ? '免费' : n.toFixed(2) + 'x');
        if (m.badge) bits.push(m.badge);
        if (m.tierBadge) bits.push(m.tierBadge);
        if (m.custom) bits.push('自定义');
        return m.name + (bits.length ? ' · ' + bits.join(' / ') : '');
    }

    function modelTitle(m) {
        var bits = [m.name, 'id: ' + m.id];
        if (m.onlyReasoning) bits.push('强制思考');
        else if (m.reasoning === false) bits.push('不支持思考');
        if (m.ctx) bits.push('上下文 ' + Math.round(m.ctx / 1000) + 'k');
        return bits.join(' · ');
    }

    function selectHtml(id) {
        var opts = ['<option value="">（未设置）</option>'];
        modelList.forEach(function (m) {
            var sel = m.id === id ? ' selected' : '';
            opts.push(
                '<option value="' + esc(m.id) + '"' + sel + ' title="' + esc(modelTitle(m)) + '">' +
                    esc(modelLabel(m)) +
                '</option>',
            );
        });
        // 已保存的模型若不在当前官方列表里（下架/换名），仍然保留可选项，避免静默丢配置
        if (id) {
            var known = false;
            for (var i = 0; i < modelList.length; i++) {
                if (modelList[i].id === id) { known = true; break; }
            }
            if (!known) {
                opts.push('<option value="' + esc(id) + '" selected>' + esc(id) + '（不在当前官方列表）</option>');
            }
        }
        return opts.join('');
    }

    var bodyEl = null;

    function renderPhaseRow() {
        var host = bodyEl && bodyEl.querySelector('[data-dm="phase"]');
        if (!host) return;
        host.querySelectorAll('button').forEach(function (b) {
            var on = b.getAttribute('data-phase') === state.phase;
            b.style.background = on ? '#534AB7' : 'rgba(255,255,255,.08)';
            b.style.color = on ? '#fff' : 'inherit';
        });
    }

    function renderPanelBody(target) {
        bodyEl = target || (panelRef && panelRef.body) || bodyEl;
        if (!bodyEl) return;
        var body = bodyEl;
        body.innerHTML = '';
        body.style.cssText = 'min-width:380px;font:12px/1.6 system-ui,-apple-system,sans-serif;';

        function row(label) {
            var d = document.createElement('div');
            d.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0;';
            var l = document.createElement('span');
            l.textContent = label;
            l.style.cssText = 'width:76px;flex:none;opacity:.65;';
            d.appendChild(l);
            body.appendChild(d);
            return d;
        }

        function note(text) {
            var d = document.createElement('div');
            d.textContent = text;
            d.style.cssText = 'margin:2px 0 8px 84px;opacity:.5;font-size:11px;';
            body.appendChild(d);
        }

        var srcRow = document.createElement('div');
        srcRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px;opacity:.7;';
        var srcTxt = document.createElement('span');
        srcTxt.style.flex = '1';
        srcTxt.textContent =
            '模型来源：' + modelSource +
            ' · 官方列表 ' + modelList.length + (modelPoolSize > modelList.length ? ' / ' + modelPoolSize : '') + ' 个';
        var refresh = document.createElement('button');
        refresh.textContent = '刷新';
        refresh.style.cssText = 'padding:3px 8px;border-radius:5px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;cursor:pointer;font-size:11px;';
        refresh.onclick = function () {
            refresh.disabled = true;
            refreshModels().then(function (ok) {
                refresh.disabled = false;
                if (!ok) ctx.ui.toast('宿主未提供模型配置，仍用内置列表');
            });
        };
        srcRow.appendChild(srcTxt);
        srcRow.appendChild(refresh);
        body.appendChild(srcRow);

        // 主从模式开关（与模型下拉里的「主从模型」是同一个状态）
        var duoRow = document.createElement('div');
        duoRow.style.cssText =
            'display:flex;align-items:center;gap:8px;margin:0 0 10px;padding:7px 9px;' +
            'border-radius:8px;background:rgba(83,74,183,.16);border:1px solid rgba(127,119,221,.35);font-size:12px;';
        var duoTxt = document.createElement('span');
        duoTxt.style.flex = '1';
        duoTxt.textContent = state.duo ? '主从协作：已开启（对话流里会显示当前阶段）' : '主从协作：未开启';
        var duoBtn = document.createElement('button');
        duoBtn.textContent = state.duo ? '关闭' : '开启';
        duoBtn.style.cssText =
            'padding:4px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.2);' +
            'background:transparent;color:inherit;cursor:pointer;font-size:11px;';
        duoBtn.onclick = function () { setDuo(!state.duo); };
        duoRow.appendChild(duoTxt);
        duoRow.appendChild(duoBtn);
        body.appendChild(duoRow);

        var mainSel = document.createElement('select');
        mainSel.innerHTML = selectHtml(state.mainModel);
        mainSel.style.cssText = 'flex:1;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14);';
        row('主模型').appendChild(mainSel);
        note('决策与验收；开启「主从模型」时充当当前会话模型');

        var workerSel = document.createElement('select');
        workerSel.innerHTML = selectHtml(state.workerModel);
        workerSel.style.cssText = mainSel.style.cssText;
        row('工作模型').appendChild(workerSel);
        note('执行计划；由 hook 在每次子代理调用时指定，改完下一次委派即生效');

        var turns = document.createElement('input');
        turns.type = 'number';
        turns.min = '0';
        turns.placeholder = '默认 200';
        turns.value = state.workerMaxTurns || '';
        turns.style.cssText = 'width:90px;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14);';
        row('执行轮次').appendChild(turns);
        note('子代理最多跑多少轮，留空用默认');

        var actions = document.createElement('div');
        actions.style.cssText = 'display:flex;gap:8px;margin:12px 0 4px;';

        var save = document.createElement('button');
        save.textContent = '保存';
        save.style.cssText = 'flex:1;padding:7px;border-radius:7px;border:0;background:#534AB7;color:#fff;cursor:pointer;';
        save.onclick = function () {
            var patch = {
                mainModel: mainSel.value,
                workerModel: workerSel.value,
                workerMaxTurns: Number(turns.value) || 0,
            };
            save.disabled = true;
            saveConfig(patch)
                .then(function (res) {
                    // 配置已经落地（本地或 runtime.json），接着尝试切换当前会话模型
                    var switchP =
                        patch.mainModel && state.duo
                            ? applyMainModel(patch.mainModel).catch(function (e) {
                                  return { ok: false, detail: String((e && e.message) || e) };
                              })
                            : Promise.resolve(null);
                    return switchP.then(function (r) {
                        lastApply = r ? r.detail : '';
                        if (!res.synced) {
                            ctx.ui.toast('已保存到本地；控制服务未启动，运行 wbpro up 后会自动补写');
                        } else if (patch.mainModel && !state.duo) {
                            ctx.ui.toast('主模型已保存；选中「主从模型」档位时生效');
                        } else if (patch.workerModel) {
                            ctx.ui.toast('已保存；工作模型下一次子代理调用生效');
                        } else {
                            ctx.ui.toast('已保存');
                        }
                        if (r && !r.ok) ctx.log('主模型切换未生效：' + r.detail);
                        renderPanelBody();
                    });
                })
                .catch(function (e) {
                    ctx.ui.toast('保存失败: ' + (e && e.message ? e.message : e));
                })
                .finally(function () {
                    save.disabled = false;
                });
        };

        var copy = document.createElement('button');
        copy.textContent = '复制协同规则';
        copy.style.cssText = 'flex:1;padding:7px;border-radius:7px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;cursor:pointer;';
        copy.onclick = function () {
            try {
                navigator.clipboard.writeText(COOP_RULES).then(
                    function () { ctx.ui.toast('规则已复制，粘到 CODEBUDDY.md 末尾'); },
                    function () { showRules(); },
                );
            } catch (e) {
                showRules();
            }
        };
        actions.appendChild(save);
        actions.appendChild(copy);
        body.appendChild(actions);

        function showRules() {
            ctx.ui.panel({ title: '协同规则（手动复制）', position: 'top-right', css: '.p{max-width:560px}' , render: function (b) {
                var pre = document.createElement('pre');
                pre.textContent = COOP_RULES;
                pre.style.cssText = 'white-space:pre-wrap;font:11px/1.6 ui-monospace,Consolas,monospace;margin:0;user-select:text;';
                b.appendChild(pre);
            } });
        }

        var phaseBox = document.createElement('div');
        phaseBox.setAttribute('data-dm', 'phase');
        phaseBox.style.cssText = 'display:flex;gap:6px;margin:10px 0 2px;';
        [['idle', '待命'], ['planning', '主模型'], ['working', '工作模型']].forEach(function (p) {
            var b = document.createElement('button');
            b.textContent = p[1];
            b.setAttribute('data-phase', p[0]);
            b.style.cssText = 'flex:1;padding:5px;border-radius:6px;border:0;cursor:pointer;font-size:11px;';
            b.onclick = function () { setPhase(p[0]); };
            phaseBox.appendChild(b);
        });
        row('当前阶段').appendChild(phaseBox);
        note('自动检测不准时可手动标记');

        var auto = document.createElement('label');
        auto.style.cssText = 'display:flex;align-items:center;gap:6px;margin:8px 0;cursor:pointer;';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.auto;
        cb.onchange = function () {
            state.auto = cb.checked;
            saveConfig({ auto: state.auto });
        };
        auto.appendChild(cb);
        auto.appendChild(document.createTextNode('按子代理调用自动切换阶段'));
        body.appendChild(auto);

        var diag = document.createElement('div');
        diag.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.1);font-size:11px;opacity:.72;';
        var lines = [
            ['宿主对象', probe.desktop],
            ['通用桥 __wbInvoke', probe.invoke],
            ['事件订阅 __wbOn', probe.onEvent],
            ['setSessionModel', probe.setModel],
            ['产品配置', !!probe.invokeFn || !!probe.getConfigFn],
            ['控制服务（wbpro up）', controlOk !== false],
        ];
        lines.forEach(function (l) {
            var line = document.createElement('div');
            line.textContent = (l[1] ? '✓ ' : '✕ ') + l[0];
            diag.appendChild(line);
        });
        if (lastApply) {
            var p = document.createElement('div');
            p.textContent = '上次切换：' + lastApply;
            p.style.cssText = 'margin-top:6px;opacity:.9;';
            diag.appendChild(p);
        }
        var sid = currentSessionId();
        var s = document.createElement('div');
        s.textContent = '会话：' + (sid ? sid.slice(0, 8) + '…' : '未识别');
        s.style.marginTop = '4px';
        diag.appendChild(s);
        body.appendChild(diag);

        renderPhaseRow();
    }

    function openPanel() {
        if (panelRef && panelRef.el && panelRef.el.isConnected) return;
        panelRef = ctx.ui.panel({
            title: '双模型协同',
            position: 'bottom-right',
            css: '.p{min-width:380px}',
            persist: true,
            onClose: function () {
                panelRef = null;
            },
            render: function (b) {
                renderPanelBody(b);
            },
        });
    }

    function togglePanel() {
        if (panelRef && panelRef.el && panelRef.el.isConnected) {
            panelRef.remove();
            return;
        }
        openPanel();
    }

    /* ---------- 子代理轨迹面板 ---------- */

    var subagentPanel = null;
    var trailBtn = null;

    function ensureSubagentPanel() {
        if (subagentPanel) return subagentPanel;
        if (!window.__duoSubagent || typeof window.__duoSubagent.create !== 'function') {
            ctx.log('子代理面板模块未加载（检查 rendererIncludes）');
            return null;
        }
        // 页面里拿不到 cwd，后端会按 sessionId 全盘搜索，这里传空
        subagentPanel = window.__duoSubagent.create(ctx, currentSessionId, function () { return ''; });
        return subagentPanel;
    }

    /** 徽标旁的「轨迹」按钮：只做开关，不抢徽标本身的设置入口 */
    function mountTrailButton() {
        if (trailBtn && trailBtn.isConnected) return;
        trailBtn = document.createElement('div');
        trailBtn.setAttribute('data-wbpro-trail', PLUGIN_ID);
        trailBtn.style.cssText = [
            'position:fixed', 'right:18px', 'bottom:112px', 'z-index:2147482990',
            'padding:4px 9px', 'border-radius:999px', 'cursor:pointer',
            'font:11px/1.4 system-ui,-apple-system,sans-serif',
            'background:rgba(28,28,32,.86)', 'color:#c9c4f7',
            'border:1px solid rgba(127,119,221,.45)',
            'backdrop-filter:blur(6px)', 'user-select:none',
        ].join(';');
        trailBtn.textContent = '子代理轨迹';
        trailBtn.title = '查看子代理的思考与工具调用';
        trailBtn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var p = ensureSubagentPanel();
            if (p) p.toggle();
        });
        document.body.appendChild(trailBtn);
    }

    /* ---------- 启动 ---------- */

    try {
        detect();
        mountBadge();
        mountTrailButton();
        loadConfig();
        subscribeEvents();
        subscribeConfigChange();
        refreshModels();
        installDuoUI();
        window.__duoBoot = 'ok';
    } catch (e) {
        window.__duoBoot = 'ERR: ' + String((e && e.stack) || e);
    }

    var keeper = setInterval(function () {
        if (badge && !badge.isConnected && document.body) document.body.appendChild(badge);
        if (trailBtn && !trailBtn.isConnected && document.body) document.body.appendChild(trailBtn);
    }, 3000);
    ctx.onCleanup(function () { clearInterval(keeper); });

    ctx.onCleanup(function () {
        if (unsubEvent && typeof unsubEvent === 'function') {
            try { unsubEvent(); } catch (e) { /* ignore */ }
        }
        if (unsubConfig && typeof unsubConfig === 'function') {
            try { unsubConfig(); } catch (e) { /* ignore */ }
        }
        if (menuObserver) { menuObserver.disconnect(); menuObserver = null; }
        if (menuTimer) { clearTimeout(menuTimer); menuTimer = null; }
        if (chipTimer) { clearInterval(chipTimer); chipTimer = null; }
        document.removeEventListener('click', onDocClickCapture, true);
        document.documentElement.classList.remove('wbpro-duo-mode');
        trigOrig = null;
        var chipNode = document.querySelector('[' + CHIP_FLAG + ']');
        if (chipNode) chipNode.remove();
        var rowNode = document.querySelector('[' + MENU_FLAG + ']');
        if (rowNode) rowNode.remove();
        if (!(panelRef && panelRef.persist)) panelRef && panelRef.remove();
        panelRef = null;
        badge && badge.remove();
        badge = null;
        trailBtn && trailBtn.remove();
        trailBtn = null;
        if (subagentPanel) {
            try { subagentPanel.destroy(); } catch (e) { /* ignore */ }
            subagentPanel = null;
        }
    });

    ctx.log('双模型协同已加载', JSON.stringify(probe));
}
