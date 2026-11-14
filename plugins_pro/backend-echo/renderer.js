// 演示插件自带后端：点击按钮 → 请求本地 Node 服务 → 回显结果。
function activate(ctx) {
    var panel = ctx.ui.panel({
        title: '后端示例',
        position: 'bottom-left',
        render: function (body) {
            var out = document.createElement('div');
            out.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:12px;opacity:.85;word-break:break-all;';
            out.textContent = ctx.backend.baseUrl ? '就绪 · ' + ctx.backend.baseUrl : '该插件未启动后端';

            var btn = document.createElement('button');
            btn.textContent = '调用 /echo';
            btn.style.marginTop = '8px';
            btn.onclick = function () {
                out.textContent = '请求中…';
                ctx.backend
                    .json('/echo?msg=' + encodeURIComponent('你好，来自页面'))
                    .then(function (d) {
                        out.textContent = 'PID ' + d.pid + ' · node ' + d.node + ' · ' + d.time;
                    })
                    .catch(function (e) {
                        out.textContent = '失败: ' + e.message;
                    });
            };

            body.appendChild(out);
            body.appendChild(btn);
        },
    });

    return function () {
        panel.remove();
    };
}
