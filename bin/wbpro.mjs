#!/usr/bin/env node
// wbpro —— WorkBuddy 运行时插件读取管理器
// 用法： wbpro up | status | list | doctor | inject
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP, listTargets, pickMainTarget, waitForCdp, waitForDomReady, waitForMainTarget } from '../lib/cdp.mjs';
import { DEFAULT_PLUGINS_DIR, loadPlugins, setPluginEnabled, watchPlugins } from '../lib/registry.mjs';
import { appVersion, electronVersion, exePath, killAll, launch, loadConfig, loadPluginEnv, processCount } from '../lib/launcher.mjs';
import { Injector, attach, loadAndInject } from '../lib/injector.mjs';
import { startControl } from '../lib/control.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'up';
const has = (f) => argv.includes(f);
const getOpt = (name, dflt) => {
    const i = argv.indexOf(name);
    return i > -1 && argv[i + 1] ? argv[i + 1] : dflt;
};
const LOG_FILE = path.join(process.cwd(), 'wbpro.log');

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, timeoutMs, intervalMs = 400) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await fn()) return true;
        await sleep(intervalMs);
    }
    return false;
}

/** 是否跑在 WorkBuddy 自己的终端里（此时它属于应用进程树，会被 --restart 一起杀掉） */
function insideAppTree() {
    return !!(process.env.CODEBUDDY_SESSION_ID || process.env.WORKBUDDY_STARTUP_PID || process.env.WORKBUDDY_RESOURCES_PATH);
}

/**
 * 把「重启 + 注入 + 常驻」整件事交给一个独立后台进程，自己退出。
 *
 * 关键点：不能直接 spawn —— 那样它仍是本进程的子进程，会被 taskkill /T 一并杀掉。
 * 改成写一个 .cmd 再用 `cmd /c start` 拉起：发起它的 cmd 立即退出，
 * 新进程变成孤儿（父 PID 已不存在），taskkill 的进程树遍历就抓不到它了。
 */
function handoffDetached({ dry = false } = {}) {
    const args = ['up', '--restart', '--yes', '--phase2'];
    const port = getOpt('--port', null);
    if (port) args.push('--port', String(port));

    if (process.platform !== 'win32') {
        if (dry) return { dry: true, lines: [`${process.execPath} ${process.argv[1]} ${args.join(' ')}`] };
        const out = fs.openSync(LOG_FILE, 'a');
        const childEnv = { ...process.env };
        delete childEnv.NODE_OPTIONS;
        delete childEnv.ELECTRON_RUN_AS_NODE;
        const child = spawn(process.execPath, [process.argv[1], ...args], {
            cwd: process.cwd(),
            env: childEnv,
            detached: true,
            stdio: ['ignore', out, out],
        });
        child.unref();
        return { pid: child.pid };
    }

    const bat = path.join(os.tmpdir(), 'wbpro-restart.cmd');
    const lines = [
        '@echo off',
        // 清掉宿主注入的变量，否则后台 node 会加载 app 的 shim / 进 Node 模式
        'set NODE_OPTIONS=',
        'set ELECTRON_RUN_AS_NODE=',
        `cd /d "${process.cwd()}"`,
        `echo.>>"${LOG_FILE}"`,
        `echo ===== ${new Date().toISOString()} 后台接管重启 >>"${LOG_FILE}"`,
        `"${process.execPath}" "${process.argv[1]}" ${args.join(' ')} >>"${LOG_FILE}" 2>&1`,
    ];

    if (dry) return { dry: true, lines, bat };

    fs.writeFileSync(bat, lines.join('\r\n') + '\r\n', 'utf8');
    const child = spawn('cmd.exe', ['/c', 'start', '', '/b', bat], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    child.unref();
    return { pid: child.pid };
}

function cmdLogs() {
    banner();
    const tail = tailLog(40);
    console.log(tail ? tail : dim('  暂无日志（只有 --restart 后台接管时才写）'));
}

function tailLog(lines = 25) {
    try {
        const all = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
        return all.slice(-lines).join('\n');
    } catch {
        return '';
    }
}

/** 按数值比较点分版本号：字符串比较会把 "20.9.0" 误判为 >= "20.10" */
function versionAtLeast(actual, required) {
    const a = String(actual).split('.').map((n) => parseInt(n, 10) || 0);
    const b = String(required).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        if (x !== y) return x > y;
    }
    return true;
}

async function cmdDoctor() {
    banner();
    const cfg = loadConfig();
    const checks = [];
    const push = (name, pass, note = '') => checks.push({ name, pass, note });

    push('Node 版本 >= 20.10', versionAtLeast(process.versions.node, '20.10'), process.versions.node);
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
        // url 里带 wbSeedToken / accountSnapshot 等凭据，打印到终端或粘进 issue 就是泄露。
        // 只留协议与路径，查询串整体隐去。
        const safeUrl = String(target.url || '').replace(/\?.*$/, '?…');
        console.log(`  目标: ${dim((target.title || '').slice(0, 50))} ${dim(safeUrl)}`);
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
        // 后端进程由 BackendHost 做差分复用，这里不能整体 stopAll
        const r = await loadAndInject({ injector, plugins, meta, backends });
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
                // 先等真正的主窗口，再等 DOM 可用，最后才注入——重启后尤其重要，
                // 否则会注入到闪屏/空白页，表现为「重启路径没有插件」。
                await waitForMainTarget(cfg.port, { timeoutMs: 90_000 });
                const { client: c } = await attach(cfg.port);
                client = c;
                injector = new Injector(c);
                const ready = await waitForDomReady(c, { timeoutMs: 30_000 });
                if (!ready) console.log(warn('  页面 DOM 迟迟未就绪，先注入一次并等待重试'));
                await doInject(ready ? '首次注入' : '提前注入');
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
                console.log(dim(`  等待主窗口… ${e.message}`));
                await sleep(1500);
            }
        }
        if (!stopWatch) {
            stopWatch = watchPlugins(cfg.pluginsDir, () => {
                console.log(dim('\n  检测到插件变更，热更新…'));
                doInject('热更新').catch((e) => console.log(bad(`  热更新失败: ${e.message}`)));
            });
        }
    };

    // 控制服务：给页面里的插件管理器提供列表/启停/热更新能力
    const ctl = await startControl({
        pluginsDir: cfg.pluginsDir,
        getPlugins: async () => {
            const { plugins } = await loadPlugins(cfg.pluginsDir, { includeDisabled: true });
            return plugins.map((p) => ({
                id: p.id,
                name: p.name,
                version: p.version,
                description: p.description,
                enabled: p.enabled,
                system: p.system,
                ui: typeof p.code === 'string',
                backend: !!p.backendEntry,
                dir: p.dir,
            }));
        },
        setEnabled: (id, enabled) => setPluginEnabled(cfg.pluginsDir, id, enabled),
        reload: () => doInject('管理面板触发热更新'),
    });
    meta.controlUrl = ctl.url;
    meta.controlToken = ctl.token;
    console.log(dim(`  控制服务 127.0.0.1:${ctl.port}`));

    await connectLoop();
    console.log(dim('\n  监听中：Ctrl+C 退出（不会关闭 WorkBuddy）\n'));

    const shutdown = () => {
        stopWatch?.();
        backends?.stopAll();
        client?.close();
        ctl.close().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

async function cmdUp() {
    banner();
    installDuoHooks();
    installCdpGuardHook();
    const cfg = loadConfig();
    const port = Number(getOpt('--port', cfg.port));
    const wantRestart = has('--restart');
    const phase2 = has('--phase2');

    // 已经开着调试端口：直接注入（--restart 也走这条路，不重复折腾进程）
    if (await cdpAlive(port)) {
        if (wantRestart) console.log(dim('  调试端口已开启，无需重启，直接注入'));
        else console.log(ok(`  检测到已开启调试端口 ${port} 的实例，直接注入`));
        return interactive();
    }

    const count = await processCount();
    if (count > 0) {
        console.log(warn(`  已有 ${count} 个 WorkBuddy 进程在运行，但没有开启调试端口。`));
        if (!wantRestart) {
            console.log(`  需要重启才能注入：${bold('wbpro up --restart --yes')}（会关闭当前窗口）`);
            return;
        }
        if (!has('--yes')) {
            console.log(bad('  重启会关闭当前 WorkBuddy 窗口，请加 --yes 确认。'));
            return;
        }

        // 关键：在应用自己的终端里跑时，taskkill /T 会把本进程一起杀掉，
        // 导致重启后没人继续注入。此时把整套流程交给独立后台进程。
        if (!phase2 && (has('--detach') || insideAppTree())) {
            const r = handoffDetached({ dry: has('--dry-run') });
            if (r.dry) {
                console.log(dim('  --dry-run：以下命令会被放到后台执行（不实际运行）'));
                for (const l of r.lines) console.log(dim('    ' + l));
                return;
            }
            console.log(`  ${ok('已交给后台进程')} pid=${r.pid}`);
            console.log(dim(`  日志：${LOG_FILE}`));
            console.log(dim('  本窗口可以关闭；后台会完成重启 → 注入 → 常驻。'));
            return;
        }

        console.log(dim('  正在结束现有进程…'));
        await killAll();
        const gone = await waitUntil(async () => (await processCount()) === 0, 30_000);
        if (!gone) console.log(warn('  仍有残留进程，继续尝试启动（可能被单实例锁顶掉）'));
        else console.log(dim('  旧进程已全部退出'));
    }

    // 启动最多试两轮：第一轮被单实例锁顶掉时，再等一会儿重来
    for (let attempt = 1; attempt <= 2; attempt++) {
        const pluginEnv = loadPluginEnv(cfg.pluginsDir);
    const pid = launch(cfg.appRoot, port, pluginEnv);
        console.log(`  ${ok('已启动')} WorkBuddy ${dim('v' + appVersion(cfg.appRoot))} pid=${pid} 调试端口=${port}`);
        console.log(dim('  等待调试端口就绪…'));
        try {
            await waitForCdp(port, { timeoutMs: 60_000 });
            console.log(ok('  端口就绪'));
            break;
        } catch (e) {
            if (attempt === 2) throw e;
            console.log(warn(`  启动未就绪（${e.message}），3 秒后重试一次`));
            await sleep(3000);
        }
    }
    return interactive();
}

/** 把仓库里自带的示例插件复制到用户插件目录。
 *  默认覆盖；--if-missing 时跳过已存在的非系统插件（保护用户改动），
 *  系统插件（plugin-manager）始终同步，避免管理器停留在旧版。 */
/**
 * 把「主从路由」hook 装进 WorkBuddy 的 settings.json。
 * 两个事件都指向同一个脚本，脚本自己读 runtime.json 判断是否处于协作模式：
 *   UserPromptSubmit → 注入协作规则
 *   PreToolUse(Agent) → 把子代理调用的 model 强制改成工作模型
 * 幂等：先删掉自己以前写的条目再插，不会重复堆叠。
 */
const DUO_HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'];

function duoHookCommand() {
    const script = path.join(DEFAULT_PLUGINS_DIR, 'dual-model', 'hooks', 'router.mjs');
    return `"${process.execPath}" "${script}"`;
}

function installDuoHooks({ remove = false } = {}) {
    const file = path.join(os.homedir(), '.workbuddy', 'settings.json');

    // 装之前先确认脚本真的在：否则会往 hooks 里塞一条指向不存在文件的命令，
    // 用户每次提交 prompt 都要白跑一次失败进程。
    const script = path.join(DEFAULT_PLUGINS_DIR, 'dual-model', 'hooks', 'router.mjs');
    if (!remove && !fs.existsSync(script)) {
        console.log(dim(`  跳过 hook 安装：${script} 不存在（先装 dual-model 插件）`));
        return false;
    }

    // 读不到 / 解析失败时绝对不能当成 {} 再写回去——那会把用户整个配置清空。
    // 拿不到可信的现有内容就放弃修改，并明确告知。
    let settings;
    let existed = true;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
        if (e.code === 'ENOENT') {
            existed = false;
            settings = {};
        } else {
            console.log(bad(`  跳过 hook 安装：${path.basename(file)} 无法解析（${e.message}）`));
            console.log(dim('  为避免覆盖你的其它配置，此处不做任何写入。修好该文件后重试。'));
            return false;
        }
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
        console.log(bad(`  跳过 hook 安装：${path.basename(file)} 顶层不是对象`));
        return false;
    }

    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};

    for (const ev of DUO_HOOK_EVENTS) {
        const list = Array.isArray(hooks[ev]) ? hooks[ev] : [];
        const kept = list.filter((g) => {
            const s = JSON.stringify(g);
            return !(s.indexOf('dual-model') > -1 && s.indexOf('router.mjs') > -1);
        });
        if (!remove) {
            kept.push({
                matcher: ev === 'UserPromptSubmit' ? '*' : 'Agent',
                hooks: [{ type: 'command', command: duoHookCommand(), timeout: 10 }],
            });
        }
        if (kept.length) hooks[ev] = kept;
        else delete hooks[ev];
    }
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;

    try {
        writeSettingsFile(file, settings);
    } catch (e) {
        // settings.json 被宿主的文件保护策略覆盖（productSettings: write=ask），
        // 沙箱里拿不到审批就会 EPERM。这里不能抛：一抛整个 demo/up 都中断，
        // 用户只看到一坨堆栈却不知道要做什么。降级为一条可执行的指引。
        console.log(bad(`  无法写入 ${path.basename(file)}（${e.code || e.message}）`));
        console.log(dim('  该文件受宿主保护策略限制，需你本人批准后才能修改。'));
        console.log(dim(`  在你自己的终端执行一次即可：node bin/wbpro.mjs hooks`));
        return false;
    }

    if (remove) console.log(ok(`  已移除主从路由 hook`));
    else if (existed) console.log(ok(`  已安装主从路由 hook → ${path.basename(file)}`));
    else console.log(ok(`  已创建 ${path.basename(file)} 并安装主从路由 hook`));
    return true;
}

/**
 * 写 settings.json：先落临时文件再 rename，避免写一半崩掉留下半截 JSON。
 *
 * Windows 上目标文件被别的进程打开时，rename 会 EPERM/EBUSY（实测 WorkBuddy
 * 运行时可能持有 settings.json）。这种情况不能直接失败——那就永远装不上 hook——
 * 退回就地覆盖：writeFileSync 能写被占用的文件，代价是失去原子性，
 * 但这里写的是纯 JSON、体积很小，风险可接受。
 */
function writeSettingsFile(file, settings) {
    const json = JSON.stringify(settings, null, 2) + '\n';
    // 用唯一名：固定名会和上次失败残留的 tmp 撞车，那个文件可能正被别的进程占着
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, json, 'utf8');
    try {
        fs.renameSync(tmp, file);
        return;
    } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') throw e;
        fs.writeFileSync(file, json, 'utf8');
        try {
            fs.unlinkSync(tmp);
        } catch {
            /* 残留的 tmp 无害，下次用别的名字 */
        }
        console.log(dim(`  提示：${path.basename(file)} 被占用（${e.code}），已改为就地写入`));
    }
}

/**
 * 安装 CDP 守卫 hook：硬拦截模型对调试端口的访问。
 *
 * 为什么必须是 hook 而不是写进规则：规则只是建议，模型会打折扣；
 * PreToolUse 返回 permissionDecision:"deny" 是宿主层面的拒绝，工具根本不会执行。
 *
 * 这个守卫与协作模式无关，装了就一直在，所以单独一条、不跟 duo 的门控绑在一起。
 * 幂等：先删掉含 cdp-guard 的旧条目再插。
 */
const CDP_GUARD_MATCHER = 'Bash|PowerShell|WebFetch|WebSearch';

function cdpGuardCommand() {
    const script = path.join(DEFAULT_PLUGINS_DIR, 'cdp-guard', 'hooks', 'no-cdp.mjs');
    return `"${process.execPath}" "${script}"`;
}

function installCdpGuardHook({ remove = false } = {}) {
    const file = path.join(os.homedir(), '.workbuddy', 'settings.json');
    const script = path.join(DEFAULT_PLUGINS_DIR, 'cdp-guard', 'hooks', 'no-cdp.mjs');

    if (!remove && !fs.existsSync(script)) {
        console.log(dim(`  跳过 CDP 守卫：${script} 不存在（先装 cdp-guard 插件）`));
        return false;
    }

    let settings;
    let existed = true;
    try {
        const raw = fs.readFileSync(file, 'utf8');
        settings = raw.trim() ? JSON.parse(raw) : {};
    } catch (e) {
        if (e.code === 'ENOENT') {
            existed = false;
            settings = {};
        } else {
            console.log(bad(`  跳过 CDP 守卫：${path.basename(file)} 无法解析（${e.message}）`));
            return false;
        }
    }
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
        console.log(bad(`  跳过 CDP 守卫：${path.basename(file)} 顶层不是对象`));
        return false;
    }

    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    const list = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
    const kept = list.filter((g) => JSON.stringify(g).indexOf('cdp-guard') === -1);
    if (!remove) {
        kept.push({
            matcher: CDP_GUARD_MATCHER,
            hooks: [{ type: 'command', command: cdpGuardCommand(), timeout: 10 }],
        });
    }
    if (kept.length) hooks.PreToolUse = kept;
    else delete hooks.PreToolUse;
    if (Object.keys(hooks).length) settings.hooks = hooks;
    else delete settings.hooks;

    try {
        writeSettingsFile(file, settings);
    } catch (e) {
        // settings.json 被宿主的文件保护策略覆盖（productSettings: write=ask），
        // 沙箱里拿不到审批就会 EPERM。这里不能抛：一抛整个 demo/up 都中断，
        // 用户只看到一坨堆栈却不知道要做什么。降级为一条可执行的指引。
        console.log(bad(`  无法写入 ${path.basename(file)}（${e.code || e.message}）`));
        console.log(dim('  该文件受宿主保护策略限制，需你本人批准后才能修改。'));
        console.log(dim(`  在你自己的终端执行一次即可：node bin/wbpro.mjs hooks`));
        return false;
    }

    if (remove) console.log(ok('  已移除 CDP 守卫 hook'));
    else if (existed) console.log(ok(`  已安装 CDP 守卫 hook → ${path.basename(file)}`));
    else console.log(ok(`  已创建 ${path.basename(file)} 并安装 CDP 守卫 hook`));
    return true;
}

async function cmdDemo() {
    banner();
    const cfg = loadConfig();
    const ifMissing = has('--if-missing');
    // 必须用 fileURLToPath：URL.pathname 会把非 ASCII 路径百分号编码，
    // 项目放在中文目录下时 readdir 直接 ENOENT。
    const srcDir = fileURLToPath(new URL('../plugins_pro/', import.meta.url));
    fs.mkdirSync(cfg.pluginsDir, { recursive: true });
    let copied = 0;
    let skipped = 0;
    let dualModelSynced = false;
    for (const name of fs.readdirSync(srcDir)) {
        const from = path.join(srcDir, name);
        if (!fs.statSync(from).isDirectory()) continue;
        const to = path.join(cfg.pluginsDir, name);

        const readVer = (dir) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).version || '0.0.0';
            } catch {
                return null;
            }
        };
        /** 读目标插件里用户自己的 enabled 选择，覆盖时必须保留 */
        const readEnabled = (dir) => {
            try {
                const m = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
                return m.enabled === false ? false : true;
            } catch {
                return null;
            }
        };

        let syncAlways = false;
        try {
            const m = JSON.parse(fs.readFileSync(path.join(from, 'plugin.json'), 'utf8'));
            // 系统插件与随包发布的插件始终同步，避免管理器/示例停留在旧版
            syncAlways = m.system === true || m.managed === true;
        } catch {
            /* 读不到就当普通插件 */
        }

        // 版本不同也强制同步：只靠 managed 标记容易漏（新插件忘了标就一直不更新），
        // 版本号是唯一可靠信号。
        const srcVer = readVer(from);
        const dstVer = fs.existsSync(to) ? readVer(to) : null;
        const outdated = srcVer && srcVer !== dstVer;

        if (ifMissing && fs.existsSync(to) && !syncAlways && !outdated) {
            console.log(`  ${dim('跳过')} ${name}（已存在 v${dstVer || '?'}）`);
            skipped++;
            continue;
        }

        // 覆盖前记住用户的启用状态：否则每次启动都会把手动停用的插件又打开
        const userEnabled = fs.existsSync(to) ? readEnabled(to) : null;

        fs.cpSync(from, to, { recursive: true });

        if (userEnabled === false) {
            const manifestFile = path.join(to, 'plugin.json');
            try {
                const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
                if (m.system !== true) {
                    m.enabled = false;
                    fs.writeFileSync(manifestFile, JSON.stringify(m, null, 2) + '\n', 'utf8');
                }
            } catch {
                /* 清单坏了就跳过，不影响其它插件 */
            }
        }

        if (name === 'dual-model') dualModelSynced = true;
        const why = dstVer === null ? '' : outdated ? `  ${dim(`${dstVer} → ${srcVer}`)}` : '';
        const keep = userEnabled === false ? dim('  （保持停用）') : '';
        console.log(`  ${ok('复制')} ${name}${why}${keep}`);
        copied++;
    }
    if (skipped) console.log(dim(`\n  ${copied} 个已同步，${skipped} 个已存在跳过（--if-missing）`));
    else console.log(dim(`\n  ${copied} 个插件已就位`));
    console.log(dim(`  插件目录：${cfg.pluginsDir}`));
    // 只有真的装了 dual-model 才去动 settings.json
    if (dualModelSynced) installDuoHooks();
    // 守卫与协作模式无关，装了就一直生效；脚本不存在时函数自己会跳过
    installCdpGuardHook();
}

async function main() {
    switch (cmd) {
        case 'up':
            return cmdUp();
        case 'demo':
            return cmdDemo();
        case 'logs':
            return cmdLogs();
        case 'list':
            return cmdList();
        case 'status':
            return cmdStatus();
        case 'doctor':
            return cmdDoctor();
        case 'reload': {
            // 插件改完不想重启应用：让页面里的宿主重新拉一遍 plugins_pro 并热替换
            const cfg = loadConfig();
            if (!(await cdpAlive(cfg.port))) {
                console.log(bad(`  CDP 未开启，先执行 wbpro up`));
                return;
            }
            const target = pickMainTarget(await listTargets(cfg.port));
            const client = await CDP.attach(target);
            try {
                const meta = await client.eval('window.__wbpro && window.__wbpro.meta');
                if (!meta || !meta.controlUrl) {
                    console.log(bad(`  页面里没有 wbpro 宿主，先执行 wbpro up`));
                    return;
                }
                const res = await fetch(`${meta.controlUrl}/api/reload?t=${meta.controlToken}`, { method: 'POST' });
                const body = await res.json().catch(() => ({}));
                if (!body.ok) throw new Error(`控制服务返回 ${res.status}`);
                await sleep(1200);
                const st = await client.eval('window.__wbpro.status()');
                console.log(ok(`  已热更新`));
                for (const p of st?.plugins || []) {
                    console.log(dim(`    ${p.id.padEnd(16)} ${p.version}${p.error ? '  ✗ ' + p.error : ''}`));
                }
            } finally {
                client.close();
            }
            return;
        }
        case 'hooks': {
            banner();
            installDuoHooks({ remove: has('--remove') });
            installCdpGuardHook({ remove: has('--remove') });
            return;
        }
        case 'inject': {
            const cfg = loadConfig();
            if (!(await cdpAlive(cfg.port))) {
                console.log(bad(`  CDP 未开启，先执行 wbpro up`));
                return;
            }
            console.log(ok(`  CDP 已就绪，注入并常驻`));
            return interactive();
        }
        default:
            console.log(`未知命令: ${cmd}\n可用: up | status | list | doctor | reload | hooks | inject`);
    }
}

main().catch((e) => {
    console.error(bad(`\n[wbpro] ${e.stack || e.message}`));
    process.exit(1);
});
