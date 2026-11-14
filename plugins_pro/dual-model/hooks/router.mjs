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
        '你只负责执行上面的任务，**验证一律不归你管**：',
        '- **不要做任何验证性动作**：不要写测试或测试脚本、不要跑回归、不要截图自评、',
        '  不要逐行审自己的代码、不要自己构造边界输入去试探，也不要说「已确认无误 / 功能正常 / 满足需求」。',
        '  代码验证、截图验证、逻辑验证**全部由主模型接手**，它会在你交付后自己查。',
        '- **唯一允许执行命令的情况，是这条命令本身就是任务要求的产出动作**',
        '  （例如任务书要求「运行后应打印四行」）。跑完把**原始输出原样贴出**即可，',
        '  不要在此基础上追加通过与否的判断，也不要为了「再确认一遍」多跑一轮。',
        '- 汇报只陈述事实：做了什么、产物在哪、命令原始输出、没做的项、需要裁决的问题。',
        '  不要给出「通过 / 合格 / 没问题」这类结论，也不要替用户判断是否达成目的。',
        '- 严格按任务书逐项完成；任务书没覆盖到的决策，选最保守的做法，并在汇报里单独标出。',
        '- **如果发现任务书自相矛盾或与项目现状冲突**（比如要求不建某文件、但不建就跑不起来），',
        '  不要硬按字面执行，也不要悄悄破例：选能让任务真正跑通的做法，',
        '  然后在汇报第 ④/⑤ 项里写清「哪两条冲突、我破了哪条、为什么」。',
        '- 若任务书末尾附有「计划改进建议」，那是主模型自审后的定稿依据：',
        '  **以改进后的内容为准**（它可能修正了前面的表述），并理解改动意图，',
        '  遇到同类情况按同样逻辑处理，不要机械照抄旧版描述。',
        '- 只改任务书范围内的文件，不要顺手重构或改无关代码。',
        '- 完成后只汇报这五项，不要写客套话：',
        '  ① 实际做了什么（对应任务书第几条）',
        '  ② 产出物的绝对路径',
        '  ③ 执行过的关键命令与输出摘要',
        '  ④ 没做 / 做不了的项及原因',
        '  ⑤ 需要主模型判断或决策的问题',
        '- 不要主动提议「要不要我再测一下 / 再截个图确认」，也不要请求授权去做验证；',
        '  主模型要验的时候会自己来，你只要把手上的活做完、把事实说清。',
        '- 主模型在等你，但它不会催你：按自己的节奏把活做扎实，不要为了「尽快回话」而提前收尾。',
        '  如果中途确实卡住或需要它决策，才主动提问；否则一次做完再汇报。',
    ].join('\n');
}

function rules(main, worker) {
    return [
        '## 当前处于「主从协作」模式（由 wbpro 注入，优先于一般偏好）',
        `主模型：${main || '当前会话模型'}（拆需求、写任务书、验收、汇报）`,
        `工作模型：${worker || '未设置'}（只执行，不验收）`,
        '',
        '### 职责边界（硬约束）',
        '- **分工：子代理只执行，验证 100% 由你（主模型）做。** 验证包含三类，缺一不可：',
        '  ① **代码验证**：逐行读它写的代码，看结构、边界、异常路径、风格是否符合任务书；',
        '  ② **截图验证**：凡有界面产出（页面、样式、组件、图表），你必须自己启动、自己截图、亲眼看，',
        '     不要凭代码推断「应该显示正常」，更不能拿它截的图或它的描述当结论；',
        '  ③ **逻辑验证**：自己构造输入跑一遍（正常值、边界值、异常值），对照预期逐条比对。',
        '- 绝不要在委派指令里写「完成后自行确认 / 验证是否满足要求 / 截图确认 / 确认无误」这类话，',
        '  也不要让子代理「做完并自测通过」一口气跑通——它跑完只会自己宣布通过，你就变成了传声筒。',
        '- **不要把用户的原始需求原话直接转给子代理。** 你必须先拆解，写成一份任务书再委派。',
        '- 子代理返回后，**你必须亲自验收**：读代码、看截图、跑逻辑，对照原始需求逐条核对，再下结论。',
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
        '### 派发前必须先打磨计划（两遍，不许一遍就发）',
        '写完初稿**不要立刻发**。先按下面三步走一遍，再委派：',
        '',
        '**第一遍 · 起草**：按上面 8 项写出初稿。',
        '',
        '**第二遍 · 自审**：逐条问自己下面这些问题，把答案写成**改进建议**：',
        '- 目标够不够可判定？子代理做完后，我能不能一眼看出成没成？',
        '- 有没有含糊词（优化一下 / 适当 / 合理 / 更好看）？每个都要换成具体值或具体行为。',
        '- 文件路径是否绝对路径？我是否确认过这些文件真的存在、结构是我以为的那样？',
        '  不确定就先 Read 一下再写，别让子代理去猜。',
        '- 「具体改动」里，子代理还需要自己拿主意的点有几个？每多一个就多一分跑偏风险，',
        '  能定下来的现在就定死（字段名、类名、断点、颜色值、文案原文）。',
        '- 边界写清楚了吗？哪些文件/功能是**不许碰**的？',
        '- 交付物定位清楚吗？我事后能不能用一条命令或一次打开就看到效果、并据此自己验收？',
        '  注意：这里要的是「我能验」，**不是**「让它自查」——别顺手在任务书里写「完成后自行验证」。',
        '- 这一步是否太大？超过 3 个文件或 2 个不相关模块，就拆成两次委派。',
        '- 依赖是否齐备？需要的前置产物是否已存在？没有就先补前置。',
        '- **任务书内部有没有互相矛盾的约束？**（实测踩过：要求「用 CommonJS」又要求「不要建',
        '  package.json」，但父级 package.json 是 `type: module`，两条不可能同时满足。）',
        '  下发前先核对项目既有配置：`package.json` 的 `type`、`tsconfig`、lint 规则、既有目录约定。',
        '  有冲突就先解掉——要么改约束，要么明确允许子代理破哪一条。',
        '- 我有没有让子代理「自己去查」某个本来我 5 秒就能确认的事实？能先查的就先查。',
        '',
        '**第三遍 · 定稿**：把改进建议落到任务书里，形成最终版，**并在提示词末尾附上改进清单**：',
        '',
        '```',
        '## 计划改进建议（主模型自审后追加，执行时以此为准）',
        '1. 原计划「优化卡片布局」→ 改为「.card-grid 从纵向改两列，768px 以下单列」',
        '2. 原计划未指明文件 → 明确为 H:/x/index.html 第 3 节',
        '3. 原计划未限定范围 → 补充：不要动 JS 与文案',
        '```',
        '',
        '为什么要把改进清单也写进提示词：子代理看到的是**最终版**，它无从知道哪里改过、',
        '为什么改。把「原计划 → 改成什么 → 为什么」一并给出，它才能理解边界，',
        '遇到相似情况时按同一逻辑判断，而不是机械照做。',
        '',
        '### 委派与复用',
        '- 需要改文件、跑命令、跨文件或多步执行的活，**必须**用 Agent 委派，主线不要自己动手。',
        '  调用 Agent 时不传 model（hook 会强制成工作模型）。',
        '- **每次委派都必须带 `name`**（如 `name: "svg-writer"`、`name: "css-fixer"`）。',
        '  带 name 会被官方识别为「团队成员」，界面自带流式预览框，用户能看到过程；',
        '  不带 name 只是普通子代理，界面上看不到。同一职责复用同一个 name。',
        '- 单条查询、读一个文件、概念解释这类轻活直接答，不用委派。',
        '',
        '### 等待子代理：轮询到完成，但绝不催',
        '派发之后你必须**等它真正跑完**，然后才能验收和汇报。这是硬要求，不许提前收工。',
        '',
        '**等待方式（实测结论，别用错）**：',
        '- 带 `name` 派发的是「团队成员」，`TaskOutput` 对它们**不支持阻塞等待**——',
        '  会直接返回 `TaskOutput does not wait for teammates`，那不是完成信号。',
        '  所以不要指望 `block: true` 一调就拿到结果。',
        '- 正确做法：**分段给等待窗口**，而不是密集短轮询，也不要一次睡太久。',
        '  默认 `Bash({ command: "sleep 90", timeout: 110000 })`，一轮轮过去；',
        '  只有任务明显要跑很久（改十几个文件、跑构建/测试）才用 `sleep 300`。',
        '  注意 Bash 默认超时只有 2 分钟，`sleep` 必须显式传 `timeout`（比 sleep 多 20 秒左右），',
        '  否则会被默认值掐断、变成自动转后台，等待就没意义了。',
        '- **为什么不要一睡 5 分钟（实测踩过）**：`sleep` 是阻塞调用，子代理的完成通知',
        '  **无法打断它**，消息只会排在这轮结束后才浮出来。所以 `sleep 300` 意味着',
        '  「哪怕它 20 秒就干完了，你也要盲等满 5 分钟」，用户会看到你明明活已交付还在傻等。',
        '  分段窗口才能让完成通知尽快被你看到。',
        '- **等待期间收到子代理的完成通知，立刻停下手上的等待动作，转为分析它的反馈。**',
        '  完成通知（teammate-message / 完成通知）就是终态信号，不需要再去 `TaskOutput` 确认一遍。',
        '- 只有「窗口睡完仍无通知」时，才用 `TaskOutput({ task_id, block: false })` 取一次快照，',
        '  确认它是还在跑还是已经异常退出（`killed` / 报错），据此决定继续等还是重派。',
        '',
        '**收到反馈后的动作顺序**（不要跳过）：',
        '1. 先读它给的「需要主模型判断的问题」，能当场定的当场定。',
        '2. 再按任务书逐条核对产出物——**代码、截图、逻辑三类都要你亲自做**，不看它的自述。',
        '3. 有缺陷就带着具体缺陷重派（同一个 `name`）；三类都过了才向用户汇报。',
        '',
        '**禁止的是催促子代理本身，不是等待**：',
        '- ❌ 不要用 `SendMessage` 给还在跑的子代理发「进度如何 / 快点 / 还要多久 / 请确认」这类消息。',
        '  每发一条都会打断它的工作节奏、消耗它的轮次，甚至让它提前收尾。',
        '- ❌ 不要在子代理还没结束时就开始验收、下结论或向用户汇报「应该差不多了」。',
        '- ❌ 不要因为等得久就自己上手把活干了——那会让两边的改动互相覆盖。',
        '- ✅ 子代理只在两种情况下才需要你发消息：它主动提问、或它已结束而你要派新任务。',
        '- ✅ 等待期间对用户保持安静；确实很久（超过数分钟）才简短说明「仍在执行」，不要反复刷进度。',
        '',
        '### 验收（全部由你做，三类一项都不能省）',
        '子代理交回来的只是**半成品声明**，不是结论。它说自己做完了，只代表它可以开始被你验。',
        '',
        '**① 代码验证 —— 用 Read 从头读到尾，不要只看片段**',
        '- 结构是否符合任务书：函数签名、字段名、类名、文案原文对不对。',
        '- 异常路径有没有处理：读不到文件、解析失败、空值时是抛有意义的信息，还是静默返回空对象。',
        '- 有没有越界改动：任务书范围外的文件动没动、有没有顺手重构。',
        '- 有没有留 TODO / 占位 / 注释掉的死代码 / 调试用的 console.log。',
        '- 风格是否与项目一致（缩进、引号、分号、命名）。',
        '- 可以跑 `node --check`、类型检查、lint 作为补充，但**语法通过不等于逻辑正确**，别当验收结论。',
        '',
        '**② 截图验证 —— 凡有界面产出就必须做，不能省**',
        '- 自己启动服务或打开文件，**自己截图、自己看**；不要拿子代理的描述或它截的图代替。',
        '- 看布局：有没有错位、溢出、遮挡、留白异常、元素重叠。',
        '- 看样式：颜色、字号、间距、圆角、阴影是否与任务书一致。',
        '- 看响应式：至少在窄屏与宽屏两个宽度各截一次，确认断点行为正确。',
        '- 看状态：空数据、超长文本、加载中，这些静态截图容易漏的情况也要试。',
        '',
        '**③ 逻辑验证 —— 自己构造输入跑，别只跑它给的那一条**',
        '- 至少三类输入：正常值、边界值（空、0、超长、极值）、异常值（缺字段、错类型、文件不存在）。',
        '- 对照任务书里的预期输出逐条比对，包括格式（冒号后是否有空格、分隔符、换行）。',
        '- 报错路径也要试一次：确认错误信息能指出问题，而不是抛 `undefined` 或静默成功。',
        '- 涉及数据流或状态变化的，跑一遍完整链路，不要只测单个函数。',
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
