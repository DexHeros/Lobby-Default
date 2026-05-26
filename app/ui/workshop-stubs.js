/* Workshop stubs — placeholder popovers for the not-yet-wired chapters.
 *
 * Listens for `dexhero:workshop-part` events whose `part` is NOT
 * 'brain' (owned by app/ui/brain-picker.js), 'voice' (owned by
 * app/ui/voice-editor.js — Phase C), or 'schedule' (owned by
 * app/ui/schedule-editor.js — Phase C). Opens a small popover with
 * a teaser of what that workshop chapter will eventually configure,
 * mapped to the corresponding field on JarJar's CharacterRecipe.
 *
 * Each chapter ships as a fully-wired picker in a future iteration:
 *   - MEMORY  → memory.lesson_max_bytes + memory.working_db_path
 *   - BODY    → body.rig_variant (already chosen at mint)
 */

/* No remaining stub chapters — Body (annotation id 'memory') is now
   owned by app/ui/body-picker.js; Movement (id 'body') is now owned by
   app/ui/movement-picker.js (Phase 4). This file is retained as a
   bail-out registry only; remove once the annotation rename ships
   (Phase 5) and no event consumers reference it. */
const CHAPTERS = {};

let _wired = false;
let _popover = null;
let _outsideClickHandler = null;

function closePopover() {
    if (!_popover) return;
    _popover.remove();
    _popover = null;
    if (_outsideClickHandler) {
        document.removeEventListener('click', _outsideClickHandler, true);
        document.removeEventListener('keydown', _onKeyDown, true);
        _outsideClickHandler = null;
    }
}
function _onKeyDown(ev) { if (ev.key === 'Escape') { ev.preventDefault(); closePopover(); } }

function positionPopover(popover, anchorEl) {
    if (!popover || !anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const pw = 320;
    let left = rect.left + window.scrollX + rect.width / 2 - pw / 2;
    let top  = rect.bottom + window.scrollY + 10;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - pw - 12;
    if (left > maxLeft) left = maxLeft;
    if (left < 12 + window.scrollX) left = 12 + window.scrollX;
    popover.style.left = `${left}px`;
    popover.style.top  = `${top}px`;
}

function openStub(part, anchorEl) {
    closePopover();
    const c = CHAPTERS[part];
    if (!c) return;

    _popover = document.createElement('div');
    _popover.className = 'brain-picker workshop-stub';
    _popover.setAttribute('role', 'dialog');
    _popover.setAttribute('aria-label', `${c.title} workshop chapter`);
    _popover.innerHTML = `
        <div class="brain-picker__head">
            <span class="brain-picker__title">${c.title}</span>
            <button type="button" class="brain-picker__close" aria-label="Close">×</button>
        </div>
        <div class="brain-picker__body">
            <div class="workshop-stub__teaser">${c.teaser}</div>
            <div class="workshop-stub__meta">
                <span class="workshop-stub__chip">Coming soon</span>
                <span class="workshop-stub__field">${c.recipeField}</span>
            </div>
        </div>`;
    document.body.appendChild(_popover);
    positionPopover(_popover, anchorEl);

    _popover.querySelector('.brain-picker__close')?.addEventListener('click', closePopover);
    _outsideClickHandler = (ev) => {
        if (!_popover) return;
        if (_popover.contains(ev.target)) return;
        if (anchorEl && anchorEl.contains(ev.target)) return;
        closePopover();
    };
    document.addEventListener('click', _outsideClickHandler, true);
    document.addEventListener('keydown', _onKeyDown, true);
}

/** Wire the stub popovers against the workshop-part event stream. Call
 *  once at app boot — idempotent. */
export function initWorkshopStubs() {
    if (_wired) return;
    _wired = true;
    document.addEventListener('dexhero:workshop-part', (ev) => {
        const part = ev.detail?.part;
        // Each owned-elsewhere part bails out to its own picker module:
        //   brain    → app/ui/brain-picker.js
        //   voice    → app/ui/voice-editor.js
        //   schedule → app/ui/schedule-editor.js
        //   install  → app/ui/install-jarjar.js
        // All known parts route to dedicated pickers / editors. Bail on
        // every known part so the (now-empty) stub registry never opens.
        if (!part) return;
        if (['brain', 'voice', 'schedule', 'install', 'memory', 'body', 'movement'].includes(part)) return;
        openStub(part, ev.detail?.anchorEl);
    });
}
