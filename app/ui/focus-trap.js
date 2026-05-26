/* V3Labs focus trap — simple tab-cycling trap for open panels.
   Restores focus to the previously-active element on release. */

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export function createFocusTrap(root) {
    let previous = null;
    let keyHandler = null;

    function focusables() {
        return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
            return el.offsetParent !== null || el === document.activeElement;
        });
    }

    return {
        activate() {
            previous = document.activeElement;
            const list = focusables();
            const first = list[0] || root;
            // Ensure root can receive focus if it has no tabbable children.
            if (!root.hasAttribute('tabindex')) root.setAttribute('tabindex', '-1');
            (first === root ? root : first).focus({ preventScroll: true });

            keyHandler = (e) => {
                if (e.key !== 'Tab') return;
                const items = focusables();
                if (!items.length) { e.preventDefault(); return; }
                const idx = items.indexOf(document.activeElement);
                if (e.shiftKey) {
                    if (idx <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
                } else {
                    if (idx === items.length - 1) { e.preventDefault(); items[0].focus(); }
                }
            };
            root.addEventListener('keydown', keyHandler);
        },
        release() {
            if (keyHandler) root.removeEventListener('keydown', keyHandler);
            keyHandler = null;
            if (previous && typeof previous.focus === 'function') {
                try { previous.focus({ preventScroll: true }); } catch {}
            }
            previous = null;
        },
    };
}
