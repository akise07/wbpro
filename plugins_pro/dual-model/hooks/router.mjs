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
        '你只负责执行上面的任务，**验收判定不归你，执行级自检归你**：',
        '- **允许**：语法 / 类型检查、编译、跑一次主流程，确认「没写崩」。',
        '  这是执行的一部分，能挡掉低级错误。跑完只贴**原始输出**，',
        '  不要追加「已确认无误 / 功能正常 / 满足需求」这类结论。',
        '- **不要做**：写测试套件、大范围回归、截图自评、反复重读自己的代码找茬、海量构造边界输入。',
        '  那是主模型的活。',
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
        '- 执行级自检**直接做，不用请示**；但不要提议「要不要我再测一遍」来拖延收尾。',
        '- 主模型不会催你：按自己的节奏做扎实，别为了尽快回话提前收尾；卡住才主动提问。',
    ].join('\n');
}

function rules(main, worker) {
    return [
        '## 当前处于「主从协作」模式（由 wbpro 注入，优先于一般偏好）',
        `主模型：${main || '当前会话模型'}（拆需求、写任务书、验收、汇报）`,
        `工作模型：${worker || '未设置'}（只执行，不验收）`,
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
        '- **不要访问 wbpro 的 CDP 调试端口**：`curl 127.0.0.1:9333`、`lib/cdp.mjs`、`show-trail.mjs`、',
        '  `wbpro inject/up` 都算。cdp-guard hook 会直接拒绝这次调用，换命令重试也没用。',
        '',
        '### 任务书：管「什么算对」，不管「怎么写」',
        '**最常见的错是写太细**。把字段名、类名、断点、色值、每行输出全定死，子代理就只剩照抄，',
        '它自己的能力（判断、权衡、踩坑经验）全被压住；而你设想里的一个小错会被放大成整体错误。',
        '**规格密度应与模型能力成反比**——默认只给契约和验收标准，它做偏了再补细节。',
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
        '**反例（过度规定 = 让它当打字员）**：「在 calc.mjs 第 12 行写 const assertFinite = (v) => {...}，',
        '先判 Number.isFinite，再判 b === 0，错误文案用『除数不能为 0』」。',
        '**正例（给契约与标准）**：「新建 `_t/calc.mjs`（ESM），导出 `add(a,b)`、`divide(a,b)`；',
        '非法参数与除零都要抛可读中文错误；验收：`node calc.mjs divide 1 0` 非零退出且信息能指出原因。',
        '怎么实现你自己定。」',
        '',
        '### 派发前必须先打磨计划（两遍，不许一遍就发）',
        '写完初稿**不要立刻发**。先按下面三步走一遍，再委派：',
        '',
        '**第一遍 · 起草**：按上面 6 项硬契约写出初稿，实现部分留空。',
        '',
        '**第二遍 · 自审**：逐条问自己，把答案写成**改进建议**：',
        '- **我是不是在替它写代码？** 凡是「怎么实现」的句子都删掉，改成要达到的效果。',
        '  我定死的东西，真的对外可见吗（接口名、文件名、输出格式、验收行为）？',
        '  内部实现、命名、算法、文案措辞本该它定，我定死只会降低质量。',
        '- 目标可判定吗？含糊词（优化一下 / 适当 / 合理 / 更好看）都换成可观察行为或验收命令了吗？',
        '- 路径是绝对路径吗？文件真的存在、结构如我所想吗？不确定就先 Read——',
        '  凡我 5 秒能查清的事实，不要让子代理去猜。',
        '- 边界写清了吗？哪些文件 / 功能**不许碰**？',
        '- 验收标准能用一条命令或一次打开就判定吗？异常场景点到了吗？',
        '- 是不是太大了？超过 3 个文件或 2 个不相关模块就拆。',
        '- **任务书内部有没有互相矛盾的约束？**（踩过：要求「用 CommonJS」又「不要建 package.json」，',
        '  但父级是 `type: module`。）下发前核对 `package.json` 的 `type`、`tsconfig`、lint 规则。',
        '',
        '**第三遍 · 定稿**：把改进建议落到任务书里，**并在末尾附改进清单**（写给子代理看的，不是写给你自己）：',
        '',
        '```',
        '## 计划改进建议（主模型自审后追加，执行时以此为准）',
        '1. 原计划「优化卡片布局」→ 改为「两列网格，768px 以下单列」（这是可验收的效果，不是实现步骤）',
        '2. 原计划未指明文件 → 明确为 H:/x/index.html 第 3 节',
        '3. 原计划未限定范围 → 补充：只改 .card-grid 相关样式，不动 JS 与文案',
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
        '- ❌ 用 `SendMessage` 发「进度如何 / 快点 / 还要多久」——打断它、烧它的轮次、逼它提前收尾。',
        '- ❌ 它还没结束就开始验收、下结论，或对用户说「应该差不多了」。',
        '- ❌ 等久了就自己上手干——两边改动会互相覆盖。',
        '- ✅ 只在它提问、或它已结束而你要派新任务时才发消息；等待期间对用户安静，很久才说一句「仍在执行」。',
        '',
        '### 验收（全部由你做，三类一项都不能省）',
        '子代理交回来的只是**半成品声明**，不是结论。它说自己做完了，只代表它可以开始被你验。',
        '',
        '**先摆正心态：不要逐字比对规格。** 任务书约束的是对外契约与验收行为，不是实现样板。',
        '看「做出来的东西对不对、有没有隐患」，而不是「像不像我脑子里那一版」。',
        '它的实现比你想的更好时**采纳**，并把差异写进汇报；跑偏时指出具体差异，别只甩一句「不符合」。',
        '如果产出质量差，**先怀疑任务书是不是过度规定**（把它的判断空间挤没了），再怀疑模型能力。',
        '',
        '**① 代码验证 —— 用 Read 从头读到尾，不要只看片段**',
        '- 契约对不对：导出的名字、参数、返回、CLI 用法、对外字段——这些必须与任务书一致。',
        '- 实现是否自洽：有没有越界改动、顺手重构、TODO / 占位 / 注释掉的死代码 / 调试 log。',
        '- 异常路径：读不到文件、解析失败、空值时是抛有意义的信息，还是静默返回空对象。',
        '- `node --check`、类型检查、lint 只作补充，**语法过 ≠ 逻辑对**，别当验收结论。',
        '',
        '**② 截图验证 —— 凡有界面产出就必须做，不能省**',
        '- 自己启动、自己截图、自己看；不要拿它的描述或它截的图代替。',
        '- 布局（错位 / 溢出 / 遮挡 / 元素重叠）、样式（色值 / 字号 / 间距 / 圆角）、',
        '  响应式（窄屏与宽屏各截一次，确认断点）三项都要看。',
        '- 空数据、超长文本、加载中这些静态截图容易漏的状态，也要看一眼。',
        '',
        '**③ 逻辑验证 —— 自己构造输入跑，别只跑它给的那一条**',
        '- 三类输入：正常值、边界值（空 / 0 / 超长 / 极值）、异常值（缺字段 / 错类型 / 文件不存在）。',
        '- 对照预期逐条比对，含格式（空格、分隔符、换行）；报错路径也试一次，确认信息能指出问题。',
        '- 有数据流或状态变化的，跑一遍完整链路，别只测单个函数。',
        '',
        '- 三类里任何一项没过，就带着**具体缺陷**（哪个文件哪一行、什么现象、期望是什么）再派一次',
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
