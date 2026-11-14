import { createHash } from 'node:crypto';

// 插件指纹：代码或清单变了才算「变更」，其余情况热更新时原地保留、不重建 UI。
export function pluginSig(p) {
    const raw = [
        p.code || '',
        p.id,
        p.name,
        p.version,
        p.description,
        JSON.stringify(p.manifest?.contributes ?? null),
        p.backendUrl || '',
    ].join('\u0000');
    return createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

/**
 * 后端进程指纹：只看代码与清单，**不含 backendUrl**。
 * 后端进程的端口是每次启动新分配的，用含 backendUrl 的指纹去比会永远不等，
 * 表现为「每次热更新都重启所有后端」。判断要不要重启进程只能用这个。
 */
export function pluginCoreSig(p) {
    const raw = [p.code || '', p.id, p.name, p.version, p.description, JSON.stringify(p.manifest?.contributes ?? null)].join(
        '\u0000',
    );
    return createHash('sha1').update(raw).digest('hex').slice(0, 12);
}

// 把运行时 + 所有插件拼成一段可直接 Runtime.evaluate 的表达式。
// 不使用 new Function / eval，避免被页面 CSP 拦掉；插件源码直接作为函数体内联。
export function buildBundle({ bootstrap, plugins, meta }) {
    const defs = plugins
        .filter((p) => typeof p.code === 'string')
        .map((p) => {
            const manifest = JSON.stringify({
                id: p.id,
                name: p.name,
                version: p.version,
                description: p.description,
                permissions: p.permissions,
                contributes: p.manifest?.contributes ?? null,
                __dir: p.dir,
            });
            const backendUrl = JSON.stringify(p.backendUrl || null);
            // 插件源码作为 code 函数体；末尾统一调用 activate(ctx)
            // 指纹优先用调用方算好的 p.sig，保证与 injector 判定口径完全一致
            const sig = JSON.stringify(p.sig || pluginSig(p));
            return `{id:${JSON.stringify(p.id)},sig:${sig},manifest:${manifest},backendUrl:${backendUrl},code:function(ctx){
${p.code}
;return typeof activate==="function"?activate(ctx):undefined;}}`;
        })
        .join(',\n');

    return `(function(){
try{
${bootstrap}
}catch(e){console.error("[wbpro] 运行时装载失败",e);return;}
window.__wbpro.__mount(${JSON.stringify(meta || {})},[
${defs}
]);
})()`;
}

export function summarize(plugins) {
    return plugins.map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        renderer: typeof p.code === 'string',
        backend: !!p.backendUrl,
    }));
}
