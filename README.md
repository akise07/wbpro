# wbpro · WorkBuddy 运行时插件管理器

给官方 WorkBuddy 加一层**不写入任何官方文件**的插件系统：插件放在 `~/.workbuddy/plugins_pro/<插件名>/`，能改界面、能跑自己的后端进程，**官方升级后不用重新打包**。

---

## 1. 为什么是这个方案

改 WorkBuddy 有三条路，差别很大：

| 方案 | 能改什么 | 升级后 | 风险 | 结论 |
|---|---|---|---|---|
| 改 `app.asar` | 什么都能改 | **被覆盖**，需重打补丁 | 破坏签名/完整性校验，一处升级全废 | 不推荐 |
| 官方插件体系（`plugins/` + marketplace） | 只能加 skills / commands / agents / hooks / MCP | 可以 | 无 | **互补，但改不了 UI** |
| **CDP 运行时注入**（本方案） | UI、DOM、CSS、IPC 调用、独立后端 | **自动继续可用** | 低（不动文件） | ✅ 采用 |

关键依据来自逆向：`main/index.js` 里有一段隐藏开关——

```
WORKBUDDY_REMOTE_DEBUGGING_PORT=9333   →  自动 appendSwitch('remote-debugging-port', 9333)
```

它没有任何生产环境限制。只要用这个环境变量启动，官方就把整个渲染进程的调试通道打开，我们通过 CDP 把代码注入进去。**文件一个字节都不用动**，所以升级只是换了个新版本，注入逻辑照旧。

## 2. 工作原理

```
wbpro up
  ├─ 清洗环境变量（清掉 ELECTRON_RUN_AS_NODE 等）
  ├─ 启动 WorkBuddy.exe，带 WORKBUDDY_REMOTE_DEBUGGING_PORT
  ├─ 轮询 127.0.0.1:<port>/json/list 直到渲染进程就绪
  ├─ 选中主窗口 target，建立 WebSocket（CDP）
  ├─ 读 ~/.workbuddy/plugins_pro/*/plugin.json
  ├─ 为有 backend 的插件拉起独立 Node 进程（分配空闲端口）
  ├─ 把「运行时 + 全部插件源码」拼成一个 bundle，Runtime.evaluate 注入
  └─ 常驻：监听插件目录变化热更新、页面刷新后自动重注、应用重启后自动重连
```

注入的代码跑在页面主世界（main world），所以能直接操作 DOM，也能用官方暴露的 `window.__wbInvoke` 调用任意 IPC 通道。

## 3. 快速开始

```bash
cd wbpro

node bin/wbpro.mjs doctor     # 环境体检
node bin/wbpro.mjs demo       # 把示例插件复制到 ~/.workbuddy/plugins_pro
node bin/wbpro.mjs up         # 启动 WorkBuddy 并注入（用这个方式启动才有插件）
node bin/wbpro.mjs reload     # 改了插件不想重启应用：热替换一遍
node bin/wbpro.mjs status     # 查看已激活插件
node bin/wbpro.mjs list       # 列出插件目录
```

**或者直接双击 `start.bat`**：自动定位 Node → 同步随包插件 → 带调试端口启动 → 注入 → 常驻（窗口开着别关）。

`start.bat` 里的同步用的是 `demo --if-missing`：标记了 `system: true`（插件管理器）或 `managed: true`（随包示例）的插件**每次都会覆盖更新**，你自己建的插件目录不会被碰。覆盖时会**保留你在管理面板里的启用/停用选择**，不会因为重启又被悄悄打开。

已经开着 WorkBuddy 时：

```bash
node bin/wbpro.mjs up --restart --yes    # 关掉当前窗口重开，会话不丢但窗口会重启
```

`--restart` 的行为（重点）：

| 情况 | 实际动作 |
|---|---|
| 调试端口已开 | 不折腾进程，直接注入 |
| 在**普通终端**里执行 | 结束进程 → 等它们真的退干净 → 启动 → 等主窗口和 DOM 就绪 → 注入 → 常驻 |
| 在 **WorkBuddy 自带终端**里执行 | 自动把整套流程交给独立后台进程（`cmd /c start` 方式脱离进程树），本窗口可关闭，日志写 `wbpro/` 下的 `wbpro.log` |

为什么要交接：`taskkill /T` 会顺父进程链一起杀，而 wbpro 跑在应用终端里时就在那棵树上，不交接的话「重启完就没人注入了」，表现就是你觉得 `--restart` 没有 `up` 的功能。

相关开关：

```bash
node bin/wbpro.mjs up --restart --yes --dry-run   # 只打印将要执行的后台命令，不动进程
node bin/wbpro.mjs up --restart --yes --detach    # 强制走后台接管
node bin/wbpro.mjs logs                           # 查看后台日志尾部
```

**把桌面快捷方式指向 `wbpro up`** 之后，日常就等于「带插件的 WorkBuddy」。用原快捷方式启动则是一个纯净的官方实例。

## 4. 目录结构

```
wbpro/
├─ bin/wbpro.mjs            CLI：up / status / list / doctor / demo / inject
├─ lib/
│  ├─ cdp.mjs               CDP 客户端（无第三方依赖，Node 22 内置 WebSocket）
│  ├─ launcher.mjs          环境清洗 + 启动 + 进程探测
│  ├─ registry.mjs          插件目录扫描
│  ├─ bundle.mjs            运行时与插件拼装
│  └─ injector.mjs          注入 + 后端进程托管
├─ runtime/bootstrap.js     注入到页面的插件宿主（UI/存储/IPC API）
└─ plugins_pro/             示例插件（运行时会复制到用户目录）
   ├─ plugin-manager/       内置：左侧栏「插件管理」入口 + 列表/启停/热更新
   ├─ hello-panel/          浮动面板 + 宿主信息
   ├─ dusk-theme/           整屏色调切换（暮色/冷夜/护眼/去色）
   └─ backend-echo/         自带 Node 后端进程
```

## 5. 插件格式

```
~/.workbuddy/plugins_pro/我的插件/
├─ plugin.json
├─ renderer.js      （可选）注入到页面的 UI 逻辑
└─ backend.cjs      （可选）独立后端进程
```

`plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "一句话说明",
  "renderer": "renderer.js",
  "backend": { "entry": "backend.cjs" },
  "permissions": ["ui.panel", "ipc.invoke"],
  "contributes": { "panel": { "position": "top-right" } }
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | ✅ | 唯一标识，建议小写中划线 |
| `renderer` | 可选 | UI 入口；缺省时自动找 `renderer.js` |
| `rendererIncludes` | 可选 | 额外要内联的文件数组，按顺序拼在入口之前（见下） |
| `backend.entry` | 可选 | 后端入口；缺省时自动探测 `backend.cjs` / `backend.mjs` / `backend.js` |
| `enabled` | 可选 | 设为 `false` 可临时停用 |
| `contributes.panel.position` | 可选 | `top-right` / `top-left` / `bottom-right` / `bottom-left` |

`renderer.js` 约定：定义 `activate(ctx)`，返回值作为卸载函数。

**多文件插件**：bundle 是把整个 renderer 当函数体注入的，插件里没有 `require` / `module`，
所以拆文件不能靠模块系统。用 `rendererIncludes` 声明额外文件，读取阶段会按顺序拼到入口之前：

```json
{
  "renderer": "renderer.js",
  "rendererIncludes": ["subagent-panel.js"]
}
```

被包含的文件可以直接写 `window.xxx = {...}` 暴露给入口用（`dual-model` 就是这么拆出子代理面板的）。

```js
function activate(ctx) {
  ctx.ui.css('::selection{background:rgba(127,119,221,.4)}');

  const p = ctx.ui.panel({
    title: '我的面板',
    position: 'top-right',
    render(body) {
      const btn = document.createElement('button');
      btn.textContent = '点我';
      btn.onclick = async () => {
        const info = await ctx.ipc.invoke('some:channel');   // 调官方 IPC
        ctx.ui.toast('拿到 ' + JSON.stringify(info).slice(0, 40));
      };
      body.appendChild(btn);
    },
  });

  return () => p.remove();      // 卸载
}
```

## 6. 可用 API（`ctx`）

| 命名空间 | 方法 | 说明 |
|---|---|---|
| `ctx.ui` | `panel({title, render, position, css, closable, onClose, persist})` | 浮动面板，Shadow DOM 隔离样式，可拖动；`onClose` 在面板销毁时回调；`persist: true` 让面板在热重载后存活（复用同一节点） |
| | `css(text)` | 注入全局样式，卸载时自动移除 |
| | `toast(msg, ms)` | 轻提示 |
| | `observe(fn, opts)` | MutationObserver 封装，用来嗅探界面结构 |
| | `waitFor(selector, timeout)` | 等某节点出现，做「挂到官方的某个按钮旁边」 |
| `ctx.ipc` | `invoke(channel, ...args)` | 走官方 `__wbInvoke` 桥，可调 93 个已注册通道 |
| | `on(channel, cb)` | 订阅主进程推送 |
| `ctx.storage` | `get(k, dflt)` / `set(k, v)` | 按插件命名空间隔离 |
| `ctx.backend` | `baseUrl` / `fetch(p, init)` / `json(p)` | 访问插件自己的后端进程 |
| `ctx.control` | `list()` / `toggle(id, enabled)` / `reload()` / `openDir()` | 调用 wbpro 控制服务（插件管理器用的就是它） |
| `ctx.control` | `configGet(id)` / `configSet(id, cfg)` | 读写插件目录下的 `runtime.json`，Node 侧也能读同一份 |
| `ctx` | `app` | 宿主信息：应用版本、调试端口、注入时间 |
| | `log(...)` | 带插件前缀的日志 |
| | `onCleanup(fn)` | 注册卸载回调 |

## 7. 内置插件管理器

`plugin-manager` 是系统插件（`"system": true`，不可被停用，否则会失去重新启用的入口）。它做两件事：

**1）在左侧栏注入入口**

不硬编码类名，而是找到文字为「更多」（或 `More`）的叶子节点 → 向上找到那一行 → **克隆整行** → 把图标换成拼图、文字换成「插件管理」、去掉 active 状态 → 插在原行后面。因为克隆的是官方节点，样式、间距、hover 效果全部自动继承，官方改主题也不用跟着改。

React 重渲染会把节点冲掉，所以每 1.2s 检查一次 `isConnected`，掉了就补回去。

**2）管理面板**

点入口打开面板，**再点一次关闭**（入口本身是开关，打开时会有淡紫色高亮）；面板右上角 × 也能关。面板显示：插件名 / 版本 / id / 标签（UI、后端）/ 描述 + 启用开关；底部有「热更新」和「打开插件目录」。面板开着时每 4s 拉一次列表，外部改动也能看到。

开关走的是 wbpro 的控制服务，不是直接改内存：

```
GET  /api/plugins                   → { plugins: [...], dir }
POST /api/plugins/:id/enabled       → 写回该插件 plugin.json 的 enabled，然后热重载
POST /api/reload                    → 全量重新注入
POST /api/open-dir                  → 资源管理器打开插件目录
```

控制服务只绑 `127.0.0.1`，每次启动生成随机 token，注入页面时带上 `?t=<token>`，同机其他进程拿到端口也调不动。

**热更新是差分的**：`enabled:false` 的插件在扫描阶段就被跳过（源码都不进 bundle）；重新注入时 `__mount` 会先按 `sig` 比对每个插件（`sig` = 代码 + 清单 + 后端地址的 sha1 前 12 位），

| 情况 | 行为 |
|---|---|
| 插件消失（被停用/删除） | 执行 `cleanup`，销毁它的面板与样式 |
| `sig` 变了 | 卸载旧的，用新代码重新 `activate` |
| `sig` 相同 | **原样保留**：不重跑代码、不动它的面板 DOM、不动它的样式 |

所以开关某个插件时，插件管理器本身（代码没变）根本不会被重建，面板不闪、入口不闪、滚动位置也不丢。默认行为就是「谁变了才动谁」。

**为什么管理器面板不会消失**：面板声明了 `persist: true`。插件被停用时 `__reset` 会保留这类面板、标记为未认领，若下一轮没人认领则由 `reclaimPanels()` 回收。插件仍在时反过来走「保留」路径，连复用都用不上——节点压根没被碰过。

注意：`persist` 面板不会被自动加进卸载队列，插件自己的 `cleanup` 里也不要 `remove()` 它，否则又会「关了打不开」。

## 7.5 双模型协同（`dual-model`）

主模型负责决策与验收，工作模型负责执行，界面上实时显示当前阶段由谁负责。

**它是一个「档位」，不是开关**：模型选择器顶部多出一项 `⇄ 主从模型`（克隆官方行，样式自动继承）。选中后它就像官方模型一样成为**当前档位**——

| 位置 | 选中「主从模型」后 |
|---|---|
| 输入框上方触发器 | 标签变成 `⇄ 主从模型`（图标也换），提示里带 `主 xxx / 工 xxx` |
| 下拉列表 | 勾选落在「主从模型」上，真实模型那一项的勾选隐藏（用 `html.wbpro-duo-mode` 下的 CSS） |
| 再次点它 | 什么都不做（等同点已选中的模型），不会关掉 |
| 点别的模型 | 立刻切回那个模型，协作档位退出、状态条移除 |

关闭路径只有两条：选别的模型，或在面板里点「关闭」。

**状态显示在对话流里**，不是面板：`.cr-message-list` 内注入一条 `position: sticky; bottom: 8px` 的胶囊，内容随阶段变化——

| 阶段 | 状态条 |
|---|---|
| 决策 | `● 主模型 Hy4 · 决策 / 验收`（紫点） |
| 执行 | `● 工作模型 xxx · 执行中`（绿点） |
| 待命 | `● 主从协作 · 待命`（灰点） |

点击状态条直接打开设置面板。React 重渲染会把它冲掉，所以有 2s 兜底补挂；插件卸载时会一并清掉下拉项与状态条。

**为什么用克隆而不是写死样式**：官方选项行的类名是 `cr-model-selector__item` 这类语义类，但内部结构（图标 SVG、倍率、角标、勾选）随时可能变。克隆第一行再替换文字/图标，能跟着官方一起变；`.cr-model-selector__list` 找不到时自动跳过，不影响其它功能。

**两个模型走的是两条完全不同的通道**，这是关键：

| 角色 | 通道 | 生效时机 |
|---|---|---|
| 主模型 | **点官方模型下拉项**（渲染层 store → `onChange`） | 下一次发送时同步给 ACP 会话 |
| 工作模型 | **hook 改写 `Agent` 工具入参的 `model`**（`PreToolUse.updatedInput`） | 每一次子代理调用，改完即生效 |

**主模型为什么不能走 IPC**（5.9.3 实测）：`__wbInvoke('session:setModel', {sessionId, modelId})` 会老老实实返回 `{success:true}`，
但下一条消息仍然是旧模型——它只改了主进程里的会话记录，没通知真正跑 Agent 的 ACP 连接。官方切换完全在渲染层：
下拉项 `onClick` → 输入框 store `api.setModel(selection)` → `onChange` → 发送前 `ensureSessionModelBeforeSend` 才同步进会话。
所以插件改成「展开下拉 → 点在那个真实档位上」，点完用触发器的 `aria-label`（`Select model: xxx`）复核，
没变就报错，不再假成功。

**工作模型为什么不走环境变量**：CLI 的 `resolveAgentModel()` 是 **env 优先于调用参数**——
`CODEBUDDY_CODE_SUBAGENT_MODEL` 一旦注入，`Agent` 工具里的 `model` 就被忽略，改模型还得重启。
所以 `loadPluginEnv()` 故意不再注入它，改由 `plugins_pro/dual-model/hooks/router.mjs` 在每次
`PreToolUse`（matcher=`Agent`）里读 `runtime.json`，用 `updatedInput` 把 `model` 强制改成工作模型。
好处：面板里改完工作模型，**下一次委派直接生效**，不用重启。

同一个 hook 还在 `UserPromptSubmit` 里注入协作规则（只在协作档位开启时），所以不用再手工往
`CODEBUDDY.md` 里粘规则。hook 装在 `~/.workbuddy/settings.json` 的 `hooks` 字段，由 `wbpro up` /
`demo` 自动安装（`node bin/wbpro.mjs hooks` 手动装，`hooks --remove` 卸掉）。

**使用流程**

1. 点右下角浮标 → 面板（或直接在模型下拉里选「主从模型」）
2. 选主模型、工作模型、执行轮次 → 保存
3. 打开模型下拉，最上面就是「⇄ 主从模型」档位——选中它，当前会话会立刻切到主模型（顶部触发器显示「主从模型」，真实模型名藏在下面）
4. 之后对话里：主线调用走主模型，凡是委派给子代理的执行步骤自动走工作模型；对话流胶囊显示当前阶段
5. 想换模型：主模型直接在下拉里点，工作模型在面板里改——都是下一次调用生效

> 从旧版升级：如果之前被注入过 `CODEBUDDY_CODE_SUBAGENT_MODEL`（旧版 `wbpro` 会设），
> 需要重启一次应用把 env 清掉，之后才能享受"改完即生效"。

想换回普通档位：下拉里点任意真实模型即可退出协作（会把标签交还给 React，不会卡在「主从模型」）。

## 7.6 子代理轨迹面板（`dual-model` v0.8.0）

主从协作的实际执行发生在子代理里，而**普通 `Agent` 调用在官方 UI 里看不到过程**：只渲染一个折叠卡片。
点右下角浮标上方的「子代理轨迹」，能看到每个子代理的思考、工具调用和返回结果。

### 前提：委派时必须带 `name`

官方对 `Agent` 工具做了两条分支，**只差一个 `name` 参数**：

| 调用形态 | 官方行为 | 界面上能看到 |
|---|---|---|
| `Agent({ description, prompt })` | 普通子代理 | 一个折叠卡片，看不到过程 |
| `Agent({ name, description, prompt })` | **团队成员**（`team-member-spawned`） | **自带流式预览框**，实时显示思考与工具调用 |

带 `name` 时官方会自动建团队（`~/.workbuddy/teams/_auto_<会话ID>/`），
CLI 提示原话：*"Named Agent() auto-creates a team if none exists — do not call TeamCreate first."*
所以**不需要**先 `TeamCreate`，也不用 `run_in_background`。

界面上的 DOM 特征（可用来验证是否生效）：

```
.conversation-team-collaboration              ← 那个「N 位团队成员」面板
.conversation-team-collaboration--streaming   ← 流式中
.conversation-team-collaboration__member      ← 每个成员一行
.conversation-team-collaboration__status--completed
```

`dual-model` 的 hook 做了两层保证：

1. `UserPromptSubmit` 注入规则，要求主模型每次委派都带 `name`（用职责英文名）；
2. `PreToolUse(Agent)` 兜底——**主模型漏了 name 就自动补一个**（从 description 抽英文词，
   抽不到就用 `subagent_type`），保证预览框必然出现。

关键是：**两种调用都会把轨迹写进同一个 `subagents/agent-*.jsonl`**，
所以官方预览框和我们自己的轨迹面板可以并存，互不冲突。

### 为什么轨迹面板必须读文件（而不是订阅事件）

先试过事件流，走不通，实测数据：

| 通道 | 结果 |
|---|---|
| `session:event` | **0 条**（wbpro 早期订阅的就是这条，一直没数据） |
| `wb:event` | 有流量，但 `childAgentEvent` 只带生命周期 |

`childAgentEvent` 的真实载荷：

```json
{ "event": "listChanged",
  "snapshot": { "kind": "subagent", "projectionId": "subagent:call_xxx",
                "requests": [], "requestsIncluded": false, "state": "running" } }
```

`requestsIncluded: false` 是明确的信号：官方**故意**不在事件里带内容。渲染层要另调
`childAgentRequests(conversationId, projectionId, page)` 去拉，但那个方法挂在按会话实例创建的桥接对象上，
插件拿不到。`__wbInvoke('childAgentRequests')` 直接返回 `No handler`。

**但数据一直都在**，CLI 会把子代理的完整轨迹独立落盘：

```
~/.workbuddy/projects/<编码cwd>/<会话ID>/subagents/agent-<uuid>.jsonl
```

一个真实文件的类型分布（183 行）：`reasoning` 35、`function_call` 67、`function_call_result` 66、`message` 15。
每条都带 `providerData.isSubAgent: true`、`agent` 名、`model`、`stepSeq`。

### 实现

```
dual-model/
├─ backend.cjs          读 jsonl，提供 /api/subagents 与 /api/subagent
├─ subagent-panel.js    面板 UI（通过 rendererIncludes 内联）
└─ renderer.js          加一个「子代理轨迹」按钮，挂面板
```

后端做三件事：

1. **定位会话**。见下方「会话定位」。
2. **解析 jsonl**。文件可能正在被写入，最后一行常是不完整的，逐行 `try/catch` 容错。
3. **去重思考**。同一 step 的多个工具调用会重复携带同一段 `providerData.reasoning`，
   按 step 记录指纹，只保留第一次。

#### 会话定位：必须认准 `data-root-id`，不能猜

页面里**没有**现成的 sessionId 变量：`location.hash` 是空的，`workbuddyDesktop` 上也没有，
React 把它存在内部 store 里拿不到。所以只能从 DOM 反推，而这里有个陷阱：

| 选择器 | 能用吗 | 原因 |
|---|---|---|
| `.cr-message-list-viewport [data-root-id]` | ✅ 用这个 | 官方 `DocumentRenderer` 标记当前文档根，值就是会话 ID，**全局唯一**，切会话时跟着变 |
| `[data-conversation-id]` | ❌ | 侧边栏**每个列表项**都有，拿到的是任意一个，不是当前打开的 |
| 目录 mtime 最新的会话 | ❌ | 同时开两个会话时，另一个正在跑的那个才是最新写入的，会指错会话 |

后两种做法在单会话时看起来都对，一旦多开就会串——面板显示的是别的会话的子代理，
用户会以为是数据错乱。所以后端的规则是：

- 前端传了 `sessionId` → **必须精确命中**，找不到直接 404 报错，绝不静默回退到别的会话；
- 只有完全没传（老前端 / 手动调接口）才走 mtime 兜底，且响应里带 `guessed: true` 提示。

面板每轮轮询都会重新读 `data-root-id`，发现会话变了就清掉展开状态并提示「会话已切换」，
避免把上一个会话的子代理详情留在面板里。

两个坑：

- `reasoning` 记录的正文在 `rawContent` 里，是 `[{type:'reasoning_text', text}]` **数组**，
  不是字符串。直接当字符串用会渲染出 `[object Object]`。
- cwd 编码规则是 `H:/a/b` → `h-a-b`（盘符小写、冒号去掉）。**先去掉冒号再替换分隔符**，
  否则会得到 `h--a-b`（多一个横杠）。

### 界面

点「子代理轨迹」→ 面板列出当前会话所有子代理（运行中的有绿点），点开看时间线：

```
任务：<委派给子代理的 prompt>
思考 · step 1 · deepseek-v4.1-flash
  <思考正文>
Bash  21:09:55
  echo "all-channel-4"
结果 · Bash · completed
  Stdout: all-channel-4
```

面板每 1.5s 轮询，运行中的子代理会实时增长。重绘前比对签名，内容没变就不动 DOM，所以滚动位置不会被打断。

### 前提

- 必须用 `wbpro up` / `wbpro inject` 启动（后端进程由它托管）。
  **`wbpro reload` 单独跑不管用** —— 它是独立进程，通过控制服务触发重注入，
  如果那个常驻的 wbpro 已经不在了，它仍会打印「已热更新」，但后端不会起来。
- 后端只绑 `127.0.0.1`，端口每次启动随机分配。

**模型列表从哪来（与官方选择器同源，不是自己筛的）**：官方渲染层是 `normalizeProductModels()` → `selectTeamsModelsByCliAgent()`，规则是

1. 候选池 = 产品配置的 `models`；
2. 若配置里有非空 `availableModels` → 只保留其中的 id（`custom-local:` 前缀会先剥掉再比对）；
3. 若 `agents[]` 里 `name === "cli"` 且带 `models` 数组 → **以它为白名单和顺序**。这就是官方下拉框里「快速 / 均衡 / 极致 / Hy3 …」那十几个的来源，当前配置是 19 个；
4. 再并上用户自己的自定义模型（`custom-local:*` / `tags` 含 `custom`），官方在策略允许时同样会列出它们；
5. `modelPromotions` / `modelTiers` 提供倍率角标（限时免费、夜间折扣、订阅优先）。

插件完全照这五步实现，所以下拉框顺序、倍率、角标与官方一致；面板顶部显示「模型来源：运行时 · 官方列表 25 / 66 个」（25 = 19 官方 + 6 自定义，66 = 配置里的模型总数）。

取不到宿主配置时退回内置表，内置表也换成了同一份 19 个的官方白名单，不再是早期那份手工整理、已经过时的 43 个。

取数入口有个坑（实测 5.9.3）：`workbuddyDesktop` 上**没有** `config.getProductConfiguration`，`workbuddyDesktop.invoke(...)` 也不认这个命令（会报 `Unsupported desktop command`）。唯一可用的是泛化桥：

```js
await window.__wbInvoke('config:getProductConfiguration')   // → { models: 66, agents: 20, modelPromotions, modelTiers, ... }
```

插件优先用这条通道；万一某个版本把它挂成了对象方法，也会退回去试 `findFns` 找到的候选，所以两种形态都能取到。

上游链路是 `GET /v3/config`

**保存为什么不会失败**：配置写两处——页面里的 `localStorage`（永远可写）和插件目录的 `runtime.json`（由控制服务写，Node 侧读它注入环境变量）。控制服务没起来时（没跑 `wbpro up`），保存照样成功，只是提示「已保存到本地」，并记一个 pending 标记；下次 `up` 起来后自动补写。所以不会再出现 `保存失败: Failed to fetch`。

**这两个前提必须满足**，否则功能会降级：

| 能力 | 依赖 | 没有时会怎样 |
|---|---|---|
| 写 `runtime.json`（工作模型环境变量） | `wbpro up` 在跑 | 只存本地，补齐后自动同步 |
| 热更新（改文件后自动重注入） | `wbpro up` 在跑 | 需要手动 `wbpro inject` 或重启 |
| 主模型切换 | `__wbInvoke('session:setModel', ...)` | 通道只回 `{success:true}`、不回模型 id，因此面板显示「已请求切换，以界面为准」 |

**配置存放**：`~/.workbuddy/plugins_pro/dual-model/runtime.json`。页面侧通过控制服务的 `/api/config/dual-model` 读写，`wbpro` 启动时读同一份文件注入环境变量。

**自检区**：面板底部的四项（宿主对象 / `__wbInvoke` / `__wbOn` / `setSessionModel`）是运行时探测结果。如果 `setSessionModel` 是 ✕，说明这个版本的宿主没暴露该接口，主模型只能靠 `settings.json` 改——其余功能不受影响。

**已知边界**

- 阶段自动判断是「启发式」的：订阅 `session:event` 后找 `toolName`/`title`/`kind` 里是否带 agent/task。官方没公开事件结构，所以有可能判断不出来；面板里可以手动标记阶段兜底。
- 协作靠提示词协议，不是硬约束。想强制，得配合 hook 的 `permissionDecision`。
- 「主模型决策、工作模型执行」的实际效果取决于主模型愿不愿意委派。规则写得越具体，越稳定。

## 8. 为什么升级后还能用

| 依赖 | 升级后是否稳定 |
|---|---|
| 官方文件 | **完全不动**，不存在"被覆盖"问题 |
| `WORKBUDDY_REMOTE_DEBUGGING_PORT` | 源码里是普通环境变量分支，大概率长期保留（但不保证） |
| `window.__wbInvoke` / `__wbOn` | preload 暴露的正式接口，改名概率低 |
| DOM 结构 | **会变**——这是插件侧唯一需要维护的东西，所以优先用 `ctx.ui.waitFor` + 语义选择器，别硬编码 hash 类名 |

万一哪天官方把这个开关关了，本方案失效但不破坏任何东西；降级路线是「版本感知的 asar 补丁器」（检测到版本变化才重打），需要另做。

## 9. 已知坑（踩过）

1. **`ELECTRON_RUN_AS_NODE=1` 必须清掉**。在 WorkBuddy 的 Agent 终端里它被继承，直接跑 `WorkBuddy.exe --xxx` 会变成纯 Node 进程，报 `bad option`。启动器的 `cleanEnv()` 已处理。
2. **单实例锁 + `--user-data-dir` 无效**。主进程启动早期就 `app.setPath('userData', ...)` 覆盖了命令行，所以没法用独立 profile 开第二个实例做实验。
3. **`up --restart` 会关掉当前窗口**，正在跑的对话会中断（历史不丢）。所以默认不自动重启，要你自己加 `--yes`。
4. **调试端口是明文可连的**。CDP 开在 `127.0.0.1`，任何本机进程都能连上并执行代码。只在需要时 `up`，不要长期挂着；也不要把端口映射到外网。
5. **CSP 与 `new Function`**：注入的 bundle 不用 eval，插件源码是直接内联成函数体的，绕开 CSP 限制。插件里也不要自己用 `eval`。
6. **后端插件推荐 `.cjs`**：`wbpro/package.json` 有 `"type": "module"`，同目录下的 `.js` 会被当 ESM 解析，`require` 会报错。
7. **侧边栏入口靠文本定位**：`plugin-manager/renderer.js` 里 `ANCHOR_TEXTS = ['更多', 'More']`，官方如果改了导航文案，改这一行即可；万一整块结构大改，`findRow()` 会退回两层祖先，仍能插进去，只是位置可能偏。
8. **改了 `runtime/bootstrap.js` 必须 +`RUNTIME_VERSION`**。页面里的 host 会一直活着，同版本号会走 early-return 复用旧对象，新加的 API（比如 `ctx.control`）不会生效，表现为「渲染失败: Cannot read properties of undefined」。当前版本 `0.6.0`。重启 wbpro 后会自动替换旧 host，不需要刷新页面。
9. **升级运行时版本的那一次，面板会闪一下**。因为版本不同会走「整体替换旧 host」的路径，旧面板被销毁。这只是一次性的迁移代价；之后就进入差分模式，不再重建。想彻底避开，就让 `RUNTIME_VERSION` 保持不变、只改插件代码。
10. **`--restart` 会杀掉自己**。跑在 WorkBuddy 自带终端里时，wbpro 是应用进程的后代，`taskkill /T /F` 会连它一起杀，重启后没人注入。所以这种情况会自动切后台接管（`cmd /c start` 制造孤儿进程，脱离进程树），日志在 `wbpro.log`。另外后台进程必须清掉 `NODE_OPTIONS` 和 `ELECTRON_RUN_AS_NODE`，否则会加载宿主 shim 或进入 Node 模式。
11. **`demo --if-missing` 会覆盖系统/随包插件，但必须保留用户的启用状态**。`plugin-manager`（`system`）和示例（`managed`）每次启动都会覆盖更新，所以覆盖前要读一次目标 `plugin.json` 的 `enabled`，写回 `false` 后再复制，否则用户手动停用的插件每次启动都会被悄悄打开。
12. **`installDuoHooks` 绝不能把解析失败当成空配置**。`settings.json` 里若有注释（JSONC）或语法错误，`JSON.parse` 会抛错；此时若退回 `{}` 再写回，用户的模型、主题、权限规则会全部丢失。正确做法是放弃本次写入并提示，同时用「临时文件 + rename」保证不写半截。

## 10. 能力边界

- ✅ 改界面：加面板、改样式、往现有节点挂东西、监听 DOM 变化
- ✅ 加功能：任意 DOM 交互 + 调官方 IPC + 自己的 Node 后端（文件、数据库、网络都行）
- ⚠️ 改主进程内部逻辑（比如拦截 ACP 消息）：CDP 够不到主进程，需要 `--inspect` 连 Node inspector，**未验证**（Electron fuse 可能已禁用）。真要做得先探针确认。
- ❌ 不要用它改计费、额度、授权、风控。这些都是服务端判定 + 设备指纹（qimei/turing），本地改只会触发风控，且属于滥用。
- ℹ️ 与官方插件体系不冲突：`~/.workbuddy/plugins/` 那套继续用来做 skill / command / MCP，本方案只管 UI 和进程级扩展。
