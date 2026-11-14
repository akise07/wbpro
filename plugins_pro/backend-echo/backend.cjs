// 插件后端进程：由 wbpro 用 WBPRO_PORT 拉起，监听 127.0.0.1。
// 这里的「后端逻辑」跑在独立 Node 进程里，与官方主进程完全隔离，
// 因此官方更新不会影响它。
const http = require('node:http');
const os = require('node:os');

const PORT = Number(process.env.WBPRO_PORT || 0);
const ID = process.env.WBPRO_PLUGIN_ID || 'backend-echo';

const server = http.createServer((req, res) => {
    // 页面来源可能是 file:// 或自定义协议，统一放开 CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, id: ID }));
        return;
    }

    if (url.pathname === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
            JSON.stringify({
                plugin: ID,
                msg: url.searchParams.get('msg') || '',
                pid: process.pid,
                node: process.versions.node,
                host: os.hostname(),
                time: new Date().toISOString(),
            }),
        );
        return;
    }

    res.writeHead(404).end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`listening on 127.0.0.1:${PORT}`);
});
