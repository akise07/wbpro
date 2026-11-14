// 插件约定：定义 activate(ctx)，返回值作为卸载函数。
// 这里演示：浮动面板 + 宿主信息 + 用 localStorage 记住开关状态。
function activate(ctx) {
    var plat = window.__hostPlatform || {};
    var appMeta = ctx.app || {};

    var panel = ctx.ui.panel({
        title: 'wbpro 示例面板',
        position: 'top-right',
        render: function (body) {
            var rows = [
                ['wbpro', ctx.version],
                ['WorkBuddy', appMeta.appVersion || '未知'],
                ['平台', (plat.platform || '?') + ' / ' + (plat.arch || '?')],
                ['调试端口', String(appMeta.port || '?')],
                ['注入时间', appMeta.startedAt ? new Date(appMeta.startedAt).toLocaleTimeString() : '?'],
            ];
            var table = document.createElement('div');
            rows.forEach(function (r) {
                var line = document.createElement('div');
                line.style.cssText = 'display:flex;gap:10px;padding:2px 0;';
                var k = document.createElement('span');
                k.textContent = r[0];
                k.style.cssText = 'width:76px;flex:none;opacity:.62;';
                var v = document.createElement('span');
                v.textContent = r[1];
                v.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;';
                line.appendChild(k);
                line.appendChild(v);
                table.appendChild(line);
            });
            body.appendChild(table);

            var bar = document.createElement('div');
            bar.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
            var btn = document.createElement('button');
            btn.textContent = '打个招呼';
            btn.onclick = function () {
                ctx.ui.toast('插件运行正常 · ' + new Date().toLocaleTimeString());
                ctx.log('按钮被点击');
            };
            bar.appendChild(btn);
            body.appendChild(bar);

            var tip = document.createElement('div');
            tip.style.cssText = 'margin-top:8px;opacity:.5;font-size:12px;';
            tip.textContent = '面板可拖动，点右上角 × 关闭';
            body.appendChild(tip);
        },
    });

    ctx.log('已激活，面板 id=hello-panel');

    return function () {
        panel.remove();
        ctx.log('已卸载');
    };
}
