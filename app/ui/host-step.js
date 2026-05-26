// app/ui/host-step.js
//
// Phase-4 Setup tab — visual checklist row for the 6-step host setup
// flow (Hardware / Network / Wallet / Steam library / Play Pass /
// First relay test). Each row has a state circle (○ ⏳ ✓ ✗), label,
// and right-aligned detail. The collection collapses to a single
// "✓ Setup complete" banner once every row is OK.

/**
 * @param {object} step
 * @param {string} step.id          — unique key
 * @param {number} step.idx         — 1-based index for the dot
 * @param {string} step.label
 * @param {string} step.detail
 * @param {'idle' | 'pending' | 'ok' | 'err'} step.state
 * @param {string} [step.action]    — optional remediation link text
 * @param {string} [step.actionHref]
 * @returns {HTMLElement}
 */
export function buildHostStep(step) {
    const el = document.createElement('div');
    el.className = `host-step host-step--${step.state || 'idle'}`;
    el.dataset.id = step.id;
    el.innerHTML = `
        <div class="host-step-bullet" aria-hidden="true">
            <span class="host-step-bullet-num">${step.idx}</span>
        </div>
        <div class="host-step-body">
            <div class="host-step-label">${step.label}</div>
            <div class="host-step-detail" data-detail>${step.detail || ''}</div>
        </div>
        <div class="host-step-action" data-action>
            ${step.action ? `<a href="${step.actionHref || '#'}" class="hud-btn hud-btn--ghost hud-btn--xs">${step.action} →</a>` : ''}
        </div>
    `;

    el.update = (next) => {
        el.className = `host-step host-step--${next.state || 'idle'}`;
        el.querySelector('[data-detail]').textContent = next.detail || '';
        const actionSlot = el.querySelector('[data-action]');
        if (next.action) {
            actionSlot.innerHTML = `<a href="${next.actionHref || '#'}" class="hud-btn hud-btn--ghost hud-btn--xs">${next.action} →</a>`;
        } else {
            actionSlot.innerHTML = '';
        }
    };

    return el;
}

/**
 * Build the full 6-step container. Returns { el, update(stateMap) }.
 *
 * @param {object[]} initialSteps — array of step descriptors (see above)
 */
export function buildHostStepList(initialSteps) {
    const wrap = document.createElement('div');
    wrap.className = 'host-steps';

    const rendered = new Map();
    for (const s of initialSteps) {
        const row = buildHostStep(s);
        wrap.appendChild(row);
        rendered.set(s.id, row);
    }

    function update(stateMap) {
        // stateMap = { id: { detail, state, action, actionHref } }
        for (const [id, patch] of Object.entries(stateMap)) {
            const row = rendered.get(id);
            if (!row) continue;
            const merged = {
                idx: row.querySelector('.host-step-bullet-num')?.textContent || '?',
                label: row.querySelector('.host-step-label')?.textContent || '',
                ...patch,
            };
            row.update(merged);
        }
    }

    return { el: wrap, update };
}
