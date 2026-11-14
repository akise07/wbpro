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
node bin/wbpro.mjs status     # 查看已激活插件
node bin/wbpro.mjs list       # 列出插件目录
```

**或者直接双击 `start.bat`**：自动定位 Node → 同步随包插件 → 带调试端口启动 → 注入 → 常驻（窗口开着别关）。

`start.bat` 里的同步用的是 `demo --if-missing`：标记了 `system: true`（插件管理器）或 `managed: true`（随包示例）的插件**每次都会覆盖更新**，你自己建的插件目录不会被碰。

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
| `backend.entry` | 可选 | 后端入口；缺省时自动探测 `backend.cjs` / `backend.mjs` / `backend.js` |
| `enabled` | 可选 | 设为 `false` 可临时停用 |
| `contributes.panel.position` | 可选 | `top-right` / `top-left` / `bottom-right` / `bottom-left` |

`renderer.js` 约定：定义 `activate(ctx)`，返回值作为卸载函数。

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
| `ctx.ui` | `panel({title, render, position, css, closable, onClose})` | 浮动面板，Shadow DOM 隔离样式，可拖动；`onClose` 在面板销毁时回调 |
| | `css(text)` | 注入全局样式，卸载时自动移除 |
| | `toast(msg, ms)` | 轻提示 |
| | `observe(fn, opts)` | MutationObserver 封装，用来嗅探界面结构 |
| | `waitFor(selector, timeout)` | 等某节点出现，做「挂到官方的某个按钮旁边」 |
| `ctx.ipc` | `invoke(channel, ...args)` | 走官方 `__wbInvoke` 桥，可调 93 个已注册通道 |
| | `on(channel, cb)` | 订阅主进程推送 |
| `ctx.storage` | `get(k, dflt)` / `set(k, v)` | 按插件命名空间隔离 |
| `ctx.backend` | `baseUrl` / `fetch(p, init)` / `json(p)` | 访问插件自己的后端进程 |
| `ctx.control` | `list()` / `toggle(id, enabled)` / `reload()` / `openDir()` | 调用 wbpro 控制服务（插件管理器用的就是它） |
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

**为什么开关能立刻生效**：`enabled:false` 的插件在扫描阶段就被跳过（源码都不会被读进 bundle），改完文件后 CLI 重新构建 bundle 并 `Runtime.evaluate` 注入，新 bundle 会先 `__reset()` 卸载旧插件再挂载新的。整个过程不重启应用。

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
8. **改了 `runtime/bootstrap.js` 必须 +`RUNTIME_VERSION`**。页面里的 host 会一直活着，同版本号会走 early-return 复用旧对象，新加的 API（比如 `ctx.control`）不会生效，表现为「渲染失败: Cannot read properties of undefined」。当前版本 `0.3.0`。重启 wbpro 后会自动替换旧 host，不需要刷新页面。
9. **`--restart` 会杀掉自己**。跑在 WorkBuddy 自带终端里时，wbpro 是应用进程的后代，`taskkill /T /F` 会连它一起杀，重启后没人注入。所以这种情况会自动切后台接管（`cmd /c start` 制造孤儿进程，脱离进程树），日志在 `wbpro.log`。另外后台进程必须清掉 `NODE_OPTIONS` 和 `ELECTRON_RUN_AS_NODE`，否则会加载宿主 shim 或进入 Node 模式。

## 10. 能力边界

- ✅ 改界面：加面板、改样式、往现有节点挂东西、监听 DOM 变化
- ✅ 加功能：任意 DOM 交互 + 调官方 IPC + 自己的 Node 后端（文件、数据库、网络都行）
- ⚠️ 改主进程内部逻辑（比如拦截 ACP 消息）：CDP 够不到主进程，需要 `--inspect` 连 Node inspector，**未验证**（Electron fuse 可能已禁用）。真要做得先探针确认。
- ❌ 不要用它改计费、额度、授权、风控。这些都是服务端判定 + 设备指纹（qimei/turing），本地改只会触发风控，且属于滥用。
- ℹ️ 与官方插件体系不冲突：`~/.workbuddy/plugins/` 那套继续用来做 skill / command / MCP，本方案只管 UI 和进程级扩展。
