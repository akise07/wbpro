// 插件注册表：扫描 <repo>/plugins_pro/<插件目录>/plugin.json
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认插件目录 = 仓库里的 plugins_pro（不再读用户目录下的副本） */
export const DEFAULT_PLUGINS_DIR = path.join(fileURLToPath(new URL('..', import.meta.url)), 'plugins_pro');

/** 读 plugin.json，做最小校验；错误不抛出，落到 errors 里。
 *  includeDisabled=true 时把 enabled:false 的插件也返回（供管理界面展示）。 */
export async function loadPlugins(dir = DEFAULT_PLUGINS_DIR, { includeDisabled = false } = {}) {
    const plugins = [];
    const errors = [];
    let entries = [];
    try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
        if (e.code === 'ENOENT') return { plugins, errors, dir, missing: true };
        throw e;
    }

    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_')) continue;
        const pluginDir = path.join(dir, ent.name);
        const manifestPath = path.join(pluginDir, 'plugin.json');
        let manifest;
        try {
            manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
        } catch (e) {
            errors.push({ dir: ent.name, reason: `plugin.json 读取失败: ${e.message}` });
            continue;
        }
        if (!manifest.id) {
            errors.push({ dir: ent.name, reason: 'plugin.json 缺少 id' });
            continue;
        }
        const enabled = manifest.enabled !== false;
        if (!enabled && !includeDisabled) continue;

        const rendererEntry = manifest.renderer || (fs.existsSync(path.join(pluginDir, 'renderer.js')) ? 'renderer.js' : null);
        let code = null;
        // 停用的插件不读源码，避免把不该跑的东西带进页面
        if (enabled && rendererEntry) {
            try {
                code = await fsp.readFile(path.join(pluginDir, rendererEntry), 'utf8');
            } catch (e) {
                errors.push({ dir: ent.name, reason: `renderer 入口读取失败: ${e.message}` });
                continue;
            }

            // 可选的多文件支持：manifest.rendererIncludes 里的文件会按顺序内联到入口之前。
            // 因为 bundle 是把整个 renderer 当函数体注入的，插件里没有 require/module，
            // 拆分成多文件只能靠「读取阶段拼接」，不能用模块系统。
            const includes = Array.isArray(manifest.rendererIncludes) ? manifest.rendererIncludes : [];
            if (includes.length) {
                const parts = [];
                let incFailed = null;
                for (const rel of includes) {
                    const incPath = path.join(pluginDir, rel);
                    try {
                        parts.push(await fsp.readFile(incPath, 'utf8'));
                    } catch (e) {
                        incFailed = `${rel}: ${e.message}`;
                        break;
                    }
                }
                if (incFailed) {
                    errors.push({ dir: ent.name, reason: `rendererIncludes 读取失败 → ${incFailed}` });
                    continue;
                }
                // 拼接顺序：被包含文件在前，入口在后（入口可直接引用它们定义的全局）
                code = parts.join('\n;\n') + '\n;\n' + code;
            }
        }
        // 后端入口：优先 manifest 声明，否则按常见文件名探测
        const backendEntry = manifest.backend?.entry
            || ['backend.cjs', 'backend.mjs', 'backend.js'].find((f) => fs.existsSync(path.join(pluginDir, f)))
            || null;
        const backendPath = backendEntry ? path.join(pluginDir, backendEntry) : null;
        plugins.push({
            id: manifest.id,
            name: manifest.name || manifest.id,
            version: manifest.version || '0.0.0',
            description: manifest.description || '',
            permissions: manifest.permissions || [],
            engines: manifest.engines || {},
            position: manifest.contributes?.panel?.position || 'top-right',
            dir: pluginDir,
            dirName: ent.name,
            enabled,
            system: manifest.system === true,
            code,
            backendEntry: enabled && backendPath && fs.existsSync(backendPath) ? backendPath : null,
            manifest,
        });
    }
    plugins.sort((a, b) => a.id.localeCompare(b.id));
    return { plugins, errors, dir, missing: false };
}

/** 改写某个插件的 enabled 字段（保留其余字段与缩进） */
export async function setPluginEnabled(dir, id, enabled) {
    const { plugins } = await loadPlugins(dir, { includeDisabled: true });
    const target = plugins.find((p) => p.id === id);
    if (!target) throw new Error(`未找到插件 ${id}`);
    if (target.system) throw new Error(`${id} 是系统插件，不允许停用`);
    const file = path.join(target.dir, 'plugin.json');
    const manifest = JSON.parse(await fsp.readFile(file, 'utf8'));
    manifest.enabled = !!enabled;
    await fsp.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    return target;
}

/** 监听插件目录变化（防抖 300ms） */
export function watchPlugins(dir, onChange) {
    let timer = null;
    let watcher = null;
    // 攒一下这次变更涉及的文件名，交给回调打日志用：
    // 只写「检测到插件变更」时，出问题没法判断是哪个文件触发的热更新。
    const touched = new Set();
    try {
        watcher = fs.watch(dir, { recursive: true }, (_evt, name) => {
            if (name) touched.add(String(name).replace(/\\/g, '/'));
            clearTimeout(timer);
            timer = setTimeout(() => {
                const files = [...touched];
                touched.clear();
                onChange(files);
            }, 300);
        });
    } catch (e) {
        console.warn(`[wbpro] 插件目录监听失败（将不自动热更新）: ${e.message}`);
    }
    return () => {
        clearTimeout(timer);
        watcher?.close();
    };
}
