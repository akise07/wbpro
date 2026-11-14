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

function rules(main, worker) {
    return [
        '## 当前处于「主从协作」模式（由 wbpro 注入，优先于一般偏好）',
        `主模型：${main || '当前会话模型'}（负责理解需求、拆计划、验收、汇报）`,
        `工作模型：${worker || '未设置'}（负责实际执行）`,
        '',
        '- 需要改文件、跑命令、跨文件或多步执行的活，**必须**用 Agent 工具委派给子代理，主线不要自己动手。',
        '  调用 Agent 时不传 model（系统会强制使用工作模型）。',
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
            logLine(`  input.model=${ev?.tool_input?.model || '-'}`);
            if (/^(agent|task)$/i.test(tool)) writePhase('working', { tool });
            if (/^(agent|task)$/i.test(tool) && worker) {
                const input = ev.tool_input && typeof ev.tool_input === 'object' ? ev.tool_input : {};
                if (input.model === worker) {
                    emit({});
                    return;
                }
                logLine(`  → 强制 model=${worker}`);
                emit({
                    hookSpecificOutput: {
                        hookEventName: 'PreToolUse',
                        updatedInput: { ...input, model: worker },
                    },
                });
                return;
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
