// 极简 CDP 客户端：只用 Node 内置 http + 全局 WebSocket（Node 22+），无第三方依赖。
import http from 'node:http';

/** GET 一个本地 CDP 接口（必须绕过 http_proxy） */
export function getJson(port, path, timeout = 1500) {
    return new Promise((resolve, reject) => {
        const req = http.get(
            { host: '127.0.0.1', port, path, timeout, headers: { Host: `127.0.0.1:${port}` } },
            (res) => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (raw += c));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(raw));
                    } catch (e) {
                        reject(new Error(`非 JSON 响应: ${raw.slice(0, 120)}`));
                    }
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('CDP 探测超时')));
        req.on('error', reject);
    });
}

/** 列出可附着目标（page / webview / iframe） */
export async function listTargets(port) {
    return getJson(port, '/json/list');
}

/** 轮询等待 CDP 端口就绪 */
export async function waitForCdp(port, { timeoutMs = 60_000, intervalMs = 400 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastErr;
    while (Date.now() < deadline) {
        try {
            const list = await listTargets(port);
            if (Array.isArray(list) && list.length) return list;
        } catch (e) {
            lastErr = e;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`等待 CDP 端口 ${port} 超时：${lastErr?.message ?? '未知原因'}`);
}

/** 选中主窗口目标：优先 index.html 的 page */
export function pickMainTarget(targets) {
    const pages = targets.filter((t) => t.type === 'page');
    const byUrl = pages.find((t) => /renderer\/index\.html/.test(t.url || ''));
    return byUrl || pages[0] || targets[0];
}

/** 等「真正的主窗口」出现：排除启动瞬间的空白页/闪屏，要求连续两次命中 */
export async function waitForMainTarget(port, { timeoutMs = 90_000, intervalMs = 350 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let hits = 0;
    while (Date.now() < deadline) {
        try {
            const list = await listTargets(port);
            const t = pickMainTarget(list);
            const isMain = t && /renderer\/index\.html/.test(t.url || '');
            const hasUrl = t && /^(file|https?|wb-seed):/.test(t.url || '');
            if (t && (isMain || hasUrl)) {
                hits++;
                if (hits >= 2) return t;
            } else {
                hits = 0;
            }
        } catch {
            hits = 0;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error(`等待主窗口就绪超时（端口 ${port}）`);
}

/** 等页面 DOM 真正可用，避免在 React 还没挂载时注入 */
export async function waitForDomReady(client, { timeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < deadline) {
        try {
            last = await client.eval('location.href + "|" + document.readyState + "|" + (document.body ? document.body.childElementCount : -1)');
            const [href, state, count] = String(last).split('|');
            if (state === 'complete' && Number(count) > 3 && !/^(about:blank|chrome:)/.test(href || '')) return true;
        } catch {
            /* 页面可能还在切换上下文 */
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return false;
}

export class CDP {
    #ws = null;
    #seq = 0;
    #pending = new Map();
    #listeners = new Map();
    #closed = false;

    constructor(wsUrl) {
        this.wsUrl = wsUrl;
    }

    static async attach(target) {
        const client = new CDP(target.webSocketDebuggerUrl);
        await client.connect();
        return client;
    }

    get closed() {
        return this.#closed;
    }

    connect() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            this.#ws = ws;
            const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000);
            ws.onopen = () => {
                clearTimeout(timer);
                resolve(this);
            };
            ws.onerror = (e) => {
                clearTimeout(timer);
                reject(new Error(`WebSocket 错误: ${e?.message ?? 'unknown'}`));
            };
            ws.onclose = () => {
                this.#closed = true;
                for (const { reject: rj } of this.#pending.values()) rj(new Error('连接已关闭'));
                this.#pending.clear();
                this.#emit('close', null);
            };
            ws.onmessage = (ev) => {
                let msg;
                try {
                    msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
                } catch {
                    return;
                }
                if (msg.id && this.#pending.has(msg.id)) {
                    const { resolve: ok, reject: rj } = this.#pending.get(msg.id);
                    this.#pending.delete(msg.id);
                    msg.error ? rj(new Error(`${msg.error.message} (${msg.error.code})`)) : ok(msg.result);
                } else if (msg.method) {
                    this.#emit(msg.method, msg.params);
                }
            };
        });
    }

    send(method, params = {}) {
        if (this.#closed) return Promise.reject(new Error('连接已关闭'));
        const id = ++this.#seq;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#ws.send(JSON.stringify({ id, method, params }));
            setTimeout(() => {
                if (this.#pending.has(id)) {
                    this.#pending.delete(id);
                    reject(new Error(`CDP 调用超时: ${method}`));
                }
            }, 15_000);
        });
    }

    /** 在页面执行表达式；awaitPromise 让 async 函数可等待 */
    async eval(expression, { awaitPromise = false } = {}) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise,
            returnByValue: true,
        });
        if (res?.exceptionDetails) {
            const d = res.exceptionDetails;
            throw new Error(d.exception?.description || d.text || '页面执行异常');
        }
        return res?.result?.value;
    }

    on(event, cb) {
        if (!this.#listeners.has(event)) this.#listeners.set(event, new Set());
        this.#listeners.get(event).add(cb);
        return () => this.#listeners.get(event)?.delete(cb);
    }

    #emit(event, payload) {
        for (const cb of this.#listeners.get(event) ?? []) {
            try {
                cb(payload);
            } catch (e) {
                console.error('[wbpro] 事件回调异常', e);
            }
        }
    }

    close() {
        try {
            this.#ws?.close();
        } catch {
            /* ignore */
        }
    }
}
