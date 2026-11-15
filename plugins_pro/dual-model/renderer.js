/* 双模型协同：主模型决策 + 工作模型执行，并在界面上标出当前阶段。
 *
 * 两个模型的分工靠两条不同的通道：
 *   主模型 —— 就是**当前会话模型**，但由插件在进入主从档位时主动切过去（见 applyMainModel）。
 *             切法只有一条有效路径：调官方下拉项的 React 回调（ModelItem.props.onSelect）。
 *             IPC 的 session:setModel / setSessionModel 回 {success:true} 却不写渲染层 store，
 *             下一条消息仍按旧模型发送 —— 实测两次都如此，别再走那条路。
 *             UI 上用 applyTriggerLabel 把顶部文案盖成「主从模型」，下拉里真实项的勾选由
 *             CSS（html.wbpro-duo-mode）压掉，所以显示与实际一致（实际就是主模型）。
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
    /**
     * 单实例守卫
     * ----------
     * 热更新时 bootstrap 会调旧 ctx.cleanup()，但**只有登记过的副作用才会被清掉**。
     * 早先这里的 document 监听器 / MutationObserver / 两个定时器都没登记，于每改一版
     * 就多留一套"僵尸实例"，和新实例共用同一个 DOM：
     *   旧实例的 paintDuoRow 按旧 state 把「已启用」写回「协作」，
     *   MutationObserver / 定时器 / document 监听器全都没拆，两套一起改同一个 DOM，
     * 表现就是列表勾选和文案在 0.2 秒级别来回跳（视频里那种闪）。
     * 这次把清理补齐；再留一道代数守卫，将来万一又漏登记，旧实例也会自己停手。
     */
    var GEN_KEY = '__wbpro_duo_gen';
    var myGen = (window[GEN_KEY] || 0) + 1;
    window[GEN_KEY] = myGen;
    function alive() {
        return window[GEN_KEY] === myGen;
    }

    var state = {
        mainModel: '',
        workerModel: '',
        workerMaxTurns: 0,
        phase: 'idle',
        auto: true,
        duo: false, // 是否处于「主从模型」协作模式
        prevModel: '', // 进入主从模式前的官方模型，退出时还原
    };
    var panelRef = null;
    var badge = null;
    var badgeText = null;
    var probe = { desktop: false, setModel: false, invoke: false, onEvent: false };
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
        var text =
            (state.duo ? '\u21c4 ' : '') +
            (isWork ? '工 ' : '主 ') +
            shortName(currentOwner()) +
            ' · ' +
            PHASES[state.phase].label;

        // 幂等更新，别每次 innerHTML='' 重建（会在浮标上闪，也白白触发 MutationObserver）
        if (!badge.firstChild) {
            var d0 = document.createElement('span');
            d0.setAttribute('data-dot', '1');
            d0.style.cssText = 'width:6px;height:6px;border-radius:50%;flex:none';
            var t0 = document.createElement('span');
            t0.setAttribute('data-txt', '1');
            t0.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
            badge.appendChild(d0);
            badge.appendChild(t0);
            badgeText = t0;
        }
        var dotEl = badge.querySelector('[data-dot]');
        var txtEl = badge.querySelector('[data-txt]');
        if (dotEl && dotEl.style.background !== dot) dotEl.style.background = dot;
        if (txtEl && txtEl.textContent !== text) txtEl.textContent = text;
        if (badge.title !== '双模型协同：点击设置') badge.title = '双模型协同：点击设置';
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

    /** 收起模型下拉。
     *  触发器可能监听 click，也可能监听 mousedown（不同版本文案不同），所以
     *  点一次不算「已关闭」——60ms 后回查一遍，还开着就补一次 Escape + click。
     *  以前这里点一下就直接 return，遇到监听 mousedown 的版本会一直开着。 */
    function closeModelPopover() {
        var open = document.querySelector('.cr-model-selector__trigger--open');
        if (open) open.click();
        setTimeout(function () {
            if (!document.querySelector(MENU_LIST)) return;
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            var still = document.querySelector('.cr-model-selector__trigger--open');
            if (still) still.click();
        }, 60);
    }

    /** 克隆行必须「去身份」：宿主用 DOM 上的 data-* 反查它属于哪个选项，
     *  克隆体带着原项的标记会被当成真实模型点击——表现就是「点了主从模型却切到别的模型」。 */
    function stripIdentity(root) {
        var nodes = [root];
        if (root.querySelectorAll) {
            nodes = nodes.concat(Array.prototype.slice.call(root.querySelectorAll('*')));
        }
        nodes.forEach(function (n) {
            if (!n.attributes) return;
            for (var i = n.attributes.length - 1; i >= 0; i--) {
                var nm = n.attributes[i].name;
                if (nm === 'id' || nm.indexOf('data-') === 0) n.removeAttribute(nm);
            }
        });
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
        stripIdentity(row); // 先去掉原项的身份标记，再打自己的标
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

        // 行上的点击不在这里绑：鼠标走 document 的 pointerdown 委托（见 onDuoPressCapture），
        // 键盘激活走 document 的 click 委托（见 onDuoClickCapture）。
        // 只在行上绑 click 会「点两次才生效」——按下到抬起之间 React 可能重建列表，
        // 这个克隆行被换掉，click 就落不到它身上，第一次点击白点。
        return row;
    }

    /** 协作档位激活时，让顶部触发器显示「⇄ 主从模型」。
     *  注意：不能改 React 那个 label 的文本 —— 我们改了它，React 的 vdom 仍记着旧值，
     *  等用户切回真实档位时它不会重写文本，标签就永远卡在"主从模型"。
     *  正确做法是把它藏起来，另外插一个自己的节点；退出时删掉自己的、露出官方的。
     */
    var DUO_LABEL_ATTR = 'data-wbpro-duo-label';
    var DUO_ICON_ATTR = 'data-wbpro-duo-icon';
    var DUO_TITLE_ATTR = 'data-wbpro-duo-title';

    function applyTriggerLabel() {
        if (!alive()) return;
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
            // 官方的 title 先存下来，退出时还回去。以前直接 removeAttribute('title')，
            // 但 React 不会因为属性被外部删掉而重写它，结果就是鼠标悬停再也没提示。
            if (!trig.hasAttribute(DUO_TITLE_ATTR)) {
                trig.setAttribute(DUO_TITLE_ATTR, trig.getAttribute('title') || '');
            }
            trig.title =
                '当前档位：主从模型（主 ' + shortName(state.mainModel) + ' / 工 ' + shortName(state.workerModel) + '）';
        } else {
            trig.removeAttribute('data-wbpro-duo-active');
            if (trig.hasAttribute(DUO_TITLE_ATTR)) {
                var prevTitle = trig.getAttribute(DUO_TITLE_ATTR);
                if (prevTitle) trig.setAttribute('title', prevTitle);
                else trig.removeAttribute('title');
                trig.removeAttribute(DUO_TITLE_ATTR);
            }
            var l2 = trig.querySelector('[' + DUO_LABEL_ATTR + ']');
            if (l2) l2.remove();
            var i2 = trig.querySelector('[' + DUO_ICON_ATTR + ']');
            if (i2) i2.remove();
            if (label.style.display === 'none') label.style.display = '';
            if (icon && icon.style.display === 'none') icon.style.display = '';
        }
    }

    /** 把「当前是不是协作档位」同步到我们插入的那一行上。
     *
     *  **只在值真的变了才写 DOM。** 这个函数被 800ms 定时器、MutationObserver、
     *  状态变更三处调用，如果每次都无条件写 textContent，就会不停地触发
     *  MutationObserver 自己（写文字 → 观察器回调 → 再写），列表跟着抖。
     *  幂等写入既省事又不会再制造新的 DOM 变动。 */
    function paintDuoRow(row) {
        var item = row.matches && row.matches(MENU_ITEM) ? row : row.querySelector(MENU_ITEM);
        if (!item) return;
        var wantText = state.duo ? '已启用' : '协作';
        var credits = item.querySelector('.cr-model-selector__item-credits');
        if (credits && credits.textContent !== wantText) credits.textContent = wantText;

        var check = item.querySelector('.cr-model-selector__item-check');
        if (check) {
            var vis = state.duo ? 'visible' : 'hidden';
            if (check.style.visibility !== vis) check.style.visibility = vis;
        }
        var aria = state.duo ? 'true' : 'false';
        if (item.getAttribute('aria-selected') !== aria) item.setAttribute('aria-selected', aria);
        if (state.duo) {
            if (!item.classList.contains('cr-model-selector__item--selected')) {
                item.classList.add('cr-model-selector__item--selected');
            }
        } else if (item.classList.contains('cr-model-selector__item--selected')) {
            item.classList.remove('cr-model-selector__item--selected');
        }
    }

    /** 协作档位生效时，真实模型那一项已经不代表"当前模型"了，把它的选中态压掉 */
    /**
     * 协作档位生效时，真实模型那一项的勾/高亮不该再显示。
     *
     * **只交给 CSS 处理，不再改 DOM 属性。** 以前这里会把 aria-selected 改成 false、
     * 把 --selected 类删掉，两个后果：
     *   1) React 下次渲染又把它们加回来 —— 删一次加一次，就是可见的闪烁；
     *   2) switchModelViaUI 用 aria-selected 判断"是否已经选中"，
     *      被我们改成 false 之后每次都判定为"没选中"，于是反复下发同一个模型。
     * 现在属性保持官方原样，视觉由 html.wbpro-duo-mode 那条 CSS 压住。
     */

    /** 取某一项显示的模型名 */
    function itemName(el) {
        var n = el.querySelector('.cr-model-selector__item-name');
        return n ? String(n.textContent || '').trim() : '';
    }

    function ensureDuoRow() {
        var list = document.querySelector(MENU_LIST);
        if (!list) return;
        var mine = list.querySelector('[' + MENU_FLAG + ']');
        if (mine) {
            // 打开态可能变化，刷新勾选/文字。
            // 官方那一项的勾**不在这里改**：它归 React 管，协作态下由 CSS 压住；
            // 退出时也不去"还原"它（那一刻 label 还是旧值，先点亮再被 React 改一次 = 闪）。
            paintDuoRow(mine);
            return;
        }
        var row = buildDuoRow(list);
        if (row) {
            list.insertBefore(row, list.firstChild);
            paintDuoRow(row);
        }
    }

    /** 用户在下拉里点了真实模型 → 退出协作模式。
     *
     *  注意这里**必须异步**改状态：本函数跑在捕获阶段，React 的 onSelect 还没执行，
     * 此时 setDuo(false) 会立刻重画界面（恢复触发器 label、删 chip、压勾选），
     * 而 React 紧接着又按新模型画一遍 —— 两边各画一次，就是可见的闪。
     * 推到微任务/下一帧之后，React 已经提交完，我们再收尾，用户看不到中间态。
     */
    function onDocClickCapture(e) {
        if (!alive()) return;
        // 程序化派发的事件（isTrusted === false）不是用户操作，直接忽略。
        // 现在已不再用脚本点官方下拉项，但这层判断留着：
        // 它比任何计时器都可靠，能挡住别的扩展/自动化造成的误判。
        if (e && e.isTrusted === false) return;
        var t = e.target;
        if (!t || !t.closest) return;
        var item = t.closest(MENU_ITEM);
        if (!item) return;
        if (item.closest('[' + MENU_FLAG + ']')) return;
        if (!state.duo) return;
        // 用户亲手选了别的模型 = 他要的就是这个模型，退出协作但不要还原
        setTimeout(function () {
            if (!alive()) return;
            if (state.duo) setDuo(false, true, { manual: true });
        }, 0);
    }

    /* ---------- 点「主从模型」这一行 ---------- */

    // pointerdown 与 mousedown 是同一串事件，只处理第一次
    var lastPress = 0;
    // 诊断用：面板里能看到「按下事件到底有没有到我们手上」。
    // 只靠点击结果倒推很难区分「事件没来」和「来了但状态没落」，这两个数能分开。
    var duoStat = { press: 0, kb: 0, enter: 0, at: 0, flips: 0, flipAt: 0 };

    /** 「主从模型」被选中：进入协作档位并收起下拉。
     *  设计成幂等——已经是协作档位时再点不会有副作用，只是收起菜单。
     *  这样无论调用方是 pointerdown、click 还是键盘，结果都一样。 */
    function enterDuoFromList() {
        duoStat.enter++;
        duoStat.at = Date.now();
        var applying = setDuo(true);
        // 收菜单要延后，而且**要等切换真的做完**：
        //   · 立刻收 —— 元素在抬起前就没了，浏览器把随后的 click 落到触发器上，下拉又被点开；
        //   · 固定 90ms 收 —— 切换要读下拉项的 fiber（ModelItem.props.onSelect），
        //     而 fiber 只在下拉渲染时存在。收早了 fiber 没了，切换失败，
        //     表现就是视频里那样：「已启用」但 DeepSeek 还打着勾。
        // 所以先等 setDuo 返回的 promise（内部已经等过界面回查），再收；3 秒兜底防卡死。
        var closed = false;
        function closeOnce() {
            if (closed || !alive()) return;
            closed = true;
            setTimeout(closeModelPopover, 60);
        }
        if (applying && typeof applying.then === 'function') {
            applying.then(closeOnce, closeOnce);
            setTimeout(closeOnce, 3000);
        } else {
            setTimeout(closeOnce, 90);
        }
    }

    /** 用 pointerdown 接管鼠标点击，而不是等 click。
     *
     *  实测症状：只绑 click 时会「点两次才进得去」。原因是 React 在按下与抬起之间
     *  重渲染了下拉列表，我们插进去的克隆行被换成新节点，click 事件落不到它身上；
     *  第二次点击时列表已经稳定、状态也已画好，才命中。
     *
     *  pointerdown 是整串事件里最早的一个，且在 document 捕获阶段委托，
     *  不依赖「点的时候那个节点还在不在」。 */
    function onDuoPressCapture(e) {
        if (!alive()) return;
        if (e && e.isTrusted === false) return;
        var t = e.target;
        if (!t || !t.closest) return;
        if (!t.closest('[' + MENU_FLAG + ']')) return;

        var now = Date.now();
        if (now - lastPress < 500) return;
        lastPress = now;
        duoStat.press++;

        if (e.cancelable) e.preventDefault();
        e.stopPropagation(); // 别让宿主把它当成点了某个真实模型
        enterDuoFromList();
    }

    /** 键盘激活（Enter / Space）走 click，且 detail === 0；
     *  鼠标点击已经由 pointerdown 处理过，这里只负责不让宿主看到，
     *  否则它可能把这次点击当成选了克隆行背后的真实模型。 */
    function onDuoClickCapture(e) {
        if (!alive()) return;
        var t = e.target;
        if (!t || !t.closest) return;
        if (!t.closest('[' + MENU_FLAG + ']')) return;
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (e.detail === 0) {
            duoStat.kb++;
            enterDuoFromList();
            return;
        }
        // 鼠标点击：正常情况下同一次按压的 pointerdown 已经处理过（lastPress 刚更新）。
        // 如果没处理过——事件被别的扩展拦了、或去重窗口吃掉了——这里补一次，
        // 保证「点一次就进得去」不依赖 pointerdown 一定送达。
        if (Date.now() - lastPress > 400) enterDuoFromList();
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

        // 幂等更新：内容没变就不碰 DOM。
        // 这个函数被 2 秒定时器 + MutationObserver 反复调用，以前每次都
        // textContent='' 再重建两个 span —— 等于每 2 秒把节点删了重插一次，
        // 既触发观察器，也会让 chip 闪一下。
        if (!chip.firstChild) {
            var d0 = document.createElement('span');
            d0.setAttribute('data-dot', '1');
            d0.style.cssText = 'width:6px;height:6px;border-radius:50%;flex:none';
            var t0 = document.createElement('span');
            t0.setAttribute('data-txt', '1');
            chip.appendChild(d0);
            chip.appendChild(t0);
        }
        var dotEl = chip.querySelector('[data-dot]');
        var txtEl = chip.querySelector('[data-txt]');
        if (dotEl && dotEl.style.background !== dot) dotEl.style.background = dot;
        if (txtEl && txtEl.textContent !== label) txtEl.textContent = label;
    }

    function installDuoUI() {
        // 协作档位激活时，真实模型那一项不该再显示勾选（它已不是"当前模型"）
        try {
            ctx.ui.css(
                [
                    // 勾选只留在「主从模型」上。
                    // 这里用**后代**选择器而不是 `>` 直接子元素：官方列表中间可能插包装层
                    // （probe 里 item 的父级是带 onPointerDown 的 div，不是 list 本身），
                    // 用 `>` 会静默不命中，表现就是"已启用但真实模型还打着勾"。
                    'html.wbpro-duo-mode .cr-model-selector__list .cr-model-selector__item-check{visibility:hidden!important}',
                    // 我们的行要露出来。两条同为 !important 时后写的赢，所以放在后面。
                    'html.wbpro-duo-mode [data-wbpro-duo-item] .cr-model-selector__item-check{visibility:visible!important}',
                    // 官方那一项的"选中底色/描边"也要压掉，否则两个条目同时高亮。
                    'html.wbpro-duo-mode .cr-model-selector__list .cr-model-selector__item--selected{' +
                        'background-color:transparent!important;background-image:none!important;box-shadow:none!important}',
                    'html.wbpro-duo-mode [data-wbpro-duo-item].cr-model-selector__item--selected{' +
                        'background-color:rgba(127,119,221,.16)!important}',
                    // 隐形打开：切换模型时临时弹出的下拉不可见（fiber 仍存在，事件照常）。
                    // 放在 CSS 里而不是逐个改 style，是为了覆盖"刚创建还没被 JS 摸到"的首帧。
                    'html.wbpro-veil .cr-model-selector__popover,' +
                        'html.wbpro-veil .cr-model-selector__menu,' +
                        'html.wbpro-veil .cr-popover{visibility:hidden!important;pointer-events:none!important}',
                ].join('\n'),
            );
        } catch (e) {
            ctx.log('注入样式失败', e);
        }
        if (!menuObserver) {
            menuObserver = new MutationObserver(function (records) {
                if (!alive()) return;
                // 忽略"我们自己写进去"的变动，否则 写DOM → 回调 → 再写DOM 会自激成抖动。
                // 判据：所有变动的 target 都落在我们自己的节点里（主从行 / 标签 / chip）。
                var onlyOurs = true;
                for (var i = 0; i < records.length; i++) {
                    var n = records[i].target;
                    if (!n || !n.closest) { onlyOurs = false; break; }
                    if (!n.closest('[' + MENU_FLAG + '],[' + DUO_LABEL_ATTR + '],[' + DUO_ICON_ATTR + '],[' + CHIP_FLAG + ']')) {
                        onlyOurs = false;
                        break;
                    }
                }
                if (onlyOurs) return;

                // 触发器标签被 React 重建时会短暂露出原文案（看着像来回闪），
                // 这里立即补回，不走 120ms 节流；重活仍走节流，避免 DOM 抖动时爆量。
                if (state.duo) applyTriggerLabel();
                if (menuTimer) return;
                menuTimer = setTimeout(function () {
                    menuTimer = null;
                    if (!alive()) return;
                    if (state.duo || document.querySelector(MENU_LIST)) ensureDuoRow();
                    applyTriggerLabel();
                    if (state.duo) renderChip();
                    // 切会话后主模型要在这个会话里重新下发：新会话默认回到它自己的模型，
                    // 不发一次就等于主从模式没生效。放在这里而不是定时器里，
                    // 是因为切会话必然伴随 DOM 变动，这里比轮询更贴近真实时机。
                    var sid = currentSessionId();
                    if (
                        state.duo &&
                        sid &&
                        sid !== appliedSession &&
                        Date.now() - (applyStat.lastFailAt || 0) > 60000 // 失败后 1 分钟内不反复重试，免得刷屏
                    ) {
                        applyMainModel('session-change', 0, false, { quiet: true });
                    }
                }, 120);
            });
            // 只观察主对话区与模型选择器的祖先，不再整棵 body：
            // 整棵 body 在流式输出时每个 token 都变，回调被触发得极频繁。
            menuObserver.observe(document.body, { childList: true, subtree: true });
        }
        document.addEventListener('click', onDocClickCapture, true);
        // 「主从模型」这一行用 pointerdown 委托接管（click 会因 React 重渲染而丢失，
        // 表现为要点两次）。mousedown 兜一层：老 WebView / 某些环境没有 pointerdown。
        document.addEventListener('pointerdown', onDuoPressCapture, true);
        document.addEventListener('mousedown', onDuoPressCapture, true);
        document.addEventListener('click', onDuoClickCapture, true);
        // 点开下拉时立刻补几次，别等 800ms 兜底。具名才能在卸载时精确移除。
        function onTriggerClick(e) {
            var t = e.target;
            if (!t || !t.closest || !t.closest('.cr-model-selector__trigger')) return;
            [60, 200, 420].forEach(function (ms) {
                setTimeout(function () {
                    if (!alive()) return;
                    if (document.querySelector(MENU_LIST)) ensureDuoRow();
                }, ms);
            });
        }
        document.addEventListener('click', onTriggerClick, true);
        // 下拉每次打开都可能被 React 重建，MutationObserver 有 120ms 节流，
        // 这里再加一层低频兜底，保证「主从模型」不会因为时机问题消失
        if (!menuGuardTimer) {
            menuGuardTimer = setInterval(function () {
                if (!alive()) return;
                if (!document.querySelector(MENU_LIST)) return;
                ensureDuoRow();
                applyTriggerLabel();
            }, 800);
        }
        // React 重渲染可能把状态条冲掉，兜一层
        if (!chipTimer) {
            chipTimer = setInterval(function () {
                if (!alive()) return;
                if (!state.duo) return;
                if (!document.querySelector('[' + CHIP_FLAG + ']')) renderChip();
            }, 2000);
        }

        // 卸载：热更新时必须把上面这些全局副作用全部拆掉，否则新旧实例会抢同一个 DOM。
        // （这就是"列表来回闪"的根因：旧实例没死，一直在按旧状态重画。）
        ctx.onCleanup(function () {
            document.removeEventListener('click', onDocClickCapture, true);
            document.removeEventListener('pointerdown', onDuoPressCapture, true);
            document.removeEventListener('mousedown', onDuoPressCapture, true);
            document.removeEventListener('click', onDuoClickCapture, true);
            document.removeEventListener('click', onTriggerClick, true);
            if (menuObserver) {
                try { menuObserver.disconnect(); } catch (e) { /* ignore */ }
                menuObserver = null;
            }
            if (menuGuardTimer) { clearInterval(menuGuardTimer); menuGuardTimer = null; }
            if (chipTimer) { clearInterval(chipTimer); chipTimer = null; }
            if (menuTimer) { clearTimeout(menuTimer); menuTimer = null; }
            try { if (badge) badge.remove(); } catch (e) { /* ignore */ }
            var chips = document.querySelectorAll('[' + CHIP_FLAG + ']');
            for (var i = 0; i < chips.length; i++) { try { chips[i].remove(); } catch (e) { /* ignore */ } }
            var lb = document.querySelectorAll('[' + DUO_LABEL_ATTR + ']');
            for (var j = 0; j < lb.length; j++) { try { lb[j].remove(); } catch (e) { /* ignore */ } }
            var ic = document.querySelectorAll('[' + DUO_ICON_ATTR + ']');
            for (var k = 0; k < ic.length; k++) {
                try { ic[k].parentNode && (ic[k].style.display = ''); ic[k].remove(); } catch (e) { /* ignore */ }
            }
            document.documentElement.classList.remove('wbpro-duo-mode');
        });
        // 重载后如果仍是协作模式，默认落在「决策」阶段，而不是待命
        if (state.duo && state.phase === 'idle') state.phase = 'planning';
        try { ensureDuoRow(); } catch (e) { window.__duoRowErr = String((e && e.stack) || e); }
        applyTriggerLabel();
        // 插件重载 / 页面刷新后，已有的协作状态要把模型真正下发一次，
        // 否则界面是「主从模型」，跑的却是别的模型。
        if (state.duo) setTimeout(function () { applyMainModel('boot', 0, false, { quiet: true }); }, 1000);
        document.documentElement.classList.toggle('wbpro-duo-mode', state.duo);
        renderChip();
    }

    /** 开启 / 关闭协作档位。
     *
     *  **幂等**：重复调用同一目标状态不会有副作用——不重写配置、不弹 toast，
     *  只把视觉重新画一遍（便宜且必要，能修掉「状态是对的但界面没跟上」）。
     *
     *  以前这里有个 400ms 时间去抖，本意是压掉模拟点击时代的多余调用。
     *  那次模拟点击已经删了，去抖反而成了「第一次点击被吞掉」的嫌疑点：
     *  点击、配置回包、兜底轮询都打到这里，谁先谁后不受控。改成幂等后不需要时间窗。
     */
    function setDuo(on, silent, opts) {
        on = !!on;
        var wasDuo = state.duo;
        var changed = on !== wasDuo;
        // manual = 用户在官方下拉里亲手选了别的模型，这不是「退出协作」，
        // 而是「换了个主模型」，所以不能再把进入前的模型还原回去。
        var manual = !!(opts && opts.manual);
        state.duo = on;

        if (on && !wasDuo) {
            if (state.phase === 'idle') state.phase = 'planning';

            // 进入前记下官方当前档位，退出时还原。
            // officialLabel() 读的是官方那个被我们藏起来的 label，值始终是真实模型名。
            var curLabel = officialLabel();
            var curId = curLabel ? idByLabel(curLabel) : '';

            // 还没配过主模型：就用用户当前选中的这个，至少不凭空换模型
            if (!state.mainModel && curId) {
                state.mainModel = curId;
                saveConfig({ mainModel: curId });
            }
            if (curId && curId !== state.mainModel) {
                state.prevModel = curId;
                saveConfig({ prevModel: curId });
            }
        } else if (!on) {
            if (state.phase !== 'idle') state.phase = 'idle';
        }

        try {
            renderBadge();
            renderChip();
            renderPhaseRow();
            ensureDuoRow();
            applyTriggerLabel();
            document.documentElement.classList.toggle('wbpro-duo-mode', state.duo);
        } catch (e) {
            // 视觉刷新出错不能连累状态：状态已经落下，下一次重绘会补上
            ctx.log('刷新协作界面失败', e);
        }
        startPhasePoll();

        if (changed) saveConfig({ duo: state.duo });

        // 会话模型必须真的切过去：只改界面没用，发消息时官方还会按「当前选择」再同步一次。
        // 返回 promise 交给调用方（enterDuoFromList 要据此决定何时收起下拉：
        // 切换要读下拉项的 fiber，收早了就切不成）。
        var applying = null;
        if (on) applying = applyMainModel('enter');
        else if (changed && !manual) applying = restorePrevModel();

        if (changed && !silent) {
            ctx.ui.toast(
                state.duo
                    ? '主从模型已开启' +
                          (state.mainModel
                              ? '：主模型 ' + shortName(state.mainModel) + '，工作模型 ' + shortName(state.workerModel || '未设置')
                              : '；请先在面板里指定主模型')
                    : '已退出主从模式',
            );
        }
        return applying;
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
    // 本会话里「我们亲手写过」的键。服务端回包 / 拉起时读到的旧 snapshot
    // 一律不许覆盖它们，否则会出现「刚点开又被改回 false」的闪回。
    var dirtyKeys = {};
    // 服务端（runtime.json）里 duo 的最近一次已知值。
    // 重要：hook 注入规则**只读 runtime.json**，不看页面状态。
    // 所以这两个值一旦分叉，界面显示「已启用」但规则根本没下发——
    // 表现就是「主从模式下主模型完全不按规则走」。面板里要能看出来。
    var serverDuoSeen = null;

    function readLocalCfg() {
        try {
            var c = ctx.storage.get(CFG_KEY, null);
            return c && typeof c === 'object' ? c : null;
        } catch (e) {
            return null;
        }
    }

    /** 写本地缓存并记住这些键是「脏」的（以我们为准）。
     *  cached=true 表示这次只是把服务端的值缓存下来，不算我们的修改。 */
    function writeLocalCfg(patch, opt) {
        var cur = readLocalCfg() || {};
        Object.keys(patch || {}).forEach(function (k) {
            cur[k] = patch[k];
            if (!opt || !opt.cached) dirtyKeys[k] = true;
        });
        try { ctx.storage.set(CFG_KEY, cur); } catch (e) { /* 隐私模式等 */ }
        return cur;
    }

    function applyCfg(c) {
        if (!c) return;
        if (typeof c.mainModel === 'string') state.mainModel = c.mainModel;
        if (typeof c.workerModel === 'string') state.workerModel = c.workerModel;
        if (typeof c.workerMaxTurns === 'number') state.workerMaxTurns = c.workerMaxTurns;
        if (typeof c.prevModel === 'string') state.prevModel = c.prevModel;
        if (typeof c.auto === 'boolean') state.auto = c.auto;
        if (typeof c.duo === 'boolean') {
            // 记一笔：duo 真被改了几次。界面来回闪的时候这个数会一直涨，
            // 稳定的话点一次只应该 +1。
            if (c.duo !== state.duo) {
                duoStat.flips++;
                duoStat.flipAt = Date.now();
            }
            state.duo = c.duo;
        }
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
                if (typeof c.duo === 'boolean') serverDuoSeen = c.duo;
                if (pendingSync && local) {
                    // 本地更新过，别让旧的 runtime.json 覆盖掉
                    return trySyncPending();
                }
                if (Object.keys(c).length) {
                    // 我们把某些键标脏（本会话亲手写过）之后，旧 snapshot 不许再把它们改回去。
                    var apply = {};
                    Object.keys(c).forEach(function (k) {
                        if (!dirtyKeys[k]) apply[k] = c[k];
                    });
                    if (Object.keys(apply).length) {
                        applyCfg(apply);
                        writeLocalCfg(apply, { cached: true }); // 服务端值只做缓存，不算我们的修改
                    }
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
        // 只把**这次改的键**灌进状态。以前这里 applyCfg(writeLocalCfg(patch))，
        // 拿的是整包本地缓存——里面还留着旧的 duo:false，于是
        // setDuo(true) 刚把 state.duo 置真，紧接着又被这包旧值改回假，
        // 下拉里「已启用」就会闪一帧「协作」再回来。
        writeLocalCfg(patch);
        applyCfg(patch);
        renderBadge();

        return ctx.control
            .configSet(PLUGIN_ID, patch)
            .then(function (r) {
                controlOk = true;
                pendingSync = false;
                var c = (r && r.config) || {};
                if (typeof c.duo === 'boolean') serverDuoSeen = c.duo;
                // 服务端回包可能是「本次写入之前」的快照（并发写 / 旧缓存）。
                // 凡是本会话由我们写过的键（dirtyKeys），一律以本地为准，不采信回包。
                var safe = {};
                Object.keys(c).forEach(function (k) {
                    if (!dirtyKeys[k]) safe[k] = c[k];
                });
                Object.keys(patch || {}).forEach(function (k) { safe[k] = patch[k]; });
                if (Object.keys(safe).length) {
                    applyCfg(safe);
                    writeLocalCfg(safe, { cached: true });
                    // 状态若被纠正过，视觉立刻跟上，别等下一个轮询/观察者周期
                    ensureDuoRow();
                    applyTriggerLabel();
                    document.documentElement.classList.toggle('wbpro-duo-mode', state.duo);
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

    /* ---------- 主模型下发：让会话真实切到主模型 ---------- */

    /**
     * 为什么必须有这一步
     * ------------------
     * 官方每次发消息都会把「当前选中的模型」重新同步给会话：
     *   sendMessage → _meta['codebuddy.ai'].model
     *     → ensureSessionModelBeforeSend() → setSessionModel()
     *     → daemon updateSessionConfig{model} → agent session/set_model
     * 所以「会话模型」每个 turn 都会被重申一次。插件只改界面显示、不动会话模型，
     * 主模型就必然回落到用户在官方下拉里选的那个 —— 这正是删掉模拟点击后
     * 主模型从 hy4 变回 ds 的原因。
     *
     * 参数形态（容易踩的坑）
     * --------------------
     * preload: setSessionModel: invoke(SET_MODEL)
     *          invoke = (channel, payload, ...rest) => ipcRenderer.invoke('wb:invoke', ...)
     * 主进程 handler: (sessionId, modelId) 两个位置参数。
     * 5.9.3 那次实测传的是单个对象 {sessionId, modelId}，于是 sessionId 收到对象、
     * modelId 是 undefined，主进程 try/catch 吞掉异常回 {success:true} —— 看起来成功，实际没做。
     * 所以「IPC 假成功」的结论很可能只是参数错位，这里按位置参数重新下发。
     *
     * 下发完延迟回查官方触发器文案，结果记进 applyStat；面板诊断里能直接看到
     * 用了哪条通道、成功几次、最后一次报什么错，不用靠肉眼猜。
     */
    var applyStat = { tries: 0, ok: 0, fail: 0, channel: '', appliedAt: 0, err: '', lastTarget: '', verify: '', lastFailAt: 0 };
    var appliedSession = '';

    /** 「调了但没做」的返回值：宿主某些版本会用字符串 unsupported 或 errorCode 表示不支持 */
    function badResult(r) {
        if (typeof r === 'string') return /unsupport|not\s*supported/i.test(r) ? r : '';
        if (r && typeof r === 'object') {
            if (r.errorCode) return String(r.errorCode);
            if (typeof r.error === 'string' && r.error) return r.error;
            if (r.success === false) return 'success=false';
        }
        return '';
    }

    /** 拿一条能改会话模型的通道（都不存在时 reject，调用方决定是否降级） */
    function callSetModel(sessionId, modelId) {
        var fn = probe.setModelFn || findFn(window.workbuddyDesktop, 'setSessionModel', 3);
        probe.setModelFn = fn;
        if (fn) {
            return Promise.resolve(fn(sessionId, modelId)).then(function (r) {
                var bad = badResult(r);
                if (!bad) return { channel: 'sessions.setSessionModel', result: r };
                // 方法在、但这一版没实现（见过返回 unsupported），换通用桥再试
                if (typeof window.__wbInvoke === 'function') {
                    return Promise.resolve(window.__wbInvoke('session:setModel', sessionId, modelId)).then(function (r2) {
                        return { channel: '__wbInvoke', result: r2 };
                    });
                }
                throw new Error('setSessionModel 不可用: ' + bad);
            });
        }
        if (typeof window.__wbInvoke === 'function') {
            // 位置参数：channel, sessionId, modelId —— 不是单个对象
            return Promise.resolve(window.__wbInvoke('session:setModel', sessionId, modelId)).then(function (r) {
                return { channel: '__wbInvoke', result: r };
            });
        }
        return Promise.reject(new Error('宿主未暴露会话模型接口'));
    }

    /** 把当前会话模型切到 state.mainModel。force 用于面板里的手动重试（不要求已开协作） */
    /**
     * 把当前会话模型切到 state.mainModel。
     *
     * opts.quiet = true 表示后台触发（boot / 切会话）：这种时候**不主动打开下拉**，
     * 下拉没开就直接放弃。原因见 switchModelViaUI 的"隐形打开"说明 —— 隐形只是不可见，
     * 焦点和弹层状态仍然会动；后台悄悄做这事，万一和用户正在操作撞上，会显得界面自己在跳。
     * 用户主动触发的场景（点主从行、面板保存、手动重试）才允许打开。
     */
    function applyMainModel(reason, attempt, force, opts) {
        if (!alive()) return Promise.resolve(false);
        if (!state.duo && !force) return Promise.resolve(false);
        var want = String(state.mainModel || '').trim();
        if (!want) {
            applyStat.err = '未设置主模型';
            return Promise.resolve(false);
        }
        var sid = currentSessionId();
        if (!sid) {
            // 新会话可能还没有 data-root-id，等一拍再来
            attempt = attempt || 0;
            if (attempt < 3) {
                return new Promise(function (res) {
                    setTimeout(function () { res(applyMainModel(reason, attempt + 1, force, opts)); }, 600);
                });
            }
            applyStat.err = '未识别到会话 ID';
            return Promise.resolve(false);
        }

        applyStat.tries++;
        applyStat.lastTarget = want;
        applyStat.appliedAt = Date.now();

        // 首选：官方下拉项的 React 回调。这是唯一能写进渲染层 store 的通道 ——
        // IPC 只改主进程的会话记录，下一条消息仍按 store 里的旧模型发送（已实测）。
        return switchModelViaUI(want, { quiet: !!(opts && opts.quiet) })
            .then(function (r) {
                if (r.ok) {
                    applyStat.ok++;
                    applyStat.channel = r.strategy ? 'UI:' + r.strategy : 'UI';
                    applyStat.err = '';
                    applyStat.verify = 'ok';
                    appliedSession = sid;
                    ctx.log('主模型已切换 ' + want + ' → ' + sid.slice(0, 8) + '（' + applyStat.channel + '，' + reason + '）', r.detail);
                    return true;
                }

                // 兜底：IPC。多数版本里它只改主进程记录，但 UI 结构变化（找不到条目）时
                // 它至少还有机会，所以留着。
                ctx.log('UI 切换未生效（' + r.detail + '），改试 IPC');
                return callSetModel(sid, want)
                    .then(function (res) {
                        return waitLabel(shortName(want), 900).then(function (ok) {
                            if (ok) {
                                applyStat.ok++;
                                applyStat.channel = 'IPC:' + res.channel;
                                applyStat.err = '';
                                applyStat.verify = 'ok';
                                appliedSession = sid;
                                return true;
                            }
                            applyStat.fail++;
                            applyStat.lastFailAt = Date.now();
                            applyStat.err = 'UI 未生效（' + r.detail + '）；IPC 回成功但界面未变';
                            applyStat.verify = '未变';
                            return false;
                        });
                    })
                    .catch(function (e) {
                        applyStat.fail++;
                        applyStat.lastFailAt = Date.now();
                        applyStat.err = 'UI 未生效（' + r.detail + '）；IPC 失败：' + ((e && e.message) || e);
                        return false;
                    });
            });
    }

    /** 退出协作时把进入前的官方模型还回去（同样只能走 UI 通道）。
     *  这里允许打开下拉（非 quiet）：退出主从是用户主动操作，静默失败会让模型停在
     *  主模型上，比"下拉动一下"更让人困惑。 */
    function restorePrevModel() {
        var back = String(state.prevModel || '').trim();
        if (!back) return;
        switchModelViaUI(back).then(function (r) {
            if (r.ok) {
                ctx.log('已恢复进入主从前的模型 ' + back + '（' + (r.strategy || 'UI') + '）');
                appliedSession = '';
                return;
            }
            var sid = currentSessionId();
            if (sid) callSetModel(sid, back).catch(function () { /* 兜底也失败就保持现状 */ });
        });
    }

    /* ---------- 探测下拉的 React 结构 ---------- */

    /**
     * 为什么需要它
     * ----------
     * IPC 走不通（回查显示界面没变），说明真正决定发送模型的是渲染层 store，
     * 而 store 只能通过下拉项的 React 回调写进去。要直接调那个回调，
     * 就得先知道：元素上挂的是 `__reactProps$xxx` 还是 `__reactFiber$xxx`、
     * 回调叫什么名字、参数是 item 对象还是 id。
     * 这些只能从真实 DOM 上读，不能猜。所以抓一次结构落盘，照着它写调用。
     */
    function reactKeyOf(node, prefix) {
        var keys = node ? Object.keys(node) : [];
        for (var i = 0; i < keys.length; i++) if (keys[i].indexOf(prefix) === 0) return keys[i];
        return '';
    }

    function typeName(t) {
        if (typeof t === 'string') return t;
        if (typeof t === 'function') return t.displayName || t.name || 'anon';
        if (t && typeof t === 'object') {
            if (t.displayName) return t.displayName;
            if (typeof t.render === 'function') return 'forwardRef(' + (t.render.displayName || t.render.name || 'anon') + ')';
            return 'object';
        }
        return String(t);
    }

    function fnKeys(obj) {
        var out = [];
        if (!obj || typeof obj !== 'object') return out;
        Object.keys(obj).forEach(function (k) {
            try { if (typeof obj[k] === 'function') out.push(k); } catch (e) { /* 代理可能抛错 */ }
        });
        return out;
    }

    /** 浅层可读化：对象只展开一层，函数只留名字，避免把 React 元素树整个序列化 */
    function brief(v, depth) {
        if (v === null || v === undefined) return String(v);
        if (typeof v === 'function') return '[fn ' + (v.name || '') + ']';
        if (typeof v !== 'object') return v;
        if (depth > 0) return '[obj]';
        try {
            var o = {};
            Object.keys(v).slice(0, 16).forEach(function (k) {
                var x = v[k];
                o[k] = typeof x === 'function' ? '[fn]' : x && typeof x === 'object' ? '[obj]' : x;
            });
            return o;
        } catch (e) {
            return '[unreadable]';
        }
    }

    function describeNode(el) {
        var pk = reactKeyOf(el, '__reactProps$');
        var fk = reactKeyOf(el, '__reactFiber$');
        var props = pk ? el[pk] : null;
        var d = {
            tag: el.tagName,
            reactPropsKey: pk,
            reactFiberKey: fk,
            propsKeys: props && typeof props === 'object' ? Object.keys(props) : [],
            fnKeys: fnKeys(props),
            values: {},
        };
        if (props && typeof props === 'object') {
            ['value', 'item', 'option', 'model', 'selected', 'current', 'data', 'id', 'onSelect'].forEach(function (k) {
                if (k in props) d.values[k] = brief(props[k], 0);
            });
        }
        return d;
    }

    /** 从元素所在 fiber 往上走，看每层组件的 props 里有哪些回调（onSelect / onChange …） */
    function describeFiberUp(el, maxDepth) {
        var fk = reactKeyOf(el, '__reactFiber$');
        var f = fk ? el[fk] : null;
        var out = [];
        var d = 0;
        while (f && d < maxDepth) {
            var p = f.memoizedProps;
            out.push({
                depth: d,
                type: typeName(f.type || f.elementType),
                propsKeys: p && typeof p === 'object' ? Object.keys(p).slice(0, 30) : [],
                fnKeys: fnKeys(p),
                hasState: !!f.memoizedState,
            });
            f = f.return;
            d++;
        }
        return out;
    }

    function probeMenu() {
        var trig = document.querySelector('.cr-model-selector__trigger');
        if (!trig) return Promise.resolve({ error: '找不到模型选择器' });

        var wasOpen = !!document.querySelector(MENU_LIST);
        if (!wasOpen) trig.click();

        return new Promise(function (resolve) {
            var waited = 0;
            (function tick() {
                var list = document.querySelector(MENU_LIST);
                if (!list && waited < 2400) {
                    waited += 120;
                    setTimeout(tick, 120);
                    return;
                }
                if (!list) {
                    resolve({ error: '下拉没有打开' });
                    return;
                }

                var data = {
                    at: new Date().toISOString(),
                    trigger: describeNode(trig),
                    items: [],
                    fiberUp: [],
                };
                var items = list.querySelectorAll(MENU_ITEM);
                for (var i = 0; i < items.length && i < 40; i++) {
                    var it = items[i];
                    if (it.closest('[' + MENU_FLAG + ']')) continue; // 跳过我们自己插的那行
                    var rec = describeNode(it);
                    rec.name = itemName(it);
                    rec.ariaSelected = it.getAttribute('aria-selected');
                    data.items.push(rec);
                    if (!data.fiberUp.length) data.fiberUp = describeFiberUp(it, 10);
                }
                if (!wasOpen) setTimeout(closeModelPopover, 120);
                resolve(data);
            })();
        });
    }

    function reportProbe(data) {
        var slim = {
            at: data.at,
            trigger: data.trigger,
            items: data.items.slice(0, 12),
            fiberUp: data.fiberUp,
        };
        var viaConfig = function () {
            // 控制服务一直在跑，改的是 runtime.json，不需要重启应用。
            // 只用于探测输出，键名带下划线避免和配置项混淆。
            return ctx.control.configSet(PLUGIN_ID, { _probe: slim }).then(function () {
                return { via: 'runtime.json', bytes: JSON.stringify(slim).length };
            });
        };
        if (!ctx.backend || !ctx.backend.baseUrl) return viaConfig();
        return ctx.backend
            .fetch('/api/probe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(slim),
            })
            .then(function (r) { return r.json(); })
            .then(function (r) {
                // reload 不重启 backend 进程：老进程没有新路由会回 404，自动退回写配置
                if (r && r.ok) return { via: 'probe.json', bytes: r.bytes };
                throw new Error((r && r.error) || 'backend 未响应');
            })
            .catch(viaConfig);
    }

    /* ---------- 走官方下拉的 React 回调切模型 ---------- */

    /**
     * 为什么不用 IPC
     * -------------
     * `session:setModel` 只改主进程里的会话记录，渲染层 store 不动；而发消息时
     * `ensureSessionModelBeforeSend()` 用的是 store 里的值，于是下一条消息又用回旧模型。
     * 实测也印证了：通道回 {success:true}，下拉文案没变。
     *
     * 唯一能把值写进 store 的入口，是下拉项的 React 回调。探测结果（probe.json）显示：
     *   div.cr-model-selector__item  →  React props.onClick
     *   fiber 上溯 3 层              →  ModelItem 组件，props 有 option / isSelected / onSelect
     * 所以按 onSelect(option) → onSelect() → props.onClick(事件桩) → element.click() 依次尝试，
     * 每步都等界面回查，谁先成功就用谁，不再靠"点了应该就成"。
     */
    function waitForMenu(ms) {
        return new Promise(function (res) {
            var t0 = Date.now();
            (function tick() {
                var l = document.querySelector(MENU_LIST);
                if (l) return res(l);
                if (Date.now() - t0 > ms) return res(null);
                setTimeout(tick, 80);
            })();
        });
    }

    function waitLabel(expect, ms) {
        return new Promise(function (res) {
            var t0 = Date.now();
            (function tick() {
                var got = officialLabel();
                if (got && got === expect) return res(true);
                if (Date.now() - t0 > ms) return res(false);
                setTimeout(tick, 100);
            })();
        });
    }

    /** 按显示名找下拉项。同名多项时取第一个（官方列表里同名模型通常只有一个）。 */
    /** 读某一项对应的模型 id（从 ModelItem 的 props.option 里取）。
     *  官方列表里同名的模型不止一个（hy4free / hy4std 都显示 "Hy4"），
     *  只按名字找会挑错，所以能用 id 就用 id。 */
    function itemModelId(it) {
        var hit = findFiberWithFn(it, 'onSelect', 12);
        var opt = hit && hit.props && hit.props.option;
        if (!opt || typeof opt !== 'object') return '';
        return String(opt.id || opt.modelId || opt.value || opt.key || '');
    }

    /** 按 id 找下拉项；找不到再按显示名兜底（老版本 option 里可能没有 id） */
    function findMenuItem(modelId) {
        var list = document.querySelector(MENU_LIST);
        if (!list) return null;
        var want = shortName(modelId);
        var items = list.querySelectorAll(MENU_ITEM);
        var byName = null;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.closest('[' + MENU_FLAG + ']')) continue;
            if (modelId && itemModelId(it) === modelId) return it;
            if (!byName && itemName(it) === want) byName = it;
        }
        return byName;
    }

    /** 从元素所在 fiber 往上找第一个带指定回调的组件（不按组件名匹配，官方改名也不受影响） */
    function findFiberWithFn(el, fnName, maxDepth) {
        var k = reactKeyOf(el, '__reactFiber$');
        var f = k ? el[k] : null;
        var d = 0;
        while (f && d < (maxDepth || 12)) {
            var p = f.memoizedProps;
            if (p && typeof p === 'object' && typeof p[fnName] === 'function') {
                return { props: p, depth: d, type: typeName(f.type || f.elementType) };
            }
            f = f.return;
            d++;
        }
        return null;
    }

    /** React 合成事件桩：onClick 内部常调 e.preventDefault()/stopPropagation()，无参调用会抛错 */
    function evtStub(el) {
        return {
            type: 'click',
            target: el,
            currentTarget: el,
            nativeEvent: {},
            button: 0,
            detail: 1,
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            preventDefault: function () { this.defaultPrevented = true; },
            stopPropagation: function () {},
            isPropagationStopped: function () { return false; },
            isDefaultPrevented: function () { return this.defaultPrevented; },
            persist: function () {},
        };
    }

    /** 用 React 回调选中某一项，返回用了哪个策略（结果可能是 Promise，由调用方等） */
    function selectMenuItem(it) {
        // 1) ModelItem.onSelect —— 官方语义入口，参数是这一项的 option
        var hit = findFiberWithFn(it, 'onSelect', 12);
        if (hit) {
            var opt = hit.props.option;
            try {
                return { strategy: 'onSelect(option)', result: hit.props.onSelect(opt) };
            } catch (e) {
                ctx.log('onSelect(option) 抛错，改试无参', e);
            }
            try {
                return { strategy: 'onSelect()', result: hit.props.onSelect() };
            } catch (e2) {
                ctx.log('onSelect() 抛错，改走 onClick', e2);
            }
        }
        // 2) 行自身的 React onClick（内部就是 () => onSelect(option)）
        var pk = reactKeyOf(it, '__reactProps$');
        var props = pk ? it[pk] : null;
        if (props && typeof props.onClick === 'function') {
            try {
                return { strategy: 'item.onClick', result: props.onClick(evtStub(it)) };
            } catch (e3) {
                ctx.log('item.onClick 抛错，最后用 DOM click', e3);
            }
        }
        // 3) 兜底：程序化 DOM 点击（React 的事件委托照样能收到）
        it.click();
        return { strategy: 'item.click()', result: null };
    }

    /**
     * 通过官方下拉把当前会话模型切到 modelId。
     * 返回 { ok, detail, strategy } —— ok 以界面回查为准，不看返回值。
     *
     * **为什么要"隐形打开"**
     * 切换唯一有效的入口是下拉项的 `ModelItem.props.onSelect`，而 fiber 只在下拉
     * 渲染时存在 —— 不打开下拉就拿不到它，所以"打开"这一步绕不过去。
     * 但"打开"不等于"让人看见"：把浮层在打开的那一瞬间设为不可见，
     * 布局、fiber、事件委托全都正常，只有视觉上是透明的。用户看到的就是
     * 「点了一下主从模型，模型已经换好了」，中间没有下拉一闪。
     *
     * 只在**我们自己打开**时隐藏（openedByUs）。如果用户本来就把下拉开着了，
     * 那是他自己的界面，绝不能动手脚 —— 那种情况下本来也不存在"闪"。
     */
    function switchModelViaUI(modelId, opts) {
        if (!alive()) return Promise.resolve({ ok: false, detail: '实例已卸载' });
        var quiet = !!(opts && opts.quiet);
        var want = shortName(modelId);
        var trig = document.querySelector('.cr-model-selector__trigger');
        if (!trig) return Promise.resolve({ ok: false, detail: '当前页面没有模型选择器' });
        if (!want) return Promise.resolve({ ok: false, detail: '模型名为空' });

        var focusBack = document.activeElement;
        var openedByUs = false;
        var veil = null;

        if (!document.querySelector(MENU_LIST)) {
            // 后台触发（boot / 切会话）不主动开下拉：隐形只是看不见，焦点和弹层状态
            // 仍然会动，和用户操作撞上就会显得界面自己在跳。等下一次用户交互再说。
            if (quiet) return Promise.resolve({ ok: false, detail: '下拉未打开，后台触发时跳过' });
            // 先挂"隐形"标记，再点开 —— 顺序不能反：点开是同步渲染的，
            // 先点后藏会有一帧可见（就是用户看到的"闪一下"）。
            veil = beginVeil();
            trig.click();
            openedByUs = true;
        }

        function done(res) {
            if (openedByUs) {
                setTimeout(function () {
                    closeModelPopover();
                    // 收起动画结束后再摘掉隐形，避免"摘了但还没收完"那一帧又露出来
                    setTimeout(function () { endVeil(veil); }, 200);
                }, 80);
            } else {
                endVeil(veil);
            }
            // 临时点开下拉会抢焦点，操作完还给原来的输入框，别打断用户打字
            if (openedByUs && focusBack && focusBack.focus) {
                setTimeout(function () {
                    try { focusBack.focus(); } catch (e) { /* ignore */ }
                }, 240);
            }
            return res;
        }

        return waitForMenu(2400)
            .then(function (list) {
                if (!list) return { ok: false, detail: '下拉没有打开' };
                var it = findMenuItem(modelId);
                if (!it) return { ok: false, detail: '下拉里找不到「' + want + '」' };
                // 「已经是它」只看 id：aria-selected 在某些版本里会被我们自己或别的
                // 逻辑动过，用它判断会导致反复下发同一个模型。
                var alreadyId = itemModelId(it);
                if (alreadyId && alreadyId === modelId && officialLabel() === want) {
                    return { ok: true, detail: '已经是「' + want + '」', strategy: 'skip' };
                }
                var picked = selectMenuItem(it);
                return waitLabel(want, 1500).then(function (ok) {
                    return {
                        ok: ok,
                        detail: ok
                            ? '已切到「' + want + '」'
                            : '调了 ' + picked.strategy + ' 但官方档位没变（当前 ' + officialLabel() + '）',
                        strategy: picked.strategy,
                    };
                });
            })
            .catch(function (e) {
                return { ok: false, detail: String((e && e.message) || e) };
            })
            .then(done);
    }

    /* ---------- 隐形打开：让临时弹出的下拉不可见 ---------- */

    var VEIL_ATTR = 'data-wbpro-veil';
    var VEIL_CLASS = 'wbpro-veil';
    var veilObserver = null;

    /**
     * 开始隐形。浮层是 portal 渲染的（挂在 body 末尾），且打开瞬间才创建，
     * 所以不能只给一个已知节点打标记 —— 用 MutationObserver 盯着，
     * 一出现就立刻套上样式，同时给 body 加一个类兜住首帧。
     *
     * 用 `visibility:hidden` 而不是 `display:none`：
     * display:none 会让元素不参与布局，某些弹层库会据此判定"未挂载"而提前卸载内容，
     * 那样 fiber 就没了。visibility 只影响绘制，布局与 fiber 全部保留。
     */
    function beginVeil() {
        var veil = { active: true };
        // 这条类规则兜住"点了但 React 还没渲染完"的首帧：
        // 节点一出现就是隐藏的，不必等 MutationObserver 回调（那要等到下一微任务）。
        document.documentElement.classList.add(VEIL_CLASS);

        function paint() {
            if (!veil.active) return;
            var sel = '.cr-model-selector__popover, .cr-model-selector__menu, .cr-popover';
            var nodes = document.querySelectorAll(sel);
            for (var i = 0; i < nodes.length; i++) {
                var n = nodes[i];
                if (n.getAttribute(VEIL_ATTR)) continue;
                n.setAttribute(VEIL_ATTR, '1');
                n.style.visibility = 'hidden';
                n.style.pointerEvents = 'none';
            }
        }
        paint();

        if (!veilObserver) {
            veilObserver = new MutationObserver(paint);
            veilObserver.observe(document.body, { childList: true, subtree: true });
        }
        veil.paint = paint;
        return veil;
    }

    function endVeil(veil) {
        if (!veil || !veil.active) return;
        veil.active = false;
        document.documentElement.classList.remove(VEIL_CLASS);
        if (veilObserver) {
            try { veilObserver.disconnect(); } catch (e) { /* ignore */ }
            veilObserver = null;
        }
        var nodes = document.querySelectorAll('[' + VEIL_ATTR + ']');
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            n.removeAttribute(VEIL_ATTR);
            n.style.visibility = '';
            n.style.pointerEvents = '';
        }
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
        if (!alive()) return;
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
        note('决策与验收；开启主从时会把当前会话模型真正切到它（不是只改显示）');

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
                    // 主模型要在当前会话里真正生效，必须下发一次；工作模型由 hook 在派发子代理时强制。
                    var willApply = !!(state.duo && patch.mainModel);
                    if (!res.synced) {
                        ctx.ui.toast('已保存到本地；控制服务未启动，运行 wbpro up 后会自动补写');
                    } else if (willApply) {
                        applyMainModel('panel-save').then(function (ok) {
                            ctx.ui.toast(
                                ok
                                    ? '主模型已切到 ' + shortName(patch.mainModel)
                                    : '已保存，但模型下发失败：' + (applyStat.err || '未知原因') + '（面板诊断里可看详情）',
                            );
                        });
                    } else if (patch.mainModel && !state.duo) {
                        ctx.ui.toast('主模型已保存；选中「主从模型」档位时生效');
                    } else if (patch.workerModel) {
                        ctx.ui.toast('已保存；工作模型下一次子代理调用生效');
                    } else {
                        ctx.ui.toast('已保存');
                    }
                    renderPanelBody();
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
        var sid = currentSessionId();
        var s = document.createElement('div');
        s.textContent = '会话：' + (sid ? sid.slice(0, 8) + '…' : '未识别');
        s.style.marginTop = '4px';
        diag.appendChild(s);

        // 主模型下发结果：最容易出问题的一环，直接摆出来，不用翻控制台
        var ap = document.createElement('div');
        ap.style.marginTop = '4px';
        ap.textContent =
            '主模型切换：' +
            (applyStat.tries === 0
                ? '未触发'
                : applyStat.ok + ' 成功 / ' + applyStat.fail + ' 失败' +
                  (applyStat.channel ? ' · ' + applyStat.channel : '') +
                  (applyStat.lastTarget ? ' · →' + shortName(applyStat.lastTarget) : '') +
                  (applyStat.verify ? ' · 回查 ' + applyStat.verify : '') +
                  (applyStat.err ? ' · ' + applyStat.err : ''));
        diag.appendChild(ap);

        // 现场验证用：不退出主从、不重开下拉，点一下就知道这条通道通不通
        var retry = document.createElement('button');
        retry.textContent = '试一次切换';
        retry.style.cssText =
            'margin-top:5px;padding:3px 8px;border-radius:5px;border:1px solid rgba(255,255,255,.18);' +
            'background:transparent;color:inherit;cursor:pointer;font-size:11px;';
        retry.onclick = function () {
            retry.disabled = true;
            applyMainModel('manual', 0, true).then(function (ok) {
                retry.disabled = false;
                ctx.ui.toast(ok ? '已下发，看顶部模型名有没有变成 ' + shortName(state.mainModel) : '下发失败：' + (applyStat.err || '未知'));
                renderPanelBody();
            });
        };
        diag.appendChild(retry);

        // 抓一次下拉项的 React 结构（写 probe.json），用来确定「程序化选中」该调哪个回调
        var probeBtn = document.createElement('button');
        probeBtn.textContent = '抓取下拉结构';
        probeBtn.style.cssText = retry.style.cssText + 'margin-left:6px;';
        probeBtn.onclick = function () {
            probeBtn.disabled = true;
            probeMenu()
                .then(function (data) {
                    if (data.error) {
                        ctx.ui.toast('探测失败：' + data.error);
                        return null;
                    }
                    return reportProbe(data).then(function (r) {
                        ctx.ui.toast('已写入 ' + r.via + '：' + data.items.length + ' 项 / ' + (r.bytes || 0) + ' 字节');
                    });
                })
                .catch(function (e) {
                    ctx.ui.toast('上报失败：' + ((e && e.message) || e));
                })
                .finally(function () {
                    probeBtn.disabled = false;
                });
        };
        diag.appendChild(probeBtn);

        var dp = document.createElement('div');
        dp.style.marginTop = '4px';
        dp.textContent =
            '主从行：按下 ' +
            duoStat.press +
            ' / 键盘 ' +
            duoStat.kb +
            ' / 进入 ' +
            duoStat.enter +
            ' / 状态翻转 ' +
            duoStat.flips +
            (duoStat.at ? '（最近进入 ' + new Date(duoStat.at).toLocaleTimeString() + '）' : '');
        diag.appendChild(dp);

        // hook 只认 runtime.json；和界面不一致时，规则不会下发。
        var dg = document.createElement('div');
        dg.style.marginTop = '2px';
        var mismatch = serverDuoSeen !== null && serverDuoSeen !== state.duo;
        dg.textContent =
            '规则注入：runtime.json duo = ' +
            (serverDuoSeen === null ? '未知（控制服务未连上）' : serverDuoSeen ? 'true' : 'false') +
            (mismatch ? '  ⚠ 与界面不一致，规则不会生效' : '');
        if (mismatch) dg.style.color = '#e0a33e';
        diag.appendChild(dg);
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
