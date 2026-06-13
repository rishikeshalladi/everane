/* med-image.js
 * Shared helper for the Everane medication-image feature.
 *
 * Public API (mounted on window.MedImage):
 *   - lookup(name)                     -> Promise<{isMed, canonical, genericName, form, imageUrl, source}>
 *   - fallbackPillSvgDataUri()         -> string (data: URI for the neutral pill icon)
 *   - applyImgFallback(imgEl)          -> attaches onerror handler swapping to pill SVG
 *   - renderInlineCard(opts)           -> HTMLElement (a styled image card for inline/right-side use)
 *   - renderFloatingCard(opts)         -> HTMLElement (a fixed-positioned floating card for voice flow)
 *   - renderCardImage(opts)            -> HTMLElement (a soft-blend image for home cards)
 *   - debounce(fn, ms)                 -> debounce helper
 *
 * The helper depends on Firebase Auth being initialized on the page; it grabs
 * an ID token via window.auth.currentUser.getIdToken().
 */
(function () {
  'use strict';

  const LOOKUP_URL = 'https://us-central1-medtracker-8c467.cloudfunctions.net/lookupMedicationImage';

  // Neutral pill silhouette — minimal SVG, dark-mode friendly via currentColor.
  const PILL_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" aria-hidden="true">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3f6ff5" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#7a5cff" stop-opacity="0.32"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="22" fill="url(#g)"/>
  <g transform="translate(18 22) rotate(-22 32 28)">
    <rect x="0" y="14" width="64" height="28" rx="14" fill="#ffffff" opacity="0.9"/>
    <rect x="0" y="14" width="32" height="28" rx="14" fill="#3f6ff5" opacity="0.85"/>
    <rect x="31" y="14" width="2" height="28" fill="#ffffff" opacity="0.65"/>
  </g>
</svg>`.trim();

  function fallbackPillSvgDataUri() {
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(PILL_SVG);
  }

  function applyImgFallback(imgEl) {
    if (!imgEl) return;
    imgEl.referrerPolicy = 'no-referrer';
    imgEl.loading = 'lazy';
    imgEl.decoding = 'async';
    imgEl.addEventListener('error', function onErr() {
      imgEl.removeEventListener('error', onErr);
      imgEl.src = fallbackPillSvgDataUri();
      imgEl.dataset.fellback = '1';
    });
  }

  // Tiny in-tab memo so the same page doesn't refetch a name twice during a session.
  const memo = new Map();
  // De-dupe concurrent lookups for the same key.
  const inflight = new Map();

  async function getIdTokenOrThrow() {
    if (!window.auth || !window.auth.currentUser) {
      throw new Error('not signed in');
    }
    return await window.auth.currentUser.getIdToken();
  }

  async function lookup(rawName) {
    const name = String(rawName || '').trim();
    if (!name || name.length < 2) {
      return { isMed: false, canonical: null, genericName: null, form: null, imageUrl: null, source: 'none' };
    }
    const key = name.toLowerCase();
    if (memo.has(key)) return memo.get(key);
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      let idToken = null;
      try { idToken = await getIdTokenOrThrow(); }
      catch (_) {
        return { isMed: false, canonical: null, genericName: null, form: null, imageUrl: null, source: 'none' };
      }
      try {
        const r = await fetch(LOOKUP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
          body: JSON.stringify({ name }),
        });
        if (!r.ok) {
          return { isMed: false, canonical: null, genericName: null, form: null, imageUrl: null, source: 'error' };
        }
        const data = await r.json();
        memo.set(key, data);
        return data;
      } catch (e) {
        return { isMed: false, canonical: null, genericName: null, form: null, imageUrl: null, source: 'error' };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  }

  // ---------- Renderers ---------------------------------------------------

  function ensureStylesInjected() {
    if (document.getElementById('med-image-styles')) return;
    const css = `
.medimg-card {
  --medimg-size: 200px;
  --medimg-radius: 18px;
  --medimg-accent: #3f6ff5;
  --medimg-accent-2: #7a5cff;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  padding: 0.7rem;
  border-radius: var(--medimg-radius);
  background:
    radial-gradient(120% 120% at 0% 0%, color-mix(in oklab, var(--medimg-accent) 14%, transparent), transparent 70%),
    radial-gradient(120% 120% at 100% 100%, color-mix(in oklab, var(--medimg-accent-2) 14%, transparent), transparent 70%),
    color-mix(in oklab, var(--surface, #ffffff) 92%, transparent);
  border: 1px solid color-mix(in oklab, var(--border, #e5e7eb) 85%, transparent);
  box-shadow: 0 10px 22px rgba(63, 111, 245, 0.10), 0 1px 0 rgba(255,255,255,0.5) inset;
  transition: transform .22s ease, box-shadow .22s ease, opacity .22s ease;
  opacity: 0;
  transform: scale(.96);
}
.medimg-card.is-shown {
  opacity: 1;
  transform: scale(1);
}
.medimg-card__img-wrap {
  width: var(--medimg-size);
  height: var(--medimg-size);
  border-radius: calc(var(--medimg-radius) - 4px);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: color-mix(in oklab, var(--surface, #ffffff) 94%, transparent);
}
.medimg-card__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: transparent;
}
.medimg-card__label {
  font-size: 0.92rem;
  font-weight: 700;
  color: var(--text, #0f172a);
  letter-spacing: 0.01em;
  text-align: center;
  max-width: var(--medimg-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.medimg-card__sub {
  font-size: 0.78rem;
  color: var(--muted, #64748b);
  text-align: center;
  max-width: var(--medimg-size);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: -0.2rem;
}

/* Summary paragraph shown below the card (only on add/edit/renew forms). */
.medimg-summary {
  margin-top: 0.85rem;
  padding: 0.85rem 1rem;
  border-radius: 14px;
  border: 1px solid color-mix(in oklab, var(--border, #e5e7eb) 80%, transparent);
  background: color-mix(in oklab, var(--surface, #ffffff) 96%, transparent);
  color: var(--text, #0f172a);
  font-size: 0.9rem;
  line-height: 1.55;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity .25s ease .05s, transform .25s ease .05s;
  max-width: 100%;
}
.medimg-summary.is-shown {
  opacity: 1;
  transform: translateY(0);
}
.medimg-summary__label {
  display: block;
  font-size: 0.7rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted, #64748b);
  margin-bottom: 0.35rem;
}

/* Floating voice card */
.medimg-floating {
  position: fixed;
  top: 88px;
  right: 22px;
  z-index: 5;
  opacity: 0;
  transform: translateX(40px);
  transition: opacity .3s ease, transform .3s ease;
}
.medimg-floating.is-shown {
  opacity: 1;
  transform: translateX(0);
}
@media (max-width: 720px) {
  .medimg-floating {
    top: 64px;
    right: 50%;
    transform: translate(50%, -20px);
  }
  .medimg-floating.is-shown {
    transform: translate(50%, 0);
  }
  .medimg-floating .medimg-card { --medimg-size: 110px; }
}

/* Soft-blend image used on home cards */
.medimg-soft {
  width: var(--medimg-soft-size, 96px);
  height: var(--medimg-soft-size, 96px);
  border-radius: 16px;
  object-fit: cover;
  background: color-mix(in oklab, var(--surface, #ffffff) 92%, transparent);
  -webkit-mask-image: radial-gradient(120% 120% at 50% 50%, #000 70%, transparent 100%);
          mask-image: radial-gradient(120% 120% at 50% 50%, #000 70%, transparent 100%);
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.10), inset 0 0 0 1px rgba(255,255,255,0.4);
  flex-shrink: 0;
  display: block;
}
@media (max-width: 720px) {
  .medimg-soft { --medimg-soft-size: 72px; }
}

/* Inline two-column wrapper for add-medication / renew / email-action */
.medimg-inline-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 1.4rem;
}
/* Pull the input column away from the image so it doesn't run edge-to-edge. */
.medimg-inline-row > :first-child {
  max-width: 520px;
}
@media (max-width: 720px) {
  .medimg-inline-row { grid-template-columns: 1fr; gap: 1rem; }
  .medimg-inline-row > :first-child { max-width: none; }
  .medimg-inline-row > .medimg-card {
    justify-self: center;
    --medimg-size: 140px;
  }
}
`.trim();
    const styleEl = document.createElement('style');
    styleEl.id = 'med-image-styles';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  /**
   * Render an inline image card (used in add-medication, renew, email-action).
   * @param {Object} opts
   * @param {string} opts.imageUrl
   * @param {string} [opts.canonical]
   * @param {string} [opts.genericName]
   * @param {number} [opts.size] pixel size; default 140
   * @returns {HTMLElement}
   */
  function renderInlineCard(opts) {
    ensureStylesInjected();
    const card = document.createElement('div');
    card.className = 'medimg-card';
    if (opts.size) card.style.setProperty('--medimg-size', opts.size + 'px');

    const wrap = document.createElement('div');
    wrap.className = 'medimg-card__img-wrap';
    const img = document.createElement('img');
    img.className = 'medimg-card__img';
    img.alt = opts.canonical || 'Medication';
    img.src = opts.imageUrl || fallbackPillSvgDataUri();
    applyImgFallback(img);
    wrap.appendChild(img);
    card.appendChild(wrap);

    if (opts.canonical) {
      const label = document.createElement('div');
      label.className = 'medimg-card__label';
      label.textContent = opts.canonical;
      card.appendChild(label);
    }
    if (opts.genericName && opts.canonical && opts.genericName.toLowerCase() !== String(opts.canonical).toLowerCase()) {
      const sub = document.createElement('div');
      sub.className = 'medimg-card__sub';
      sub.textContent = opts.genericName;
      card.appendChild(sub);
    }
    requestAnimationFrame(() => card.classList.add('is-shown'));
    return card;
  }

  /**
   * Render a fixed-positioned floating image card (used in the AI Voice page).
   * Returns the wrapper element; caller is responsible for inserting + later removing.
   * @param {Object} opts {imageUrl, canonical, genericName}
   */
  function renderFloatingCard(opts) {
    ensureStylesInjected();
    const wrap = document.createElement('div');
    wrap.className = 'medimg-floating';
    const card = renderInlineCard(opts);
    wrap.appendChild(card);
    requestAnimationFrame(() => wrap.classList.add('is-shown'));
    return wrap;
  }

  /**
   * Render the standalone "About this medication" summary block.
   * Used ONLY on add/edit/renew forms (not on home cards or email-action).
   * @param {Object} opts {summary, canonical}
   * @returns {HTMLElement|null}
   */
  function renderSummary(opts) {
    ensureStylesInjected();
    const summary = opts && typeof opts.summary === 'string' ? opts.summary.trim() : '';
    if (!summary) return null;
    const box = document.createElement('div');
    box.className = 'medimg-summary';
    const label = document.createElement('span');
    label.className = 'medimg-summary__label';
    label.textContent = opts && opts.canonical ? `About ${opts.canonical}` : 'About this medication';
    box.appendChild(label);
    const p = document.createElement('p');
    p.style.margin = '0';
    p.textContent = summary;
    box.appendChild(p);
    requestAnimationFrame(() => box.classList.add('is-shown'));
    return box;
  }

  /**
   * Render the soft-blend square image used on home med cards.
   * @param {Object} opts {imageUrl, alt}
   * @returns {HTMLImageElement}
   */
  function renderCardImage(opts) {
    ensureStylesInjected();
    const img = document.createElement('img');
    img.className = 'medimg-soft';
    img.alt = (opts && opts.alt) || 'Medication';
    img.src = (opts && opts.imageUrl) || fallbackPillSvgDataUri();
    applyImgFallback(img);
    return img;
  }

  window.MedImage = {
    lookup,
    debounce,
    fallbackPillSvgDataUri,
    applyImgFallback,
    renderInlineCard,
    renderSummary,
    renderFloatingCard,
    renderCardImage,
  };
})();
