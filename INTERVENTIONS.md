# WorkBuddy 干预手段总表

> 依据：`re/AGENT_LOOP.md`、`re/HOOKS.md`、`re/REPORT.md`，以及 `cli/dist/codebuddy-lite-wb.mjs` 的实际代码。
> 验证标记：✅ 代码确证 ｜ ⚠️ 部分确证 ｜ ❓ 未实测 ｜ ✗ 明确不可行
> 稳定性：★★★ 官方接口，升级不受影响 ｜ ★★ 半官方，小版本可能变 ｜ ★ 依赖内部实现 ｜ ✗ 改文件，升级覆盖

## 总览

| 层 | 干预什么 | 主要手段 | 稳定性 |
|---|---|---|---|
| 界面层 | 看什么、点什么 | CDP 注入 + preload IPC | ★★ |
| 协议层 | 会话怎么走 | ACP 方法（steer / cancel / 权限响应） | ★★ |
| 工具层 | 工具怎么执行 | Hook（`PreToolUse` / `PostToolUse`） | ★★★ |
| 提示词层 | 模型知道什么 | `CODEBUDDY.md`、skills、hooks 注入 | ★★★ |
| 配置层 | 行为参数 | 环境变量、`settings.json` | ★★ |
| 能力层 | 新增能力 | MCP、skills、subagent | ★★★ |
| 内核层 | 循环本身 | 改 asar | ✗ |

## 1. 界面层（渲染进程）

| 手段 | 能做什么 | 稳定性 | 验证 |
|---|---|---|---|
| CDP 注入 DOM/CSS | 加侧栏入口、面板、主题、改布局 | ★★ | ✅ |
| `wbpro` 插件运行时 | 面板、toast、storage、热更新 | ★★ | ✅ |
| `__wbInvoke(channel, payload)` | 调官方 93 个 IPC 通道，触发原生动作 | ★★ | ⚠️ 通道路由未逐个验证 |
| 读流式事件 | 观察对话内容，据此做反应 | ★★ | ⚠️ 依赖渲染层事件结构 |
| 改输入框 + 模拟发送 | 间接改写用户消息 | ★ | ❓ React 受控组件，需原生 setter |

开启方式：`WORKBUDDY_REMOTE_DEBUGGING_PORT`（源码里的隐藏开关，无生产限制）。

### 1.1 换模型：只能走渲染层，IPC 是空的（5.9.3 实测 + 11-15 二次复验）

| 方式 | 返回 | 实际效果 |
|---|---|---|
| `__wbInvoke('session:setModel', {sessionId, modelId})` | `{success:true}` | ✗ 下一条消息仍用旧模型 |
| `__wbInvoke('session:setModel', sessionId, modelId)`（位置参数） | `{success:true}` | ✗ 同上，**参数形态不是原因** |
| `workbuddyDesktop.setSessionModel(...)` | 不存在 / `unsupported` | ✗ 本版本没有该方法 |
| 点 `.cr-model-selector__list` 里对应项 | React `onSelect` | ✅ 真实切换 |
| **直接调下拉项的 React 回调**（`ModelItem.props.onSelect(option)`） | — | ✅ 真实切换，且不用模拟鼠标事件 |

原因：官方切换完全发生在渲染层 —— 下拉项 onClick → 输入框 store `api.setModel(selection)` →
`onChange` → 发送时 `ensureSessionModelBeforeSend` / `resolveAndSyncSessionModel` 才把模型同步进
ACP 会话；`session:setModel` 只改了主进程里的会话记录，没有通知跑 Agent 的 ACP 连接。
既然发送前用的是 store 的值，那**只有写进 store 才算数**，而 store 只能由 React 回调写。

> **11-15 复验结论**：位置参数形态也试过了，通道回 `{success:true}`，界面文案不变、
> 下一条消息仍用旧模型 —— 所以「IPC 是假的」这条成立，与参数形态无关。
> 之前怀疑的"参数错位"已被排除（`handlers.js` 里确实是 `(sessionId, modelId)`，传位置参数同样无效）。

**怎么找到那个回调**（`plugins_pro/dual-model/probe.json` 实测结构）：

```
div.cr-model-selector__item        →  React props.onClick
  ↑ fiber.return 上溯 3 层
ModelItem                          →  memoizedProps: option / isSelected / onSelect / onToggleThinking …
```

调用顺序（每步都等界面回查，不信返回值）：
`ModelItem.onSelect(option)` → `onSelect()` → `item.props.onClick(事件桩)` → `element.click()`。
事件桩必须提供 `preventDefault` / `stopPropagation`，否则 onClick 内部一调就抛错。

判定成功的唯一标准：`.cr-model-selector__trigger-label` 的文案变成目标模型名
（`aria-label` 同样可用）。验证会话侧还可以看 jsonl 里的 `"model"` 字段
（`~/.workbuddy/projects/<cwd>/<session>.jsonl`）。

### 1.2 按「每次调用」换模型：Agent 工具的 model + PreToolUse（5.9.3 实测）

官方唯一能"这一次调用用别的模型"的入口，是 `Agent`（子代理）工具的入参 `model`：

```
Agent({ description, prompt, subagent_type, model: "deepseek-v4.1-flash" })
```

CLI 侧 `resolveAgentModel(t)` 解析顺序：**env `CODEBUDDY_CODE_SUBAGENT_MODEL` > 调用参数 `model` > agent 定义**。
所以想按次控制，必须**不要**注入那个 env。

配套两条真机验证过的注入通道（都热生效，不用重启）：

| 通道 | 位置 | 用途 | 验证 |
|---|---|---|---|
| 规则文件 | `~/.workbuddy/rules/*.md` | 常驻指令，随会话注入 | 写 `RULE-ALPHA`，模型回复里能原样复述 ✅ |
| Hook | `~/.workbuddy/settings.json` → `hooks.<Event>` | 改工具入参 / 注入上下文 | `UserPromptSubmit` 注入 `HOOK-BETA` 出现在上下文 ✅；`PreToolUse`(matcher=`Agent`) 改写 `model`，日志确认 ✅ |

`settings.json` 的 hook 形状（`matcher` 对 `PreToolUse` 是工具名，`*` 匹配全部）：

```jsonc
{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "*", "hooks": [{ "type": "command", "command": ""node.exe" "...\\router.mjs"", "timeout": 10 }] }],
    "PreToolUse":       [{ "matcher": "Agent", "hooks": [{ "type": "command", "command": "...同上..." }] }]
  }
}
```

`dual-model` 插件就是靠这套做的：`UserPromptSubmit` 注入"执行必须委派"的规则，
`PreToolUse(Agent)` 把 `model` 强改成工作模型，状态从 `runtime.json` 现读，改完下一次调用即生效。

## 2. 协议层（ACP / JSON-RPC）

| 方法 | 能做什么 | 谁能发 | 稳定性 |
|---|---|---|---|
| `session/cancel` | 中止当前 run | 客户端 | ★★★ |
| `session/steer` | 往**正在跑**的 run 里插话，下一 turn 生效 | 客户端 | ★★ |
| `_codebuddy.ai/resolveInterruption` | 代替用户批准/拒绝工具调用 | 客户端 | ★★ |
| `session/set_model` / `set_mode` / `set_config_option` | 换模型、换模式（plan/auto）、改配置 | 客户端 | ★★ |
| `session/new` / `load` / `resume` | 新建、回放历史、恢复运行态 | 客户端 | ★★★ |

限制：这些是「客户端 → CLI」的方向。wbpro 在渲染层，要发这些得先找到主进程对应的 IPC 通道，不是每个都暴露。

## 3. 工具层（Hook，29 个事件）

这一层**权限最大、也最稳**，因为它是官方设计的扩展点。

| 事件 | 能干预什么 | 关键字段 | 稳定性 |
|---|---|---|---|
| `PreToolUse` | 改工具入参 / 拦截 / 强制弹审批 / 放行 | `updatedInput`、`permissionDecision`、`permissionDecisionReason` | ★★★ |
| `PostToolUse` | 改工具结果 / 追加提示 | `updatedToolOutput`、`additionalContext` | ★★★ |
| `PostToolUseFailure` | 工具失败后补救、换策略 | `additionalContext` | ★★★ |
| `UserPromptSubmit` | 改/拦用户输入 | `additionalContext`、`decision: block` | ★★★ |
| `PermissionRequest` / `PermissionDenied` | 观察权限决策、记录、告警 | 只读 + `systemMessage` | ★★★ |
| `Stop` / `SubagentStop` | 阻止结束、要求续跑、改停止原因 | `continue`、`stopReason` | ★★★ |
| `PreCompact` / `PostCompact` | 压缩前后介入 | `systemMessage` | ★★★ |
| `SessionStart` / `SessionEnd` | 会话生命周期钩子 | `additionalContext` | ★★★ |
| `Notification` | 弹窗/空闲/完成时触发外部动作 | 只读 | ★★★ |
| `FileChanged` / `CwdChanged` / `ConfigChange` | 环境变化响应 | 只读 | ★★★ |
| `SubagentStart` / `TeammateIdle` / `TaskCreated` / `TaskCompleted` | 团队与子任务编排 | `additionalContext` | ★★★ |

实现形式三种：

| 形式 | 特点 | 适合 |
|---|---|---|
| `type: "command"` | stdin JSON / stdout JSON，exit 2 = block | 脚本、试验 |
| `type: "http"` | POST 到本地 URL，**失败 fail-open** | 接 wbpro 等外部服务 |
| mod（`hooks/hooks.json`） | 硬化沙箱 JS，只有 `$.fs/process/http/env/store` | 复杂逻辑 |

## 4. 提示词层

| 手段 | 内容 | 生效时机 | 稳定性 |
|---|---|---|---|
| `CODEBUDDY.md`（兼容 `AGENTS.md`） | 项目规则，插在 system-reminder 最前 | 下一个 run | ★★★ |
| 用户级 memory | 跨项目偏好 | 下一个 run | ★★★ |
| 自定义 agent 的 `instructions` | 角色化行为准则 | 该 agent 的每个 run | ★★★ |
| Skill（`SKILL.md`） | 按需加载的专门流程 | 调用时 | ★★★ |
| 斜杠命令 | 模板化 prompt | 触发时 | ★★★ |
| Hook `additionalContext` | 以 `<system-reminder data-role="tool-hint">` 塞进工具结果 | 下一个 turn | ★★★ |
| `session/steer` | 作为用户消息插入 | 下一个 turn | ★★ |

注意：**system prompt 的骨架改不了**（6 段模板 + 24 个拦截器），只能往后追加。

## 5. 配置层（行为参数）

| 配置 | 作用 | 稳定性 |
|---|---|---|
| `CODEBUDDY_CODE_MAX_TURNS` | 主 agent 轮次上限（默认 500） | ★★ |
| `CODEBUDDY_CODE_SUBAGENT_MAX_TURNS` | 子 agent 轮次（默认下限 200） | ★★ |
| `CODEBUDDY_AUTOCOMPACT_PCT_OVERRIDE` | 自动压缩阈值（百分比 1–100，默认 92%） | ★★ |
| `CODEBUDDY_PRE_MESSAGE_COMPACT(_PCT)` | 预压缩开关与阈值 | ★★ |
| `MAX_THINKING_TOKENS` | 思考预算 | ★★ |
| `settings.json: alwaysThinkingEnabled` / `reasoningEffort` | 是否思考、思考强度 | ★★ |
| `settings.json: model` / `theme` / 沙箱 / 自动更新 | 常规偏好 | ★★★ |
| 权限规则、`allowedTools` | 工具白名单与审批策略 | ★★★ |

## 6. 能力层（不是干预，是新增）

| 手段 | 加什么 | 稳定性 |
|---|---|---|
| MCP server | 新工具、新数据源 | ★★★ |
| Skill | 新流程、领域知识 | ★★★ |
| 自定义 agent / subagent | 新角色、并行分工 | ★★★ |
| 斜杠命令 | 新快捷入口 | ★★★ |

## 7. 明确做不到的

| 目标 | 原因 |
|---|---|
| 改 `Runner.run` 的循环决策 | 在 CLI 子进程内，`NODE_OPTIONS` 被黑名单剥离 |
| 在 reasoning token 生成中途插入内容 | 自回归解码，物理上不可能 |
| 改 system prompt 骨架 | 只能追加，不能替换 |
| 改压缩算法本身 | 只能调阈值 |
| 拦截/伪造遥测（`qimei.dll`、`turing-sdk`） | 风控边界，不应触碰 |
| 改主进程内部逻辑 | 需 `--inspect`，Electron fuse 可能已禁，未验证 |

## 8. 破坏性手段（能做，但不建议）

| 手段 | 效果 | 代价 |
|---|---|---|
| 改 `app.asar` / CLI bundle | 什么都能改 | 每次更新被覆盖、签名破坏、要重打补丁 |

## 9. 按需求索引

| 你想要 | 用这个 |
|---|---|
| 让 agent 守某条规矩 | `CODEBUDDY.md` 或 agent `instructions` |
| 拦危险命令 | `PreToolUse` hook + `permissionDecision: "deny"` |
| 悄悄改工具参数 | `PreToolUse` hook + `updatedInput` |
| 给模型补一条事实 | `PostToolUse` + `additionalContext`，或 MCP resource |
| 加一个新工具 | MCP server |
| 加一段固定流程 | Skill |
| 加界面/侧栏/面板 | wbpro CDP 注入 |
| 省 token | 调压缩阈值、精简 `CODEBUDDY.md`、关掉不用的 MCP 工具 |
| 换模型/换模式 | **调下拉项的 React 回调**（`ModelItem.props.onSelect(option)`，见 1.1）或点官方项；`session:setModel` / `setSessionModel` 走 IPC 一律假成功 |
| 跑更久 | `CODEBUDDY_CODE_MAX_TURNS` |
| 中途改变它的方向 | `session/steer` 或 hook `additionalContext` |
