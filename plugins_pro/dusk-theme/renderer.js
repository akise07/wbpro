// 主题切换插件
// 做法：一层 pointer-events:none 的全屏混合色层做整体色调，配合强调色（选区/滚动条）
// 和可选的全屏降饱和。不改任何官方类名，所以不怕改版；切换是即时可见的。

var THEMES = [
    { id: 'off', name: '原色', accent: null },
    { id: 'dusk', name: '暮色', tint: { color: 'rgba(255,146,84,0.62)', blend: 'soft-light' }, accent: '#FF9A5C' },
    { id: 'cool', name: '冷夜', tint: { color: 'rgba(88,140,255,0.60)', blend: 'soft-light' }, accent: '#7FA8FF' },
    { id: 'mint', name: '护眼', tint: { color: 'rgba(110,220,168,0.46)', blend: 'soft-light' }, accent: '#6FD3A8' },
    { id: 'mono', name: '去色', accent: '#B9B9C0', grayscale: true },
];

// #RRGGBB + alpha -> rgba()
function fade(hex, a) {
    var h = hex.replace('#', '');
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

function activate(ctx) {
    var overlay = null;
    var styleEl = null;
    var current = ctx.storage.get('theme', 'off');

    function ensureOverlay() {
        if (overlay && overlay.isConnected) return overlay;
        overlay = document.createElement('div');
        overlay.setAttribute('data-wbpro-theme-layer', '1');
        overlay.style.cssText = [
            'position:fixed',
            'inset:0',
            'pointer-events:none', // 绝不吃鼠标事件
            'z-index:2147482998', // 低于插件面板，面板保持清晰
            'transition:background .2s ease,opacity .2s ease',
            'opacity:0',
        ].join(';');
        document.body.appendChild(overlay);
        return overlay;
    }

    function apply(id) {
        var theme = THEMES.filter(function (t) { return t.id === id; })[0] || THEMES[0];
        current = theme.id;
        ctx.storage.set('theme', theme.id);

        // 1) 色调层
        if (theme.tint) {
            var o = ensureOverlay();
            o.style.background = theme.tint.color;
            o.style.mixBlendMode = theme.tint.blend;
            o.style.opacity = '1';
        } else if (overlay) {
            overlay.style.opacity = '0';
            overlay.style.mixBlendMode = 'normal';
        }

        // 2) 全屏去色（只有「去色」主题会开）
        document.documentElement.style.filter = theme.grayscale ? 'grayscale(.75) contrast(1.04)' : '';

        // 3) 强调色
        if (styleEl) {
            styleEl.remove();
            styleEl = null;
        }
        if (theme.accent) {
            styleEl = document.createElement('style');
            styleEl.setAttribute('data-wbpro-style', 'dusk-theme');
            styleEl.textContent = [
                '::selection{background:' + fade(theme.accent, 0.38) + ';color:inherit}',
                '::-webkit-scrollbar{width:10px;height:10px}',
                '::-webkit-scrollbar-thumb{background:' + fade(theme.accent, 0.55) + ';border-radius:6px;border:2px solid transparent;background-clip:content-box}',
                '::-webkit-scrollbar-thumb:hover{background:' + fade(theme.accent, 0.85) + ';background-clip:content-box}',
                '::-webkit-scrollbar-track{background:transparent}',
                'html{scrollbar-color:' + fade(theme.accent, 0.55) + ' transparent;scrollbar-width:thin}',
            ].join('\n');
            document.head.appendChild(styleEl);
        }
        return theme;
    }

    var panel = ctx.ui.panel({
        title: '主题',
        position: 'bottom-right',
        css: '.p{min-width:236px;}',
        render: function (body) {
            var grid = document.createElement('div');
            grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';

            function paint() {
                grid.textContent = '';
                THEMES.forEach(function (t) {
                    var active = t.id === current;
                    var btn = document.createElement('button');
                    btn.textContent = t.name;
                    btn.style.cssText = [
                        'padding:6px 8px',
                        'border-radius:7px',
                        'font-size:12px',
                        'cursor:pointer',
                        'border:1px solid ' + (active ? 'rgba(127,119,221,.85)' : 'rgba(255,255,255,.14)'),
                        'background:' + (active ? 'rgba(127,119,221,.28)' : 'rgba(255,255,255,.05)'),
                        'color:' + (active ? '#dcd9ff' : '#e9e9ec'),
                    ].join(';');
                    btn.onclick = function () {
                        apply(t.id);
                        paint();
                        ctx.ui.toast('主题：' + t.name);
                    };
                    grid.appendChild(btn);
                });
                tip.textContent = '当前：' + (THEMES.filter(function (t) { return t.id === current; })[0] || THEMES[0]).name;
            }

            var tip = document.createElement('div');
            tip.style.cssText = 'margin-top:8px;font-size:11px;opacity:.5;';

            body.appendChild(grid);
            body.appendChild(tip);
            paint();
        },
    });

    // 首屏恢复上次选择
    apply(current);

    // React 若替换 body 子节点，把色层补回去
    var keeper = setInterval(function () {
        var t = THEMES.filter(function (x) { return x.id === current; })[0];
        if (t && t.tint && (!overlay || !overlay.isConnected)) {
            document.body.appendChild(overlay);
            overlay.style.opacity = '1';
        }
    }, 1500);

    ctx.log('已应用主题：' + current);

    return function () {
        clearInterval(keeper);
        if (overlay) overlay.remove();
        if (styleEl) styleEl.remove();
        document.documentElement.style.filter = '';
    };
}
