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

/** 中文职责 → 英文名。只用于展示，不需要覆盖全部场景。 */
const CN_ROLE = [
    [/svg|插画|绘图|图标/i, 'svg-writer'],
    [/样式|css|布局|配色|主题/i, 'css-fixer'],
    [/页面|前端|组件|界面|ui/i, 'frontend-dev'],
    [/接口|后端|服务|api|数据库/i, 'backend-dev'],
    [/测试|用例|回归|验证/i, 'tester'],
    [/文档|说明|readme|注释/i, 'docs-writer'],
    [/重构|拆分|整理|清理/i, 'refactorer'],
    [/调研|搜索|查找|分析|排查/i, 'researcher'],
    [/脚本|命令|批处理|部署/i, 'scripter'],
    [/文案|翻译|写作|内容/i, 'writer'],
];

function autoName(input) {
    const raw = String(input.description || '').trim();

    // 描述里含中文：直接走职责映射，比从「SVG」这种零星英文词里抽更准确
    if (/[\u4e00-\u9fff]/.test(raw)) {
        const mapped = CN_ROLE.find(([re]) => re.test(raw));
        if (mapped) return mapped[1];
    }

    // 纯英文（或中文没命中）：抽英文词
    const words = raw
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/[\s-]+/)
        .filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
    if (words.length >= 2) return words.slice(0, 2).join('-');
    if (words.length === 1) return words[0];

    // 中文没命中映射：再试一次映射（兜底），最后用 subagent_type
    const mapped = CN_ROLE.find(([re]) => re.test(raw));
    if (mapped) return mapped[1];
    const type = String(input.subagent_type || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    return type || 'worker';
}

/**
 * 附加到子代理 prompt 末尾的「执行者约定」。
 *
 * 为什么要 hook 强加：光在规则里写「不要自我验收」，模型还是会顺手在委派指令里
 * 加一句「完成后确认是否满足要求」，子代理于是自己跑完、自己判定通过，主模型只当传声筒。
 * 这条约定直接改 tool_input.prompt，子代理必然读到，不依赖主模型自觉。
 */
const EXECUTOR_MARKER = '【执行者约定 · wbpro 自动附加】';

function executorContract() {
    return [
        '',
        '---',
        EXECUTOR_MARKER,
        '你只负责执行上面的任务，**不负责验收**：',
        '- 不要自我验收，不要下「已满足需求 / 确认无误 / 全部通过」这类结论，也不要替用户判断是否达成目的。',
        '- 严格按任务书逐项完成；任务书没覆盖到的决策，选最保守的做法，并在汇报里单独标出。',
        '- 只改任务书范围内的文件，不要顺手重构或改无关代码。',
        '- 完成后只汇报这五项，不要写客套话：',
        '  ① 实际做了什么（对应任务书第几条）',
        '  ② 产出物的绝对路径',
        '  ③ 执行过的关键命令与输出摘要',
        '  ④ 没做 / 做不了的项及原因',
        '  ⑤ 需要主模型判断或决策的问题',
        '- 验收由主模型完成，你的汇报不需要也不应该给出「通过 / 合格」的结论。',
    ].join('\n');
}

function rules(main, worker) {
    return [
        '## 当前处于「主从协作」模式（由 wbpro 注入，优先于一般偏好）',
        `主模型：${main || '当前会话模型'}（拆需求、写任务书、验收、汇报）`,
        `工作模型：${worker || '未设置'}（只执行，不验收）`,
        '',
        '### 职责边界（硬约束）',
        '- **子代理只负责执行，验收由你（主模型）自己做。**',
        '  绝不要在委派指令里写「完成后自行确认 / 验证是否满足要求 / 确认无误」这类话，',
        '  也不要让子代理「做完并验收」一口气跑通——它跑完只会自己宣布通过，你就变成了传声筒。',
        '- **不要把用户的原始需求原话直接转给子代理。** 你必须先拆解，写成一份任务书再委派。',
        '- 子代理返回后，**你必须亲自验收**：读产出物、跑命令、对照原始需求逐条核对，再下结论。',
        '',
        '### 任务书必须写详细（缺一项就补上再发）',
        '1. **目标**：这一步要达成的具体结果，一句话且可判定。',
        '2. **背景**：为什么要做、上下文、和哪些既有功能相关。',
        '3. **具体位置**：涉及的文件的**绝对路径**（新建就写目标路径），不要只说「相关文件」。',
        '4. **具体改动**：要做成什么样，越具体越好——结构、字段名、函数签名、样式值、文案原文。',
        '5. **输入 / 输出**：数据从哪来、产出成什么格式、给谁用。',
        '6. **技术约束**：用什么库与版本、代码风格、必须兼容什么、不能引入什么依赖。',
        '7. **边界**：明确「不要做什么」，防止它越界改别的文件或顺手重构。',
        '8. **交付物**：完成后应当存在哪些文件，用什么命令可以复现或看到效果。',
        '',
        '反例（太粗，会被子代理自由发挥）：「帮我优化一下这个页面」。',
        '正例：「把 H:/x/index.html 里第 3 节的卡片布局从纵向改为两列网格，',
        '断点 768px 以下回落单列；只改 .card-grid 相关样式，不要动 JS 和文案。」',
        '',
        '### 委派与复用',
        '- 需要改文件、跑命令、跨文件或多步执行的活，**必须**用 Agent 委派，主线不要自己动手。',
        '  调用 Agent 时不传 model（hook 会强制成工作模型）。',
        '- **每次委派都必须带 `name`**（如 `name: "svg-writer"`、`name: "css-fixer"`）。',
        '  带 name 会被官方识别为「团队成员」，界面自带流式预览框，用户能看到过程；',
        '  不带 name 只是普通子代理，界面上看不到。同一职责复用同一个 name。',
        '- 单条查询、读一个文件、概念解释这类轻活直接答，不用委派。',
        '',
        '### 验收（你自己做，别让子代理代劳）',
        '- 逐条对照任务书的 8 项，不要只看它说「完成了」。',
        '- 用 Read / Bash 亲自确认：文件在不在、内容对不对、命令能不能跑通。',
        '- 不满足就带着**具体缺陷**再派一次（同一个 name），而不是自己接手改。',
        '- 汇报按「计划 → 执行结果 → 验收结论（逐条）」分段，写清哪部分由子代理完成。',
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

                // 3) 给子代理 prompt 末尾追加「执行者约定」：只执行、不自我验收。
                //    主模型有时会在委派指令里写「完成后确认是否满足要求」，
                //    子代理就会自己跑完自己判通过，主模型只剩传声筒。
                //    这段直接改 prompt，子代理必然读到，不依赖主模型自觉。
                const prompt = String(input.prompt || '');
                if (!prompt.includes(EXECUTOR_MARKER)) {
                    patch.prompt = prompt + '\n' + executorContract();
                    changed = true;
                    logLine(`  → 追加执行者约定（原 prompt ${prompt.length} 字符）`);
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
