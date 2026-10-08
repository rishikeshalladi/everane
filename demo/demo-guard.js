/* Makes the demo inert.
 *
 * The fake Firestore already discards every write, so the data cannot change.
 * What it does not prevent is navigation: several controls jump straight to
 * pages the demo does not include (add-medication.html and friends) via
 * `location.href`, which cannot be intercepted. So those controls have to be
 * stopped before they run.
 *
 * Rather than setting `disabled` — which swallows the click silently and
 * leaves the visitor wondering whether the demo is broken — every action
 * control is marked inert and a capture-phase listener blocks the click and
 * says why. Only genuinely view-only controls (date navigation, range tabs,
 * close/cancel) are left alone.
 */
(function () {
  'use strict';

  // View-only controls: navigating dates, switching ranges, opening and
  // closing read-only panels. Everything not listed here is treated as an
  // action and blocked.
  var KEEP = [
    '.demo-banner__x',
    '.time-range-btn',          // stats: week / month / year / all
    '.nav-btn',                 // calendar month + notes day navigation
    '.mini-calendar-btn', '#mini-prev-month', '#mini-next-month',
    '#open-agenda-btn', '#agenda-close',
    '.nav-arrow',               // help carousel
    '.help-modal-close', '#close-help-modal', '#open-help-modal-from-popup',
    '#open-help-btn', '#finish-btn', '.finish-btn',
    '.popup-close-btn', '#close-first-time-popup',
    '.day-details-close', '.dose-status-close',
    '.modal-close', '.faq-modal__close', '.toast-close',
    '#groups-modal-close', '#stock-close-btn',
    '.pw-toggle',               // reveal/hide a field, writes nothing
    '#profile-more-btn', '#notification-dropdown-toggle', '.notification-dropdown-toggle'
  ].join(',');

  // Dismissals arrive under many names across the pages; match them by what
  // they say instead of enumerating every id.
  var KEEP_TEXT = /^(cancel|close|back|no|not now|never mind|dismiss|got it|done|ok|okay|skip|maybe later|×|✕|✖|x)$/i;
  var KEEP_LABEL = /^(close|hide|cancel|back|previous|next|dismiss)\b/i;

  function text(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isViewOnly(el) {
    try { if (el.matches(KEEP)) return true; } catch (_) {}
    if (KEEP_TEXT.test(text(el))) return true;
    if (KEEP_LABEL.test(el.getAttribute('aria-label') || '')) return true;
    return false;
  }

  function mark(root) {
    var scope = (root && root.querySelectorAll) ? root : document;
    var nodes;
    try { nodes = scope.querySelectorAll('button:not([data-demo-seen])'); }
    catch (_) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var b = nodes[i];
      b.setAttribute('data-demo-seen', '1');
      if (isViewOnly(b)) continue;
      b.setAttribute('data-demo-inert', '1');
      b.setAttribute('aria-disabled', 'true');
      if (!b.title) b.title = 'Not available in this demo';
    }
    lockFields(scope);
  }

  // Every field in the demo is an edit field — there are no view filters — so
  // they all lock. Text stays readable and selectable rather than disabled,
  // which keeps the sample notes and profile legible; the rest is disabled so
  // its current value still shows.
  function lockFields(scope) {
    var fields;
    try { fields = scope.querySelectorAll('input:not([data-demo-seen]), textarea:not([data-demo-seen]), select:not([data-demo-seen])'); }
    catch (_) { return; }
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      f.setAttribute('data-demo-seen', '1');
      // The hamburger is a bare checkbox driving `.menu-toggle:checked ~ nav`,
      // so disabling it would take the sidebar with it.
      if (f.classList.contains('menu-toggle') || f.id === 'menu-toggle') continue;
      var type = (f.getAttribute('type') || '').toLowerCase();
      if (f.tagName === 'TEXTAREA' || (f.tagName === 'INPUT' && !/^(checkbox|radio|range|file|color|submit|button|reset)$/.test(type))) {
        f.readOnly = true;
        f.setAttribute('data-demo-readonly', '1');
      } else {
        f.disabled = true;
        f.setAttribute('data-demo-inert', '1');
      }
    }
  }

  // --- feedback ------------------------------------------------------------
  var toast, hideTimer;
  function say(message) {
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'demo-toast';
      toast.setAttribute('role', 'status');
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('demo-toast--on');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { toast.classList.remove('demo-toast--on'); }, 2600);
  }

  // --- blocking ------------------------------------------------------------
  // Capture phase on document runs before any handler on the button itself,
  // including inline onclick, so stopping here stops everything.
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;

    var link = t.closest('a[data-demo-disabled]');
    if (link) {
      e.preventDefault();
      e.stopImmediatePropagation();
      say('That screen is not part of this demo.');
      return;
    }

    var btn = t.closest('button');
    if (!btn) return;
    if (!btn.hasAttribute('data-demo-seen')) {      // rendered since the last sweep
      btn.setAttribute('data-demo-seen', '1');
      if (!isViewOnly(btn)) {
        btn.setAttribute('data-demo-inert', '1');
        btn.setAttribute('aria-disabled', 'true');
      }
    }
    if (!btn.hasAttribute('data-demo-inert')) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    say('This is a read-only demo — nothing here can be changed.');
  }, true);

  // Keyboard activation reaches the same handlers, so block it the same way.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    var btn = e.target && e.target.closest && e.target.closest('button[data-demo-inert]');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    say('This is a read-only demo — nothing here can be changed.');
  }, true);

  document.addEventListener('beforeinput', function (e) {
    var f = e.target;
    if (!f || !f.hasAttribute || !f.hasAttribute('data-demo-readonly')) return;
    say('This is a read-only demo — nothing here can be changed.');
  }, true);

  // Medication cards, agenda rows and modal bodies all render after load.
  function start() {
    mark(document);
    try {
      new MutationObserver(function () { mark(document); })
        .observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
