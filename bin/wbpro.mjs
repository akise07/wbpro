#!/usr/bin/env node
// wbpro —— WorkBuddy 运行时插件读取管理器
// 用法： wbpro up | status | list | doctor | inject
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { listTargets, waitForCdp, pickMainTarget } from '../lib/cdp.mjs';
import { DEFAULT_PLUGINS_DIR, loadPlugins, watchPlugins } from '../lib/registry.mjs';
import { appVersion, electronVersion, exePath, killAll, launch, loadConfig, processCount } from '../lib/launcher.mjs';
import { Injector, attach, loadAndInject } from '../lib/injector.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'up';
const has = (f) => argv.includes(f);
const getOpt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};

const color = (n) => (s) => (process.stdout.isTTY ? `\x1b[${n}m${s}\x1b[0m` : s);
const dim = color(90);
const ok = color(32);
const warn = color(33);
const bad = color(31);
const bold = color(1);

function banner() {
    console.log(bold(`\nwbpro · WorkBuddy 插件读取管理器`));
}

async function cdpAlive(port) {
    try {
        const list = await listTargets(port);
        return Array.isArray(list) && list.length > 0;
    } catch {
        return false;
    }
}

async function cmdDoctor() {
    banner();
    const cfg = loadConfig();
    const checks = [];
    const push = (name, pass, note = '') => checks.push({ name, pass, note });

    push('Node 版本 >= 20.10', Number(process.versions.node.split('.')[0]) >= 20 || process.versions.node >= '20.10', process.versions.node);
    push('全局 WebSocket 可用', typeof WebSocket === 'function', typeof WebSocket);
    push('appRoot 存在', fs.existsSync(cfg.appRoot), cfg.appRoot);
    let exe = '';
    try {
        exe = exePath(cfg.appRoot);
        push('WorkBuddy.exe 存在', true, exe);
    } catch (e) {
        push('WorkBuddy.exe 存在', false, e.message);
    }
    push('插件目录存在', fs.existsSync(cfg.pluginsDir), cfg.pluginsDir);
    push('CDP 端口当前可用', await cdpAlive(cfg.port), `127.0.0.1:${cfg.port}`);
    const count = await processCount();
    push('当前无运行中的实例', count === 0, count === 0 ? '随时可启动' : `WorkBuddy.exe 进程数 ${count}（正常使用中，up 需 --restart）`);

    if (process.env.ELECTRON_RUN_AS_NODE) {
        push('终端可直接启动 EXE', false, `ELECTRON_RUN_AS_NODE=${process.env.ELECTRON_RUN_AS_NODE} 已被启动器自动清除`);
    }

    for (const c of checks) {
        console.log(`  ${c.pass ? ok('OK  ') : warn('WARN')} ${c.name}${c.note ? dim(`  (${c.note})`) : ''}`);
    }
    console.log(dim(`\n  应用版本: ${appVersion(cfg.appRoot)}  |  Electron: ${electronVersion(cfg.appRoot)}  |  插件目录: ${cfg.pluginsDir}`));
}

async function cmdList() {
    banner();
    const cfg = loadConfig();
    const { plugins, errors, missing } = await loadPlugins(cfg.pluginsDir);
    if (missing) {
        console.log(warn(`插件目录不存在：${cfg.pluginsDir}`));
        return;
    }
    console.log(`  目录: ${dim(cfg.pluginsDir)}`);
    if (!plugins.length) console.log(warn('  没有可用插件'));
    for (const p of plugins) {
        const tags = [p.code ? 'UI' : null, p.backendEntry ? 'backend' : null].filter(Boolean).join('+') || '-';
        console.log(`  ${bold(p.id.padEnd(18))} ${p.version.padEnd(8)} ${dim(tags.padEnd(12))} ${p.name}`);
        if (p.description) console.log(`  ${' '.repeat(20)}${dim(p.description)}`);
    }
    for (const e of errors) console.log(bad(`  [跳过] ${e.dir}: ${e.reason}`));
    console.log(dim(`\n  共 ${plugins.length} 个插件，${errors.length} 个错误`));
}

async function cmdStatus() {
    banner();
    const cfg = loadConfig();
    if (!(await cdpAlive(cfg.port))) {
        console.log(warn(`  CDP 未开启（端口 ${cfg.port} 无响应）。请用 ${bold('wbpro up')} 启动 WorkBuddy。`));
        return;
    }
    const { client, target } = await attach(cfg.port);
    try {
        const raw = await client.eval('window.__wbpro ? JSON.stringify(window.__wbpro.status()) : null');
        console.log(`  目标: ${dim((target.title || '').slice(0, 50))} ${dim(target.url || '')}`);
        if (!raw) {
            console.log(warn('  运行中，但未注入插件运行时'));
            return;
        }
        const st = JSON.parse(raw);
        console.log(`  运行时: wbpro ${st.version}  应用版本: ${st.meta?.appVersion ?? '?'}`);
        if (!st.plugins.length) console.log(warn('  没有已激活的插件'));
        for (const p of st.plugins) {
            console.log(`  ${p.error ? bad('FAIL') : ok('LIVE')} ${bold(p.id.padEnd(18))} ${p.version ?? ''} ${p.error ? bad(p.error.slice(0, 80)) : ''}`);
        }
    } finally {
        client.close();
    }
}

async function interactive() {
    const cfg = loadConfig();
    const meta = { appVersion: appVersion(cfg.appRoot), port: cfg.port, startedAt: new Date().toISOString() };
    let backends = null;
    let client = null;
    let injector = null;
    let stopWatch = null;

    const doInject = async (reason) => {
        const { plugins, errors, missing } = await loadPlugins(cfg.pluginsDir);
        if (missing) console.log(warn(`  插件目录不存在，已创建：${cfg.pluginsDir}`));
        for (const e of errors) console.log(bad(`  [跳过] ${e.dir}: ${e.reason}`));
        backends?.stopAll();
        const r = await loadAndInject({ injector, plugins, meta });
        backends = r.backends;
        const live = plugins.filter((p) => typeof p.code === 'string').length;
        console.log(`  ${ok('已注入')} ${live} 个 UI 插件 · ${r.sizeKb} KB · ${dim(reason)}`);
        for (const p of plugins) {
            console.log(`    ${dim('•')} ${bold(p.id)} ${dim('v' + p.version)}${p.backendUrl ? dim(` backend=${p.backendUrl}`) : ''}`);
        }
    };

    const connectLoop = async () => {
        for (;;) {
            try {
                const { client: c } = await attach(cfg.port);
                client = c;
                injector = new Injector(c);
                await doInject('首次注入');
                c.on('close', () => {
                    console.log(warn('\n  页面连接断开，等待重连…（应用重启后会自动重新注入）'));
                    setTimeout(connectLoop, 1200);
                });
                // 页面刷新/跳转后 CDP 连接仍在，但脚本需重注
                c.on('Page.frameNavigated', () => {
                    setTimeout(() => doInject('页面导航后重注').catch(() => {}), 600);
                });
                break;
            } catch (e) {
                await new Promise((r) => setTimeout(r, 1500));
            }
        }
        if (!stopWatch) {
            stopWatch = watchPlugins(cfg.pluginsDir, () => {
                console.log(dim('\n  检测到插件变更，热更新…'));
                doInject('热更新').catch((e) => console.log(bad(`  热更新失败: ${e.message}`)));
            });
        }
    };

    await connectLoop();
    console.log(dim('\n  监听中：Ctrl+C 退出（不会关闭 WorkBuddy）\n'));

    const shutdown = () => {
        stopWatch?.();
        backends?.stopAll();
        client?.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function cmdUp() {
    banner();
    const cfg = loadConfig();
    const port = Number(getOpt('--port', cfg.port));

    if (await cdpAlive(port)) {
        console.log(ok(`  检测到已开启调试端口 ${port} 的实例，直接注入`));
        return interactive();
    }

    const count = await processCount();
    if (count > 0) {
        console.log(warn(`  已有 ${count} 个 WorkBuddy 进程在运行，但没有开启调试端口。`));
        if (!has('--restart')) {
            console.log(`  需要重启才能注入：${bold('wbpro up --restart')}${has('--yes') ? '' : '（会关闭当前会话窗口）'}`);
            return;
        }
        if (!has('--yes')) {
            console.log(bad('  重启会关闭当前 WorkBuddy 窗口，请加 --yes 确认。'));
            return;
        }
        console.log(dim('  正在结束现有进程…'));
        await killAll();
        await new Promise((r) => setTimeout(r, 2500));
    }

    const pid = launch(cfg.appRoot, port);
    console.log(`  ${ok('已启动')} WorkBuddy ${dim('v' + appVersion(cfg.appRoot))} pid=${pid} 调试端口=${port}`);
    console.log(dim('  等待调试端口就绪…'));
    await waitForCdp(port, { timeoutMs: 90_000 });
    console.log(ok('  端口就绪'));
    return interactive();
}

/** 把仓库里自带的示例插件复制到用户插件目录 */
async function cmdDemo() {
    banner();
    const cfg = loadConfig();
    const src = new URL('../plugins_pro/', import.meta.url);
    const srcDir = src.pathname.replace(/^\/([A-Za-z]:)/, '$1');
    fs.mkdirSync(cfg.pluginsDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
        const from = path.join(srcDir, name);
        if (!fs.statSync(from).isDirectory()) continue;
        const to = path.join(cfg.pluginsDir, name);
        fs.cpSync(from, to, { recursive: true });
        console.log(`  ${ok('复制')} ${name} -> ${to}`);
    }
    console.log(dim(`\n  示例插件已就位，执行 wbpro up 启动并注入`));
}

async function main() {
    switch (cmd) {
        case 'up':
            return cmdUp();
        case 'demo':
            return cmdDemo();
        case 'list':
            return cmdList();
        case 'status':
            return cmdStatus();
        case 'doctor':
            return cmdDoctor();
        case 'inject': {
            const cfg = loadConfig();
            if (!(await cdpAlive(cfg.port))) {
                console.log(bad(`  CDP 未开启，先执行 wbpro up`));
                return;
            }
            const { client } = await attach(cfg.port);
            const injector = new Injector(client);
            const { plugins } = await loadPlugins(cfg.pluginsDir);
            const r = await loadAndInject({
                injector,
                plugins,
                meta: { appVersion: appVersion(cfg.appRoot), port: cfg.port, startedAt: new Date().toISOString() },
            });
            console.log(ok(`  已注入 ${plugins.length} 个插件（${r.sizeKb} KB）`));
            client.close();
            r.backends.stopAll();
            return;
        }
        default:
            console.log(`未知命令: ${cmd}\n可用: up | status | list | doctor | inject`);
    }
}

main().catch((e) => {
    console.error(bad(`\n[wbpro] ${e.stack || e.message}`));
    process.exit(1);
});
