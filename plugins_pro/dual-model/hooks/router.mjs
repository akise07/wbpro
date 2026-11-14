#!/usr/bin/env node
/**
 * 主从路由 hook（dual-model 插件）
 *
 * 被 WorkBuddy 的 settings.json → hooks 调用，两种事件：
 *   UserPromptSubmit  → 注入协作规则（只在 duo 开启时）
 *   PreToolUse        → 把 Agent/Task 调用的 model 改成工作模型（强制，不依赖模型自觉）
 *
 * 状态全部从 runtime.json 现读，所以插件面板里改主/工作模型、开关协作，下一次调用即生效。
 * 任何异常都必须 fail-open（输出 {}），绝不能挡住用户对话。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RUNTIME =
    process.env.WBPRO_DUO_RUNTIME ||
    path.join(os.homedir(), '.workbuddy', 'plugins_pro', 'dual-model', 'runtime.json');
const LOG = path.join(os.homedir(), '.workbuddy', 'plugins_pro', 'dual-model', 'hook.log');
const PHASE = path.join(os.homedir(), '.workbuddy', 'plugins_pro', 'dual-model', 'phase.json');

function readCfg() {
    try {
        return JSON.parse(fs.readFileSync(RUNTIME, 'utf8'));
    } catch {
        return {};
    }
}

function logLine(s) {
    try {
        fs.appendFileSync(LOG, `${new Date().toISOString()} ${s}\n`);
    } catch {
        /* 日志失败不影响主流程 */
    }
}

function writePhase(phase, extra) {
    try {
        fs.writeFileSync(PHASE, JSON.stringify({ phase, at: Date.now(), ...(extra || {}) }) + '\n', 'utf8');
    } catch {
        /* ignore */
    }
}

function emit(obj) {
    process.stdout.write(JSON.stringify(obj));
}

/**
 * 给没带 name 的 Agent 调用补一个可读名字。
 *
 * 为什么非要 name：官方在 Agent 工具里对「带 name」的调用走团队成员路径
 * （renderer 类型 team-member-spawned，界面上有流式预览框）；
 * 不带的只是普通子代理，用户看不到过程。
 * name 只用于展示与 SendMessage 寻址，重名会被官方自动加后缀，所以这里不需要保证唯一。
 */
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'use', 'using',
    'task', 'agent', 'run', 'make', 'get', 'set', 'all', 'any', 'not', 'but',
]);

function autoName(input) {
    const raw = String(input.description || '').trim();
    // 从描述里抽英文词
    const words = raw
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/[\s-]+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    if (words.length >= 2) return words.slice(0, 2).join('-');
    if (words.length === 1) return words[0];
    // 中文描述抽不出英文词：用 subagent_type 兜底（比笼统的 worker 有信息量）
    const type = String(input.subagent_type || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (type) return type;
    return 'worker';
}

function rules(main, worker) {
    return [
        '## 当前处于「主从协作」模式（由 wbpro 注入，优先于一般偏好）',
        `主模型：${main || '当前会话模型'}（负责理解需求、拆计划、验收、汇报）`,
        `工作模型：${worker || '未设置'}（负责实际执行）`,
        '',
        '- 需要改文件、跑命令、跨文件或多步执行的活，**必须**用 Agent 工具委派给子代理，主线不要自己动手。',
        '  调用 Agent 时不传 model（系统会强制使用工作模型）。',
        '- **每次委派都必须带 `name` 参数**（如 `name: "file-writer"`、`name: "svg-writer"`）。',
        '  带 name 的 Agent 调用会被官方识别为「团队成员」，界面上自带流式预览框，',
        '  用户能实时看到子代理的思考与工具调用；不带 name 只是个普通子代理，界面上看不到过程。',
        '  name 用能表达职责的短英文名，同一职责复用同一个 name。',
        '- 子代理返回后核对是否满足原始要求；不满足就带更明确的指令再委派一次，而不是自己接手。',
        '- 单条查询、读一个文件、概念解释这类轻活直接答，不用委派。',
        '- 汇报时按「计划 → 执行结果 → 验收结论」分段，并说明哪部分由子代理完成。',
    ].join('\n');
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
    raw += c;
});
process.stdin.on('end', () => {
    try {
        const cfg = readCfg();
        const duo = cfg.duo === true;
        const worker = String(cfg.workerModel || '').trim();
        const main = String(cfg.mainModel || '').trim();

        let ev = {};
        try {
            ev = JSON.parse(raw || '{}');
        } catch {
            /* 非法输入就当空事件 */
        }
        const event = ev.hook_event_name || process.argv[2] || '';
        const tool = String(ev.tool_name || '');

        if (event === 'PreToolUse') logLine(`PreToolUse tool=${tool} duo=${duo}`);

        if (!duo) {
            emit({});
            return;
        }

        if (event === 'UserPromptSubmit') {
            emit({
                hookSpecificOutput: {
                    hookEventName: 'UserPromptSubmit',
                    additionalContext: rules(main, worker),
                },
            });
            return;
        }

        if (event === 'PreToolUse') {
            logLine(`  input.model=${ev?.tool_input?.model || '-'} name=${ev?.tool_input?.name || '-'}`);
            if (/^(agent|task)$/i.test(tool)) writePhase('working', { tool });
            if (/^(agent|task)$/i.test(tool)) {
                const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
                const patch = { ...input };
                let changed = false;

                // 1) 强制工作模型
                if (worker && input.model !== worker) {
                    patch.model = worker;
                    changed = true;
                    logLine(`  → 强制 model=${worker}`);
                }

                // 2) 补 name：带 name 的 Agent 调用会被官方当作「团队成员」，
                //    界面上有流式预览框能看到子代理的思考和工具；不带就只有一张折叠卡片。
                //    主模型偶尔会漏，这里兜一道，保证预览框必然出现。
                if (!String(input.name || '').trim()) {
                    patch.name = autoName(input);
                    changed = true;
                    logLine(`  → 补 name=${patch.name}`);
                }

                if (changed) {
                    emit({
                        hookSpecificOutput: {
                            hookEventName: 'PreToolUse',
                            updatedInput: patch,
                        },
                    });
                    return;
                }
            }
        }

        if (event === 'PostToolUse' && /^(agent|task)$/i.test(tool)) {
            writePhase('planning', { tool });
        }

        emit({});
    } catch (e) {
        logLine(`ERR ${e && e.message ? e.message : e}`);
        emit({});
    }
});
