(function () {
  'use strict';

  var KEEP = [
    '.demo-banner__x',
    '.time-range-btn',
    '.nav-btn',
    '.mini-calendar-btn', '#mini-prev-month', '#mini-next-month',
    '#open-agenda-btn', '#agenda-close',
    '.nav-arrow',
    '.help-modal-close', '#close-help-modal', '#open-help-modal-from-popup',
    '#open-help-btn', '#finish-btn', '.finish-btn',
    '.popup-close-btn', '#close-first-time-popup',
    '.day-details-close', '.dose-status-close',
    '.modal-close', '.faq-modal__close', '.toast-close',
    '#groups-modal-close', '#stock-close-btn',
    '.pw-toggle',
    '#profile-more-btn', '#notification-dropdown-toggle', '.notification-dropdown-toggle'
  ].join(',');

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

  function lockFields(scope) {
    var fields;
    try { fields = scope.querySelectorAll('input:not([data-demo-seen]), textarea:not([data-demo-seen]), select:not([data-demo-seen])'); }
    catch (_) { return; }
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      f.setAttribute('data-demo-seen', '1');
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
    if (!btn.hasAttribute('data-demo-seen')) {
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
