/*
 * Build /demo/ from the real pages.
 *
 * Each page is copied verbatim, then:
 *   1. an import map redirects every Firebase SDK URL to the local fakes,
 *   2. the demo dataset is loaded before anything else,
 *   3. a read-only banner is added,
 *   4. links to pages not in the demo are neutralised so nothing 404s.
 *
 * Copying rather than rewriting means the demo renders the real UI, and a
 * change to the real app is one re-run away from being reflected here.
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/Users/rishikeshalladi/Documents/MedTracker';
const OUT = path.join(ROOT, 'demo');

const PAGES = ['home.html', 'calendar.html', 'history.html', 'stats.html', 'notes.html', 'medicom.html', 'profile.html'];
const IN_DEMO = new Set(PAGES);

const SDK = 'https://www.gstatic.com/firebasejs/12.4.0';
const NOINDEX = `  <meta name="robots" content="noindex, nofollow">\n`;

const IMPORT_MAP = `  <script type="importmap">
  {
    "imports": {
      "${SDK}/firebase-app.js": "./fb-app.js",
      "${SDK}/firebase-auth.js": "./fb-auth.js",
      "${SDK}/firebase-firestore.js": "./fb-firestore.js",
      "${SDK}/firebase-functions.js": "./fb-functions.js"
    }
  }
  </script>
  <script src="demo-data.js"></script>
`;

const BANNER_CSS = `  <style>
    .demo-banner{
      position:fixed; top:0; left:0; right:0; z-index:30000;
      display:flex; align-items:center; justify-content:center; gap:.6rem;
      padding:.5rem 1rem; font:600 .85rem/1.3 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;
      background:linear-gradient(135deg,#4f8cff,#7a5cff); color:#fff; text-align:center;
      box-shadow:0 2px 10px rgba(0,0,0,.25);
    }
    .demo-banner b{font-weight:800}
    body{padding-top:34px !important}
    .sidebar{top:34px !important}
    .demo-banner__x{
      position:absolute; right:.6rem; top:50%; transform:translateY(-50%);
      background:transparent; border:0; color:#fff; font-size:1.1rem; cursor:pointer; opacity:.85;
    }
    @media (max-width:640px){ .demo-banner{font-size:.76rem; padding:.45rem .5rem} }
  </style>
`;

const BANNER_HTML = `  <div class="demo-banner" role="status">
    <span><b>Demo</b> &middot; sample data, read&#8209;only &mdash; nothing you change here is saved</span>
    <button class="demo-banner__x" type="button" aria-label="Hide" onclick="this.parentNode.remove();document.body.style.paddingTop='0'">&times;</button>
  </div>
`;

// Pages that exist in the real app but not in the demo.
const NEUTRALISE_NOTE = `  <script>
    // Anything outside the demo set is inert rather than a 404.
    document.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[data-demo-disabled]');
      if (!a) return;
      e.preventDefault();
      alert('This part of Everane is not included in the demo.');
    }, true);
  </script>
`;

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

let report = [];
for (const page of PAGES) {
  const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
  let out = src;

  // 1 + 2. Inject the import map and dataset as the first thing in <head>.
  const headMatch = out.match(/<head[^>]*>/i);
  if (!headMatch) { console.error(`ABORT ${page}: no <head>`); process.exit(1); }
  const headEnd = out.indexOf(headMatch[0]) + headMatch[0].length;
  out = out.slice(0, headEnd) + '\n' + NOINDEX + IMPORT_MAP + BANNER_CSS + out.slice(headEnd);

  // 3. Banner right after <body>.
  const bodyMatch = out.match(/<body[^>]*>/i);
  if (!bodyMatch) { console.error(`ABORT ${page}: no <body>`); process.exit(1); }
  const bodyEnd = out.indexOf(bodyMatch[0]) + bodyMatch[0].length;
  out = out.slice(0, bodyEnd) + '\n' + BANNER_HTML + out.slice(bodyEnd);

  // 4. Neutralise links to pages we did not build.
  let disabled = 0;
  out = out.replace(/href="([a-zA-Z0-9_-]+\.html)"/g, (m, target) => {
    if (IN_DEMO.has(target)) return m;
    disabled++;
    return `href="#" data-demo-disabled="${target}"`;
  });

  // Drop the problem-report button: it posts to the real backend.
  out = out.replace(/<button type="button" id="report-fab"[\s\S]*?<\/button>/, '');
  out = out.replace(/<div id="report-modal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/, '');

  // Strip service-worker / push registration — irrelevant and noisy in a demo.
  out = out.replace(/<script src="push-subscribe\.js"><\/script>/g, '');
  out = out.replace(/<script src="(\.\.\/)?push-subscribe\.js"><\/script>/g, '');

  // 5. Sibling assets live one level up from /demo/. Rewrite every relative
  //    reference except the demo's own files and the import-map entries.
  const OWN = /^(demo-data|fb-app|fb-auth|fb-firestore|fb-functions)\.js$/;
  out = out.replace(/\b(src|href)="(?!https?:|\/\/|\.\.\/|#|data:|mailto:)([^"]+\.(?:js|css|svg|png|jpg|json|webmanifest))"/g,
    (m, attr, file) => (OWN.test(file) ? m : `${attr}="../${file}"`));

  out = out.replace(/<\/body>/i, NEUTRALISE_NOTE + '</body>');

  fs.writeFileSync(path.join(OUT, page), out);
  report.push({ page, bytes: out.length, disabledLinks: disabled });
}

console.log('  built:');
report.forEach(r => console.log(`    ${r.page.padEnd(16)} ${String(r.bytes).padStart(7)} bytes  ${r.disabledLinks} link(s) neutralised`));
