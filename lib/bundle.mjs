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
            return `{id:${JSON.stringify(p.id)},manifest:${manifest},backendUrl:${backendUrl},code:function(ctx){
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
