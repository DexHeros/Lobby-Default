/* V3Labs toast — ephemeral notifications in the top-right corner. */

let _host = null;

function ensureHost() {
    if (_host) return _host;
    _host = document.querySelector('.lobby-toasts') || document.body.appendChild(
        Object.assign(document.createElement('div'), { className: 'lobby-toasts' })
    );
    return _host;
}

export function toast(message, { kind = 'info', ttl = 3600 } = {}) {
    const host = ensureHost();
    const t = document.createElement('div');
    t.className = `lobby-toast lobby-toast--${kind}`;
    t.setAttribute('role', 'status');
    t.setAttribute('aria-live', 'polite');
    t.innerHTML = `
        <span class="hud-dot" style="color:currentColor;background:currentColor;"></span>
        <span style="flex:1;color:var(--ink-1);font-family:var(--font-mono);font-size:12px;letter-spacing:0.06em;">${escape(message)}</span>
    `;
    host.appendChild(t);
    setTimeout(() => {
        t.setAttribute('data-leaving', 'true');
        setTimeout(() => t.remove(), 250);
    }, ttl);
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
