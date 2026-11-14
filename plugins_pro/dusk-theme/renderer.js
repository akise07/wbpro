// 演示「只改样式」的最小插件：不接触任何业务逻辑，风险最低。
var ACCENT = 'rgba(127,119,221,.55)';

var CSS = [
    '::-webkit-scrollbar{width:10px;height:10px}',
    '::-webkit-scrollbar-track{background:transparent}',
    '::-webkit-scrollbar-thumb{background:' + ACCENT + ';border-radius:6px;border:2px solid transparent;background-clip:content-box}',
    '::-webkit-scrollbar-thumb:hover{background:rgba(127,119,221,.85);background-clip:content-box}',
    '::-webkit-scrollbar-corner{background:transparent}',
    '::selection{background:rgba(127,119,221,.38)}',
    'html{scrollbar-color:' + ACCENT + ' transparent;scrollbar-width:thin}',
].join('\n');

function activate(ctx) {
    ctx.ui.css(CSS);

    var on = ctx.storage.get('enabled', true);
    var styleEl = null;

    function applyAccent(enable) {
        if (enable && !styleEl) {
            styleEl = document.createElement('style');
            styleEl.setAttribute('data-wbpro-style', 'dusk-theme-accent');
            styleEl.textContent = [
                'a{text-underline-offset:2px}',
                'button{transition:background .15s ease,border-color .15s ease}',
                'input:focus,textarea:focus{outline:1px solid rgba(127,119,221,.5);outline-offset:1px}',
            ].join('\n');
            document.head.appendChild(styleEl);
        } else if (!enable && styleEl) {
            styleEl.remove();
            styleEl = null;
        }
    }
    applyAccent(on);

    var panel = ctx.ui.panel({
        title: '主题 · 暮色',
        position: 'bottom-right',
        render: function (body) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:8px;';
            var btn = document.createElement('button');
            btn.textContent = on ? '已开启' : '已关闭';
            btn.onclick = function () {
                on = !on;
                applyAccent(on);
                ctx.storage.set('enabled', on);
                btn.textContent = on ? '已开启' : '已关闭';
                ctx.ui.toast(on ? '暮色主题已开启' : '暮色主题已关闭');
            };
            row.appendChild(btn);
            var hint = document.createElement('span');
            hint.style.cssText = 'opacity:.55;font-size:12px;';
            hint.textContent = '滚动条 / 选区 / 焦点框';
            row.appendChild(hint);
            body.appendChild(row);
        },
    });

    return function () {
        panel.remove();
        if (styleEl) styleEl.remove();
    };
}
