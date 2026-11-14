import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 自测：node plugins_pro/cdp-guard/selftest.mjs
const hook = fileURLToPath(new URL('./hooks/no-cdp.mjs', import.meta.url));

const cases = [
    // 应当拦截
    ['curl 直连端口', 'Bash', { command: 'curl http://127.0.0.1:9333/json/version' }, 'deny'],
    ['localhost 端口', 'Bash', { command: 'curl localhost:9333' }, 'deny'],
    ['node 内联 http', 'Bash', { command: `node -e "require('http').get('http://127.0.0.1:9333/json')"` }, 'deny'],
    ['启动参数', 'Bash', { command: './app.exe --remote-debugging-port=9333' }, 'deny'],
    ['lib/cdp.mjs', 'Bash', { command: 'node lib/cdp.mjs foo' }, 'deny'],
    ['show-trail.mjs', 'Bash', { command: 'node tools/show-trail.mjs 9333' }, 'deny'],
    ['wbpro inject', 'Bash', { command: 'node bin/wbpro.mjs inject' }, 'deny'],
    ['wbpro up 带端口', 'Bash', { command: 'node bin/wbpro.mjs up --port 9333' }, 'deny'],
    ['wbpro up 无端口', 'Bash', { command: 'node bin/wbpro.mjs up' }, 'deny'],
    ['PS 探测端口', 'PowerShell', { command: 'Test-NetConnection -ComputerName 127.0.0.1 -Port 9333' }, 'deny'],
    ['WebFetch 本地端口', 'WebFetch', { url: 'http://127.0.0.1:9333/json/list' }, 'deny'],
    ['devtools 端点', 'Bash', { command: 'websocat ws://127.0.0.1:9333/devtools/page/AB12' }, 'deny'],
    ['IPv6 回环', 'Bash', { command: 'curl http://[::1]:9333/json' }, 'deny'],

    // 应当放行
    ['普通命令', 'Bash', { command: 'node --check lib/cdp-guard/hooks/no-cdp.mjs' }, 'allow'],
    ['wbpro status', 'Bash', { command: 'node bin/wbpro.mjs status' }, 'allow'],
    ['wbpro demo', 'Bash', { command: 'node bin/wbpro.mjs demo' }, 'allow'],
    ['跑测试', 'Bash', { command: 'node --test test/*.mjs' }, 'allow'],
    ['编辑文件（Write）', 'Write', { file_path: 'a.md', content: '端口 9333' }, 'allow'],
    ['其它端口的本地服务', 'Bash', { command: 'curl http://127.0.0.1:8080/health' }, 'allow'],
    ['非 PreToolUse 事件', 'Bash', { command: 'curl http://127.0.0.1:9333' }, 'allow', 'UserPromptSubmit'],
];

let pass = 0;
let fail = 0;

for (const [desc, tool, input, expect, event] of cases) {
    const payload = JSON.stringify({
        hook_event_name: event || 'PreToolUse',
        tool_name: tool,
        tool_input: input,
    });
    const r = spawnSync(process.execPath, [hook], { input: payload, encoding: 'utf8' });
    let decision = 'allow';
    try {
        const out = JSON.parse(r.stdout || '{}');
        decision = out.hookSpecificOutput?.permissionDecision || 'allow';
    } catch {
        decision = 'parse-error';
    }
    const ok = decision === expect;
    if (ok) pass++;
    else fail++;
    console.log(`${ok ? '✓' : '✗'} ${desc.padEnd(24)} ${decision}${ok ? '' : `  (期望 ${expect})`}`);
}

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
