/**
 * Everane Interactive Tutorial — v3 (SVG-mask spotlight)
 *
 * 10-step guided tour with a TRUE spotlight cutout drawn as an SVG mask.
 * The highlighted element receives zero overlay paint on top of it, so there
 * is no blur, no dimming, no GPU-compositing artifact.
 *
 * Why v3?
 *   v1 used backdrop-filter + a clear rect on top of the highlight (blurred
 *   the element through the overlay).
 *   v2 used four DOM rectangles around the cutout (still produced subpixel
 *   re-rasterization artifacts on some browsers + retina displays).
 *   v3 uses an <svg> covering the viewport with a <mask>: the background of
 *   the overlay is a dark rect, the cutout is a transparent rect at the
 *   highlight position. SVG masking composites at the pixel level — no
 *   layer-promotion side effects.
 *
 * Other behaviour:
 *   - MutationObserver-backed waitForElement (up to 5s) so async-mounted
 *     elements are still found after page navigation.
 *   - sessionStorage is the source of truth for "tour is in-flight";
 *     Firestore flag is only used to detect first-ever visit for auto-start.
 *   - rAF loop keeps the cutout pinned to the element through any
 *     resize / scroll / DOM reflow.
 */
(function () {
  if (window.Everane && window.Everane.Tutorial && window.Everane.Tutorial._loaded) {
    return;
  }
  window.Everane = window.Everane || {};

  const STORAGE_KEY = 'everaneTutorialState';
  const FLAG_DOC_FIELD = 'tutorialCompleted';
  const PAD = 10;
  const WAIT_FOR_EL_MS = 5000;
  const RESUME_DELAY_MS = 250;

  const inCaregiverSubfolder = window.location.pathname.includes('/caregiver/');
  function root(rel) { return inCaregiverSubfolder ? '../' + rel : rel; }

  const STEPS = [
    {
      id: 'welcome',
      page: 'home.html',
      selector: null,
      title: 'Welcome to Everane',
      body: "Let's take a quick tour. You'll learn how to track meds, get reminders, and see your adherence. About one minute."
    },
    {
      id: 'home-med-list',
      page: 'home.html',
      // Prefer the demo card first (we inject it in setup if list is empty),
      // then a real card if one exists, then fall back to the list container.
      selector: '[data-tutorial="demo-med-card"], #med-list .card, [data-tutorial="med-list"] .card, #med-list > div',
      title: "Today's medications",
      body: "Each card is one of your medications. Tap Taken or Not Taken when you take a dose — adherence tracking happens automatically.",
      // setup runs before we measure / highlight; teardown runs when leaving this step
      setup: () => injectDemoMedCardIfEmpty(),
      teardown: () => removeDemoMedCard()
    },
    {
      id: 'add-medication',
      page: 'home.html',
      selector: '[data-tutorial="add-medication"], a[href="add-medication.html"], .sidebar a[href*="add-medication"]',
      title: 'Adding a medication',
      body: 'Click here to add a new medication. You can either fill out the form manually or use AI voice — talk and the AI fills it in for you.'
    },
    {
      id: 'medicom',
      page: 'home.html',
      selector: '[data-tutorial="medicom"], a[href="medicom.html"], .sidebar a[href*="medicom"]',
      title: 'Add a doctor',
      body: 'Communication lets your doctor see your med list and suggest edits. Once you set up Doctor Access, they can review your adherence.'
    },
    {
      id: 'history',
      page: 'history.html',
      selector: '[data-tutorial="history-content"], h1, .container > h1, main h1',
      title: 'History',
      body: 'Every dose you delete, shows up here just in case you need to retake it again!'
    },
    {
      id: 'calendar',
      page: 'calendar.html',
      selector: '[data-tutorial="calendar-content"], h1, .container > h1, main h1',
      title: 'Calendar',
      body: 'See your medication schedule visually. Each day shows what was taken, missed, or upcoming.'
    },
    {
      id: 'stats',
      page: 'stats.html',
      selector: '[data-tutorial="stats-content"], h1, .container > h1, main h1',
      title: 'Stats & adherence',
      body: "Your adherence percentage and streaks live here. Daily, weekly, monthly — see how you're doing at a glance."
    },
    {
      id: 'notes',
      page: 'notes.html',
      selector: '[data-tutorial="notes-content"], h1, .container > h1, main h1',
      title: 'Notes',
      body: 'Log a note on any dose — side effects, food taken with it, anything. Your doctor sees these too if you grant access.'
    },
    {
      id: 'profile-notifications',
      page: 'profile.html',
      selector: '[data-tutorial="profile-notifications"], .notification-reminders, #notification-dropdown-toggle',
      title: 'Reminder timing & caregivers',
      body: 'Choose when to be reminded (at the time, 30 min before, etc.) and add caregivers who should also get your reminders.'
    },
    {
      id: 'done',
      page: 'home.html',
      selector: null,
      title: "You're all set",
      body: "That's it! You can replay this tutorial anytime from your profile. Now go add your first medication."
    }
  ];

  // ---------- Demo card injection ----------
  // When the user has no real medications yet, the med-list step has nothing
  // to spotlight. We inject a fake demo card so the user sees what a real one
  // will look like, then tear it down when the step ends.
  function injectDemoMedCardIfEmpty() {
    const list = document.querySelector('#med-list, [data-tutorial="med-list"]');
    if (!list) return;
    // Real cards on home.html use class="card". Skip if any real card exists.
    if (list.querySelector('.card')) return;
    // Already injected — don't double-add
    if (list.querySelector('[data-tutorial="demo-med-card"]')) return;

    const demo = document.createElement('div');
    demo.className = 'card';
    demo.setAttribute('data-tutorial', 'demo-med-card');
    demo.setAttribute('data-everane-demo', '1');
    // Inline the layout so we don't depend on host stylesheets being a
    // specific version. Matches the visual style of real cards.
    demo.style.cssText = [
      'background: var(--surface, #ffffff)',
      'border: 1px solid var(--border, #e5e7eb)',
      'border-radius: var(--radius, 16px)',
      'padding: 1rem 1.1rem',
      'margin: 0 auto 0.75rem',
      'max-width: 560px',
      'box-shadow: var(--shadow, 0 6px 18px rgba(15,23,42,0.08))',
      'color: var(--text, #1f2933)',
      'font-family: inherit'
    ].join(';');
    demo.innerHTML = `
      <h2 style="margin:0 0 .35rem; font-size:1.15rem; font-weight:800;">Sample Medication</h2>
      <p style="margin:0; line-height:1.55;">
        <strong>Per Week:</strong> 7 dosages<br>
        <strong>Per Day:</strong> 1 dosage<br>
        <strong>Next Dosage:</strong> 9:00 AM
      </p>
      <div style="margin-top:.75rem; display:flex; gap:.45rem; flex-wrap:wrap;">
        <button type="button" disabled style="padding:.45rem .85rem; border:none; border-radius:999px; background:#10b981; color:#fff; font-weight:600; font-size:.85rem; opacity:.95; cursor:default;">Taken</button>
        <button type="button" disabled style="padding:.45rem .85rem; border:none; border-radius:999px; background:#ef4444; color:#fff; font-weight:600; font-size:.85rem; opacity:.95; cursor:default;">Not Taken</button>
        <button type="button" disabled style="padding:.45rem .85rem; border:none; border-radius:999px; background:color-mix(in oklab, #6b7280 18%, transparent); color:var(--text, #1f2933); font-weight:600; font-size:.85rem; opacity:.85; cursor:default;">Edit</button>
        <button type="button" disabled style="padding:.45rem .85rem; border:none; border-radius:999px; background:color-mix(in oklab, #6b7280 18%, transparent); color:var(--text, #1f2933); font-weight:600; font-size:.85rem; opacity:.85; cursor:default;">Stock</button>
      </div>
      <div style="margin-top:.5rem; font-size:.78rem; color:var(--muted, #6b7280); font-style:italic;">
        ↑ Example only — your real medications will appear here once you add one.
      </div>
    `;
    list.appendChild(demo);
  }
  function removeDemoMedCard() {
    const demo = document.querySelector('[data-tutorial="demo-med-card"], [data-everane-demo="1"]');
    if (demo && demo.parentNode) demo.parentNode.removeChild(demo);
  }

  // ---------- State ----------
  function readState() {
    try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null'); } catch (_) { return null; }
  }
  function writeState(s) { try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {} }
  function clearState() { try { sessionStorage.removeItem(STORAGE_KEY); } catch (_) {} }

  // ---------- DOM ----------
  // SVG overlay with mask cutout. Highlighted region is mathematically
  // transparent — no paint, no blur, no GPU layer side effects.
  let overlaySvg = null;
  let overlayRect = null;
  let overlayCutout = null;
  let highlightRing = null;
  let tooltipEl = null;
  let positionLoopId = null;
  let currentTargetSel = null;

  function injectStyles() {
    if (document.getElementById('everane-tutorial-styles')) return;
    const style = document.createElement('style');
    style.id = 'everane-tutorial-styles';
    style.textContent = `
      .everane-tut-svg {
        position: fixed; inset: 0;
        width: 100vw; height: 100vh;
        z-index: 99998;
        pointer-events: auto;
        animation: everane-tut-fadein .25s ease;
      }
      @keyframes everane-tut-fadein { from { opacity: 0; } to { opacity: 1; } }

      .everane-tut-ring {
        position: fixed;
        z-index: 99999;
        pointer-events: none;
        border-radius: 14px;
        /* Promote to own GPU layer so its pulse never repaints what's under it */
        transform: translateZ(0);
        will-change: top, left, width, height;
        /* Solid border + OUTER glow shadows only. No inset shadow.
           The inside of the ring stays totally untouched. */
        border: 3px solid rgba(63, 111, 245, 1);
        box-shadow:
          0 0 0 8px rgba(63, 111, 245, 0.28),
          0 0 40px 8px rgba(63, 111, 245, 0.55);
        transition: top .25s cubic-bezier(.2,.8,.2,1),
                    left .25s cubic-bezier(.2,.8,.2,1),
                    width .25s cubic-bezier(.2,.8,.2,1),
                    height .25s cubic-bezier(.2,.8,.2,1);
        animation: everane-tut-pulse 2s ease-in-out infinite;
      }
      @keyframes everane-tut-pulse {
        0%, 100% { box-shadow: 0 0 0 8px rgba(63,111,245,.28), 0 0 40px 8px rgba(63,111,245,.55); }
        50%      { box-shadow: 0 0 0 14px rgba(63,111,245,.16), 0 0 56px 14px rgba(63,111,245,.7); }
      }

      .everane-tut-tooltip {
        position: fixed;
        z-index: 100000;
        max-width: min(420px, calc(100vw - 32px));
        background: #ffffff;
        color: #1f2933;
        border-radius: 18px;
        padding: 22px 22px 18px;
        box-shadow: 0 24px 60px -8px rgba(8, 12, 24, 0.6);
        font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
        animation: everane-tut-tooltipin .3s ease;
      }
      @keyframes everane-tut-tooltipin {
        from { opacity: 0; transform: translateY(6px) scale(.98); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .everane-tut-tooltip__step {
        font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase;
        color: #3f6ff5; margin: 0 0 6px;
      }
      .everane-tut-tooltip__title {
        font-size: 20px; font-weight: 800; margin: 0 0 10px; color: #0f172a; line-height: 1.25;
      }
      .everane-tut-tooltip__body {
        font-size: 15px; line-height: 1.55; color: #44506b; margin: 0 0 18px;
      }
      .everane-tut-tooltip__actions {
        display: flex; align-items: center; gap: 10px; justify-content: space-between;
      }
      .everane-tut-tooltip__progress {
        display: flex; gap: 5px; align-items: center;
      }
      .everane-tut-tooltip__dot {
        width: 7px; height: 7px; border-radius: 50%; background: #d7e3ff; transition: background .2s, transform .2s;
      }
      .everane-tut-tooltip__dot--active { background: #3f6ff5; transform: scale(1.35); }
      .everane-tut-tooltip__btns { display: flex; gap: 8px; }
      .everane-tut-btn {
        font-family: inherit; font-size: 14px; font-weight: 600;
        border: none; border-radius: 999px;
        padding: 9px 18px; cursor: pointer;
        transition: transform .15s, background .15s, box-shadow .15s;
      }
      .everane-tut-btn:hover { transform: translateY(-1px); }
      .everane-tut-btn--skip { background: transparent; color: #6b7280; }
      .everane-tut-btn--skip:hover { color: #1f2933; background: rgba(0,0,0,0.04); }
      .everane-tut-btn--next {
        background: linear-gradient(135deg, #3f6ff5, #2850c6);
        color: white;
        box-shadow: 0 8px 22px -8px rgba(63,111,245,.6);
      }
      .everane-tut-btn--next:hover { box-shadow: 0 12px 28px -8px rgba(63,111,245,.75); }

      .everane-tut-tooltip--center {
        left: 50% !important;
        top: 50% !important;
        transform: translate(-50%, -50%);
      }

      @media (prefers-color-scheme: dark) {
        .everane-tut-tooltip { background: #161b27; color: #e7ecf6; }
        .everane-tut-tooltip__title { color: #f5f7fb; }
        .everane-tut-tooltip__body { color: #b6c0d4; }
        .everane-tut-tooltip__dot { background: #2a3247; }
      }

      .everane-tut-lock-scroll { overflow: hidden !important; }
    `;
    document.head.appendChild(style);
  }

  function ensureNodes() {
    if (!overlaySvg) {
      const NS = 'http://www.w3.org/2000/svg';
      overlaySvg = document.createElementNS(NS, 'svg');
      overlaySvg.setAttribute('class', 'everane-tut-svg');
      overlaySvg.setAttribute('preserveAspectRatio', 'none');

      const defs = document.createElementNS(NS, 'defs');
      const mask = document.createElementNS(NS, 'mask');
      mask.setAttribute('id', 'everane-tut-mask');
      // In a mask, white = show this region, black = hide it.
      const fullWhite = document.createElementNS(NS, 'rect');
      fullWhite.setAttribute('width', '100%');
      fullWhite.setAttribute('height', '100%');
      fullWhite.setAttribute('fill', 'white');
      mask.appendChild(fullWhite);
      // Black rectangle for the cutout — this becomes the transparent hole.
      overlayCutout = document.createElementNS(NS, 'rect');
      overlayCutout.setAttribute('fill', 'black');
      overlayCutout.setAttribute('rx', '14');
      overlayCutout.setAttribute('ry', '14');
      overlayCutout.setAttribute('x', '-1000');
      overlayCutout.setAttribute('y', '-1000');
      overlayCutout.setAttribute('width', '0');
      overlayCutout.setAttribute('height', '0');
      mask.appendChild(overlayCutout);
      defs.appendChild(mask);
      overlaySvg.appendChild(defs);

      // The dim rect, masked.
      overlayRect = document.createElementNS(NS, 'rect');
      overlayRect.setAttribute('x', '0');
      overlayRect.setAttribute('y', '0');
      overlayRect.setAttribute('width', '100%');
      overlayRect.setAttribute('height', '100%');
      overlayRect.setAttribute('fill', 'rgba(8, 12, 24, 0.74)');
      overlayRect.setAttribute('mask', 'url(#everane-tut-mask)');
      overlaySvg.appendChild(overlayRect);

      document.body.appendChild(overlaySvg);
    }
    if (!highlightRing) {
      highlightRing = document.createElement('div');
      highlightRing.className = 'everane-tut-ring';
      highlightRing.style.display = 'none';
      document.body.appendChild(highlightRing);
    }
    if (!tooltipEl) {
      tooltipEl = document.createElement('div');
      tooltipEl.className = 'everane-tut-tooltip';
      document.body.appendChild(tooltipEl);
    }
  }

  function teardown() {
    if (positionLoopId) { cancelAnimationFrame(positionLoopId); positionLoopId = null; }
    currentTargetSel = null;
    [overlaySvg, highlightRing, tooltipEl].forEach(el => {
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    overlaySvg = null;
    overlayRect = null;
    overlayCutout = null;
    highlightRing = null;
    tooltipEl = null;
    document.documentElement.classList.remove('everane-tut-lock-scroll');
    document.body.classList.remove('everane-tut-lock-scroll');
  }

  function findElement(selector) {
    if (!selector) return null;
    const candidates = selector.split(',').map(s => s.trim()).filter(Boolean);
    for (const sel of candidates) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return el;
        }
      } catch (_) { /* skip invalid selector */ }
    }
    return null;
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
      const found = findElement(selector);
      if (found) return resolve(found);
      const start = Date.now();
      let observer = null;
      const tick = () => {
        const el = findElement(selector);
        if (el) { if (observer) observer.disconnect(); resolve(el); return true; }
        return false;
      };
      observer = new MutationObserver(() => { tick(); });
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      const poll = setInterval(() => {
        if (tick()) { clearInterval(poll); return; }
        if (Date.now() - start > (timeoutMs || WAIT_FOR_EL_MS)) {
          clearInterval(poll);
          if (observer) observer.disconnect();
          resolve(null);
        }
      }, 150);
    });
  }

  // ---------- Layout ----------
  function setSvgViewBox() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    overlaySvg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    overlaySvg.style.width  = vw + 'px';
    overlaySvg.style.height = vh + 'px';
  }

  function placeOverlay(rect) {
    setSvgViewBox();
    if (!rect) {
      overlayCutout.setAttribute('x', '-1000');
      overlayCutout.setAttribute('y', '-1000');
      overlayCutout.setAttribute('width', '0');
      overlayCutout.setAttribute('height', '0');
      return;
    }
    const x = Math.max(0, rect.left - PAD);
    const y = Math.max(0, rect.top - PAD);
    const w = Math.min(window.innerWidth - x, rect.width + PAD * 2);
    const h = Math.min(window.innerHeight - y, rect.height + PAD * 2);
    overlayCutout.setAttribute('x', x);
    overlayCutout.setAttribute('y', y);
    overlayCutout.setAttribute('width', w);
    overlayCutout.setAttribute('height', h);
  }

  function placeRing(rect) {
    if (!rect) { highlightRing.style.display = 'none'; return; }
    highlightRing.style.display = 'block';
    highlightRing.style.top    = `${Math.max(0, rect.top - PAD)}px`;
    highlightRing.style.left   = `${Math.max(0, rect.left - PAD)}px`;
    highlightRing.style.width  = `${rect.width + PAD * 2}px`;
    highlightRing.style.height = `${rect.height + PAD * 2}px`;
  }

  function placeTooltip(rect) {
    if (!tooltipEl) return;
    tooltipEl.classList.remove('everane-tut-tooltip--center');
    if (!rect) {
      tooltipEl.classList.add('everane-tut-tooltip--center');
      tooltipEl.style.left = '';
      tooltipEl.style.top  = '';
      return;
    }
    const tt = tooltipEl.getBoundingClientRect();
    const margin = 14;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = rect.bottom + margin;
    let left = rect.left + (rect.width / 2) - (tt.width / 2);
    if (top + tt.height + 16 > vh) {
      const aboveTop = rect.top - tt.height - margin;
      if (aboveTop >= 16) {
        top = aboveTop;
      } else {
        const rightLeft = rect.right + margin;
        if (rightLeft + tt.width + 16 < vw) {
          top = Math.max(16, Math.min(vh - tt.height - 16, rect.top));
          left = rightLeft;
        } else {
          left = Math.max(16, rect.left - tt.width - margin);
          top = Math.max(16, Math.min(vh - tt.height - 16, rect.top));
        }
      }
    }
    left = Math.max(16, Math.min(vw - tt.width - 16, left));
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top  = `${top}px`;
  }

  function startPositionLoop(selector) {
    currentTargetSel = selector;
    let lastRectStr = '';
    let lastViewport = '';
    const loop = () => {
      const vpKey = window.innerWidth + 'x' + window.innerHeight;
      const el = currentTargetSel ? findElement(currentTargetSel) : null;
      if (el) {
        const r = el.getBoundingClientRect();
        const key = `${r.top}|${r.left}|${r.width}|${r.height}|${vpKey}`;
        if (key !== lastRectStr || vpKey !== lastViewport) {
          lastRectStr = key;
          lastViewport = vpKey;
          placeOverlay(r);
          placeRing(r);
          placeTooltip(r);
        }
      } else if (currentTargetSel) {
        placeOverlay(null);
        placeRing(null);
        placeTooltip(null);
      } else if (vpKey !== lastViewport) {
        lastViewport = vpKey;
        setSvgViewBox();
      }
      positionLoopId = requestAnimationFrame(loop);
    };
    if (positionLoopId) cancelAnimationFrame(positionLoopId);
    positionLoopId = requestAnimationFrame(loop);
  }

  function stopPositionLoop() {
    if (positionLoopId) { cancelAnimationFrame(positionLoopId); positionLoopId = null; }
    currentTargetSel = null;
  }

  // Tracks the currently-rendered step so we can tear it down when moving on.
  let activeStepIndex = -1;
  function teardownStep(stepIndex) {
    const s = STEPS[stepIndex];
    if (s && typeof s.teardown === 'function') {
      try { s.teardown(); } catch (e) { /* ignore */ }
    }
  }

  // ---------- Render a step ----------
  async function renderStep(stepIndex) {
    // Tear down the previously-active step (e.g. remove the demo med card)
    if (activeStepIndex !== -1 && activeStepIndex !== stepIndex) {
      teardownStep(activeStepIndex);
    }
    activeStepIndex = stepIndex;

    const step = STEPS[stepIndex];
    if (!step) { finish(true); return; }
    ensureNodes();

    // Run this step's setup hook BEFORE we measure / wait for the selector,
    // so injected elements (like a demo med card) are findable.
    if (typeof step.setup === 'function') {
      try { step.setup(); } catch (e) { /* ignore */ }
    }

    document.documentElement.classList.add('everane-tut-lock-scroll');
    document.body.classList.add('everane-tut-lock-scroll');

    const dots = STEPS.map((_, i) => `<span class="everane-tut-tooltip__dot ${i === stepIndex ? 'everane-tut-tooltip__dot--active' : ''}"></span>`).join('');
    const isLast = stepIndex === STEPS.length - 1;
    tooltipEl.innerHTML = `
      <div class="everane-tut-tooltip__step">Step ${stepIndex + 1} of ${STEPS.length}</div>
      <div class="everane-tut-tooltip__title"></div>
      <div class="everane-tut-tooltip__body"></div>
      <div class="everane-tut-tooltip__actions">
        <div class="everane-tut-tooltip__progress">${dots}</div>
        <div class="everane-tut-tooltip__btns">
          <button type="button" class="everane-tut-btn everane-tut-btn--skip" data-action="skip">${isLast ? '' : 'Skip'}</button>
          <button type="button" class="everane-tut-btn everane-tut-btn--next" data-action="next">${isLast ? 'Done' : 'Next'}</button>
        </div>
      </div>
    `;
    tooltipEl.querySelector('.everane-tut-tooltip__title').textContent = step.title;
    tooltipEl.querySelector('.everane-tut-tooltip__body').textContent = step.body;

    const skipBtn = tooltipEl.querySelector('[data-action="skip"]');
    if (isLast && skipBtn) skipBtn.style.display = 'none';

    tooltipEl.querySelector('[data-action="next"]').addEventListener('click', () => advance(stepIndex));
    if (skipBtn) skipBtn.addEventListener('click', () => finish(true));

    let el = null;
    if (step.selector) {
      placeOverlay(null);
      placeRing(null);
      placeTooltip(null);
      el = await waitForElement(step.selector, WAIT_FOR_EL_MS);
    }

    if (el) {
      document.documentElement.classList.remove('everane-tut-lock-scroll');
      document.body.classList.remove('everane-tut-lock-scroll');
      try { el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }); }
      catch (_) { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (__) {} }
      requestAnimationFrame(() => {
        document.documentElement.classList.add('everane-tut-lock-scroll');
        document.body.classList.add('everane-tut-lock-scroll');
        const r = el.getBoundingClientRect();
        placeOverlay(r);
        placeRing(r);
        tooltipEl.style.left = '-9999px';
        tooltipEl.style.top  = '-9999px';
        requestAnimationFrame(() => {
          placeTooltip(el.getBoundingClientRect());
          startPositionLoop(step.selector);
        });
      });
    } else {
      placeOverlay(null);
      placeRing(null);
      placeTooltip(null);
      stopPositionLoop();
    }
  }

  function pageOf(step) { return step && step.page ? step.page : null; }
  function currentPathBasename() {
    const p = window.location.pathname;
    return p.split('/').filter(Boolean).pop() || 'index.html';
  }

  function navigateIfNeeded(stepIndex) {
    const step = STEPS[stepIndex];
    const want = pageOf(step);
    if (!want) return false;
    if (currentPathBasename() === want) return false;
    // Tear down the currently-active step's DOM injections (e.g. demo med card)
    // before navigating, so we don't leave artifacts behind on the page we leave.
    if (activeStepIndex !== -1) {
      teardownStep(activeStepIndex);
      activeStepIndex = -1;
    }
    writeState({ active: true, stepIndex });
    window.location.href = root(want);
    return true;
  }

  function advance(fromIndex) {
    const next = fromIndex + 1;
    if (next >= STEPS.length) { finish(true); return; }
    writeState({ active: true, stepIndex: next });
    if (navigateIfNeeded(next)) return;
    renderStep(next);
  }

  async function finish(persistFlag) {
    // Run the active step's teardown (e.g. remove demo med card) before tearing
    // down the overlay nodes.
    if (activeStepIndex !== -1) {
      teardownStep(activeStepIndex);
      activeStepIndex = -1;
    }
    teardown();
    clearState();
    if (persistFlag) {
      try {
        const a = window.auth, db = window.db, d = window.doc, s = window.setDoc;
        if (a && a.currentUser && db && d && s) {
          await s(d(db, 'users', a.currentUser.uid), { [FLAG_DOC_FIELD]: true }, { merge: true });
        }
      } catch (_) {}
    }
  }

  // ---------- Public API ----------
  function start() {
    writeState({ active: true, stepIndex: 0 });
    if (navigateIfNeeded(0)) return;
    injectStyles();
    renderStep(0);
  }

  function stop() { finish(false); }

  function resumeIfActive() {
    const state = readState();
    if (!state || !state.active) return;
    // Idempotent: if an overlay is already on screen, don't double-render.
    if (overlaySvg && overlaySvg.parentNode) return;
    const stepIndex = Math.max(0, Math.min(STEPS.length - 1, state.stepIndex || 0));
    const step = STEPS[stepIndex];
    if (!step) { clearState(); return; }
    const want = pageOf(step);
    const here = currentPathBasename();
    if (want && here !== want) {
      try { console.info('[Tutorial] wrong page; redirecting', here, '→', want); } catch (_) {}
      window.location.href = root(want);
      return;
    }
    setTimeout(() => {
      // Recheck state at fire-time — it might have been cleared
      const s2 = readState();
      if (!s2 || !s2.active) return;
      if (overlaySvg && overlaySvg.parentNode) return;
      injectStyles();
      try { console.info('[Tutorial] renderStep', stepIndex, step.id); } catch (_) {}
      renderStep(stepIndex);
    }, RESUME_DELAY_MS);
  }

  async function maybeAutoStart() {
    if (currentPathBasename() !== 'home.html') return;
    const state = readState();
    if (state && state.active) return;

    let tries = 0;
    while (tries < 60) {
      if (window.auth && window.auth.currentUser && window.db && window.doc && window.getDoc) break;
      await new Promise(r => setTimeout(r, 100));
      tries++;
    }
    if (!window.auth || !window.auth.currentUser) return;
    try {
      const snap = await window.getDoc(window.doc(window.db, 'users', window.auth.currentUser.uid));
      if (snap && snap.exists && snap.exists() && snap.data()[FLAG_DOC_FIELD] === true) return;
      injectStyles();
      writeState({ active: true, stepIndex: 0 });
      renderStep(0);
    } catch (_) {}
  }

  window.Everane.Tutorial = {
    _loaded: true,
    start,
    stop,
    STEPS,
    replay: () => {
      writeState({ active: true, stepIndex: 0 });
      try {
        const a = window.auth, db = window.db, d = window.doc, s = window.setDoc;
        if (a && a.currentUser && db && d && s) {
          s(d(db, 'users', a.currentUser.uid), { [FLAG_DOC_FIELD]: false }, { merge: true }).catch(() => {});
        }
      } catch (_) {}
      if (currentPathBasename() === 'home.html') {
        injectStyles();
        renderStep(0);
      } else {
        window.location.href = root('home.html');
      }
    }
  };

  // Boot logic: handle every realistic scenario the browser can throw at us.
  //   - Initial document parse (readyState === 'loading')   → wait for DOMContentLoaded
  //   - Fresh script execution after parsing                → run immediately
  //   - Back/forward bfcache restore                        → pageshow
  //   - Tab focus / visibility resume                       → visibilitychange
  // In every case we re-check sessionStorage and resume if a tour is in flight.
  let _bootAttempted = false;
  function boot(reason) {
    try { console.info('[Tutorial] boot:', reason, 'state=', readState(), 'path=', currentPathBasename()); } catch (_) {}
    _bootAttempted = true;
    resumeIfActive();
    maybeAutoStart();
  }
  function tryResume(reason) {
    const s = readState();
    if (s && s.active) {
      try { console.info('[Tutorial] tryResume:', reason, 'step=', s.stepIndex, 'path=', currentPathBasename()); } catch (_) {}
      resumeIfActive();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => boot('DOMContentLoaded'));
  } else {
    // Defer-loaded scripts hit this branch — DOM is already parsed.
    boot('immediate');
  }
  // bfcache restore: pageshow fires with persisted=true when the page is
  // restored from the browser's back/forward cache. Module init may not re-run
  // in that case, so we must re-resume manually.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) tryResume('pageshow-bfcache');
    else if (!_bootAttempted) boot('pageshow-fresh');
  });
  // Visibility / focus retries — covers edge cases where the SW or auth flow
  // delays the tour render until the tab becomes visible.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') tryResume('visibilitychange');
  });
})();
