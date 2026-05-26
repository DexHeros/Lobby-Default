/* V3Labs stage-card — builds one ribbon item.

   Matches the legacy home-page DOM so the existing sprite + meteor CSS
   (in /styles.css) governs the thumb→sprite transition:

     <a.lobby-carousel__item data-sprite-url data-sprite-frames data-thumb-url data-model-url>
       <div.lobby-carousel__subject>
         <div.featured-hero-sprite>
           <img.featured-hero-thumb src="thumbUrl">
           <div.meteor-flash></div>
         </div>
       </div>
       <div.lobby-carousel__label> … </div>
     </a>

   The meteor.js module watches for these cards and performs the orb→sprite
   upgrade when they enter the center of the viewport. */

export function buildCard(subject) {
    const a = document.createElement('a');
    a.className = 'lobby-carousel__item';
    a.setAttribute('role', 'listitem');
    a.style.setProperty('--card-s', '0.5');
    a.style.setProperty('--card-o', '0.3');

    const addr = subject.address || '';
    const id   = subject.id || '';
    // Deep-link to token-detail; prefer address when available, else id.
    // `_ctaHref` lets callers route a card elsewhere (e.g. the personal-lobby
    // empty-state CTA card that should send the user to /#/create/type).
    a.href = subject._ctaHref
        || ((addr || id) ? `#/token/${encodeURIComponent(addr || id)}` : '#/');
    a.setAttribute('aria-label', subject.name || 'DexHero');
    a.setAttribute('data-addr', addr);
    a.setAttribute('data-id', id);
    a.setAttribute('data-thumb-url',     subject.image  || '');
    a.setAttribute('data-model-url',     subject.model  || '');
    a.setAttribute('data-sprite-url',    subject.sprite || '');
    a.setAttribute('data-sprite-frames', String(subject.spriteFrames || 0));

    const subjectSlot = document.createElement('div');
    subjectSlot.className = 'lobby-carousel__subject';
    a.appendChild(subjectSlot);

    // ── Sprite wrapper (static thumb + flash marker) ────────────────
    const sprite = document.createElement('div');
    sprite.className = 'featured-hero-sprite';

    if (subject.image) {
        const thumb = document.createElement('img');
        thumb.className = 'featured-hero-thumb';
        thumb.alt = subject.name || 'DexHero';
        thumb.loading = 'eager';
        thumb.decoding = 'async';
        thumb.src = subject.image;
        sprite.appendChild(thumb);
    } else {
        // First-letter placeholder when no thumbnail
        const letter = document.createElement('div');
        letter.className = 'lobby-stage__subject-letter featured-hero-thumb';
        letter.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;';
        letter.textContent = (subject.name || 'D').charAt(0).toUpperCase();
        sprite.appendChild(letter);
    }

    // Meteor flash — activates on orb impact
    const flash = document.createElement('div');
    flash.className = 'meteor-flash';
    sprite.appendChild(flash);

    subjectSlot.appendChild(sprite);

    // 3D model slot — empty until meteor.js lazily mounts a model-viewer
    // for this card. The orb + thumb still cover the loading window; the
    // model only fades in once `model-viewer` fires its `load` event.
    const modelSlot = document.createElement('div');
    modelSlot.className = 'featured-hero-model';
    subjectSlot.appendChild(modelSlot);

    // ── Label: character nameplate + gamified stat pills.
    //     Name is the headline (large, cyan side-brackets via CSS).
    //     Stats sit underneath as two small "pills" — players reached
    //     and games supported. Carousel is sorted by players_count desc
    //     so the order of cards itself communicates rank; the pills
    //     give the absolute numbers at a glance.
    const players = Number(subject.players || 0);
    const games   = Number(subject.games   || 0);
    const fmtCount = (n) => n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
    const label = document.createElement('div');
    label.className = 'lobby-carousel__label';
    label.innerHTML = `
        <span class="lobby-carousel__name">${escape(subject.name || 'Untitled')}</span>
        ${(players || games) ? `
            <span class="lobby-carousel__stats">
                ${players > 0 ? `
                    <span class="lobby-carousel__stat" title="Players who own this DexHero">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                        <span>${fmtCount(players)}</span>
                    </span>` : ''}
                ${games > 0 ? `
                    <span class="lobby-carousel__stat" title="Games this DexHero rides in">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="6" y1="11" x2="10" y2="11"/>
                            <line x1="8" y1="9" x2="8" y2="13"/>
                            <line x1="15" y1="12" x2="15.01" y2="12"/>
                            <line x1="18" y1="10" x2="18.01" y2="10"/>
                            <path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258A4 4 0 0 0 17.32 5z"/>
                        </svg>
                        <span>${fmtCount(games)}</span>
                    </span>` : ''}
            </span>` : ''}
    `;
    a.appendChild(label);

    return a;
}

export function destroyCard(el) {
    if (!el) return;
    if (el._heroTurntable?.destroy) {
        try { el._heroTurntable.destroy(); } catch {}
    }
}

function escape(s) {
    return String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]);
}
