// dual-model 插件后端：读取子代理的 jsonl 轨迹，供页面侧展示。
//
// 为什么需要它：子代理的思考与工具调用不进 wb:event 事件流（实测 requestsIncluded:false），
// 官方渲染层也只显示一个折叠的 Agent 卡片。但 CLI 会把子代理的完整轨迹独立落盘到
//   ~/.workbuddy/projects/<编码cwd>/<会话ID>/subagents/agent-<uuid>.jsonl
// 所以这里直接读文件，把 reasoning / function_call / function_call_result 还原成时间线。
//
// 由 wbpro 用 WBPRO_PORT 拉起，只绑 127.0.0.1。
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.WBPRO_PORT || 0);
const HOST = process.env.WBPRO_HOST || '127.0.0.1';

const PROJECTS_ROOT = path.join(os.homedir(), '.workbuddy', 'projects');

/** 把 cwd 编码成 WorkBuddy 的 project 目录名：H:/a/b → h-_Project-a-b */
function encodeCwd(cwd) {
    if (!cwd) return '';
    // 先统一分隔符，再去掉盘符冒号，最后整体替换。
    // 注意顺序：若先替换盘符为 "h-"，后面的冒号替换会再补一个 "-"，得到 "h--"。
    const s = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
    return s.replace(/^([A-Za-z]):/, (_m, d) => d.toLowerCase()).replace(/[:/\\]+/g, '-');
}

/** 在 projects 下找出与 cwd 匹配的目录（编码规则可能随版本变，做兜底匹配） */
function findProjectDir(cwd) {
    let dirs = [];
    try {
        dirs = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return null;
    }
    const want = encodeCwd(cwd);
    if (want && dirs.includes(want)) return path.join(PROJECTS_ROOT, want);

    // 兜底：按尾部片段比对（编码规则改动时不至于全废）
    const tail = want.split('-').filter(Boolean).slice(-3).join('-').toLowerCase();
    if (tail) {
        const hit = dirs.find((d) => d.toLowerCase().endsWith(tail));
        if (hit) return path.join(PROJECTS_ROOT, hit);
    }
    return null;
}

/**
 * 定位会话目录，返回 { sessionId, dir, guessed? }。
 *
 * 优先用前端传来的 sessionId（来自页面 DOM 的 [data-root-id]，即当前正在看的会话）。
 * 一旦传了 sessionId 就必须精确命中：找不到就返回 null 让接口报错，
 * 绝不能退化成「最近写入的会话」—— 同时开两个会话时那会指到另一个会话上，
 * 看起来像是「子代理内容串了」。
 *
 * 只有在完全没传 sessionId（老版本前端 / 手动调接口）时才用最近写入兜底，
 * 并在返回值里标 guessed:true，让调用方知道这不是确定结果。
 */
function resolveSession(cwd, sessionId) {
    let projectNames = [];
    try {
        projectNames = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
        return null;
    }

    // 1) 指定了 sessionId：只认精确匹配
    if (sessionId) {
        // 1a) 有 cwd 时先走精确编码，省一次遍历
        if (cwd) {
            const proj = findProjectDir(cwd);
            if (proj) {
                const full = path.join(proj, sessionId);
                if (fs.existsSync(full)) return { sessionId, dir: full };
            }
        }
        // 1b) 没有 cwd 或没命中：在所有 project 下按目录名找
        for (const name of projectNames) {
            const candidate = path.join(PROJECTS_ROOT, name, sessionId);
            if (fs.existsSync(candidate)) return { sessionId, dir: candidate };
        }
        return null; // 明确失败，不猜
    }

    // 2) 完全没给 sessionId：兜底找最近有 subagents 写入的会话
    let best = null;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const name of projectNames) {
        const projDir = path.join(PROJECTS_ROOT, name);
        let sessions = [];
        try {
            sessions = fs.readdirSync(projDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
            continue;
        }
        for (const sid of sessions) {
            if (!UUID.test(sid)) continue;
            const subDir = path.join(projDir, sid, 'subagents');
            let files = [];
            try {
                files = fs.readdirSync(subDir).filter((n) => n.endsWith('.jsonl'));
            } catch {
                continue;
            }
            for (const f of files) {
                let st;
                try {
                    st = fs.statSync(path.join(subDir, f));
                } catch {
                    continue;
                }
                if (!best || st.mtimeMs > best.mtime) {
                    best = { sessionId: sid, dir: path.join(projDir, sid), mtime: st.mtimeMs };
                }
            }
        }
    }
    return best ? { sessionId: best.sessionId, dir: best.dir, guessed: true } : null;
}

/**
 * 解析 jsonl 成时间线条目。
 * 只保留对展示有用的四种类型；其余（如 compaction）跳过。
 * 注意：文件可能正在被写入，最后一行可能不完整，用 try/catch 逐行容错。
 */
function parseTimeline(file) {
    let raw = '';
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch {
        return { items: [], truncated: false, badLines: 0 };
    }
    const lines = raw.split('\n');
    const items = [];
    let badLines = 0;
    // 每个 step 已出现过的思考指纹，用于去重（同一 step 多工具会重复携带同一段）
    const seenReasoning = new Map();

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;
        let o;
        try {
            o = JSON.parse(line);
        } catch {
            // 正在写入的最后一行会解析失败，这是正常的，不算错误
            badLines++;
            continue;
        }
        const pd = o.providerData || {};

        if (o.type === 'message') {
            const texts = Array.isArray(o.content)
                ? o.content.filter((c) => c && (c.type === 'input_text' || c.type === 'text')).map((c) => c.text).join('\n')
                : String(o.content || '');
            items.push({
                kind: 'message',
                role: o.role || 'unknown',
                ts: o.timestamp || 0,
                text: texts.slice(0, 4000),
            });
            continue;
        }

        if (o.type === 'reasoning') {
            const text = reasoningText(o);
            if (!text.trim()) continue;
            const step = pd.stepSeq ?? null;
            // 登记指纹，避免后面的 function_call 再补一遍同样的内容
            const seen = seenReasoning.get(step) || new Set();
            seen.add(text.slice(0, 120));
            seenReasoning.set(step, seen);
            items.push({
                kind: 'reasoning',
                ts: o.timestamp || 0,
                step,
                model: pd.requestModelName || pd.model || '',
                text: text.slice(0, 8000),
            });
            continue;
        }

        if (o.type === 'function_call') {
            // 同一行里常常内嵌本步 reasoning。但同一 step 的多工具调用会重复携带同一段，
            // 所以只在本 step 还没有 reasoning 条目时才补，避免同一段思考被印三遍。
            const inlineReasoning = typeof pd.reasoning === 'string' && pd.reasoning.trim() ? pd.reasoning : '';
            const step = pd.stepSeq ?? null;
            const seen = seenReasoning.get(step) || new Set();
            const fp = inlineReasoning.slice(0, 120);
            if (inlineReasoning && !seen.has(fp)) {
                seen.add(fp);
                seenReasoning.set(step, seen);
                items.push({
                    kind: 'reasoning',
                    ts: o.timestamp || 0,
                    step,
                    model: pd.requestModelName || pd.model || '',
                    text: inlineReasoning.slice(0, 8000),
                });
            }
            items.push({
                kind: 'tool',
                ts: o.timestamp || 0,
                step,
                callId: o.callId || '',
                name: o.name || '',
                args: pd.argumentsDisplayText || String(o.arguments || '').slice(0, 3000),
            });
            continue;
        }

        if (o.type === 'function_call_result') {
            const out = o.output;
            let text = '';
            if (out && typeof out === 'object') text = out.text || JSON.stringify(out);
            else text = String(out || '');
            items.push({
                kind: 'result',
                ts: o.timestamp || 0,
                callId: o.callId || '',
                name: o.name || '',
                status: o.status || '',
                text: text.slice(0, 3000),
            });
            continue;
        }
    }
    items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return { items, truncated: false, badLines };
}

/** 从 reasoning 记录里取出正文。
 *  实测结构有两种：rawContent 是 [{type:'reasoning_text', text}] 数组，
 *  或 content 是 [{type:'text', text}]；providerData.reasoning 是纯字符串（只在 function_call 上）。
 *  三种都要兼容，否则会渲染出 [object Object]。 */
function reasoningText(o) {
    const pd = o.providerData || {};
    if (typeof pd.reasoning === 'string' && pd.reasoning.trim()) return pd.reasoning;

    const pick = (arr) => {
        if (!Array.isArray(arr)) return '';
        return arr
            .map((c) => (c && typeof c === 'object' ? c.text || c.reasoning || '' : String(c || '')))
            .filter(Boolean)
            .join('\n');
    };
    const fromRaw = pick(o.rawContent);
    if (fromRaw.trim()) return fromRaw;
    const fromContent = pick(o.content);
    if (fromContent.trim()) return fromContent;
    // 兜底：rawContent 是纯字符串
    if (typeof o.rawContent === 'string') return o.rawContent;
    if (typeof o.content === 'string') return o.content;
    return '';
}
function summarize(items) {
    const tools = {};
    let reasoningChars = 0;
    let reasoningCount = 0;
    let lastTool = '';
    let lastText = '';
    for (const it of items) {
        if (it.kind === 'tool') {
            tools[it.name] = (tools[it.name] || 0) + 1;
            lastTool = it.name;
        } else if (it.kind === 'reasoning') {
            reasoningCount++;
            reasoningChars += it.text.length;
            lastText = it.text;
        }
    }
    return {
        toolCount: Object.values(tools).reduce((a, b) => a + b, 0),
        tools,
        reasoningCount,
        reasoningChars,
        lastTool,
        lastThought: lastText.slice(-400),
    };
}

function json(res, code, data) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': '*',
    });
    res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        }).end();
        return;
    }

    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname === '/health') {
        json(res, 200, { ok: true, id: 'dual-model' });
        return;
    }

    // GET /api/subagents?cwd=...&sessionId=...  → 该会话下所有子代理的概要
    // sessionId 由前端从页面 [data-root-id] 取得；仅当完全省略时才自动兜底
    if (url.pathname === '/api/subagents') {
        const cwd = url.searchParams.get('cwd') || '';
        const sessionId = url.searchParams.get('sessionId') || '';
        const session = resolveSession(cwd, sessionId);
        if (!session) {
            json(res, 404, {
                error: sessionId ? `找不到会话 ${sessionId} 的目录` : '找不到任何带子代理记录的会话',
                cwd,
                sessionId,
                projectsRoot: PROJECTS_ROOT,
            });
            return;
        }
        const dir = path.join(session.dir, 'subagents');
        let names = [];
        try {
            names = fs.readdirSync(dir).filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl'));
        } catch {
            names = [];
        }
        const files = names
            .map((n) => {
                const full = path.join(dir, n);
                let st;
                try {
                    st = fs.statSync(full);
                } catch {
                    return null;
                }
                return { id: n.replace(/^agent-/, '').replace(/\.jsonl$/, ''), path: full, size: st.size, mtime: st.mtimeMs };
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);

        const list = files.map((f) => {
            const { items } = parseTimeline(f.path);
            return { id: f.id, size: f.size, mtime: f.mtime, itemCount: items.length, summary: summarize(items) };
        });
        json(res, 200, {
            sessionId: session.sessionId,
            guessed: !!session.guessed, // true = 前端没给 sessionId，后端自己挑的，可能不是当前会话
            sessionDir: session.dir,
            subagentDir: dir,
            count: list.length,
            subagents: list,
        });
        return;
    }

    // GET /api/subagent?id=...&cwd=...&sessionId=...  → 单个子代理的完整时间线
    if (url.pathname === '/api/subagent') {
        const id = url.searchParams.get('id') || '';
        const cwd = url.searchParams.get('cwd') || '';
        const sessionId = url.searchParams.get('sessionId') || '';
        if (!id) {
            json(res, 400, { error: '缺少 id' });
            return;
        }
        const session = resolveSession(cwd, sessionId);
        if (!session) {
            json(res, 404, { error: '找不到会话目录', cwd, sessionId });
            return;
        }
        const file = path.join(session.dir, 'subagents', `agent-${id}.jsonl`);
        if (!fs.existsSync(file)) {
            json(res, 404, { error: '子代理文件不存在', file });
            return;
        }
        const st = fs.statSync(file);
        const { items, badLines } = parseTimeline(file);
        json(res, 200, {
            id,
            sessionId: session.sessionId,
            size: st.size,
            mtime: st.mtimeMs,
            running: Date.now() - st.mtimeMs < 8000, // 8 秒内有写入视为在跑
            badLines,
            summary: summarize(items),
            items,
        });
        return;
    }

    // GET /api/debug  → 排查用：当前编码结果与目录探测
    if (url.pathname === '/api/debug') {
        const cwd = url.searchParams.get('cwd') || '';
        const encoded = encodeCwd(cwd);
        const projectDir = findProjectDir(cwd);
        let sessions = [];
        if (projectDir) {
            try {
                sessions = fs.readdirSync(projectDir).filter((n) => /^[0-9a-f-]{36}$/i.test(n));
            } catch {
                /* ignore */
            }
        }
        json(res, 200, { cwd, encoded, projectDir, projectsRoot: PROJECTS_ROOT, sessions });
        return;
    }

    // POST /api/probe  → 页面侧把探测结果落盘（下拉项的 React 结构），
    // 用来定位「程序化切换模型」该调哪个回调。只写插件目录下的 probe.json。
    if (url.pathname === '/api/probe') {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
            if (raw.length > 4 * 1024 * 1024) req.destroy();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(raw || '{}');
                const file = path.join(__dirname, 'probe.json');
                fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
                json(res, 200, { ok: true, file, bytes: raw.length });
            } catch (e) {
                json(res, 400, { error: String((e && e.message) || e) });
            }
        });
        return;
    }

    json(res, 404, { error: 'unknown route' });
});

server.listen(PORT, HOST, () => {
    console.log(`[dual-model] listening on ${HOST}:${PORT}`);
});
