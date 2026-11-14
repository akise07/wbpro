// 插件注册表：扫描 ~/.workbuddy/plugins_pro/<插件目录>/plugin.json
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PLUGINS_DIR = path.join(os.homedir(), '.workbuddy', 'plugins_pro');

/** 读 plugin.json，做最小校验；错误不抛出，落到 errors 里 */
export async function loadPlugins(dir = DEFAULT_PLUGINS_DIR) {
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
        if (manifest.enabled === false) continue;

        const rendererEntry = manifest.renderer || (fs.existsSync(path.join(pluginDir, 'renderer.js')) ? 'renderer.js' : null);
        let code = null;
        if (rendererEntry) {
            try {
                code = await fsp.readFile(path.join(pluginDir, rendererEntry), 'utf8');
            } catch (e) {
                errors.push({ dir: ent.name, reason: `renderer 入口读取失败: ${e.message}` });
                continue;
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
            code,
            backendEntry: backendPath && fs.existsSync(backendPath) ? backendPath : null,
            manifest,
        });
    }
    plugins.sort((a, b) => a.id.localeCompare(b.id));
    return { plugins, errors, dir, missing: false };
}

/** 监听插件目录变化（防抖 300ms） */
export function watchPlugins(dir, onChange) {
    let timer = null;
    let watcher = null;
    try {
        watcher = fs.watch(dir, { recursive: true }, () => {
            clearTimeout(timer);
            timer = setTimeout(() => onChange(), 300);
        });
    } catch (e) {
        console.warn(`[wbpro] 插件目录监听失败（将不自动热更新）: ${e.message}`);
    }
    return () => {
        clearTimeout(timer);
        watcher?.close();
    };
}
