// Static registry page: one card per patch with install link, status badge,
// assertion and before/after screenshots. No build step, no JS framework.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BADGE = { pass: ['verified', 'ok'], repaired: ['auto-repaired', 'fix'], fail: ['broken', 'bad'], blocked: ['site blocked CI', 'meh'], wrong: ['wrong target (audit)', 'bad'] };

function ago(iso) {
  const h = Math.round((Date.now() - new Date(iso)) / 36e5);
  return h < 1 ? 'just now' : h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// The DOM assertion proves the selector got hidden, not that it was the right element.
// A failed human audit of the current version overrides a green status.
const wrongTarget = m => m.audit && m.audit.correct === false && m.audit.version === m.version;
const shown = m => (wrongTarget(m) && (m.status === 'pass' || m.status === 'repaired') ? 'wrong' : m.status);

function card(meta, rel) {
  const [label, cls] = BADGE[shown(meta)] || [meta.status, 'meh'];
  const base = `${rel}/${meta.host}/${meta.slug}`;
  const hasShots = fs.existsSync(path.join(require('./patch').PATCHES, meta.host, `${meta.slug}.after.jpg`));
  const repairs = (meta.history || []).filter(h => h.event === 'repaired').length;
  return `<article class="card" data-status="${esc(shown(meta))}" data-q="${esc((meta.host + ' ' + meta.title + ' ' + meta.request).toLowerCase())}">
  ${hasShots ? `<figure class="shots"><img loading="lazy" src="${base}.before.jpg" alt="before"><img loading="lazy" class="after" src="${base}.after.jpg" alt="after"><figcaption><span>before</span><span>after</span></figcaption></figure>` : '<div class="noshot">no screenshot</div>'}
  <div class="body">
    <div class="row"><span class="host">${esc(meta.host)}</span><span class="badge ${cls}">${label}</span></div>
    <h2>${esc(meta.request)}</h2>
    <details><summary>assertion</summary><ul>${(meta.assertion || []).map(a => `<li><code>${esc(a)}</code></li>`).join('')}</ul>
      ${wrongTarget(meta) ? `<p class="prob">human audit: assertion passes, but ${esc(meta.audit.why)}</p>` : ''}
      ${meta.problems && meta.problems.length ? `<p class="prob">${meta.problems.map(esc).join('<br>')}</p>` : ''}
      <p class="small">tested on <a href="${esc(meta.testUrl)}" rel="noopener">${esc(meta.testUrl)}</a> · @match <code>${esc(meta.match)}</code></p></details>
    <div class="row foot"><a class="install" href="${base}.user.js">Install v${esc(meta.version)}</a>
      <span class="small">checked ${ago(meta.lastVerified)}${repairs ? ` · repaired ${repairs}×` : ''}</span></div>
  </div>
</article>`;
}

function build({ outDir = path.join(ROOT, 'site') } = {}) {
  const { listPatches, PATCHES } = require('./patch');
  const metas = listPatches().map(p => p.meta).sort((a, b) => a.host.localeCompare(b.host) || a.slug.localeCompare(b.slug));
  const rel = path.relative(outDir, PATCHES).split(path.sep).join('/');
  const ok = metas.filter(m => (m.status === 'pass' || m.status === 'repaired') && !wrongTarget(m)).length;
  const flagged = metas.filter(m => shown(m) === 'wrong').length;
  const hosts = new Set(metas.map(m => m.host)).size;
  const last = metas.map(m => m.lastVerified).sort().at(-1);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sitepatch registry — tell any website what to stop doing</title>
<style>
:root{--bg:#0e0f11;--panel:#16181c;--line:#26292f;--ink:#e8e6e1;--dim:#8b8f98;--ok:#3ecf8e;--fix:#5aa9ff;--bad:#ff5d5d;--meh:#9a9a9a;--acc:#f5c542}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:48px 32px 24px;max-width:1240px;margin:auto}
h1{font:800 44px/1 ui-monospace,"Cascadia Code",Menlo,monospace;margin:0 0 10px;letter-spacing:-1px}h1 b{color:var(--acc)}
.tag{color:var(--dim);font-size:18px;margin:0 0 22px}
.stats{display:flex;gap:28px;flex-wrap:wrap;font-family:ui-monospace,monospace;font-size:13px;color:var(--dim)}
.stats strong{display:block;font-size:28px;color:var(--ink)}.stats .ok strong{color:var(--ok)}
.bar{max-width:1240px;margin:0 auto;padding:0 32px 18px;display:flex;gap:10px;flex-wrap:wrap}
.bar input{flex:1;min-width:220px;background:var(--panel);border:1px solid var(--line);color:var(--ink);padding:10px 12px;border-radius:8px;font:inherit}
.bar button{background:var(--panel);border:1px solid var(--line);color:var(--dim);padding:8px 12px;border-radius:8px;font:13px ui-monospace,monospace;cursor:pointer}
.bar button.on{color:var(--ink);border-color:var(--acc)}
main{max-width:1240px;margin:auto;padding:0 32px 64px;display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:18px}
.card[hidden]{display:none}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;display:flex;flex-direction:column}
.card[data-status=fail],.card[data-status=wrong]{border-color:#5a2626}
.shots{position:relative;margin:0;aspect-ratio:1280/560;overflow:hidden;background:#000}
.shots img{position:absolute;inset:0;width:100%;height:auto;display:block}
.shots .after{clip-path:inset(0 0 0 50%)}
.shots:hover .after{clip-path:inset(0 0 0 0)}
.shots::after{content:"";position:absolute;top:0;bottom:0;left:50%;width:2px;background:var(--acc);transition:opacity .2s}.shots:hover::after{opacity:0}
figcaption{position:absolute;bottom:6px;left:8px;right:8px;display:flex;justify-content:space-between;font:11px ui-monospace,monospace}
figcaption span{background:#000c;padding:2px 6px;border-radius:4px}
.noshot{aspect-ratio:1280/560;display:grid;place-items:center;color:var(--dim);background:#0b0c0e}
.body{padding:14px 16px 16px;display:flex;flex-direction:column;gap:8px;flex:1}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}.foot{margin-top:auto}
.host{font:12px ui-monospace,monospace;color:var(--dim)}
h2{font-size:16px;margin:0;font-weight:600}
.badge{font:700 11px ui-monospace,monospace;padding:3px 8px;border-radius:99px;text-transform:uppercase;letter-spacing:.5px}
.badge.ok{background:#3ecf8e22;color:var(--ok)}.badge.fix{background:#5aa9ff22;color:var(--fix)}.badge.bad{background:#ff5d5d22;color:var(--bad)}.badge.meh{background:#ffffff14;color:var(--meh)}
details{font-size:13px;color:var(--dim)}summary{cursor:pointer}details ul{margin:6px 0;padding-left:18px}code{font-size:12px;color:#c9c4b8;word-break:break-all}
.prob{color:var(--bad);font:12px ui-monospace,monospace}.small{font-size:12px;color:var(--dim)}.small a{color:var(--dim)}
.install{background:var(--acc);color:#111;text-decoration:none;font-weight:700;padding:7px 12px;border-radius:8px;font-size:13px}
footer{max-width:1240px;margin:auto;padding:0 32px 48px;color:var(--dim);font-size:13px}footer code{color:var(--ink)}
</style></head><body>
<header>
  <h1>site<b>patch</b></h1>
  <p class="tag">Tell any website what to stop doing. Every patch is verified in a real browser and re-tested against the live site.</p>
  <div class="stats">
    <div class="ok"><strong>${ok}/${metas.length}</strong>verified &amp; audited</div>
    <div><strong>${flagged}</strong>pass the check, wrong target</div>
    <div><strong>${hosts}</strong>sites</div>
    <div><strong>${metas.filter(m => m.status === 'repaired').length}</strong>auto-repaired</div>
    <div><strong>${last ? ago(last) : '—'}</strong>last check</div>
  </div>
</header>
<div class="bar"><input id="q" placeholder="filter: wikipedia, sidebar, footer…" aria-label="filter patches">
  <button class="on" data-f="all">all</button><button data-f="pass">verified</button><button data-f="repaired">repaired</button><button data-f="fail">broken</button><button data-f="wrong">wrong target</button></div>
<main id="grid">
${metas.map(m => card(m, rel)).join('\n')}
</main>
<footer>Install needs a userscript manager (Tampermonkey or Violentmonkey). Patches only hide or rearrange elements: no paywall, ad, DRM, login or CAPTCHA circumvention.
Hover a screenshot to see the patched page. Make your own: <code>sitepatch "example.com: hide the sidebar"</code></footer>
<script>
const q=document.getElementById('q'),cards=[...document.querySelectorAll('.card')];let f='all';
function run(){const t=q.value.toLowerCase();cards.forEach(c=>{c.hidden=!(c.dataset.q.includes(t)&&(f==='all'||c.dataset.status===f))})}
q.oninput=run;document.querySelectorAll('.bar button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.bar button').forEach(x=>x.classList.remove('on'));b.classList.add('on');f=b.dataset.f;run()});
</script>
</body></html>
`;
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'index.html');
  fs.writeFileSync(out, html);
  return out;
}

module.exports = { build };
