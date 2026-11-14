#!/usr/bin/env node
/**
 * CDP 守卫：硬拦截模型对 wbpro 调试端口的任何访问。
 *
 * 为什么用 hook 而不是写规则：
 *   规则只是「建议」，模型会打折扣；PreToolUse 返回 permissionDecision:"deny"
 *   是宿主层面的拒绝，工具调用根本不会执行（源码：allowed===false || permissionDecision==="deny"
 *   → decision.outcome = "rejected"）。所以这条限制必须做成 hook。
 *
 * 拦什么：
 *   - 直连端口：127.0.0.1:9333 / localhost:9333 / :9333 的 http、ws 请求
 *   - CDP 协议端点：/json/version、/json/list、/devtools/page/...
 *   - 会附着调试端口的脚本：lib/cdp.mjs、tools/show-trail.mjs、chrome-remote-interface 等
 *   - `--remote-debugging-port` 这类启动参数
 *   - `wbpro inject`（注入器整个流程都走 CDP）
 *
 * 不拦什么（避免把正常运维也堵死）：
 *   - 纯生命周期命令：up / down / status / doctor / demo / hooks / list
 *   - 编辑包含端口号的文档或代码（Write / Edit 不在拦截范围内）
 *
 * 端口从 wbpro.config.json 读，缺省 9333；另支持 WORKBUDDY_REMOTE_DEBUGGING_PORT。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 9333;

/** 从配置里取端口；读不到就用默认值，绝不因为配置异常而放行 */
function resolvePort() {
    const candidates = [
        process.env.WBPRO_CONFIG,
        path.join(process.cwd(), 'wbpro.config.json'),
        path.join(os.homedir(), '.workbuddy', 'plugins_pro', 'dual-model', 'wbpro.config.json'),
    ].filter(Boolean);
    for (const file of candidates) {
        try {
            const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Number.isFinite(Number(cfg.port))) {
                return String(Number(cfg.port));
            }
        } catch {
            /* 下一个 */
        }
    }
    const envPort = Number(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT);
    return String(Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT);
}

/** 生命周期命令：不碰协议，放行。
 *  注意 `up` 故意不在白名单里——它会带着 --remote-debugging-port 拉起实例并注入，
 *  那正是要禁止的动作；需要启动就让用户自己跑 start.bat。 */
const LIFECYCLE = /wbpro(?:\.mjs)?\s+(down|stop|status|doctor|demo|hooks|list|--help|-h)\b/i;

function buildRules(port) {
    const p = port.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
        {
            re: new RegExp(`(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|::1|\\[::1\\])\\s*:\\s*${p}(?!\\d)`, 'i'),
            why: `直连调试端口 ${port}`,
        },
        {
            re: new RegExp(`\\bport\\b[^\\n]{0,20}${p}(?!\\d)`, 'i'),
            why: `显式指定调试端口 ${port}`,
        },
        { re: /--remote-debugging-port/i, why: '--remote-debugging-port 启动参数' },
        { re: /\/json\/(version|list|protocol|new)\b/i, why: 'CDP 协议端点 /json/...' },
        { re: /\/devtools\/(page|browser)\//i, why: 'CDP WebSocket 端点 /devtools/...' },
        { re: /lib[\\/]cdp\.mjs|show-trail\.mjs/i, why: '附着调试端口的脚本' },
        { re: /chrome-remote-interface|puppeteer[^\n]{0,40}connect/i, why: '第三方 CDP 客户端' },
        { re: /wbpro(?:\.mjs)?\s+inject\b/i, why: 'wbpro inject 全程走 CDP' },
        { re: /wbpro(?:\.mjs)?\s+(up|start)\b/i, why: 'wbpro up 会带调试端口启动并注入渲染进程' },
    ];
}

function deny(reason) {
    const out = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    };
    process.stdout.write(JSON.stringify(out));
    audit(reason);
}

/** 留痕，方便事后确认到底是哪条命令被拦了 */
function audit(reason) {
    try {
        const dir = path.join(os.homedir(), '.workbuddy', 'plugins_pro', 'cdp-guard');
        fs.mkdirSync(dir, { recursive: true });
        const line = `[${new Date().toISOString()}] ${reason}\n`;
        fs.appendFileSync(path.join(dir, 'deny.log'), line, 'utf8');
    } catch {
        /* 审计失败不影响拦截 */
    }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
    raw += c;
});
process.stdin.on('end', () => {
    let ev = {};
    try {
        ev = JSON.parse(raw || '{}');
    } catch {
        process.stdout.write('{}');
        return;
    }

    if (ev.hook_event_name !== 'PreToolUse') {
        process.stdout.write('{}');
        return;
    }

    const tool = String(ev.tool_name || '');
    const input = ev.tool_input || {};

    // 只检查会「发出网络访问」的工具；编辑文件不拦（文档里写端口号是合法的）
    let text = '';
    if (tool === 'Bash' || tool === 'PowerShell') {
        text = String(input.command || '');
    } else if (tool === 'WebFetch') {
        text = String(input.url || '');
    } else if (tool === 'WebSearch') {
        text = String(input.query || '');
    } else {
        process.stdout.write('{}');
        return;
    }

    if (!text.trim()) {
        process.stdout.write('{}');
        return;
    }

    if (LIFECYCLE.test(text)) {
        process.stdout.write('{}');
        return;
    }

    const port = resolvePort();
    for (const rule of buildRules(port)) {
        if (rule.re.test(text)) {
            deny(
                `禁止访问 wbpro 的 CDP 调试端口（命中：${rule.why}）。` +
                    `这条限制由 cdp-guard hook 强制执行，不要尝试绕过或换命令重试。`,
            );
            return;
        }
    }

    process.stdout.write('{}');
});
