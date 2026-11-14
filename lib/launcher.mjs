// 启动器：清洗环境变量、拉起 WorkBuddy 主程序（带 CDP 端口）、探测运行状态。
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_CONFIG = {
    appRoot: 'D:\\_Program\\WorkBuddy',
    port: 9333,
    pluginsDir: path.join(os.homedir(), '.workbuddy', 'plugins_pro'),
};

export function loadConfig(cwd = process.cwd()) {
    const file = path.join(cwd, 'wbpro.config.json');
    let cfg = {};
    try {
        cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        /* 没有配置文件就用默认 */
    }
    const merged = { ...DEFAULT_CONFIG, ...cfg };
    // 环境变量优先，便于临时切换调试目录
    if (process.env.WBPRO_APP_ROOT) merged.appRoot = process.env.WBPRO_APP_ROOT;
    if (process.env.WBPRO_PLUGINS_DIR) merged.pluginsDir = process.env.WBPRO_PLUGINS_DIR;
    if (process.env.WBPRO_PORT) merged.port = Number(process.env.WBPRO_PORT);
    return merged;
}

/** 应用版本：install-manifest.json 的 appVersion 才是产品版本 */
export function appVersion(appRoot) {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(appRoot, 'resources', 'install-manifest.json'), 'utf8'));
        if (m.appVersion) return m.appVersion;
    } catch {
        /* 落到 version 文件 */
    }
    try {
        return fs.readFileSync(path.join(appRoot, 'version'), 'utf8').trim();
    } catch {
        return 'unknown';
    }
}

/** Electron 版本（version 文件里存的是 Electron 版本号） */
export function electronVersion(appRoot) {
    try {
        return fs.readFileSync(path.join(appRoot, 'version'), 'utf8').trim();
    } catch {
        return 'unknown';
    }
}

export function exePath(appRoot) {
    const candidates = ['WorkBuddy.exe', 'workbuddy.exe'];
    for (const name of candidates) {
        const p = path.join(appRoot, name);
        if (fs.existsSync(p)) return p;
    }
    throw new Error(`未在 ${appRoot} 找到 WorkBuddy.exe，请检查 wbpro.config.json 的 appRoot`);
}

/**
 * 关键：必须清掉宿主（WorkBuddy 的 Agent 终端）注入的环境变量。
 * 尤其是 ELECTRON_RUN_AS_NODE=1，否则 exe 会以纯 Node 模式启动并报 "bad option"。
 */
export function cleanEnv(port) {
    const env = {};
    const dropExact = new Set([
        'ELECTRON_RUN_AS_NODE',
        'NODE_OPTIONS',
        'NODE_PATH',
        'CODEBUDDY_MCP_CONFIG',
        'WORKBUDDY_STARTUP_PID',
        'WORKBUDDY_SESSION_ID',
    ]);
    const dropPrefix = ['CODEBUDDY_', 'ELECTRON_', 'WORKBUDDY_', 'CLIENT_INFO_', 'VITE_', 'NODE_', 'ACC_PRODUCT_CONFIG_'];
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (dropExact.has(k)) continue;
        if (dropPrefix.some((p) => k.startsWith(p))) continue;
        env[k] = v;
    }
    env.WORKBUDDY_REMOTE_DEBUGGING_PORT = String(port);
    return env;
}

function run(file, args) {
    return new Promise((resolve) => {
        execFile(file, args, { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
            resolve({ err, stdout: stdout || '' });
        });
    });
}

/** 统计 WorkBuddy.exe 进程数（含以 Node 模式运行的 CLI 子进程） */
export async function processCount() {
    if (process.platform !== 'win32') {
        const { stdout } = await run('pgrep', ['-f', 'WorkBuddy']);
        return stdout.split('\n').filter(Boolean).length;
    }
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq WorkBuddy.exe', '/FO', 'CSV', '/NH']);
    return stdout.split('\n').filter((l) => /WorkBuddy\.exe/i.test(l)).length;
}

/** 拉起主程序；返回后由调用方轮询 CDP 端口 */
export function launch(appRoot, port) {
    const exe = exePath(appRoot);
    const child = spawn(exe, [], {
        cwd: path.dirname(exe),
        env: cleanEnv(port),
        detached: true,
        stdio: 'ignore',
    });
    child.unref();
    return child.pid;
}

/** 强杀全部 WorkBuddy 进程（含 CLI 子进程），仅在用户显式确认后调用 */
export async function killAll() {
    await run('taskkill', ['/IM', 'WorkBuddy.exe', '/T', '/F']);
}
