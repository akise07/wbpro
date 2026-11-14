// 插件控制服务：给页面里的插件管理器提供「读列表 / 启停 / 热更新 / 打开目录」能力。
// 只绑 127.0.0.1，并用一次性 token 校验，避免同机其他进程乱调。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function send(res, code, data) {
    const body = JSON.stringify(data);
    res.writeHead(code, { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => {
            raw += c;
            if (raw.length > 1e6) req.destroy();
        });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch {
                resolve({});
            }
        });
    });
}

export function openDir(dir) {
    const cmd = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
        const child = spawn(cmd, [dir], { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return true;
    } catch {
        return false;
    }
}

/**
 * @param {object} opts
 * @param {() => Promise<any[]>} opts.getPlugins 返回含 enabled 标记的完整插件列表
 * @param {(id:string, enabled:boolean) => Promise<void>} opts.setEnabled
 * @param {() => Promise<void>} opts.reload 重新注入
 * @param {string} opts.pluginsDir
 */
export async function startControl({ getPlugins, setEnabled, reload, pluginsDir }) {
    const token = crypto.randomBytes(12).toString('hex');

    const server = http.createServer(async (req, res) => {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, CORS).end();
            return;
        }
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.searchParams.get('t') !== token) {
            send(res, 403, { error: 'token 无效' });
            return;
        }

        try {
            if (url.pathname === '/health') {
                send(res, 200, { ok: true });
                return;
            }
            if (url.pathname === '/api/plugins' && req.method === 'GET') {
                const plugins = await getPlugins();
                send(res, 200, { plugins, dir: pluginsDir });
                return;
            }
            const m = url.pathname.match(/^\/api\/plugins\/([^/]+)\/enabled$/);
            if (m && req.method === 'POST') {
                const body = await readBody(req);
                await setEnabled(decodeURIComponent(m[1]), !!body.enabled);
                // 先回响应，再触发重载（重载会重置页面运行时）
                send(res, 200, { ok: true });
                setTimeout(() => {
                    Promise.resolve(reload()).catch((e) => console.error('[wbpro] 重载失败', e));
                }, 120);
                return;
            }
            if (url.pathname === '/api/reload' && req.method === 'POST') {
                send(res, 200, { ok: true });
                setTimeout(() => {
                    Promise.resolve(reload()).catch((e) => console.error('[wbpro] 重载失败', e));
                }, 120);
                return;
            }
            if (url.pathname === '/api/open-dir' && req.method === 'POST') {
                send(res, 200, { ok: openDir(pluginsDir) });
                return;
            }
            send(res, 404, { error: 'unknown route' });
        } catch (e) {
            send(res, 500, { error: String(e?.message || e) });
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    return {
        port,
        token,
        url: `http://127.0.0.1:${port}`,
        /** 带 token 的完整基址，注入给页面使用 */
        pageUrl: `http://127.0.0.1:${port}`,
        authQuery: `t=${token}`,
        close: () => new Promise((r) => server.close(r)),
    };
}
