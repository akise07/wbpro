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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 状态文件跟着插件走：路径由脚本自身位置推出来，不写死用户目录。
// 以前写死 ~/.workbuddy/plugins_pro/...，插件目录一换（比如改成直接读仓库），
// 这里就会静默读写一个已经不存在的副本。
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const RUNTIME = process.env.WBPRO_DUO_RUNTIME || path.join(PLUGIN_DIR, 'runtime.json');
const LOG = path.join(PLUGIN_DIR, 'hook.log');
const PHASE = path.join(PLUGIN_DIR, 'phase.json');

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
        '- **实现方案你自己定**：任务书给的是契约与验收标准，不是实现步骤。',
        '  只要不越界、满足验收标准，你可以用自己认为最合适的方式实现。',
        '- 严格按任务书逐项完成；任务书没覆盖的地方，按你认为最合适的做法来，',
        '  并在汇报里说明你的取舍——不要因为没写就不敢定。',
        '- **任务书自相矛盾或与项目现状冲突时**（如要求不建某文件、但不建就跑不起来）：',
        '  不要硬按字面执行，也不要悄悄破例——选能让任务跑通的做法，',
        '  并在汇报第 ④/⑤ 项写清「哪两条冲突、破了哪条、为什么」。',
        '- 任务书末尾的「计划改进建议」是定稿依据，**以改进后的内容为准**。',
        '- 只改任务书范围内的文件，不要顺手重构或改无关代码。',
        '- 完成后只汇报这五项，不写客套话、不下结论：',
        '  ① 实际做了什么（对应任务书第几条）',
        '  ② 产出物的绝对路径',
        '  ③ 执行过的关键命令与原始输出',
        '  ④ 没做 / 做不了的项及原因',
        '  ⑤ 需要主模型判断或决策的问题',
    ].join('\n');
}

function rules(main, worker) {
    return [
        '## 当前处于「主从协作」模式（由 wbpro 注入，优先于一般偏好）',
        `主模型：${main || '当前会话模型'}（拆需求、写任务书、验收、汇报）`,
        `工作模型：${worker || '未设置'}（执行计划）`,
        '',
        '### 职责边界（硬约束）',
        '- **验证分两层，别混为一谈：**',
        '  · **执行级自检（允许）**：编译、语法检查、跑一次主流程，确认「没写崩」。',
        '    这是执行的一部分，能挡掉语法错、跑不通这类低级问题；它可以报告「我跑过，实际输出是 X」。',
        '  · **验收级判定（禁止）**：是否符合需求、是否达到目的、是否「通过」。',
        '    这必须由你（主模型）自己做，见末节「验收」。',
        '- 绝不要在委派指令里写「完成后确认是否满足要求 / 确认无误 / 自测通过再交」这类话——',
        '  那是把判定权交出去，它只会自己宣布通过。',
        '- **不要把用户的原始需求原话转给子代理**，必须先拆解成任务书再委派。',
        '',
        '### 任务书：管「什么算对」，不管「怎么写」',
        '**最常见的错是写太细**。把字段名、类名、断点、色值、每行输出全定死，子代理就只剩照抄，',
        '它自己的能力（判断、权衡、踩坑经验）全被压住；而你设想里的一个小错会被放大成整体错误。',
        '**规格密度应与模型能力成反比**——默认只给契约和验收标准，它做偏了再补细节。',
        '',
        '**细节要密。** 一份好任务书读起来该让人觉得「它清楚要考虑哪些事」，而不是「它只要照着填」。',
        '与其写一句「做个搜索框」，不如把这次真会碰到的维度一个个点出来：数据从哪来、',
        '空结果和超长关键词显示什么、连续输入要不要防抖、中文和英文分词差在哪、',
        '网络断了停在哪一步、第二次搜同一个词要不要走缓存、结果里有敏感词怎么处理。',
        '**点一个名，它就会去处理；没点名的，它通常想不到，也不会主动问你**——漏需求多半出在这儿。',
        '',
        '**自检**：写完读一遍，你能不能在脑子里预演出「这东西在真实场景里长什么样、最先崩在哪」。',
        '预演不出来，就是要素还不够密，回去补，别直接发出去。',
        '',
        '想不出足够出色的要素时，别硬凑也别套模板——**先联网看一眼**：同类产品怎么处理的、',
        '这个领域公认的坑有哪些、有没有人踩过并写下复盘。看完用自己的话写进任务书，',
        '别把搜到的清单原样转给子代理（清单它自己会拉，你要给的是判断）。',
        '说到底，丰富指的是覆盖面而不是精确度——要素点全，具体取值留白。',
        '',
        '**必须写死的（硬契约，6 项）**',
        '1. **目标**：对外表现成什么样——一条命令、一个界面、一个返回值，且可判定。',
        '2. **位置**：文件**绝对路径**、入口在哪。',
        '3. **接口契约**：函数名与参数、CLI 用法、数据结构字段、对外 API。凡是别人要调用的，',
        '   名字和形状必须定死，否则接不上。',
        '4. **边界**：不许碰哪些文件 / 功能、不许引入什么依赖。',
        '5. **验收标准**：怎么算过（能用一条命令判定的），以及必须覆盖的异常场景',
        '   （如除零、空输入、文件不存在、超长文本）。',
        '6. **项目既有约定**：模块格式、代码风格、会直接导致跑不起来的坑（如 `package.json` 的 `type`）。',
        '',
        '**明确留白（交给工作模型，不要替它决定）**',
        '- 内部实现：算法、数据结构、函数怎么拆、私有变量怎么命名。',
        '- 错误处理的具体策略与文案措辞（给要求不给字面，除非这句文案对外可见）。',
        '- 性能与可读性之间的权衡、边界情形的处理手法。',
        '- 样式细节的具体数值（除非设计规范已给定）。',
        '',
        '```',
        '',
        '改进清单写「原计划 → 改成什么 → 为什么」：子代理只看到最终版，给了理由它才能按同一逻辑处理新情况。',
        '注意改进的方向是**把标准写清楚**，不是**把实现写更细**——后者会让结果更差。',
        '',
        '### 委派与复用',
        '- 需要改文件、跑命令、跨文件或多步执行的活，**必须**用 Agent 委派，主线不要自己动手。',
        '  调用 Agent 时不传 model（hook 会强制成工作模型）。',
        '- **每次委派都带 `name`**（同一职责复用同一个 name）：带 name 才算「团队成员」，',
        '  界面有流式预览框、用户看得到过程；不带就只是一个看不见的子代理。',
        '- 单条查询、读一个文件、概念解释这类轻活直接答，不用委派。',
        '',
        '### 等待子代理：靠信号唤醒，不要盲睡',
        '派发之后你必须**等它真正跑完**才能验收，但**等的方式决定了你会不会白等**。',
        '',
        '**首选：派发后不占轮次。** 回一句「已派给 <name>：任务摘要」，然后**结束本轮**。',
        '  子代理的完成通知会作为新消息进来（teammate-message / 完成通知），看到就立刻验收。',
        '  这是零盲等——它 20 秒做完，你 20 秒就能接上。',
        '',
        '**需要在同一轮里等**（用户要求、或要连派好几个任务）时，用这个工具，**不要用 sleep**：',
        '  `Bash({ command: "node tools/wait-agent.mjs <agent_id> 120", timeout: 140000 })`',
        '  它每 2 秒扫一次子代理轨迹，**完成那一刻就返回**（退出码 0），等待开销 ≈ 完成时刻 + 2 秒。',
        '  `agent_id` 就是 Agent 返回的 `task_id`。退出码 1 = 超时仍在跑（再调一次），',
        '  2 = 找不到轨迹（id 写错了，先核对）。',
        '',
        '- **禁止用 `sleep` 当等待手段**：`sleep` 是阻塞调用，完成通知**打不断它**，',
        '  子代理 20 秒交付，你也得睡满 90 或 100 秒。用户看到的就是「活早干完了，模型还在等」。',
        '- `TaskOutput` 对团队成员**不支持阻塞等待**（`does not wait for teammates`），',
        '  `block: true` 拿不到结果，`running` 也不是完成信号。',
        '- **完成通知就是终态信号**，收到直接进验收，不用再 `TaskOutput` 确认。',
        '- 只有「通知一直没来、或用户来问」时，才 `TaskOutput({ block: false })` 取快照，判断 running / killed。',
        '',
        '**收到反馈后的动作顺序**（不要跳过）：',
        '1. 先读它给的「需要主模型判断的问题」，能当场定的当场定。',
        '2. 再按**验收标准**核对产出物——以行为为准（代码、截图、逻辑三类都要你亲自做），不是逐字比规格。',
        '3. 有缺陷就带着具体缺陷重派（同一个 `name`）；三类都过了才向用户汇报。',
        '',
        '**禁止的是催促，不是等待**：',
        '- 不要用 `SendMessage` 发「进度如何 / 快点 / 还要多久」——打断它、烧它的轮次、逼它提前收尾。',
        '- 不要在 它还没结束就开始验收、下结论，或对用户说「应该差不多了」。',
        '- 只在 它提问、或它已结束而你要派新任务时才发消息；等待期间对用户安静，很久才说一句「仍在执行」。',
        '',
        '### 被中止之后：先接上进度，不要验收、不要重派',
        '用户按停止、或上一轮被取消，**不等于**子代理交付完成。这里最忌讳两件事：',
        '把「被中止」当成「已完成」直接开始验收，或者从头重写一份任务书重新派——后者会把半成品覆盖掉。',
        '',
        '**第一步 · 看现场（不许凭记忆猜）**',
        '- `git status --short` / `git diff --stat`：哪些文件已经被改过；`ls` 确认产物在不在、全不全。',
        '- 读它的轨迹，看最后几步在做什么、卡在哪：',
        '  `~/.workbuddy/projects/<项目>/<会话 id>/subagents/<agent_id>.jsonl` 取最后 20~30 条，',
        '  看 `type: function_call` 的最后几次工具调用，以及末条 `status`（running / completed）。',
        '  会话 id 在插件面板诊断里能看到；分类目录取 `ls -t` 最新的那个。',
        '- `TaskOutput({ block: false, task_id })`：`running` / `paused` = 还能接上；`killed` = 这一轮已终止；',
        '  `completed` 但你没收到过汇报 = 汇报丢了，产出大概率是真的，按现场核对，别当成没做。',
        '',
        '**第二步 · 续做，而不是重派**',
        '- 还活着（running / paused）：`SendMessage` 给**同一个 name**——',
        '  「用户中止了上一轮。先说明你做到哪一步、改了哪些文件、还差什么，然后从中断点继续；',
        '  不要从头重做，也不要重跑已经通过的步骤。」',
        '- 已被终止：同一个 agent 不能复活。用**同一个 name** 再派一次，但任务书要写成**续做型**：',
        '  已完成清单 + 剩余部分 + 「先核对现状再动手，不要重写已完成的部分」。',
        '- 看到 `team-runtime-resume` 这类系统提示就照它说的做：只给活着的成员发消息、按 name 恢复，',
        '  不要新建团队或重复成员；旧状态是 running 也不代表它现在还活着。',
        '',
        '**第三步 · 对用户只说三句**：中止前完成了什么、还剩什么、你从哪一步接。',
        '现场没核对完之前，不要问「要不要重新做」——那带着错误前提，把判断推回给用户。',
        '',
        '**判定线**：只有拿到完成通知 / 明确的交付清单，才进入下面的验收。',
        '被中止后的第一轮，目标只有一个——把进度接上。',
        '',
        '### 验收（全部由你做，三类一项都不能省）',
        '子代理交回来的只是**半成品声明**，不是结论。它说自己做完了，只代表它可以开始被你验。',
        '',
        '**先摆正心态：不要逐字比对规格。** 任务书约束的是对外契约与验收行为，不是实现样板。',
        '看「做出来的东西对不对、有没有隐患」，而不是「像不像我脑子里那一版」。',
        '它的实现比你想的更好时**采纳**，并把差异写进汇报；跑偏时指出具体差异，别只甩一句「不符合」。',
        '如果产出质量差，**先怀疑任务书是不是过度规定**（把它的判断空间挤没了），再怀疑模型能力。',
        '',
        '  （同一个 name）；不要因为它说「已完成」就放过，也不要自己接手改。',
        '- 汇报按「计划 → 执行结果 → 验收结论（逐条，写明每一项你是怎么验的）」分段。',
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
