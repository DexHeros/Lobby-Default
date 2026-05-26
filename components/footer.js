// Shared Footer Component
function createFooter() {
    return `
    <!-- Footer -->
    <footer class="footer">
        <div class="footer-content">
            <span class="copyright">© 2026 DexHero. All rights reserved.</span>
            <div class="footer-links">
                <a href="/pages/privacy.html">Privacy Policy</a>
                <a href="/pages/terms.html">Terms of Service</a>
                <a href="/pages/fees.html">Fees</a>
            </div>
        </div>
    </footer>

    `;
}

// Inject footer into page
function injectFooter() {
    const footerPlaceholder = document.getElementById('footer-placeholder');
    if (footerPlaceholder) {
        footerPlaceholder.innerHTML = createFooter();
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', injectFooter);
