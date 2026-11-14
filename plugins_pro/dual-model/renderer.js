/* 双模型协同：主模型决策 + 工作模型执行，并在界面上标出当前阶段。
 *
 * 两个模型的分工靠两条不同的通道：
 *   主模型 —— 当前会话模型，用 session:setModel 即时切换
 *   工作模型 —— 子代理模型，CLI 启动时读 CODEBUDDY_CODE_SUBAGENT_MODEL，
 *               所以只能写进 runtime.json，由 wbpro 下次启动时注入
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

function currentSessionId() {
    try {
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
    };
    var panelRef = null;
    var badge = null;
    var badgeText = null;
    var probe = { desktop: false, setModel: false, invoke: false, onEvent: false };
    var lastApply = '';
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
        t.textContent = (isWork ? '工 ' : '主 ') + shortName(currentOwner()) + ' · ' + PHASES[state.phase].label;
        t.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';
        badge.appendChild(d);
        badge.appendChild(t);
        badgeText = t;
        badge.title = '双模型协同：点击设置';
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

    // 官方没有导出「设置模型」的公开方法，这里按可信度依次试三种形态。
    function applyMainModel(modelId) {
        var sid = currentSessionId();
        var attempts = [];
        if (probe.setModelFn) {
            attempts.push({
                name: 'workbuddyDesktop.setSessionModel',
                run: function () { return probe.setModelFn(sid, modelId); },
            });
        }
        if (probe.invoke) {
            // 有 sessionId 才带上，避免把 null 当成"指定会话=null"传下去
            if (sid) {
                attempts.push({
                    name: '__wbInvoke(session:setModel)',
                    run: function () {
                        return window.__wbInvoke('session:setModel', { sessionId: sid, modelId: modelId });
                    },
                });
            }
            attempts.push({
                name: '__wbInvoke(session:setModel) 无 sessionId',
                run: function () {
                    return window.__wbInvoke('session:setModel', { modelId: modelId });
                },
            });
        }

        function step(i) {
            if (i >= attempts.length) {
                lastApply = '全部方式失败：宿主未暴露模型切换接口';
                return Promise.resolve({ ok: false, detail: lastApply });
            }
            var a = attempts[i];
            return Promise.resolve()
                .then(a.run)
                .then(function (r) {
                    if (r && r.error) throw new Error(String(r.error));
                    // 这个通道只回 {success:true}，不回模型 id，所以只能算"已请求"
                    var echoed = r && (r.modelId || r.model);
                    lastApply = echoed
                        ? '成功：' + a.name + ' → ' + echoed
                        : '已请求切换（' + a.name + '，通道无回执，以界面显示为准）';
                    return { ok: true, detail: lastApply };
                })
                .catch(function (e) {
                    return step(i + 1).catch(function () { return { ok: false, detail: String(e && e.message || e) }; });
                });
        }

        return step(0).then(function (r) {
            ctx.log('切换主模型', modelId, r.detail);
            return r;
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

        var mainSel = document.createElement('select');
        mainSel.innerHTML = selectHtml(state.mainModel);
        mainSel.style.cssText = 'flex:1;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.06);color:inherit;border:1px solid rgba(255,255,255,.14);';
        row('主模型').appendChild(mainSel);
        note('决策与验收；切换后立即作用于当前会话');

        var workerSel = document.createElement('select');
        workerSel.innerHTML = selectHtml(state.workerModel);
        workerSel.style.cssText = mainSel.style.cssText;
        row('工作模型').appendChild(workerSel);
        note('执行计划；写入配置后需重启 WorkBuddy 生效');

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
                    var switchP = patch.mainModel
                        ? applyMainModel(patch.mainModel).catch(function (e) {
                              return { ok: false, detail: String((e && e.message) || e) };
                          })
                        : Promise.resolve(null);
                    return switchP.then(function (r) {
                        lastApply = r ? r.detail : '';
                        if (!res.synced) {
                            ctx.ui.toast('已保存到本地；控制服务未启动，运行 wbpro up 后会自动补写');
                        } else if (patch.workerModel) {
                            ctx.ui.toast('已保存；工作模型重启后生效');
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

    /* ---------- 启动 ---------- */

    detect();
    mountBadge();
    loadConfig();
    subscribeEvents();
    subscribeConfigChange();
    refreshModels();

    var keeper = setInterval(function () {
        if (badge && !badge.isConnected && document.body) document.body.appendChild(badge);
    }, 3000);
    ctx.onCleanup(function () { clearInterval(keeper); });

    ctx.onCleanup(function () {
        if (unsubEvent && typeof unsubEvent === 'function') {
            try { unsubEvent(); } catch (e) { /* ignore */ }
        }
        if (unsubConfig && typeof unsubConfig === 'function') {
            try { unsubConfig(); } catch (e) { /* ignore */ }
        }
        if (!(panelRef && panelRef.persist)) panelRef && panelRef.remove();
        panelRef = null;
        badge && badge.remove();
        badge = null;
    });

    ctx.log('双模型协同已加载', JSON.stringify(probe));
}
