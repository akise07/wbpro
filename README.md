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

已经开着 WorkBuddy 时：

```bash
node bin/wbpro.mjs up --restart --yes    # 会关掉当前窗口重开，会话不丢但窗口会重启
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
   ├─ hello-panel/          浮动面板 + 宿主信息
   ├─ dusk-theme/           纯 CSS 主题
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
| `ctx.ui` | `panel({title, render, position, css, closable})` | 浮动面板，Shadow DOM 隔离样式，可拖动 |
| | `css(text)` | 注入全局样式，卸载时自动移除 |
| | `toast(msg, ms)` | 轻提示 |
| | `observe(fn, opts)` | MutationObserver 封装，用来嗅探界面结构 |
| | `waitFor(selector, timeout)` | 等某节点出现，做「挂到官方的某个按钮旁边」 |
| `ctx.ipc` | `invoke(channel, ...args)` | 走官方 `__wbInvoke` 桥，可调 93 个已注册通道 |
| | `on(channel, cb)` | 订阅主进程推送 |
| `ctx.storage` | `get(k, dflt)` / `set(k, v)` | 按插件命名空间隔离 |
| `ctx.backend` | `baseUrl` / `fetch(p, init)` / `json(p)` | 访问插件自己的后端进程 |
| `ctx` | `app` | 宿主信息：应用版本、调试端口、注入时间 |
| | `log(...)` | 带插件前缀的日志 |
| | `onCleanup(fn)` | 注册卸载回调 |

## 7. 为什么升级后还能用

| 依赖 | 升级后是否稳定 |
|---|---|
| 官方文件 | **完全不动**，不存在"被覆盖"问题 |
| `WORKBUDDY_REMOTE_DEBUGGING_PORT` | 源码里是普通环境变量分支，大概率长期保留（但不保证） |
| `window.__wbInvoke` / `__wbOn` | preload 暴露的正式接口，改名概率低 |
| DOM 结构 | **会变**——这是插件侧唯一需要维护的东西，所以优先用 `ctx.ui.waitFor` + 语义选择器，别硬编码 hash 类名 |

万一哪天官方把这个开关关了，本方案失效但不破坏任何东西；降级路线是「版本感知的 asar 补丁器」（检测到版本变化才重打），需要另做。

## 8. 已知坑（踩过）

1. **`ELECTRON_RUN_AS_NODE=1` 必须清掉**。在 WorkBuddy 的 Agent 终端里它被继承，直接跑 `WorkBuddy.exe --xxx` 会变成纯 Node 进程，报 `bad option`。启动器的 `cleanEnv()` 已处理。
2. **单实例锁 + `--user-data-dir` 无效**。主进程启动早期就 `app.setPath('userData', ...)` 覆盖了命令行，所以没法用独立 profile 开第二个实例做实验。
3. **`up --restart` 会关掉当前窗口**，正在跑的对话会中断（历史不丢）。所以默认不自动重启，要你自己加 `--yes`。
4. **调试端口是明文可连的**。CDP 开在 `127.0.0.1`，任何本机进程都能连上并执行代码。只在需要时 `up`，不要长期挂着；也不要把端口映射到外网。
5. **CSP 与 `new Function`**：注入的 bundle 不用 eval，插件源码是直接内联成函数体的，绕开 CSP 限制。插件里也不要自己用 `eval`。
6. **后端插件推荐 `.cjs`**：`wbpro/package.json` 有 `"type": "module"`，同目录下的 `.js` 会被当 ESM 解析，`require` 会报错。

## 9. 能力边界

- ✅ 改界面：加面板、改样式、往现有节点挂东西、监听 DOM 变化
- ✅ 加功能：任意 DOM 交互 + 调官方 IPC + 自己的 Node 后端（文件、数据库、网络都行）
- ⚠️ 改主进程内部逻辑（比如拦截 ACP 消息）：CDP 够不到主进程，需要 `--inspect` 连 Node inspector，**未验证**（Electron fuse 可能已禁用）。真要做得先探针确认。
- ❌ 不要用它改计费、额度、授权、风控。这些都是服务端判定 + 设备指纹（qimei/turing），本地改只会触发风控，且属于滥用。
- ℹ️ 与官方插件体系不冲突：`~/.workbuddy/plugins/` 那套继续用来做 skill / command / MCP，本方案只管 UI 和进程级扩展。
