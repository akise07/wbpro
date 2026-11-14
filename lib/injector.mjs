// 注入器：附着 CDP、下发脚本、管理插件后端进程。
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { CDP, listTargets, pickMainTarget } from './cdp.mjs';

export async function attach(port) {
    const targets = await listTargets(port);
    const target = pickMainTarget(targets);
    if (!target?.webSocketDebuggerUrl) throw new Error('未找到可附着的页面目标');
    const client = await CDP.attach(target);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    return { client, target };
}

export class Injector {
    constructor(client) {
        this.client = client;
        this.scriptId = null;
    }

    /** 下发 bundle：既注册到导航后自动执行，也立刻在当前页面跑一次 */
    async apply(bundle) {
        if (this.scriptId) {
            try {
                await this.client.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId });
            } catch {
                /* 页面已切换时可能失败，忽略 */
            }
        }
        const res = await this.client.send('Page.addScriptToEvaluateOnNewDocument', { source: bundle });
        this.scriptId = res?.identifier ?? null;
        return this.client.eval(bundle);
    }

    async status() {
        return this.client.eval('window.__wbpro ? JSON.stringify(window.__wbpro.status()) : null');
    }
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const p = srv.address().port;
            srv.close(() => resolve(p));
        });
    });
}

function waitHealth(port, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tick = async () => {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) });
                if (r.ok) return resolve(true);
            } catch {
                /* 还没起来 */
            }
            if (Date.now() > deadline) return reject(new Error(`插件后端 ${port} 启动超时`));
            setTimeout(tick, 250);
        };
        tick();
    });
}

/** 插件后端宿主：每个声明 backend.entry 的插件独立起一个 node 进程 */
export class BackendHost {
    constructor() {
        this.procs = new Map(); // id -> { proc, port, url, sig }
    }

    async start(plugin) {
        if (!plugin.backendEntry) return null;
        const port = await freePort();
        const proc = spawn(process.execPath, [plugin.backendEntry], {
            cwd: plugin.dir,
            env: {
                ...process.env,
                WBPRO_PLUGIN_ID: plugin.id,
                WBPRO_PLUGIN_DIR: plugin.dir,
                WBPRO_PORT: String(port),
                WBPRO_HOST: '127.0.0.1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        proc.stdout.on('data', (b) => process.stdout.write(`[${plugin.id}] ${b}`));
        proc.stderr.on('data', (b) => process.stderr.write(`[${plugin.id}] ${b}`));
        proc.on('exit', (code) => {
            // 主动 kill 造成的退出不算异常
            if (!proc.killed && code !== 0) console.warn(`[wbpro] 插件后端 ${plugin.id} 退出，code=${code}`);
            this.procs.delete(plugin.id);
        });
        // 用不含端口的核心指纹：端口每次启动都变，拿它做比较等于每次都判「变了」
        this.procs.set(plugin.id, { proc, port, url: `http://127.0.0.1:${port}`, sig: plugin.coreSig });
        try {
            await waitHealth(port);
        } catch (e) {
            console.warn(`[wbpro] ${e.message}（插件 ${plugin.id} 的后端可能未实现 /health）`);
        }
        return `http://127.0.0.1:${port}`;
    }

    /**
     * 热更新时只重启「新增 / 代码变了」的后端，其余沿用原进程。
     * 目的是不让没改动的插件被无谓地打断（端口不变，前端也不用重连）。
     */
    async sync(plugins) {
        const wanted = new Map();
        for (const p of plugins) {
            if (p.backendEntry) wanted.set(p.id, p);
        }
        for (const [id, rec] of [...this.procs]) {
            const next = wanted.get(id);
            if (next && next.coreSig === rec.sig) continue;
            try {
                rec.proc.kill();
            } catch {
                /* ignore */
            }
            this.procs.delete(id);
        }
        for (const p of wanted.values()) {
            const rec = this.procs.get(p.id);
            if (rec) {
                p.backendUrl = rec.url;
                continue;
            }
            p.backendUrl = await this.start(p);
        }
    }

    stopAll() {
        for (const { proc } of this.procs.values()) {
            try {
                proc.kill();
            } catch {
                /* ignore */
            }
        }
        this.procs.clear();
    }
}

/** 重新扫描插件目录 → 起后端 → 生成 bundle → 注入 */
export async function loadAndInject({ injector, plugins, meta, backends }) {
    const { pluginSig, pluginCoreSig } = await import('./bundle.mjs');

    // 先算「后端进程指纹」：它不含 backendUrl，只反映代码与清单。
    // 必须赶在 sync 之前算，sync 要靠它判断哪些后端需要重启。
    for (const p of plugins) p.coreSig = pluginCoreSig(p);

    const host = backends || new BackendHost();
    await host.sync(plugins); // 这一步会写入 p.backendUrl

    // 页面侧指纹含 backendUrl，必须在 sync 之后算：
    // 否则和 bundle.mjs 里的口径对不上，带后端的插件每轮都被误判为已变更而重建。
    for (const p of plugins) p.sig = pluginSig(p);

    const { buildBundle } = await import('./bundle.mjs');
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const bootstrapUrl = new URL('../runtime/bootstrap.js', import.meta.url);
    const bootstrap = await fs.readFile(url.fileURLToPath(bootstrapUrl), 'utf8');
    const bundle = buildBundle({ bootstrap, plugins, meta });
    await injector.apply(bundle);
    return { backends: host, sizeKb: Math.round(bundle.length / 1024) };
}

export { path };
